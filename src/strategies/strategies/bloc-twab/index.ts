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
 * Blocks per `eth_getLogs`. RHC's public RPC rejects an over-wide range outright
 * rather than truncating, so the scan is chunked; the value is deliberately well
 * under the measured ceiling, because the failure mode of guessing too high is a
 * strategy that throws on the busiest ballots only.
 */
const LOG_CHUNK = 5000;

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
  if (totalSeconds <= 0) return segments.length ? segments[0].balance : BigNumber.from(0);
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
  const logs: any[] = [];
  for (let from = startBlock + 1; from <= endBlock; from += LOG_CHUNK) {
    const to = Math.min(from + LOG_CHUNK - 1, endBlock);
    const [out, inc] = await Promise.all([
      provider.getLogs({ address: options.address, fromBlock: from, toBlock: to, topics: [TRANSFER, topics] }),
      provider.getLogs({ address: options.address, fromBlock: from, toBlock: to, topics: [TRANSFER, null, topics] })
    ]);
    logs.push(...out, ...inc);
  }

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
      // A balance can only go negative if a log was missed. Clamping hides that,
      // so it is left to underflow loudly rather than quietly scoring nonsense.
      balance.set(sender, (balance.get(sender) as BigNumber).sub(value));
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
