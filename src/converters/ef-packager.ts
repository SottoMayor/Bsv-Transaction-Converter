import axios from 'axios';
import { type Network, defaultWocBaseUrl, reverseHex, encodeVarInt, readVarInt, formatAxiosError } from '../utils/index.js';

export interface EFPackagerConfig {
  network?: Network;
  wocApiKey?: string;
}

export class EFPackager {
  private readonly wocBaseUrl: string;
  private readonly wocApiKey: string | undefined;

  constructor(config?: EFPackagerConfig) {
    const network: Network = config?.network ?? 'testnet';
    this.wocBaseUrl = defaultWocBaseUrl(network);
    this.wocApiKey = config?.wocApiKey;
  }

  async execute(
    childRawTx: string,
    parentRaws?: { [txid: string]: string }
  ): Promise<string> {
    console.log('Creating EF transaction...');
    console.log('1) Extracting parent inputs from RAW transaction...');
    const inputs = this.extractParentInputs(childRawTx);
    console.log(`   - Found ${inputs.length} input(s)`);

    // Deduplicate TXIDs to avoid redundant API calls
    const uniqueTxids = [...new Set(inputs.map(i => i.txid))];

    const parentRawMap = new Map<string, string>();

    if (parentRaws) {
      console.log(`2) Offline mode: validating ${uniqueTxids.length} provided parent transaction(s)...`);
      for (const txid of uniqueTxids) {
        const parentRaw = parentRaws[txid];
        if (!parentRaw) {
          throw new Error(
            `Missing parent transaction for TXID ${txid}. ` +
            `In offline mode, all parent transactions must be provided.`
          );
        }
        parentRawMap.set(txid, parentRaw);
      }
      console.log(`   - All ${uniqueTxids.length} parent(s) validated`);
    } else {
      console.log(`2) Fetching ${uniqueTxids.length} unique parent transaction(s)...`);
      for (const txid of uniqueTxids) {
        const raw = await this.fetchRawTx(txid);
        parentRawMap.set(txid, raw);
        console.log(`   - Fetched ${txid}`);
      }
    }

    console.log('3) Parsing previous outputs...');
    const prevOutputs = inputs.map(({ txid, vout }) => {
      const parentRaw = parentRawMap.get(txid)!;
      const { value, lockingScript } = this.parsePreviousOutput(parentRaw, vout);
      console.log(`   - Input TXID ${txid} vout=${vout}: ${parseInt(reverseHex(value), 16)} sats | script=${lockingScript}`);
      return { value, lockingScript };
    });

    console.log('4) Converting to EF format...');
    const efTx = this.rawToEF(childRawTx, prevOutputs);
    console.log(`5) EF transaction created => Length: ${efTx.length / 2} bytes\n`);

    return efTx;
  }

  private async fetchRawTx(txid: string): Promise<string> {
    const url = `${this.wocBaseUrl}/tx/${txid}/hex`;
    const headers: Record<string, string> = {};
    if (this.wocApiKey) headers['Authorization'] = this.wocApiKey;
    try {
      const response = await axios.get(url, { headers });
      return response.data;
    } catch (err) {
      throw new Error(`Failed to fetch tx ${txid} from WoC: ${formatAxiosError(err)}`);
    }
  }

  // Extract TXID and VOUT from every input of a RAW transaction
  private extractParentInputs(rawTxHex: string): Array<{ txid: string; vout: number }> {
    let offset = 0;

    // Skip version (4 bytes)
    offset += 8;

    // Read input count (VarInt)
    const r0 = readVarInt(rawTxHex, offset);
    const inputCount = r0.value;
    offset += r0.bytesRead;

    const inputs: Array<{ txid: string; vout: number }> = [];

    for (let i = 0; i < inputCount; i++) {
      // TXID (32 bytes, little-endian) -> reverse to big-endian for API
      const txidLE = rawTxHex.substr(offset, 64);
      const txid = reverseHex(txidLE);
      offset += 64;

      // VOUT (4 bytes, little-endian)
      const voutHex = rawTxHex.substr(offset, 8);
      const vout = parseInt(reverseHex(voutHex), 16);
      offset += 8;

      // Skip unlocking script
      const rs = readVarInt(rawTxHex, offset);
      offset += rs.bytesRead + rs.value * 2;

      // Skip sequence (4 bytes)
      offset += 8;

      inputs.push({ txid, vout });
    }

    return inputs;
  }

  private parsePreviousOutput(rawTxHex: string, vout: number): { value: string; lockingScript: string } {
    let offset = 0;

    // Skip version (4 bytes)
    offset += 8;

    // Read input count
    const r0 = readVarInt(rawTxHex, offset);
    const inputCount = r0.value;
    offset += r0.bytesRead;

    // Skip all inputs
    for (let i = 0; i < inputCount; i++) {
      offset += 64; // txid (32 bytes)
      offset += 8;  // vout (4 bytes)
      const rs = readVarInt(rawTxHex, offset);
      offset += rs.bytesRead + rs.value * 2; // unlocking script
      offset += 8; // sequence (4 bytes)
    }

    // Read output count
    const r1 = readVarInt(rawTxHex, offset);
    const outputCount = r1.value;
    offset += r1.bytesRead;

    // Find the output at vout index
    for (let i = 0; i < outputCount; i++) {
      const value = rawTxHex.substr(offset, 16); // 8 bytes
      offset += 16;
      const rsc = readVarInt(rawTxHex, offset);
      offset += rsc.bytesRead;
      const lockingScript = rawTxHex.substr(offset, rsc.value * 2);
      offset += rsc.value * 2;

      if (i === vout) {
        return { value, lockingScript };
      }
    }

    throw new Error(`Output at index ${vout} not found`);
  }

  private rawToEF(rawTxHex: string, prevOutputs: Array<{ value: string; lockingScript: string }>): string {
    const version = rawTxHex.substr(0, 8);
    const efMarker = '0000000000ef';
    const restOfTx = rawTxHex.substr(8);

    let offset = 0;
    const r0 = readVarInt(restOfTx, offset);
    const inputCount = r0.value;
    offset += r0.bytesRead;

    let efTx = version + efMarker + restOfTx.substr(0, offset);

    // For each input, inject previous output data after sequence
    for (let i = 0; i < inputCount; i++) {
      const inputStart = offset;

      offset += 64; // txid
      offset += 8;  // vout

      const rs = readVarInt(restOfTx, offset);
      offset += rs.bytesRead + rs.value * 2; // unlocking script
      offset += 8; // sequence

      // Add this input
      efTx += restOfTx.substr(inputStart, offset - inputStart);

      // Inject previous output data for this input
      const { value: prevOutputValue, lockingScript: prevLockingScript } = prevOutputs[i]!;
      efTx += prevOutputValue; // 8 bytes
      efTx += encodeVarInt(prevLockingScript.length / 2);
      efTx += prevLockingScript;
    }

    // Add the rest (outputs + locktime)
    efTx += restOfTx.substr(offset);

    return efTx;
  }
}
