import { createHash } from 'crypto';
import { reverseHex, encodeVarInt, readVarInt } from '../utils/index.js';

export class BEEFToEFConverter {

  execute(beefHex: string): string {
    let offset = 0;

    // 1. Validate beef marker (must be 0x0100beef)
    const versionHex = beefHex.substr(offset, 8);
    offset += 8;
    if (versionHex.toLowerCase() !== '0100beef') {
      throw new Error('Invalid BEEF: wrong version marker');
    }

    // 2. Skip BUMPs
    const nBumps = readVarInt(beefHex, offset);
    offset += nBumps.bytesRead;
    offset = this.skipBumps(beefHex, offset, nBumps.value);

    // 3. Parse transactions
    const nTxs = readVarInt(beefHex, offset);
    offset += nTxs.bytesRead;

    if (nTxs.value < 2) {
      throw new Error('Invalid BEEF: expected at least 2 transactions');
    }

    const transactions: Array<{ rawHex: string }> = [];

    for (let i = 0; i < nTxs.value; i++) {
      const { rawHex, endOffset } = this.extractRawTxAt(beefHex, offset);
      offset = endOffset;

      const hasBUMP = parseInt(beefHex.substr(offset, 2), 16);
      offset += 2;

      if (hasBUMP === 0x01) {
        const bumpIndex = readVarInt(beefHex, offset);
        offset += bumpIndex.bytesRead;
      }

      transactions.push({ rawHex });
    }

    // 4. Build parent index: txidLE -> outputs[]
    // - All transactions except the last are potential parents.
    // - doubleSHA256 output is the natural hash byte order, which is LE
    const parentIndex = new Map<string, Array<{ value: string; lockingScript: string }>>();

    for (let i = 0; i < transactions.length - 1; i++) {
      const tx = transactions[i]!;
      const txidLE = this.doubleSHA256(tx.rawHex);
      parentIndex.set(txidLE, this.parseTxOutputs(tx.rawHex));
    }

    // 5. Build EF from the target (last) transaction
    const targetRaw = transactions[transactions.length - 1]!.rawHex;
    const targetInputs = this.parseTxInputs(targetRaw);

    const targetVersion = targetRaw.substr(0, 8);
    const efMarker = '0000000000ef';

    // Reconstruct the inputCount VarInt as-is from the raw tx
    const inputCountVI = readVarInt(targetRaw, 8);
    const inputCountHex = targetRaw.substr(8, inputCountVI.bytesRead);

    let efTx = targetVersion + efMarker + inputCountHex;

    for (const input of targetInputs) {
      // Copy raw input bytes (txid + vout + unlockingLen + unlocking + sequence)
      efTx += targetRaw.substr(input.startOffset, input.endOffset - input.startOffset);

      // Look up parent output
      const outputs = parentIndex.get(input.txidLE);
      if (!outputs) {
        const txidBE = reverseHex(input.txidLE);
        throw new Error(`Invalid BEEF: missing parent transaction for txid ${txidBE}`);
      }

      if (input.vout >= outputs.length) {
        const txidBE = reverseHex(input.txidLE);
        throw new Error(`Invalid BEEF: vout ${input.vout} out of range for parent ${txidBE}`);
      }

      const { value, lockingScript } = outputs[input.vout]!;

      // Inject previous output data after sequence
      efTx += value;
      efTx += encodeVarInt(lockingScript.length / 2);
      efTx += lockingScript;
    }

    // Append outputs + locktime (everything after the last input)
    const outputsStart = targetInputs[targetInputs.length - 1]!.endOffset;
    efTx += targetRaw.substr(outputsStart);

    return efTx;
  }

  private doubleSHA256(hex: string): string {
    const buf = Buffer.from(hex, 'hex');
    const first = createHash('sha256').update(buf).digest();
    const second = createHash('sha256').update(first).digest();
    return second.toString('hex');
  }

  // Skip BUMPs section, return offset after all BUMPs
  private skipBumps(hex: string, offset: number, nBumps: number): number {
    for (let i = 0; i < nBumps; i++) {
      // Block height (VarInt)
      const blockHeight = readVarInt(hex, offset);
      offset += blockHeight.bytesRead;

      // Tree height (1 byte)
      const treeHeight = parseInt(hex.substr(offset, 2), 16);
      offset += 2;

      for (let level = 0; level < treeHeight; level++) {
        const nLeaves = readVarInt(hex, offset);
        offset += nLeaves.bytesRead;

        for (let leaf = 0; leaf < nLeaves.value; leaf++) {
          const leafOffset = readVarInt(hex, offset);
          offset += leafOffset.bytesRead;

          const flags = parseInt(hex.substr(offset, 2), 16);
          offset += 2;

          if (flags !== 0x01) {
            offset += 64; // hash (32 bytes)
          }
        }
      }
    }
    return offset;
  }

  // Parse a raw tx starting at offset in the parent hex string.
  // Returns the raw tx hex and the offset immediately after the tx.
  private extractRawTxAt(hex: string, offset: number): { rawHex: string; endOffset: number } {
    const start = offset;

    offset += 8; // version (4 bytes)

    const inputCount = readVarInt(hex, offset);
    offset += inputCount.bytesRead;

    for (let i = 0; i < inputCount.value; i++) {
      offset += 64; // txid (32 bytes)
      offset += 8;  // vout (4 bytes)
      const scriptLen = readVarInt(hex, offset);
      offset += scriptLen.bytesRead;
      offset += scriptLen.value * 2;
      offset += 8;  // sequence (4 bytes)
    }

    const outputCount = readVarInt(hex, offset);
    offset += outputCount.bytesRead;

    for (let j = 0; j < outputCount.value; j++) {
      offset += 16; // value (8 bytes)
      const scriptLen = readVarInt(hex, offset);
      offset += scriptLen.bytesRead;
      offset += scriptLen.value * 2;
    }

    offset += 8; // locktime (4 bytes)

    return { rawHex: hex.substr(start, offset - start), endOffset: offset };
  }

  // Parse outputs from a standalone raw tx hex string.
  private parseTxOutputs(rawHex: string): Array<{ value: string; lockingScript: string }> {
    let offset = 8; // skip version

    const inputCount = readVarInt(rawHex, offset);
    offset += inputCount.bytesRead;

    for (let i = 0; i < inputCount.value; i++) {
      offset += 64;
      offset += 8;
      const scriptLen = readVarInt(rawHex, offset);
      offset += scriptLen.bytesRead;
      offset += scriptLen.value * 2;
      offset += 8;
    }

    const outputCount = readVarInt(rawHex, offset);
    offset += outputCount.bytesRead;

    const outputs: Array<{ value: string; lockingScript: string }> = [];

    for (let j = 0; j < outputCount.value; j++) {
      const value = rawHex.substr(offset, 16);
      offset += 16;
      const scriptLen = readVarInt(rawHex, offset);
      offset += scriptLen.bytesRead;
      const lockingScript = rawHex.substr(offset, scriptLen.value * 2);
      offset += scriptLen.value * 2;
      outputs.push({ value, lockingScript });
    }

    return outputs;
  }

  // Parse inputs from a standalone raw tx hex string.
  // startOffset/endOffset are byte positions within rawHex.
  private parseTxInputs(rawHex: string): Array<{
    txidLE: string;
    vout: number;
    startOffset: number;
    endOffset: number;
  }> {
    let offset = 8; // skip version

    const inputCount = readVarInt(rawHex, offset);
    offset += inputCount.bytesRead;

    const inputs = [];

    for (let i = 0; i < inputCount.value; i++) {
      const startOffset = offset;

      const txidLE = rawHex.substr(offset, 64);
      offset += 64;

      const voutHex = rawHex.substr(offset, 8);
      const vout = parseInt(reverseHex(voutHex), 16);
      offset += 8;

      const scriptLen = readVarInt(rawHex, offset);
      offset += scriptLen.bytesRead;
      offset += scriptLen.value * 2; // unlocking script

      offset += 8; // sequence

      inputs.push({ txidLE, vout, startOffset, endOffset: offset });
    }

    return inputs;
  }
}
