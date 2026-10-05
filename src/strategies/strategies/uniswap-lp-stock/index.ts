import { getAddress } from '@ethersproject/address';
import { BigNumber } from '@ethersproject/bignumber';
import { formatUnits } from '@ethersproject/units';
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { Multicaller } from '../../utils';
import {
  amountsForLiquidity,
  decodeSlot0,
  decodeTicks,
  getSqrtRatioAtTick,
  poolIdOf,
  poolStateSlot
} from '../long-v4-lp-stock';

/**
 * Uniswap LP voting power — the stock token actually inside a holder's position, found
 * automatically, for EVERY pool, not a hand-listed few.
 *
 * The announcement this makes true: "OnRecord counts Uniswap LP positions. The stock in your
 * position is your voting weight." A holder who LPs a stock no longer holds that stock in their
 * wallet — the PoolManager does — so a wallet-balance strategy credits them nothing, though the
 * shares are theirs and exposed to exactly the corporate action being voted. `long-v4-lp-stock`
 * closed this for Long pools, but its positions are frozen into the proposal by hand because the
 * v4 PositionManager is not enumerable. Hand-listing is not "counts Uniswap LP positions". This
 * finds them.
 *
 * ── WHY THERE IS NO INDEXER, AND WHY THAT IS MORE CORRECT, NOT LESS ─────────────────────────────
 *
 * The brief called for a Postgres indexer because the PositionManager is not enumerable
 * (`tokenOfOwnerByIndex` reverts), so "which positions does this address hold" seemed to need a
 * pre-built owner→id map. It does not. The PositionManager is an ERC-721 and its `Transfer` event
 * has `to` INDEXED, so `eth_getLogs` filtered to `to = voter` returns every position id that voter
 * ever received, straight from the chain, at scoring time. An index can go stale or sit behind the
 * snapshot block ("if head < snapshot, throw"); a live log scan to the snapshot block cannot. So
 * discovery here is on-chain and reproducible, and every number — ownership, liquidity, price — is
 * read at the snapshot block, never from a cache that could disagree with the chain.
 *
 * Discovery can only ADD candidates; it can never inflate a position. A tokenId surfaced by the
 * scan is counted only if `ownerOf(tokenId) == voter` AT the snapshot block and the pool actually
 * contains this stock. A missed tokenId undercounts that one holder; it can never credit weight
 * that is not on the chain.
 *
 * ── THE CHAIN IS v4-ONLY HERE ───────────────────────────────────────────────────────────────────
 *
 * Verified on Robinhood Chain (4663) before writing this: the Uniswap v2 factory address holds no
 * code, and the canonical v3 factory address holds an unrelated contract whose `owner()` reverts
 * and which has emitted zero `PoolCreated` events in the sampled history — while the v4 PoolManager
 * has tens of thousands of `Initialize` events. There is no v2 or v3 Uniswap deployment on this
 * chain, so there are no v2/v3 LP positions to count. If one is ever deployed, a sibling branch is
 * added here; today a v2/v3 path would be dead code pretending the chain has pools it does not.
 *
 * ── THE METHOD, PER VOTER, AT THE SNAPSHOT BLOCK ────────────────────────────────────────────────
 *
 *   1. Discover: `eth_getLogs(PositionManager, Transfer, to=voter)` from genesis to the snapshot
 *      block, in adaptive spans (10M wide, halving on any range/result/timeout complaint — never
 *      skipping a span, because a silently dropped span undercounts and looks exactly like "holds
 *      nothing"). Each log's `topics[3]` is a tokenId the voter received.
 *   2. For every candidate id: `ownerOf`, `getPoolAndPositionInfo`, `getPositionLiquidity` at the
 *      snapshot block. Keep it only if the owner is a voter, the pool's currency0 or currency1 IS
 *      this stock, and liquidity > 0.
 *   3. `poolId = keccak256(abi.encode(PoolKey))`; slot0 via `extsload`; the stock-side amount by
 *      the exact constant-product band integral. All of steps 2–3 reuse long-v4-lp-stock verbatim.
 *
 * FEES ARE NOT COUNTED — only principal inside the band, the same as long-v4-lp-stock. Uncollected
 * fees are not share exposure until collected.
 *
 * CONTRACT-OWNED POSITIONS GET NOTHING. Only a position whose `ownerOf` is a voting address is
 * credited. Locked launch liquidity and vault-held LP are owned by contracts, which do not vote, so
 * they score zero here — unless such a contract is itself wired as a counted venue, and none is. A
 * voter's wallet balance and their LP weight therefore never double-count: the stock in the pool is
 * held by the PoolManager, not in the wallet the balance strategy reads.
 */

const positionManagerAbi = [
  'function getPoolAndPositionInfo(uint256 tokenId) external view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) external view returns (uint128 liquidity)',
  'function ownerOf(uint256 tokenId) external view returns (address)'
];

const poolManagerAbi = [
  'function extsload(bytes32 slot) external view returns (bytes32)'
];

/** ERC-721 / ERC-20 Transfer. On the ERC-721 PositionManager all three args are indexed, so the
 *  tokenId is topics[3] and the recipient is topics[2]. */
const TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const PM_DEFAULT = '0x58daec3116aae6D93017bAAea7749052E8a04fA7';
const POOLMGR_DEFAULT = '0x8366a39CC670B4001A1121B8F6A443A643e40951';

/**
 * The endpoint discovery logs are read from.
 *
 * NOT, by default, the provider snapshot hands in: on Robinhood Chain the Tenderly gateway answers
 * a wide `eth_getLogs` with FEWER logs than a sub-range of it and no error (measured in bloc-twab:
 * 14 where a 1M subset returns 12,203). A discovery scan that trusts that silently misses positions
 * and undercounts a holder. `rpc.mainnet.chain.robinhood.com` instead ERRORS at its 10M-block cap,
 * which the adaptive splitter below turns into correct narrower spans. Overridable, so a future safe
 * endpoint can be swapped in without a code change.
 */
const DEFAULT_LOG_RPC = 'https://rpc.mainnet.chain.robinhood.com';

/** 10M is this endpoint's hard span cap; it errors above it rather than truncating, so the splitter
 *  can react. The floor stops a pathological range-complaint from recursing to single blocks. */
const LOG_CHUNK_START = 10_000_000;
const LOG_CHUNK_FLOOR = 50_000;
/** Concurrency across (voter × span). 8 keeps a multi-voter ballot fast without tripping the
 *  endpoint's throttle, which — measured in bloc-twab — makes a 32-way scan SLOWER, not faster. */
const LOG_CONCURRENCY = 8;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const topicAddress = (a: string) =>
  '0x' + a.toLowerCase().slice(2).padStart(64, '0');

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(
    async () => {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx]);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

/**
 * Every PositionManager tokenId each voter ever received, from genesis to `toBlock`.
 *
 * One `to = voter` filter per voter (NOT an OR-array of all voters: the endpoint drops its span cap
 * from 10M to 100k the moment a topic position carries more than one value — "send one value per
 * position" — which would turn 9 spans into ~800). The result set per voter is small because the
 * filter is selective; the cost is the span count, so wide spans are the whole game.
 */
async function discoverByVoter(
  provider: StaticJsonRpcProvider,
  positionManager: string,
  voters: string[],
  toBlock: number
): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>(voters.map(v => [v, new Set()]));

  let chunk = LOG_CHUNK_START;
  const scan = async (
    voter: string,
    fromBlock: number,
    upto: number
  ): Promise<any[]> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await provider.getLogs({
          address: positionManager,
          fromBlock,
          toBlock: upto,
          topics: [TRANSFER, null, topicAddress(voter)]
        });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        // A pause, not a width problem: wait and retry the same span.
        if (/rate limit|429|too many requests/i.test(msg)) {
          if (attempt >= 3) throw e;
          await sleep(Math.min(4000, 400 * 2 ** attempt) + Math.floor(Math.random() * 200));
          continue;
        }
        // Only a genuine "span too wide / too many results / timed out" is split. Anything else —
        // a dead node, a bad filter — must surface, never be swallowed into an undercount.
        if (!/range|too large|max=|exceeds limit|only .* allowed|timed out|timeout|spans/i.test(msg))
          throw e;
        chunk = Math.max(LOG_CHUNK_FLOOR, Math.floor(chunk / 2));
        const mid = Math.floor((fromBlock + upto) / 2);
        if (mid <= fromBlock) throw e;
        const [a, b] = await Promise.all([
          scan(voter, fromBlock, mid),
          scan(voter, mid + 1, upto)
        ]);
        return [...a, ...b];
      }
    }
    throw new Error(`eth_getLogs failed for ${voter} ${fromBlock}-${upto}`);
  };

  const jobs: Array<[string, number, number]> = [];
  for (const voter of voters) {
    for (let from = 0; from <= toBlock; from += chunk) {
      jobs.push([voter, from, Math.min(from + chunk - 1, toBlock)]);
    }
  }
  const pages = await mapLimit(jobs, LOG_CONCURRENCY, ([voter, from, to]) =>
    scan(voter, from, to).then(logs => ({ voter, logs }))
  );
  for (const { voter, logs } of pages) {
    const set = found.get(voter)!;
    for (const log of logs) set.add(BigNumber.from(log.topics[3]).toString());
  }
  return found;
}

export async function strategy(
  _space: string,
  network: string,
  provider: any,
  addresses: string[],
  options: {
    /** The stock token whose ballot this is. Only this side of a pool is counted. */
    stock: string;
    decimals: number;
    symbol?: string;
    /** v4 PositionManager / PoolManager. Default to the Robinhood Chain deployments. */
    positionManager?: string;
    poolManager?: string;
    /** Override the endpoint discovery logs are read from (see DEFAULT_LOG_RPC). */
    rpcUrl?: string;
  },
  snapshot: string | number
): Promise<Record<string, number>> {
  if (!options.stock) throw new Error('stock parameter is required');

  // Pin the height once. Owner, pool key, liquidity and price must all describe the same instant,
  // and discovery must stop AT the snapshot block — a position received after it is not in scope.
  const blockTag =
    typeof snapshot === 'number' ? snapshot : await provider.getBlockNumber();

  const positionManager = getAddress(options.positionManager ?? PM_DEFAULT);
  const poolManager = getAddress(options.poolManager ?? POOLMGR_DEFAULT);
  const stock = getAddress(options.stock);

  const voters = [...new Set(addresses.map(a => getAddress(a)))];
  const result: Record<string, BigNumber> = {};
  for (const a of voters) result[a] = BigNumber.from(0);
  const zero = () =>
    Object.fromEntries(voters.map(a => [a, 0]));
  if (!voters.length) return {};

  // Discover each voter's positions from the chain, at the snapshot block.
  const logProvider = new StaticJsonRpcProvider(
    {
      url: options.rpcUrl ?? process.env.RPC_URL_LOGS_4663 ?? DEFAULT_LOG_RPC,
      timeout: 60_000
    },
    Number(network)
  );
  const byVoter = await discoverByVoter(
    logProvider,
    positionManager,
    voters,
    blockTag
  );

  const idToVoters = new Map<string, Set<string>>();
  for (const [voter, ids] of byVoter) {
    for (const id of ids) {
      if (!idToVoters.has(id)) idToVoters.set(id, new Set());
      idToVoters.get(id)!.add(voter);
    }
  }
  const allIds = [...idToVoters.keys()];
  if (!allIds.length) return zero();

  // Round 1: owner, pool key, liquidity for every candidate, at the pinned block.
  const pm = new Multicaller(network, provider, positionManagerAbi, { blockTag });
  for (const id of allIds) {
    pm.call(`owner:${id}`, positionManager, 'ownerOf', [id]);
    pm.call(`info:${id}`, positionManager, 'getPoolAndPositionInfo', [id]);
    pm.call(`liq:${id}`, positionManager, 'getPositionLiquidity', [id]);
  }
  const first: Record<string, any> = await pm.execute();

  type Live = {
    owner: string;
    liquidity: BigNumber;
    tickLower: number;
    tickUpper: number;
    poolId: string;
    stockIsZero: boolean;
  };
  const live: Live[] = [];

  for (const id of allIds) {
    const owner = first[`owner:${id}`];
    if (!owner) continue;
    const ownerAddr = getAddress(owner);
    // Ownership at the snapshot block is the arbiter. Discovery found every id the voter ever
    // RECEIVED; only the ones they still hold at the block count, and only for a voter on the ballot.
    if (!result[ownerAddr]) continue;

    const infoTuple = first[`info:${id}`];
    const key = infoTuple?.poolKey ?? infoTuple?.[0];
    const packed = BigNumber.from(infoTuple?.info ?? infoTuple?.[1] ?? 0);
    if (!key) continue;

    const c0 = getAddress(key.currency0 ?? key[0]);
    const c1 = getAddress(key.currency1 ?? key[1]);
    const stockIsZero = c0 === stock;
    if (!stockIsZero && c1 !== stock) continue;

    const liquidity = BigNumber.from(first[`liq:${id}`] ?? 0);
    if (liquidity.isZero()) continue;

    const { tickLower, tickUpper } = decodeTicks(packed);
    live.push({
      owner: ownerAddr,
      liquidity,
      tickLower,
      tickUpper,
      poolId: poolIdOf({
        currency0: c0,
        currency1: c1,
        fee: key.fee ?? key[2],
        tickSpacing: key.tickSpacing ?? key[3],
        hooks: key.hooks ?? key[4]
      }),
      stockIsZero
    });
  }

  if (!live.length) return zero();

  // Round 2: each distinct pool's price once, then the band maths per position.
  const pools = [...new Set(live.map(l => l.poolId))];
  const pmgr = new Multicaller(network, provider, poolManagerAbi, { blockTag });
  for (const id of pools) pmgr.call(id, poolManager, 'extsload', [poolStateSlot(id)]);
  const slots: Record<string, any> = await pmgr.execute();

  for (const l of live) {
    const word = slots[l.poolId];
    if (word === undefined || word === null) continue;
    const { sqrtPriceX96 } = decodeSlot0(word);
    if (sqrtPriceX96.isZero()) continue;

    const { amount0, amount1 } = amountsForLiquidity(
      sqrtPriceX96,
      getSqrtRatioAtTick(l.tickLower),
      getSqrtRatioAtTick(l.tickUpper),
      l.liquidity
    );
    const share = l.stockIsZero ? amount0 : amount1;
    result[l.owner] = (result[l.owner] ?? BigNumber.from(0)).add(share);
  }

  // parseFloat is the single lossy step, as in every balance strategy here. The band maths above is
  // exact 256-bit integer arithmetic; only the final cast to a Snapshot score is float.
  return Object.fromEntries(
    Object.entries(result).map(([address, amount]) => [
      address,
      parseFloat(formatUnits(amount, options.decimals))
    ])
  );
}
