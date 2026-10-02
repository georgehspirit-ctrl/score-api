import { defaultAbiCoder } from '@ethersproject/abi';
import { getAddress } from '@ethersproject/address';
import { BigNumber, BigNumberish } from '@ethersproject/bignumber';
import { keccak256 } from '@ethersproject/keccak256';
import { formatUnits } from '@ethersproject/units';
import { Multicaller } from '../../utils';

/**
 * Uniswap v4 LP voting power — the Stock Token actually inside the position.
 *
 * A holder who provides liquidity in a Long.xyz pool no longer holds the stock token in their
 * wallet: the PoolManager does. `balanceOf` returns nothing for them, so before this they had no
 * voting weight at all — despite the shares being theirs, withdrawable at will, and exposed to
 * exactly the corporate action being voted on. This is the same gap `rhj-share-balance` closed for
 * Morpho collateral, and the argument is the same one: posting an asset somewhere does not stop
 * you owning it.
 *
 * ── THE METHOD, PUBLISHED ──────────────────────────────────────────────────────────────────────
 *
 * For each position id, at the record block:
 *
 *   1. `getPoolAndPositionInfo(tokenId)` on the PositionManager returns the PoolKey
 *      (currency0, currency1, fee, tickSpacing, hooks) and a packed word carrying tickLower and
 *      tickUpper.
 *   2. The pool is skipped unless currency0 or currency1 IS the stock token being voted. A Long
 *      pool pairs a launched token against a numeraire; only the numeraire side is a share.
 *   3. `poolId = keccak256(abi.encode(PoolKey))`. Verified against chain: for position 1 the
 *      computed id is 0xdb2c…13a5 and the PositionManager's packed word carries
 *      0xdb2c20421239d46bb30a7a73029b7f9b7f166489bfb972057d, which is exactly its upper 200 bits.
 *      The packed word is NOT used as the id — it is truncated and would read the wrong pool.
 *   4. `getSlot0(poolId)` on the PoolManager gives sqrtPriceX96 at that block.
 *   5. `getPositionLiquidity(tokenId)` gives L.
 *   6. The stock-token amount is the standard constant-product band integral, in exact integer
 *      arithmetic, with the three cases decided by where the price sits relative to the band:
 *
 *        price below the band   the position is entirely currency0
 *        price above the band   the position is entirely currency1
 *        price inside the band  it holds both, split at the current price
 *
 *      amount0 = L·2^96·(sqrtB − sqrtP) / (sqrtP·sqrtB)        amount1 = L·(sqrtP − sqrtA) / 2^96
 *
 *      with sqrtP clamped into [sqrtA, sqrtB] so the in-range formulas degenerate correctly to the
 *      out-of-range ones and no branch can produce a negative.
 *   7. `ownerOf(tokenId)` at the same block is credited. The owner is read AT the record block,
 *      never at head: an NFT that changed hands after the record date must score to whoever held
 *      it on the record date, exactly as a transferred share would.
 *
 * FEES ARE NOT COUNTED. Uncollected fees sit outside the liquidity band and are not share
 * exposure until collected; counting them would credit weight for a quantity that no corporate
 * action touches. Only principal inside the band is scored.
 *
 * ── WHY POSITIONS ARE PASSED IN ────────────────────────────────────────────────────────────────
 *
 * The v4 PositionManager is NOT enumerable. `tokenOfOwnerByIndex` reverts and
 * `supportsInterface(0x780e9d63)` is false, so there is no way to ask the chain which positions an
 * address holds — only `balanceOf`, which gives a count and no ids. The alternatives are scanning
 * 3.5M `Transfer` logs on every scoring call, or freezing the ids into the proposal.
 *
 * Freezing them is both cheaper and more honest, and it is the same decision `rhj-share-balance`
 * made for Morpho market ids: the ballot then states exactly which positions were counted and a
 * reader can check each one, rather than trusting a list that could change under them. The cost is
 * that a position opened after the ballot is not in it — which is the correct behaviour anyway,
 * since weight is a fact about the record block.
 */

const positionManagerAbi = [
  'function getPoolAndPositionInfo(uint256 tokenId) external view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) external view returns (uint128 liquidity)',
  'function ownerOf(uint256 tokenId) external view returns (address)'
];

/**
 * The PoolManager exposes `extsload` and NOTHING ELSE for reading pool state.
 *
 * `getSlot0(bytes32)` does not exist on it — that name is a helper in Uniswap's off-chain
 * `StateLibrary`, not a function on the contract. Calling it reverts, which is how this was
 * caught: the first version of this strategy asked for `getSlot0` and got `execution reverted`
 * on a pool that is perfectly healthy.
 *
 * So the price is read from raw storage, and the slot is derived the way StateLibrary derives it.
 */
const poolManagerAbi = [
  'function extsload(bytes32 slot) external view returns (bytes32)'
];

/**
 * `PoolManager._pools` lives at storage slot 6.
 *
 * VERIFIED ON CHAIN rather than taken from a header. With POOLS_SLOT = 6 the derived slot yields
 * sqrtPriceX96 870035308126306014629383180975 at tick 47926 for the pool behind position 1, and
 * two independent checks confirm it: `sqrtRatioAtTick(47926) <= sqrtPriceX96 < sqrtRatioAtTick(47927)`,
 * and the word at `slot + 3` is 50,000,000,000,000, which is exactly what
 * `getPositionLiquidity(1)` returns from the PositionManager. A wrong slot constant would give a
 * zero or a nonsense price, and a nonsense price silently mis-splits every position in the pool.
 */
const POOLS_SLOT = 6;

/** `keccak256(abi.encode(poolId, POOLS_SLOT))` — where a pool's state begins. */
export function poolStateSlot(poolId: string): string {
  return keccak256(
    defaultAbiCoder.encode(['bytes32', 'uint256'], [poolId, POOLS_SLOT])
  );
}

/** Slot0 packs sqrtPriceX96 into the low 160 bits and the current tick into the next 24. */
export function decodeSlot0(word: BigNumberish): {
  sqrtPriceX96: BigNumber;
  tick: number;
} {
  const v = BigNumber.from(word);
  const sqrtPriceX96 = v.and(BigNumber.from(2).pow(160).sub(1));
  const raw = v.shr(160).and(0xffffff).toNumber();
  return { sqrtPriceX96, tick: raw >= 0x800000 ? raw - 0x1000000 : raw };
}

const Q96 = BigNumber.from(2).pow(96);

/** Uniswap v4 tick bounds. */
const MIN_TICK = -887272;
const MAX_TICK = 887272;

/**
 * sqrt(1.0001^tick) · 2^96, exactly as Uniswap's TickMath computes it on chain.
 *
 * Reimplemented rather than approximated with `Math.pow`. A float pow is wrong in the last several
 * digits, and the error does not stay small: it multiplies by L, which for a concentrated position
 * is enormous, so a 1e-12 relative error on the price becomes whole tokens of voting weight. The
 * magic constants below are the on-chain ones; they are a fixed-point representation of
 * 1.0001^(-2^i) and must not be "tidied".
 */
export function getSqrtRatioAtTick(tick: number): BigNumber {
  if (!Number.isInteger(tick))
    throw new Error(`tick ${tick} is not an integer`);
  if (tick < MIN_TICK || tick > MAX_TICK)
    throw new Error(`tick ${tick} is out of range`);

  const absTick = Math.abs(tick);
  let ratio = BigNumber.from(
    (absTick & 0x1) !== 0
      ? '0xfffcb933bd6fad37aa2d162d1a594001'
      : '0x100000000000000000000000000000000'
  );
  const muls: [number, string][] = [
    [0x2, '0xfff97272373d413259a46990580e213a'],
    [0x4, '0xfff2e50f5f656932ef12357cf3c7fdcc'],
    [0x8, '0xffe5caca7e10e4e61c3624eaa0941cd0'],
    [0x10, '0xffcb9843d60f6159c9db58835c926644'],
    [0x20, '0xff973b41fa98c081472e6896dfb254c0'],
    [0x40, '0xff2ea16466c96a3843ec78b326b52861'],
    [0x80, '0xfe5dee046a99a2a811c461f1969c3053'],
    [0x100, '0xfcbe86c7900a88aedcffc83b479aa3a4'],
    [0x200, '0xf987a7253ac413176f2b074cf7815e54'],
    [0x400, '0xf3392b0822b70005940c7a398e4b70f3'],
    [0x800, '0xe7159475a2c29b7443b29c7fa6e889d9'],
    [0x1000, '0xd097f3bdfd2022b8845ad8f792aa5825'],
    [0x2000, '0xa9f746462d870fdf8a65dc1f90e061e5'],
    [0x4000, '0x70d869a156d2a1b890bb3df62baf32f7'],
    [0x8000, '0x31be135f97d08fd981231505542fcfa6'],
    [0x10000, '0x9aa508b5b7a84e1c677de54f3e99bc9'],
    [0x20000, '0x5d6af8dedb81196699c329225ee604'],
    [0x40000, '0x2216e584f5fa1ea926041bedfe98'],
    [0x80000, '0x48a170391f7dc42444e8fa2']
  ];
  for (const [bit, hex] of muls) {
    if ((absTick & bit) !== 0) ratio = ratio.mul(hex).shr(128);
  }

  if (tick > 0) {
    // The on-chain code divides 2^256-1 by the ratio; replicate exactly.
    ratio = BigNumber.from(
      '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    ).div(ratio);
  }

  // Q128.128 -> Q96, rounding UP, matching TickMath's `(ratio >> 32) + (ratio % (1<<32) == 0 ? 0 : 1)`.
  const shifted = ratio.shr(32);
  const rem = ratio.sub(shifted.shl(32));
  return rem.isZero() ? shifted : shifted.add(1);
}

/**
 * The amount of currency0 and currency1 a position of `liquidity` holds, at `sqrtPriceX96`.
 *
 * Exact integer arithmetic throughout. `sqrtP` is clamped into the band first, which makes the
 * three price cases one formula: below the band both clamps collapse amount1 to zero, above it
 * they collapse amount0 to zero, and inside nothing is clamped.
 */
export function amountsForLiquidity(
  sqrtPriceX96: BigNumberish,
  sqrtRatioAX96: BigNumberish,
  sqrtRatioBX96: BigNumberish,
  liquidity: BigNumberish
): { amount0: BigNumber; amount1: BigNumber } {
  let a = BigNumber.from(sqrtRatioAX96);
  let b = BigNumber.from(sqrtRatioBX96);
  if (a.gt(b)) [a, b] = [b, a];
  const L = BigNumber.from(liquidity);
  let p = BigNumber.from(sqrtPriceX96);
  if (p.lt(a)) p = a;
  if (p.gt(b)) p = b;

  // amount0 = L·2^96·(b − p) / (p·b)   — zero when p == b
  const amount0 =
    p.isZero() || b.isZero()
      ? BigNumber.from(0)
      : L.mul(Q96).mul(b.sub(p)).div(b.mul(p));
  // amount1 = L·(p − a) / 2^96        — zero when p == a
  const amount1 = L.mul(p.sub(a)).div(Q96);
  return { amount0, amount1 };
}

/** `keccak256(abi.encode(PoolKey))`, which is what PoolManager keys its state by. */
export function poolIdOf(key: {
  currency0: string;
  currency1: string;
  fee: BigNumberish;
  tickSpacing: BigNumberish;
  hooks: string;
}): string {
  return keccak256(
    defaultAbiCoder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}

/** Sign-extend a 24-bit two's-complement field out of the packed position word. */
const int24 = (v: BigNumber): number => {
  const raw = v.and(0xffffff).toNumber();
  return raw >= 0x800000 ? raw - 0x1000000 : raw;
};

export async function strategy(
  space: string,
  network: string,
  provider: any,
  addresses: string[],
  options: {
    /** The stock token whose ballot this is. Only this side of a pool is counted. */
    stock: string;
    decimals: number;
    symbol?: string;
    /** v4 PositionManager. Defaults to the Robinhood Chain deployment. */
    positionManager?: string;
    /** v4 PoolManager. Defaults to the Robinhood Chain deployment. */
    poolManager?: string;
    /** Position token ids to count. Frozen into the proposal — see the note above. */
    positions: (string | number)[];
  },
  snapshot: string | number
): Promise<Record<string, number>> {
  if (!options.stock) throw new Error('stock parameter is required');

  // Resolve 'latest' to a height ONCE. Every read below — owner, pool key, liquidity and price —
  // has to describe the same instant, and multicall pages concurrently with each page re-resolving
  // a literal 'latest' against its own head. A position whose owner or liquidity changes between
  // two pages would otherwise be scored half before and half after.
  const blockTag =
    typeof snapshot === 'number' ? snapshot : await provider.getBlockNumber();

  const positionManager = getAddress(
    options.positionManager ?? '0x58daec3116aae6D93017bAAea7749052E8a04fA7'
  );
  const poolManager = getAddress(
    options.poolManager ?? '0x8366a39CC670B4001A1121B8F6A443A643e40951'
  );
  const stock = getAddress(options.stock);

  const ids = (options.positions ?? []).map(id =>
    BigNumber.from(id).toString()
  );
  const voters = new Set(addresses.map(a => getAddress(a)));
  const result: Record<string, BigNumber> = {};
  for (const a of voters) result[a] = BigNumber.from(0);
  if (!ids.length) {
    return Object.fromEntries(Object.entries(result).map(([a]) => [a, 0]));
  }

  // Round 1: owner, pool key and liquidity for every position, all at the pinned block.
  const pm = new Multicaller(network, provider, positionManagerAbi, {
    blockTag
  });
  for (const id of ids) {
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
    /** Is the stock currency0 (so we want amount0) or currency1? */
    stockIsZero: boolean;
  };
  const live: Live[] = [];

  for (const id of ids) {
    const owner = first[`owner:${id}`];
    if (!owner) continue;
    const ownerAddr = getAddress(owner);
    // Only positions held by someone on the ballot can contribute. Reading the rest would be
    // work for nothing, and crediting them would be weight for a non-voter.
    if (!voters.has(ownerAddr)) continue;

    const infoTuple = first[`info:${id}`];
    const key = infoTuple?.poolKey ?? infoTuple?.[0];
    const packed = BigNumber.from(infoTuple?.info ?? infoTuple?.[1] ?? 0);
    if (!key) continue;

    const c0 = getAddress(key.currency0 ?? key[0]);
    const c1 = getAddress(key.currency1 ?? key[1]);
    const stockIsZero = c0 === stock;
    // A pool that does not contain this stock is not evidence about this ballot.
    if (!stockIsZero && c1 !== stock) continue;

    const liquidity = BigNumber.from(first[`liq:${id}`] ?? 0);
    if (liquidity.isZero()) continue;

    live.push({
      owner: ownerAddr,
      liquidity,
      // Packed layout: bits 8..31 tickLower, bits 32..55 tickUpper.
      tickLower: int24(packed.shr(8)),
      tickUpper: int24(packed.shr(32)),
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

  if (!live.length) {
    return Object.fromEntries(Object.entries(result).map(([a]) => [a, 0]));
  }

  // Round 2: the price of each distinct pool, once per pool rather than once per position.
  const pools = [...new Set(live.map(l => l.poolId))];
  const pmgr = new Multicaller(network, provider, poolManagerAbi, { blockTag });
  for (const id of pools)
    pmgr.call(id, poolManager, 'extsload', [poolStateSlot(id)]);
  const slots: Record<string, any> = await pmgr.execute();

  for (const l of live) {
    const word = slots[l.poolId];
    if (word === undefined || word === null) continue;
    const { sqrtPriceX96 } = decodeSlot0(word);
    // A pool with no price has never been initialised; it holds nothing to credit.
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

  // parseFloat is the single lossy step, as in every balance strategy here: Snapshot scores are JS
  // numbers and the whole pipeline downstream is float, so anything wider is discarded. The
  // multiply/divide above is exact 256-bit integer arithmetic, which is the part that matters —
  // doing the band maths in floating point compounds error against L and can move a large position
  // by whole tokens.
  return Object.fromEntries(
    Object.entries(result).map(([address, amount]) => [
      address,
      parseFloat(formatUnits(amount, options.decimals))
    ])
  );
}
