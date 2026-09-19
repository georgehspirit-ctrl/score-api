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
const morphoAbi = [
  'function position(bytes32 id, address user) external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)'
];

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Morpho Blue's three ways a holder's collateral can move.
 *
 * A community token posted as collateral leaves the wallet, so without these the
 * holder's curve drops to zero the moment they borrow against it and they lose the
 * bloc weight they have been accruing. All three are needed, and the third is the one
 * that bites: a LIQUIDATION removes collateral WITHOUT a WithdrawCollateral, so a
 * wallet liquidated mid-window would otherwise keep accruing weight on a position it
 * no longer has, right through to the close. Three liquidations happened in the last
 * six million blocks, and PONS sits at 81,687 across four wallets — concentrated
 * enough that one of them would visibly move a bloc score.
 *
 * `onBehalf` (Supply/Withdraw) and `borrower` (Liquidate) are all topic 3, so the
 * node filters by holder for us.
 */
const SUPPLY_COLLATERAL =
  '0xa3b9472a1399e17e123f3c2e6586c23e504184d504de59cdaa2b375e880c6184';
const WITHDRAW_COLLATERAL =
  '0xe80ebd7cc9223d7382aab2e0d1d6155c65651f83d53c8b9b06901d167e321142';
const LIQUIDATE =
  '0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41';

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
/**
 * The span a scan STARTS at. Not mutable state.
 *
 * This was a module-level `let` that the split path halved and nothing ever restored,
 * so the first request to meet a busy span permanently shrank the chunk for every
 * request the process served afterwards. Each halving costs twice the round trips:
 * collapsed to the 500 floor, a four-day ballot needs about 9,500 eth_getLogs calls
 * instead of 24, and every bloc weight times out at the edge — which is exactly what
 * happened, and it read as "bloc-twab is broken" rather than "one earlier request
 * poisoned a global". A scorer that degrades permanently from transient node pressure
 * cannot be trusted to return the same weight twice, which is the one property this
 * strategy exists to provide.
 *
 * Adaptation still happens, per request and discarded with it: bisection inside
 * getLogs is what actually handles an over-large span, and it needs no global.
 */
/**
 * Wide spans, because the cost is per CALL, not per block.
 *
 * At 200,000 a four-day window is 14 spans and, with a filter each for sender and
 * recipient, 28 eth_getLogs. Measured against the live endpoint, a wallet with 1,605
 * matching logs and one with 17,874 both take 28 calls and 19.2s / 34.2s sequentially
 * - the volume barely matters, the call count is everything. Raising concurrency to
 * cover it made things WORSE, not better: 32-way tripped the endpoint's throttling and
 * turned 200s into 500s.
 *
 * So ask fewer times. A million-block span puts the same 2.66M-block window in 3
 * spans, 6 calls, one round. The topic filter means a span returns only the wallet's
 * own transfers - 17,874 across the whole window is well inside a 10,000-per-response
 * cap at this width for all but the most extreme holder - and the bisection below
 * still narrows any span that does overflow, permanently for the rest of THIS request.
 */
const LOG_CHUNK_START = 1000000;
const LOG_CHUNK_FLOOR = 500;
/**
 * All of a window's spans in one round.
 *
 * A four-day ballot is ~2.66M blocks, which at LOG_CHUNK_START is 14 spans and, with
 * a filter each for sender and recipient, 28 eth_getLogs. At sixteen that is two
 * rounds and the second round's latency is pure addition. Measured against the live
 * endpoint, per-call latency - not log volume - is what dominates: a wallet with
 * 1,605 logs and one with 17,874 both take 28 calls, 19.2s and 34.2s sequentially.
 */
const LOG_CONCURRENCY = 16;

/** Used only to wait out a throttle. */
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Block-timestamp reads: how many at once, and how many distinct blocks are still
 * read exactly before the interpolated ladder takes over.
 */
// Not higher. 32-way on the log scan tripped this endpoint's throttling and turned
// answers into 500s; there is no reason to believe block reads are treated better.
const STAMP_CONCURRENCY = 64;
/**
 * 5,000 was far too generous. A wallet with 4,999 event blocks still made 4,999
 * getBlock calls - fifty rounds at the width below - which is most of a 60s budget
 * before the log scan is even paid for. It explains why one wallet cleared on BONER,
 * where it is quiet, and walled on MEME, where it is not: same code, same window,
 * different number of event blocks.
 *
 * At 512 the exact path costs at most a handful of rounds, and everything above it
 * takes the bounded ladder, whose cost does not move with the wallet at all.
 */
const EXACT_STAMP_BLOCKS = 512;
const STAMP_ANCHORS = 256;

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
  options: {
    address: string;
    decimals: number;
    symbol?: string;
    windowSeconds?: number;
    /** Morpho Blue singleton. With `markets`, collateral accrues weight like a balance. */
    morpho?: string;
    /** Market ids whose collateralToken is `address`. Frozen into the proposal. */
    markets?: string[];
  },
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

  /**
   * Collateral counts toward the curve exactly like a balance, and its opening value
   * is read at the same block for the same reason. A holder who borrowed against
   * their tokens has not stopped holding them.
   */
  const markets = (options.markets ?? []).filter(Boolean);
  const useCollateral = !!options.morpho && markets.length > 0;
  if (useCollateral) {
    const morpho = new Multicaller(network, provider, morphoAbi, { blockTag: startBlock });
    wanted.forEach(a => markets.forEach(id => morpho.call(`${a}|${id}`, options.morpho as string, 'position', [id, a])));
    for (const [key, pos] of Object.entries(await morpho.execute())) {
      const a = key.split('|')[0];
      const c = BigNumber.from((pos as any)?.collateral ?? (pos as any)?.[2] ?? 0);
      if (!c.isZero()) opening[a] = (opening[a] ?? BigNumber.from(0)).add(c);
    }
  }

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

  // Per-request, so a busy scan narrows its own spans and the next request starts
  // fresh at the full width rather than inheriting this one's worst moment.
  let chunk = LOG_CHUNK_START;

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
        /**
         * Throttling is a pause, and it was fatal here.
         *
         * Raising concurrency makes a 429 likelier, and this branch only ever knew how
         * to SPLIT - which does not help, because the span was never the problem - or
         * to rethrow. A throttled scan therefore failed the whole weight read, and the
         * caller cannot tell that from "you hold nothing". Wait and retry the same
         * span instead; the split path below still handles spans that are genuinely
         * too wide.
         */
        if (/rate limit|429|too many requests/i.test(msg)) {
          if (attempt >= 3) throw e;
          await sleep(Math.min(4000, 400 * 2 ** attempt) + Math.floor(Math.random() * 200));
          continue;
        }
        if (!/range|too large|max=|exceeds limit|timed out|timeout/i.test(msg)) throw e;
        chunk = Math.max(LOG_CHUNK_FLOOR, Math.floor(chunk / 2));
        const mid = Math.floor((fromBlock + toBlock) / 2);
        if (mid <= fromBlock) throw e;
        const [a, b] = await Promise.all([getLogs(fromBlock, mid, incoming), getLogs(mid + 1, toBlock, incoming)]);
        return [...a, ...b];
      }
    }
    throw new Error(`eth_getLogs failed for ${fromBlock}-${toBlock}`);
  };

  const spans: Array<[number, number, boolean]> = [];
  for (let from = startBlock + 1; from <= endBlock; from += chunk) {
    const to = Math.min(from + chunk - 1, endBlock);
    spans.push([from, to, false], [from, to, true]);
  }
  const pages = await mapLimit(spans, LOG_CONCURRENCY, ([from, to, inc]) => getLogs(from, to, inc));

  /**
   * Collateral movements, as deltas on the same timeline as the transfers.
   *
   * Filtered by market AND by holder in the topics, so the node returns only rows
   * that change one of these curves. A liquidation is a subtraction with no matching
   * withdrawal, which is the whole reason it is here.
   */
  const collateralDeltas: Array<{ block: number; logIndex: number; who: string; delta: BigNumber }> = [];
  if (useCollateral) {
    const holders = wanted.map(topicAddress);
    const kinds: Array<[string, number, -1 | 1]> = [
      [SUPPLY_COLLATERAL, 0, 1],
      [WITHDRAW_COLLATERAL, 1, -1],
      [LIQUIDATE, 2, -1]
    ];
    const jobs: Array<[number, number, string, number, -1 | 1]> = [];
    for (let from = startBlock + 1; from <= endBlock; from += chunk) {
      const to = Math.min(from + chunk - 1, endBlock);
      for (const [topic, word, sign] of kinds) jobs.push([from, to, topic, word, sign]);
    }
    const got = await mapLimit(jobs, LOG_CONCURRENCY, async ([from, to, topic, word, sign]) => {
      const rows = await (async function scan(a: number, b: number): Promise<any[]> {
        try {
          return await provider.getLogs({
            address: options.morpho,
            fromBlock: a,
            toBlock: b,
            topics: [topic, markets, null, holders]
          });
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          if (!/range|too large|max=|exceeds limit|timed out|timeout/i.test(msg) || b <= a) throw e;
          const mid = Math.floor((a + b) / 2);
          const [x, y] = await Promise.all([scan(a, mid), scan(mid + 1, b)]);
          return [...x, ...y];
        }
      })(from, to);
      return rows.map(l => {
        const d = String(l.data).slice(2);
        // Supply: [assets]. Withdraw: [receiver, assets]. Liquidate: seizedAssets is word 2.
        const raw = d.slice(word * 64, word * 64 + 64);
        return {
          block: Number(l.blockNumber),
          logIndex: Number(l.logIndex),
          who: fromTopic(l.topics[3]),
          delta: BigNumber.from('0x' + (raw || '0')).mul(sign)
        };
      });
    });
    for (const page of got) for (const row of page) collateralDeltas.push(row);
  }
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

  /**
   * Timestamps for the blocks the events landed in.
   *
   * This was one getBlock per distinct block, twenty at a time, and the cost therefore
   * scaled with how ACTIVE the wallet is rather than with the window. A holder with
   * 12,866 transfers inside a four-day ballot needs 644 sequential rounds — about 64
   * seconds — so it died on the edge's 60s cutoff every time, while a wallet with
   * three transfers scored fine. Measured on the live scorer:
   *
   *   3 transfers       23.75s  ok
   *   20 transfers       6.73s  ok
   *   2,458 transfers   60.6s   dead
   *   12,866 transfers  60.5s   dead
   *
   * The people it refused were exactly the ones who trade the token and are most
   * likely to vote, and because a bloc weight is never cached, the sequencer rejects
   * the vote outright rather than merely failing to display a number.
   *
   * Two changes. The page is wider, which keeps timestamps EXACT for all but the most
   * extreme wallets; and past that, timestamps come from a fixed ladder of anchors and
   * linear interpolation between them, which is bounded no matter how active the
   * wallet is. The ladder depends only on the window — never on the wallet, the
   * caller, or the time of day — so two people scoring the same ballot read the same
   * anchors and recompute the same weight, which is the property this whole strategy
   * exists to provide.
   */
  const blocks = [
    ...new Set([
      ...events.map(e => e.blockNumber as number),
      ...collateralDeltas.map(d => d.block)
    ])
  ].sort((a, b) => a - b);

  const stamps = new Map<number, number>();
  const readStamps = async (want: number[]) => {
    for (let i = 0; i < want.length; i += STAMP_CONCURRENCY) {
      const page = want.slice(i, i + STAMP_CONCURRENCY);
      const got = await Promise.all(page.map(b => provider.getBlock(b)));
      page.forEach((b, j) => stamps.set(b, got[j].timestamp));
    }
  };

  if (blocks.length <= EXACT_STAMP_BLOCKS) {
    await readStamps(blocks);
  } else {
    // A ladder across the window at a fixed stride, plus the two ends, so every event
    // block is bracketed. Anchors are a function of [startBlock, endBlock] alone.
    const stride = Math.max(1, Math.ceil((endBlock - startBlock) / STAMP_ANCHORS));
    const anchors: number[] = [];
    for (let b = startBlock; b < endBlock; b += stride) anchors.push(b);
    anchors.push(endBlock);
    await readStamps(anchors);

    const ladder = anchors.slice().sort((a, b) => a - b);
    const at = (block: number): number => {
      if (stamps.has(block)) return stamps.get(block) as number;
      // Bracket by binary search, then interpolate on block number. RHC produces
      // blocks at a near-constant rate, so within one stride this is accurate to a
      // few seconds against a window measured in days.
      let lo = 0;
      let hi = ladder.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (ladder[mid] <= block) lo = mid;
        else hi = mid;
      }
      const a = ladder[lo];
      const b = ladder[hi];
      const ta = stamps.get(a) as number;
      const tb = stamps.get(b) as number;
      if (b === a) return ta;
      return Math.round(ta + ((tb - ta) * (block - a)) / (b - a));
    };
    for (const b of blocks) stamps.set(b, at(b));
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
  /**
   * Collateral movements, applied on the same timeline as the transfers.
   *
   * Replayed after the transfer walk rather than interleaved with it because the two
   * touch disjoint quantities — a transfer moves what is in the wallet, a collateral
   * event moves what Morpho holds — so the order between them within a block cannot
   * change either running total. What DOES matter is that each is applied at its own
   * timestamp, which `advance` handles, and that both cut at `endTs`.
   *
   * The negative check is deliberately softer here than for transfers. A liquidation
   * and a withdrawal can settle in the same block, and the seized amount is reported
   * against the borrower while the withdrawal is reported against onBehalf; clamping
   * at zero costs a holder nothing they are owed and refuses to invent weight, which
   * is the right way round for a number somebody is about to vote with.
   */
  for (const d of collateralDeltas.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
    if (!index.has(d.who)) continue;
    const at = stamps.get(d.block) ?? startTs;
    if (at > endTs) continue;
    advance(d.who, at);
    const after = (balance.get(d.who) as BigNumber).add(d.delta);
    balance.set(d.who, after.isNegative() ? BigNumber.from(0) : after);
  }

  wanted.forEach(a => advance(a, endTs));

  return Object.fromEntries(
    wanted.map(a => [
      a,
      parseFloat(formatUnits(integrate(segments.get(a) as Segment[], totalSeconds), options.decimals))
    ])
  );
}
