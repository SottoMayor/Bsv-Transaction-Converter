import axios from 'axios';
import { type Network, defaultWocBaseUrl, reverseHex, encodeVarInt, readVarInt, formatAxiosError } from '../utils/index.js';

export interface BEEFPackagerConfig {
  network?: Network;
  arcUrl?: string;
  arcApiKey?: string;
  wocApiKey?: string;
}

export type BEEFParentData = { rawTx: string; merklePath: string };
export type BEEFParentMap  = { [txid: string]: BEEFParentData };

function defaultArcBaseUrl(network: Network): string {
  return network === 'mainnet'
    ? 'https://arc.taal.com/v1'
    : 'https://arc-test.taal.com/v1';
}

// BUMP types (interfaces must be at module level in TypeScript)
interface BumpLeaf { offset: number; flags: number; hash?: string; }
interface ParsedBump { blockHeight: number; treeHeight: number; levels: BumpLeaf[][]; }

export class BEEFPackager {
  private readonly wocBaseUrl: string;
  private readonly arcBaseUrl: string;
  private readonly arcApiKey: string | undefined;
  private readonly wocApiKey: string | undefined;

  constructor(config?: BEEFPackagerConfig) {
    const network: Network = config?.network ?? 'testnet';
    this.wocBaseUrl = defaultWocBaseUrl(network);
    this.arcBaseUrl = config?.arcUrl ?? defaultArcBaseUrl(network);
    this.arcApiKey = config?.arcApiKey;
    this.wocApiKey = config?.wocApiKey;
  }

  async execute(
    childRawTx: string,
    options?: { parents?: BEEFParentMap }
  ): Promise<string> {
    if (!options?.parents && !this.arcApiKey) {
      throw new Error(
        'arcApiKey is required in online mode. Provide it via the constructor config.'
      );
    }

    console.log('Creating BEEF transaction...');

    // 1. Extract parent TXIDs from child transaction
    console.log('1) Extracting parent TXIDs from RAW transaction...');
    const parentTxids = this.extractParentTxids(childRawTx);
    const uniqueParentTxids = [...new Set(parentTxids)];
    if (uniqueParentTxids.length < parentTxids.length) {
      console.log(`  - Found ${parentTxids.length} input(s), ${uniqueParentTxids.length} unique parent(s):`);
    } else {
      console.log(`  - Found ${uniqueParentTxids.length} parent(s):`);
    }
    uniqueParentTxids.forEach((txid, i) => console.log(`    ${i + 1}. ${txid}`));

    // 2. Collect parent data (offline or online)
    const collectedParents: { txid: string; rawTx: string; merklePath: string }[] = [];

    if (options?.parents) {
      // Offline mode: validate all parent TXIDs are provided
      console.log('2) Offline mode: validating provided parent transactions...');
      for (const txid of uniqueParentTxids) {
        const parentData = options.parents[txid];
        if (!parentData) {
          throw new Error(
            `Missing parent data for TXID ${txid}. ` +
            `In offline mode, all parent transactions and merkle paths must be provided.`
          );
        }
        if (!parentData.rawTx) {
          throw new Error(`Missing rawTx for parent TXID ${txid}.`);
        }
        if (!parentData.merklePath) {
          throw new Error(`Missing merklePath for parent TXID ${txid}.`);
        }
        collectedParents.push({ txid, rawTx: parentData.rawTx, merklePath: parentData.merklePath });
      }
      console.log(`  - All ${uniqueParentTxids.length} parent(s) validated`);
    } else {
      // Online mode: fetch from ARC + WoC
      console.log('2) Fetching parent transactions from ARC...');
      for (const txid of uniqueParentTxids) {
        const { merklePath, rawTx } = await this.fetchTxFromARC(txid);
        collectedParents.push({ txid, rawTx, merklePath });
      }
      console.log(`  - Fetched ${collectedParents.length} parent transaction(s)`);
    }

    // 3. Merge BUMPs by block (shared: offline and online)
    console.log('3) Merging BUMPs by block (redundant leaves pruned)...');
    const parsedParents = collectedParents.map(p => ({ ...p, parsedBump: this.parseBump(p.merklePath) }));
    const bumpByBlock = new Map<number, ParsedBump>();
    for (const p of parsedParents) {
      const existing = bumpByBlock.get(p.parsedBump.blockHeight);
      bumpByBlock.set(p.parsedBump.blockHeight, existing ? this.mergeBumpsForBlock([existing, p.parsedBump]) : p.parsedBump);
    }
    const blockHeights = [...bumpByBlock.keys()];
    const bumps = blockHeights.map(bh => this.serializeBump(this.pruneRedundantLeaves(bumpByBlock.get(bh)!)));
    const parentsForAssembly = parsedParents.map(p => ({
      txid: p.txid,
      rawTx: p.rawTx,
      bumpIndex: blockHeights.indexOf(p.parsedBump.blockHeight),
    }));
    console.log(`  - ${bumps.length} BUMP(s) (merged, redundant leaves pruned)`);

    // 4. Assemble BEEF
    const version = '0100beef';
    const nBUMPs = encodeVarInt(bumps.length);
    const bumpData = bumps.join('');
    const nTxs = encodeVarInt(parentsForAssembly.length + 1); // Parents + child

    let txList = '';
    for (const p of parentsForAssembly) {
      txList += p.rawTx;
      txList += '01'; // Has BUMP = Yes
      txList += encodeVarInt(p.bumpIndex);
    }
    txList += childRawTx;
    txList += '00'; // Has BUMP = No

    const beef = version + nBUMPs + bumpData + nTxs + txList;

    console.log('4) BEEF assembled');
    console.log(`  - Total length: ${beef.length / 2} bytes`);
    console.log(`  - Structure: ${bumps.length} BUMP(s) + ${parentsForAssembly.length + 1} transaction(s)`);

    return beef;
  }

  private async fetchTxFromARC(
    txid: string
  ): Promise<{ merklePath: string; rawTx: string; txStatus: string; blockHeight: number }> {
    // Get status and merklePath
    const statusUrl = `${this.arcBaseUrl}/tx/${txid}`;
    const arcHeaders: Record<string, string> = {};
    if (this.arcApiKey) arcHeaders['Authorization'] = this.arcApiKey;
    let statusResponse;
    try {
      statusResponse = await axios.get(statusUrl, { headers: arcHeaders });
    } catch (err) {
      throw new Error(`Failed to fetch tx ${txid} from ARC: ${formatAxiosError(err)}`);
    }

    const { merklePath, txStatus, blockHeight } = statusResponse.data;

    if (txStatus !== 'MINED') {
      throw new Error(
        `Transaction ${txid} is not mined yet (status: ${txStatus}). ` +
        `BEEF v1.0 requires mined parents.`
      );
    }

    if (!merklePath || merklePath === '') {
      throw new Error(`Transaction ${txid} has no merklePath. Cannot build BUMP.`);
    }

    // Get RAW TRX HEX
    const rawUrl = `${this.wocBaseUrl}/tx/${txid}/hex`;
    const rawHeaders: Record<string, string> = {};
    if (this.wocApiKey) rawHeaders['Authorization'] = this.wocApiKey;
    let rawResponse;
    try {
      rawResponse = await axios.get(rawUrl, { headers: rawHeaders });
    } catch (err) {
      throw new Error(`Failed to fetch raw tx ${txid} from WoC: ${formatAxiosError(err)}`);
    }
    const rawTx = (rawResponse.data as string).trim();

    return { merklePath, rawTx, txStatus, blockHeight };
  }

  private parseBump(hex: string): ParsedBump {
    let pos = 0;

    const r = readVarInt(hex, pos);
    const blockHeight = r.value;
    pos += r.bytesRead;

    const treeHeight = parseInt(hex.substr(pos, 2), 16);
    pos += 2;

    const levels: BumpLeaf[][] = [];
    for (let level = 0; level < treeHeight; level++) {
      const rn = readVarInt(hex, pos);
      const nLeaves = rn.value;
      pos += rn.bytesRead;

      const leaves: BumpLeaf[] = [];
      for (let i = 0; i < nLeaves; i++) {
        const ro = readVarInt(hex, pos);
        const leafOffset = ro.value;
        pos += ro.bytesRead;

        const flags = parseInt(hex.substr(pos, 2), 16);
        pos += 2;

        let hash: string | undefined;
        if (!(flags & 1)) {
          hash = hex.substr(pos, 64);
          pos += 64;
        }

        leaves.push(hash !== undefined ? { offset: leafOffset, flags, hash } : { offset: leafOffset, flags });
      }
      levels.push(leaves);
    }

    return { blockHeight, treeHeight, levels };
  }

  private serializeBump(bump: ParsedBump): string {
    let hex = '';
    hex += encodeVarInt(bump.blockHeight);
    hex += bump.treeHeight.toString(16).padStart(2, '0');

    for (const leaves of bump.levels) {
      hex += encodeVarInt(leaves.length);
      for (const leaf of leaves) {
        hex += encodeVarInt(leaf.offset);
        hex += leaf.flags.toString(16).padStart(2, '0');
        if (!(leaf.flags & 1)) {
          hex += leaf.hash!;
        }
      }
    }

    return hex;
  }

  private mergeBumpsForBlock(bumps: ParsedBump[]): ParsedBump {
    const blockHeight = bumps[0]!.blockHeight;
    const treeHeight = Math.max(...bumps.map(b => b.treeHeight));

    const levels: BumpLeaf[][] = [];
    for (let level = 0; level < treeHeight; level++) {
      const merged = new Map<number, BumpLeaf>();
      for (const bump of bumps) {
        if (level >= bump.levels.length) continue;
        for (const leaf of bump.levels[level] ?? []) {
          const existing = merged.get(leaf.offset);
          if (!existing) {
            merged.set(leaf.offset, { ...leaf });
          } else {
            // Upgrade txid flag; never downgrade a txid leaf to a sibling hash
            existing.flags |= (leaf.flags & 2);
          }
        }
      }
      levels.push([...merged.values()].sort((a, b) => a.offset - b.offset));
    }

    return { blockHeight, treeHeight, levels };
  }

  // Remove leaves at level N that are computable from level N-1 (both children present)
  private pruneRedundantLeaves(bump: ParsedBump): ParsedBump {
    const known: Set<number>[] = [];

    // Level 0: all explicit offsets + sibling implied by duplicate leaves (flags & 1)
    const level0 = new Set((bump.levels[0] ?? []).map(l => l.offset));
    for (const leaf of bump.levels[0] ?? []) {
      if (leaf.flags & 1) {
        const sib = leaf.offset % 2 === 0 ? leaf.offset + 1 : leaf.offset - 1;
        level0.add(sib);
      }
    }
    known.push(level0);

    const prunedLevels = [bump.levels[0] ?? []];

    for (let lv = 1; lv < bump.treeHeight; lv++) {
      const prevKnown = known[lv - 1]!;
      const thisLevel = bump.levels[lv] ?? [];

      const kept = thisLevel.filter(leaf => {
        const child1 = leaf.offset * 2;
        const child2 = leaf.offset * 2 + 1;
        return !(prevKnown.has(child1) && prevKnown.has(child2)); // keep if NOT derivable
      });

      const thisKnown = new Set(kept.map(l => l.offset));
      for (const offset of prevKnown) {
        thisKnown.add(Math.floor(offset / 2));
      }
      known.push(thisKnown);
      prunedLevels.push(kept);
    }

    return { ...bump, levels: prunedLevels };
  }

  // Extract all parent TXIDs from RAW transaction inputs
  private extractParentTxids(rawTxHex: string): string[] {
    let offset = 0;

    // Skip version (4 bytes)
    offset += 8;

    // Read input count
    const r = readVarInt(rawTxHex, offset);
    const inputCount = r.value;
    offset += r.bytesRead;

    const parentTxids: string[] = [];

    // Extract TXID from each input
    for (let i = 0; i < inputCount; i++) {
      // Read TXID (32 bytes, little-endian)
      const txidLE = rawTxHex.substr(offset, 64);
      const txidBE = reverseHex(txidLE); // Convert to big-endian
      parentTxids.push(txidBE);

      offset += 64; // TXID
      offset += 8;  // VOUT

      // Skip unlocking script
      const rs = readVarInt(rawTxHex, offset);
      offset += rs.bytesRead;
      offset += rs.value * 2; // Unlocking script
      offset += 8; // Sequence
    }

    return parentTxids;
  }
}
