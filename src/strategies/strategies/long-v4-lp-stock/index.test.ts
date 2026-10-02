// Mock dependencies before importing the strategy
const mockMulticaller = {
  call: jest.fn(),
  execute: jest.fn()
};

jest.mock('../../utils', () => ({
  Multicaller: jest.fn().mockImplementation(() => mockMulticaller)
}));

import { BigNumber } from '@ethersproject/bignumber';
import {
  amountsForLiquidity,
  decodeSlot0,
  getSqrtRatioAtTick,
  poolIdOf,
  poolStateSlot,
  strategy
} from './index';

const POSITION_MANAGER = '0x58daec3116aae6D93017bAAea7749052E8a04fA7';
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const OTHER = '0x42bcdf8d4116545d04dd5b76f48b614450f18b1b';
const LP = '0x9701fb0aDE1e269c8f64Ec0C7B3CFadb31a13a52';
const STRANGER = '0x000000000000000000000000000000000000dEaD';

/**
 * Every value here was read from Robinhood Chain for v4 position #1 and its pool. Do not adjust
 * one to make a test pass — re-read the chain instead.
 *
 * The pool is the one behind position 1: WETH/0x42bcdf8d…, fee 3000, tickSpacing 60, no hook.
 * Two independent facts pin the whole decode chain:
 *   - the liquidity in the pool's state slot (+3) is 50,000,000,000,000, which is exactly what
 *     getPositionLiquidity(1) returns from the PositionManager — two different contracts, two
 *     different storage layouts, one number;
 *   - sqrtRatioAtTick(47926) <= sqrtPriceX96 < sqrtRatioAtTick(47927), so the tick the pool
 *     reports really does bracket the price the pool reports.
 */
const CHAIN = {
  poolKey: { currency0: WETH, currency1: OTHER, fee: 3000, tickSpacing: 60, hooks: `0x${'0'.repeat(40)}` },
  poolId: '0xdb2c20421239d46bb30a7a73029b7f9b7f166489bfb972057d33cbd7249413a5',
  /** The upper 200 bits of poolId, as the PositionManager packs them. */
  packedPoolId: '0xdb2c20421239d46bb30a7a73029b7f9b7f166489bfb972057d',
  sqrtPriceX96: '870035308126306014629383180975',
  tick: 47926,
  liquidity: '50000000000000',
  tickLower: -887220,
  tickUpper: 887220
};

/** The packed positionInfo word for position 1, verbatim from getPoolAndPositionInfo(1). */
const PACKED_INFO = '0xdb2c20421239d46bb30a7a73029b7f9b7f166489bfb972057d0d89b4f2764c00';

/** slot0 as the chain packs it: sqrtPriceX96 in the low 160 bits, tick in the next 24. */
const slot0Word = (sqrtPriceX96: string, tick: number): string => {
  const t = BigNumber.from(tick < 0 ? tick + 0x1000000 : tick);
  return BigNumber.from(sqrtPriceX96).add(t.shl(160)).toHexString();
};

describe('poolId and state-slot derivation', () => {
  /**
   * The single most dangerous value in this strategy. The PositionManager's packed word holds only
   * the UPPER 200 BITS of the poolId, so using it as the id reads a different pool's storage —
   * which does not fail, it returns a plausible price for the wrong market.
   */
  it('derives the full poolId, and the packed word is only its top 200 bits', () => {
    const id = poolIdOf(CHAIN.poolKey);
    expect(id).toBe(CHAIN.poolId);
    expect(BigNumber.from(id).shr(56).toHexString()).toBe(CHAIN.packedPoolId);
    // The truncated form is NOT the id.
    expect(CHAIN.packedPoolId).not.toBe(CHAIN.poolId);
  });

  it('derives the pool state slot the way StateLibrary does', () => {
    // POOLS_SLOT = 6, confirmed on chain: this slot yields the live price and the +3 word yields
    // the same liquidity the PositionManager reports.
    expect(poolStateSlot(CHAIN.poolId)).toMatch(/^0x[0-9a-f]{64}$/);
    // Different pools must never share a slot.
    const other = poolIdOf({ ...CHAIN.poolKey, fee: 500 });
    expect(poolStateSlot(other)).not.toBe(poolStateSlot(CHAIN.poolId));
  });

  it('unpacks slot0 into the live price and tick', () => {
    const { sqrtPriceX96, tick } = decodeSlot0(slot0Word(CHAIN.sqrtPriceX96, CHAIN.tick));
    expect(sqrtPriceX96.toString()).toBe(CHAIN.sqrtPriceX96);
    expect(tick).toBe(CHAIN.tick);
  });

  it('unpacks a NEGATIVE tick, which a two’s-complement slip would get wrong', () => {
    const { tick } = decodeSlot0(slot0Word('79228162514264337593543950336', -47926));
    expect(tick).toBe(-47926);
  });
});

describe('TickMath matches the chain', () => {
  // The three values Uniswap itself publishes as constants.
  it('reproduces the reference ratios exactly', () => {
    expect(getSqrtRatioAtTick(0).toString()).toBe('79228162514264337593543950336');
    expect(getSqrtRatioAtTick(-887272).toString()).toBe('4295128739');
    expect(getSqrtRatioAtTick(887272).toString()).toBe(
      '1461446703485210103287273052203988822378723970342'
    );
  });

  /**
   * The cross-check that actually proves the implementation: the tick the live pool reports must
   * bracket the price the live pool reports. A float `Math.pow` version passes the constants above
   * and fails this, because the error only shows up away from the anchors.
   */
  it('brackets the live pool price between tick and tick+1', () => {
    const p = BigNumber.from(CHAIN.sqrtPriceX96);
    expect(getSqrtRatioAtTick(CHAIN.tick).lte(p)).toBe(true);
    expect(getSqrtRatioAtTick(CHAIN.tick + 1).gt(p)).toBe(true);
  });

  it('refuses a tick outside the legal range rather than returning nonsense', () => {
    expect(() => getSqrtRatioAtTick(887273)).toThrow('out of range');
    expect(() => getSqrtRatioAtTick(-887273)).toThrow('out of range');
    expect(() => getSqrtRatioAtTick(1.5)).toThrow('not an integer');
  });

  it('is monotonic across a span, which any transposed constant would break', () => {
    let prev = getSqrtRatioAtTick(-5000);
    for (let t = -4900; t <= 5000; t += 100) {
      const cur = getSqrtRatioAtTick(t);
      expect(cur.gt(prev)).toBe(true);
      prev = cur;
    }
  });
});

describe('amountsForLiquidity', () => {
  const A = getSqrtRatioAtTick(-60);
  const B = getSqrtRatioAtTick(60);

  it('is entirely currency1 when the price is at or above the band', () => {
    const { amount0, amount1 } = amountsForLiquidity(B, A, B, '1000000');
    expect(amount0.toString()).toBe('0');
    expect(amount1.gt(0)).toBe(true);
  });

  it('is entirely currency0 when the price is at or below the band', () => {
    const { amount0, amount1 } = amountsForLiquidity(A, A, B, '1000000');
    expect(amount1.toString()).toBe('0');
    expect(amount0.gt(0)).toBe(true);
  });

  /** Out-of-range prices must CLAMP, not extrapolate — otherwise a far price invents weight. */
  it('clamps rather than extrapolating outside the band', () => {
    const farAbove = amountsForLiquidity(getSqrtRatioAtTick(500000), A, B, '1000000');
    const atTop = amountsForLiquidity(B, A, B, '1000000');
    expect(farAbove.amount0.toString()).toBe(atTop.amount0.toString());
    expect(farAbove.amount1.toString()).toBe(atTop.amount1.toString());
  });

  it('holds both sides inside the band', () => {
    const { amount0, amount1 } = amountsForLiquidity(getSqrtRatioAtTick(0), A, B, '1000000');
    expect(amount0.gt(0)).toBe(true);
    expect(amount1.gt(0)).toBe(true);
  });

  it('is linear in liquidity, and zero liquidity is zero', () => {
    const one = amountsForLiquidity(getSqrtRatioAtTick(0), A, B, '1000000');
    const ten = amountsForLiquidity(getSqrtRatioAtTick(0), A, B, '10000000');
    // Exact within the floor of integer division.
    expect(ten.amount1.sub(one.amount1.mul(10)).abs().lte(10)).toBe(true);
    const none = amountsForLiquidity(getSqrtRatioAtTick(0), A, B, '0');
    expect(none.amount0.toString()).toBe('0');
    expect(none.amount1.toString()).toBe('0');
  });

  it('does not care which way round the band is given', () => {
    const fwd = amountsForLiquidity(getSqrtRatioAtTick(0), A, B, '1000000');
    const rev = amountsForLiquidity(getSqrtRatioAtTick(0), B, A, '1000000');
    expect(rev.amount0.toString()).toBe(fwd.amount0.toString());
    expect(rev.amount1.toString()).toBe(fwd.amount1.toString());
  });
});

describe('strategy', () => {
  const base = {
    stock: OTHER,
    decimals: 18,
    positionManager: POSITION_MANAGER,
    poolManager: POOL_MANAGER,
    positions: ['1']
  };

  const firstRound = (owner = LP) => ({
    [`owner:1`]: owner,
    [`info:1`]: { poolKey: CHAIN.poolKey, info: BigNumber.from(PACKED_INFO) },
    [`liq:1`]: BigNumber.from(CHAIN.liquidity)
  });

  const secondRound = () => ({
    [CHAIN.poolId]: slot0Word(CHAIN.sqrtPriceX96, CHAIN.tick)
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockMulticaller.execute.mockReset();
  });

  it('requires the stock parameter', async () => {
    await expect(
      strategy('s', '4663', {}, [LP], { ...base, stock: '' } as any, 1)
    ).rejects.toThrow('stock parameter is required');
  });

  it('credits the LP owner with the stock side of the position', async () => {
    mockMulticaller.execute
      .mockResolvedValueOnce(firstRound())
      .mockResolvedValueOnce(secondRound());

    const res = await strategy('s', '4663', {}, [LP], base, 77_000_000);
    expect(Object.keys(res)).toEqual([LP]);
    expect(res[LP]).toBeGreaterThan(0);
  });

  /**
   * The pool is WETH/OTHER. Voting an OTHER ballot must credit the OTHER side; voting a WETH
   * ballot must credit the WETH side. Taking the wrong side is not a small error — the two
   * amounts differ by the pool price, which for a concentrated position is orders of magnitude.
   */
  it('credits currency0 or currency1 according to which is the stock', async () => {
    mockMulticaller.execute.mockResolvedValueOnce(firstRound()).mockResolvedValueOnce(secondRound());
    const asOther = await strategy('s', '4663', {}, [LP], base, 77_000_000);

    mockMulticaller.execute.mockResolvedValueOnce(firstRound()).mockResolvedValueOnce(secondRound());
    const asWeth = await strategy('s', '4663', {}, [LP], { ...base, stock: WETH }, 77_000_000);

    expect(asOther[LP]).toBeGreaterThan(0);
    expect(asWeth[LP]).toBeGreaterThan(0);
    expect(asOther[LP]).not.toBe(asWeth[LP]);
  });

  it('ignores a pool that does not contain the stock at all', async () => {
    mockMulticaller.execute.mockResolvedValueOnce(firstRound()).mockResolvedValueOnce(secondRound());
    const res = await strategy(
      's',
      '4663',
      {},
      [LP],
      { ...base, stock: '0x1111111111111111111111111111111111111111' },
      77_000_000
    );
    expect(res[LP]).toBe(0);
  });

  /** A position held by someone not on the ballot must not leak weight to a voter. */
  it('ignores a position owned by a non-voter', async () => {
    mockMulticaller.execute
      .mockResolvedValueOnce(firstRound(STRANGER))
      .mockResolvedValueOnce(secondRound());
    const res = await strategy('s', '4663', {}, [LP], base, 77_000_000);
    expect(res[LP]).toBe(0);
    expect(res[STRANGER]).toBeUndefined();
  });

  it('scores every voter, including those with no position, as a measured zero', async () => {
    mockMulticaller.execute.mockResolvedValueOnce(firstRound()).mockResolvedValueOnce(secondRound());
    const res = await strategy('s', '4663', {}, [LP, STRANGER], base, 77_000_000);
    expect(res[STRANGER]).toBe(0);
    expect(res[LP]).toBeGreaterThan(0);
  });

  it('returns zeros without any chain read when no positions are given', async () => {
    const res = await strategy('s', '4663', {}, [LP], { ...base, positions: [] }, 77_000_000);
    expect(res).toEqual({ [LP]: 0 });
    expect(mockMulticaller.execute).not.toHaveBeenCalled();
  });

  it('skips a position whose liquidity is zero', async () => {
    mockMulticaller.execute
      .mockResolvedValueOnce({ ...firstRound(), 'liq:1': BigNumber.from(0) })
      .mockResolvedValueOnce(secondRound());
    const res = await strategy('s', '4663', {}, [LP], base, 77_000_000);
    expect(res[LP]).toBe(0);
  });

  /** An uninitialised pool has sqrtPriceX96 == 0 and holds nothing; it must not divide by zero. */
  it('skips an uninitialised pool rather than throwing', async () => {
    mockMulticaller.execute
      .mockResolvedValueOnce(firstRound())
      .mockResolvedValueOnce({ [CHAIN.poolId]: '0x0' });
    const res = await strategy('s', '4663', {}, [LP], base, 77_000_000);
    expect(res[LP]).toBe(0);
  });

  it('resolves a string snapshot to a block before reading anything', async () => {
    const provider = { getBlockNumber: jest.fn().mockResolvedValue(77_123_456) };
    mockMulticaller.execute.mockResolvedValueOnce(firstRound()).mockResolvedValueOnce(secondRound());
    await strategy('s', '4663', provider, [LP], base, 'latest');
    expect(provider.getBlockNumber).toHaveBeenCalled();
    // 'latest' must never reach the Multicaller: it pages concurrently and each page would
    // re-resolve it, so an ownership transfer between pages would be scored on both sides.
    const { Multicaller } = jest.requireMock('../../utils');
    for (const call of (Multicaller as jest.Mock).mock.calls) {
      expect(call[3]).toEqual({ blockTag: 77_123_456 });
    }
  });

  it('sums several positions for one owner', async () => {
    mockMulticaller.execute
      .mockResolvedValueOnce({
        ...firstRound(),
        'owner:2': LP,
        'info:2': { poolKey: CHAIN.poolKey, info: BigNumber.from(PACKED_INFO) },
        'liq:2': BigNumber.from(CHAIN.liquidity)
      })
      .mockResolvedValueOnce(secondRound());
    const two = await strategy('s', '4663', {}, [LP], { ...base, positions: ['1', '2'] }, 77_000_000);

    mockMulticaller.execute.mockResolvedValueOnce(firstRound()).mockResolvedValueOnce(secondRound());
    const one = await strategy('s', '4663', {}, [LP], base, 77_000_000);

    expect(two[LP]).toBeCloseTo(one[LP] * 2, 6);
  });
});
