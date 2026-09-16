import { getAddress } from '@ethersproject/address';
import { BigNumber } from '@ethersproject/bignumber';
import { formatUnits } from '@ethersproject/units';
import { Multicaller } from '../../utils';

/**
 * Time-weighted average balance of a community token over a ballot's window.
 *
 * A single-block snapshot answers "who held it at one instant", which is the right
 * question for a share ballot and the wrong one for a bloc: it hands full weight to
 * someone who bought a minute before the block and sold a minute after, and zero to
 * someone who has held throughout but arrived after the ballot opened. This weighs
 * the holding the way the holding actually happened —
 *
 *   weight = ( 1 / (t_end - t_start) ) * integral of balance(t) dt
 *
 * — so a wallet that held B for the whole window scores B, one that held B for half
 * of it scores B/2, and one that bought late and kept holding keeps accruing until
 * the ballot closes. Selling stops the accrual; it never claws back what was earned.
 *
 * The window is [t_start, t_start + windowSeconds], clamped to the present.
 * `snapshot` is the proposal's own block, so the start is fixed and public, and
 * `windowSeconds` is the ballot's length, so the end is fixed too. While the ballot
 * is open the clamp bites and the number is the accrual so far — which is what the
 * page shows. Once the ballot closes the clamp lifts and the answer stops moving,
 * permanently, for everyone.
 *
 * That fixed end is not a detail. With the window ending at "now", two people
 * scoring the same wallet a minute apart get different numbers — measured at 0.5%
 * and 1.1% apart on two active wallets — and the closing tally would depend on the
 * minute the score job happened to run. A weight nobody can reproduce is not a
 * weight anybody can check.
 *
 * The balance curve is reconstructed exactly, not sampled: one archive `balanceOf`
 * at the start block, then every Transfer touching these addresses, applied in
 * order. Sampling hourly would be both more RPC calls and less accurate — an hour
 * is long enough to hide a whole round trip.
 */

const abi = ['function balanceOf(address account) external view returns (uint256)'];

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Blocks per `eth_getLogs`, and how many of those run at once.
 *
 * Measured. The brovider caps at exactly 10,000 blocks and ERRORS, so nothing is
 * lost silently there. The Tenderly gateway is the opposite and far more dangerous:
 * it answers a 3.5M-block range with 14 logs where its own 1M-block SUBSET of that
 * range returns 12,203 — deterministically, with no error. A superset returning less
 * than its subset is silent data loss, and a weight built on it would look perfectly
 * plausible. So the chunk is held at a width that was checked for additivity rather
 * than at whatever a node will accept: five 200,000-block chunks returned exactly the
 * same 12,206 logs as one 1,000,000-block call, key for key, in both directions.
 *
 * CHUNK never grows past that validated width, and halves on a range complaint so a
 * stricter node degrades instead of breaking.
 *
 * Concurrency is the part that matters. Robinhood Chain produces roughly ten blocks
 * a second, so a four-day ballot spans about 3.4 million blocks — 346 chunks, two
 * filters each. Sequentially that is some six hundred round trips and the request
 * dies long before it finishes; the ballot would simply fail to tally at close.
 */
let LOG_CHUNK = 200000;
const LOG_CONCURRENCY = 16;

/** Bounded fan-out. Keeps the scan inside one request without flooding the node. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

const topicAddress = (a: string) => '0x' + a.toLowerCase().slice(2).padStart(64, '0');
const fromTopic = (t: string) => getAddress('0x' + t.slice(-40));

export type Segment = { balance: BigNumber; seconds: number };

/**
 * The integral, given a wallet's balance segments. Split out so the arithmetic can
 * be tested, and audited, without an RPC.
 *
 * Exact integer maths on purpose: `balance` is wei and `seconds` an integer, and a
 * float multiply here would drift by whole tokens on a large holder over a long
 * window. Only the final division loses anything, and it loses less than one wei.
 */
export function integrate(segments: Segment[], totalSeconds: number): BigNumber {
  // A zero-length window has no average to take. The caller handles that case with
  // the opening balance; returning an arbitrary segment from here would be a number
  // with no meaning attached to it.
  if (totalSeconds <= 0) return BigNumber.from(0);
  let acc = BigNumber.from(0);
  for (const s of segments) {
    if (s.seconds > 0) acc = acc.add(s.balance.mul(s.seconds));
  }
  return acc.div(totalSeconds);
}

export async function strategy(
  space: string,
  network: string,
  provider: any,
  addresses: string[],
  options: { address: string; decimals: number; symbol?: string; windowSeconds?: number },
  snapshot: string | number
): Promise<Record<string, number>> {
  if (!options.address) throw new Error('address parameter is required');
  if (!addresses.length) return {};

  const head: number = await provider.getBlockNumber();
  // 'latest' means there is no window to integrate over — a caller asking for a
  // spot reading gets one, rather than a silently empty result.
  const startBlock = typeof snapshot === 'number' && snapshot > 0 ? Math.min(snapshot, head) : head;
  const windowSeconds = Number(options.windowSeconds ?? 0);

  const wanted = addresses.map(a => getAddress(a));
  const index = new Map(wanted.map(a => [a, true]));

  // Opening balances, read at the window's own block. This is the only archive
  // read; everything after it is derived from logs.
  const multi = new Multicaller(network, provider, abi, { blockTag: startBlock });
  wanted.forEach(a => multi.call(a, options.address, 'balanceOf', [a]));
  const opening: Record<string, BigNumber> = Object.fromEntries(
    Object.entries(await multi.execute()).map(([a, b]) => [a, BigNumber.from(b as any)])
  );

  const [startBlockData, headBlockData] = await Promise.all([
    provider.getBlock(startBlock),
    provider.getBlock(head)
  ]);
  const startTs: number = startBlockData.timestamp;
  const headTs: number = headBlockData.timestamp;
  // Without a declared length the window can only end at the present, and the score
  // moves every block. Every bloc space sets one; the fallback exists so a
  // misconfigured space still returns a defensible number instead of throwing.
  const closeTs = windowSeconds > 0 ? startTs + windowSeconds : headTs;
  const endTs = Math.min(headTs, closeTs);
  const totalSeconds = Math.max(0, endTs - startTs);

  /**
   * The last block inside the window. Searched rather than estimated, because a
   * closed ballot may be recounted weeks later and scanning from its block to the
   * present would be both slow and pointless — every one of those blocks is after
   * the deadline. Bounds the log scan; the integral itself still cuts on timestamp.
   */
  let endBlock = head;
  if (endTs < headTs) {
    let lo = startBlock;
    let hi = head;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const t: number = (await provider.getBlock(mid)).timestamp;
      if (t <= endTs) lo = mid;
      else hi = mid - 1;
    }
    endBlock = lo;
  }

  // Nothing has elapsed yet: the average balance over a zero-length window is the
  // balance itself. A holder who signs in the first seconds of a ballot sees their
  // real number rather than a zero that looks like a failure.
  if (totalSeconds === 0 || endBlock <= startBlock) {
    return Object.fromEntries(
      wanted.map(a => [a, parseFloat(formatUnits(opening[a] ?? 0, options.decimals))])
    );
  }

  // Only transfers that touch one of these wallets. Asking the node to filter by
  // topic is what keeps this cheap on a token with a large holder set: a ballot
  // with ten voters reads ten wallets' history, not the whole chain's.
  const topics = wanted.map(topicAddress);

  const getLogs = async (fromBlock: number, toBlock: number, incoming: boolean): Promise<any[]> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await provider.getLogs({
          address: options.address,
          fromBlock,
          toBlock,
          topics: incoming ? [TRANSFER, null, topics] : [TRANSFER, topics]
        });
      } catch (e: any) {
        /**
         * Three ways a node says "that span was too much", and all three must split
         * rather than fail. Measured on Robinhood Chain:
         *
         *   "block range exceeds maximum allowed (max=10000)"  — the brovider's cap
         *   "logs matched by query exceeds limit of 10000"     — a RESULT cap, so the
         *                                                        ceiling moves with how
         *                                                        busy the token is
         *   "log query timed out"                              — the dangerous one: a
         *                                                        scan that treats it as
         *                                                        fatal and skips the
         *                                                        chunk silently
         *                                                        undercounts, measured
         *                                                        at 25% on a 5-day span
         *
         * Anything else — a dead node, a bad filter — still surfaces. A scan that
         * quietly returns less than the truth produces a weight that looks entirely
         * plausible and is wrong, which is the failure mode worth fearing here.
         */
        const msg = String(e?.message ?? e);
        if (!/range|too large|max=|exceeds limit|timed out|timeout/i.test(msg)) throw e;
        LOG_CHUNK = Math.max(500, Math.floor(LOG_CHUNK / 2));
        const mid = Math.floor((fromBlock + toBlock) / 2);
        if (mid <= fromBlock) throw e;
        const [a, b] = await Promise.all([getLogs(fromBlock, mid, incoming), getLogs(mid + 1, toBlock, incoming)]);
        return [...a, ...b];
      }
    }
    throw new Error(`eth_getLogs failed for ${fromBlock}-${toBlock}`);
  };

  const spans: Array<[number, number, boolean]> = [];
  for (let from = startBlock + 1; from <= endBlock; from += LOG_CHUNK) {
    const to = Math.min(from + LOG_CHUNK - 1, endBlock);
    spans.push([from, to, false], [from, to, true]);
  }
  const pages = await mapLimit(spans, LOG_CONCURRENCY, ([from, to, inc]) => getLogs(from, to, inc));
  // Spread would blow the argument limit at ~65k entries, which a busy token over a
  // multi-day window reaches easily.
  const logs: any[] = [];
  for (const page of pages) for (const row of page) logs.push(row);

  // A self-transfer matches both filters and would otherwise be applied twice.
  const seen = new Set<string>();
  const events = logs
    .filter(l => {
      const k = `${l.blockNumber}:${l.logIndex}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  // One timestamp read per block that actually contains an event.
  const blocks = [...new Set(events.map(e => e.blockNumber as number))];
  const stamps = new Map<number, number>();
  for (let i = 0; i < blocks.length; i += 20) {
    const page = blocks.slice(i, i + 20);
    const got = await Promise.all(page.map(b => provider.getBlock(b)));
    page.forEach((b, j) => stamps.set(b, got[j].timestamp));
  }

  const balance = new Map<string, BigNumber>(wanted.map(a => [a, opening[a] ?? BigNumber.from(0)]));
  const mark = new Map<string, number>(wanted.map(a => [a, startTs]));
  const segments = new Map<string, Segment[]>(wanted.map(a => [a, []]));

  const advance = (who: string, at: number) => {
    const held = balance.get(who) as BigNumber;
    const since = mark.get(who) as number;
    if (at > since) segments.get(who)!.push({ balance: held, seconds: at - since });
    mark.set(who, Math.max(since, at));
  };

  for (const e of events) {
    /**
     * `Transfer(address,address,uint256)` is the same topic0 for ERC-20 and ERC-721,
     * and the NFT form puts the id in a fourth topic with empty data. A token that
     * emits both — ERC-404 and its imitators, a live genre among meme tokens — would
     * otherwise reach BigNumber.from("0x") and throw, and nobody in that space could
     * vote at all. An id is not a balance, so those are skipped.
     */
    if (e.topics.length > 3 || !e.data || e.data === '0x') continue;
    const at = stamps.get(e.blockNumber) ?? startTs;
    // Blocks are scanned up to the head, but a transfer after the ballot closed is
    // not part of the ballot. Stopping here rather than at a block boundary keeps
    // the cut exactly where the published deadline is.
    if (at > endTs) break;
    const value = BigNumber.from(e.data);
    const sender = fromTopic(e.topics[1]);
    const recipient = fromTopic(e.topics[2]);
    if (index.has(sender)) {
      advance(sender, at);
      const after = (balance.get(sender) as BigNumber).sub(value);
      /**
       * A balance can only go negative if the reconstruction missed a credit. Ethers
       * carries negatives happily and the pipeline then drops any vp <= 0, so the
       * holder is silently scored zero and told they have no voting power — a wrong
       * number wearing the costume of a correct one. Refusing is the honest failure.
       */
      if (after.isNegative()) {
        throw new Error(
          `bloc-twab: ${sender} went negative at block ${e.blockNumber} on ${options.address}; ` +
            `a balance-changing event was not seen, so no weight can be computed for this window`
        );
      }
      balance.set(sender, after);
    }
    if (index.has(recipient)) {
      advance(recipient, at);
      balance.set(recipient, (balance.get(recipient) as BigNumber).add(value));
    }
  }
  wanted.forEach(a => advance(a, endTs));

  return Object.fromEntries(
    wanted.map(a => [
      a,
      parseFloat(formatUnits(integrate(segments.get(a) as Segment[], totalSeconds), options.decimals))
    ])
  );
}
