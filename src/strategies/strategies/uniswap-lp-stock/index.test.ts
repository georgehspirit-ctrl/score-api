// Mock the Multicaller (round 1 / round 2 reads) and the discovery provider (Transfer-log scan)
// before importing the strategy. The maths it reuses from long-v4-lp-stock is pure and is NOT
// mocked — those functions are exercised for real against chain-read constants.
const mockMulticaller = {
  call: jest.fn(),
  execute: jest.fn()
};
jest.mock('../../utils', () => ({
  Multicaller: jest.fn().mockImplementation(() => mockMulticaller)
}));

const mockGetLogs = jest.fn();
jest.mock('@ethersproject/providers', () => ({
  StaticJsonRpcProvider: jest.fn().mockImplementation(() => ({
    getLogs: mockGetLogs
  }))
}));

import { BigNumber } from '@ethersproject/bignumber';
import { strategy } from './index';

const POSITION_MANAGER = '0x58daec3116aae6D93017bAAea7749052E8a04fA7';
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const STOCK = '0x42bcDF8d4116545d04dd5b76F48b614450f18B1B';
const LP = '0x9701fb0aDe1E269c8f64Ec0C7b3cfADB31A13A52';
const STRANGER = '0x000000000000000000000000000000000000dEaD';

const TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** All read from Robinhood Chain for v4 position #1 and its pool. See long-v4-lp-stock's test. */
const CHAIN = {
  poolKey: {
    currency0: WETH,
    currency1: STOCK,
    fee: 3000,
    tickSpacing: 60,
    hooks: `0x${'0'.repeat(40)}`
  },
  poolId: '0xdb2c20421239d46bb30a7a73029b7f9b7f166489bfb972057d33cbd7249413a5',
  sqrtPriceX96: '870035308126306014629383180975',
  tick: 47926,
  liquidity: '50000000000000'
};
const PACKED_INFO =
  '0xdb2c20421239d46bb30a7a73029b7f9b7f166489bfb972057d0d89b4f2764c00';

const topicAddress = (a: string) =>
  '0x' + a.toLowerCase().slice(2).padStart(64, '0');
const topicTokenId = (id: string | number) =>
  '0x' + BigNumber.from(id).toHexString().slice(2).padStart(64, '0');

const slot0Word = (sqrtPriceX96: string, tick: number): string => {
  const t = BigNumber.from(tick < 0 ? tick + 0x1000000 : tick);
  return BigNumber.from(sqrtPriceX96).add(t.shl(160)).toHexString();
};

/** A Transfer log minting/sending `id` to `to`. tokenId is topics[3], the recipient topics[2]. */
const transferLog = (id: string | number, to: string) => ({
  topics: [TRANSFER, topicAddress(`0x${'0'.repeat(40)}`), topicAddress(to), topicTokenId(id)]
});

/** getLogs returns the given ids-per-recipient, keyed by the `to` topic the scan filters on. */
const discovers = (byRecipient: Record<string, Array<string | number>>) => {
  mockGetLogs.mockImplementation(async (filter: any) => {
    const to = filter?.topics?.[2];
    for (const [addr, ids] of Object.entries(byRecipient)) {
      if (to === topicAddress(addr)) return ids.map(id => transferLog(id, addr));
    }
    return [];
  });
};

const firstRound = (entries: Record<string, { owner: string; key?: any; liq?: string }>) => {
  const out: Record<string, any> = {};
  for (const [id, e] of Object.entries(entries)) {
    out[`owner:${id}`] = e.owner;
    out[`info:${id}`] = {
      poolKey: e.key ?? CHAIN.poolKey,
      info: BigNumber.from(PACKED_INFO)
    };
    out[`liq:${id}`] = BigNumber.from(e.liq ?? CHAIN.liquidity);
  }
  return out;
};
const secondRound = (word = slot0Word(CHAIN.sqrtPriceX96, CHAIN.tick)) => ({
  [CHAIN.poolId]: word
});

const base = {
  symbol: 'STOCK',
  stock: STOCK,
  decimals: 18,
  positionManager: POSITION_MANAGER,
  poolManager: POOL_MANAGER
};

describe('uniswap-lp-stock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMulticaller.execute.mockReset();
    mockGetLogs.mockReset();
  });

  it('requires the stock parameter', async () => {
    await expect(
      strategy('s', '4663', {}, [LP], { ...base, stock: '' } as any, 1)
    ).rejects.toThrow('stock parameter is required');
  });

  it('discovers a position from Transfer logs and credits the stock side', async () => {
    discovers({ [LP]: ['1'] });
    mockMulticaller.execute
      .mockResolvedValueOnce(firstRound({ '1': { owner: LP } }))
      .mockResolvedValueOnce(secondRound());
    const res = await strategy('s', '4663', {}, [LP], base, 77_000_000);
    expect(res[LP]).toBeGreaterThan(0);
    // discovery filtered on to = LP
    const filters = mockGetLogs.mock.calls.map(c => c[0]);
    expect(filters.every(f => f.address === POSITION_MANAGER)).toBe(true);
    expect(filters.some(f => f.topics[2] === topicAddress(LP))).toBe(true);
  });

  it('never scans past the snapshot block', async () => {
    discovers({ [LP]: ['1'] });
    mockMulticaller.execute
      .mockResolvedValueOnce(firstRound({ '1': { owner: LP } }))
      .mockResolvedValueOnce(secondRound());
    await strategy('s', '4663', {}, [LP], base, 50_000_000);
    const maxTo = Math.max(...mockGetLogs.mock.calls.map(c => c[0].toBlock));
    expect(maxTo).toBeLessThanOrEqual(50_000_000);
  });

  it('sums several discovered positions for one owner', async () => {
    discovers({ [LP]: ['1', '2'] });
    mockMulticaller.execute
      .mockResolvedValueOnce(
        firstRound({ '1': { owner: LP }, '2': { owner: LP } })
      )
      .mockResolvedValueOnce(secondRound());
    const two = await strategy('s', '4663', {}, [LP], base, 77_000_000);

    discovers({ [LP]: ['1'] });
    mockMulticaller.execute
      .mockResolvedValueOnce(firstRound({ '1': { owner: LP } }))
      .mockResolvedValueOnce(secondRound());
    const one = await strategy('s', '4663', {}, [LP], base, 77_000_000);

    expect(two[LP]).toBeCloseTo(one[LP] * 2, 6);
  });

  it('ignores a discovered id the voter no longer owns at the block', async () => {
    discovers({ [LP]: ['1'] });
    mockMulticaller.execute
      .mockResolvedValueOnce(firstRound({ '1': { owner: STRANGER } }))
      .mockResolvedValueOnce(secondRound());
    const res = await strategy('s', '4663', {}, [LP], base, 77_000_000);
    expect(res[LP]).toBe(0);
  });

  it('ignores a pool that does not contain the stock', async () => {
    discovers({ [LP]: ['1'] });
    mockMulticaller.execute
      .mockResolvedValueOnce(firstRound({ '1': { owner: LP } }))
      .mockResolvedValueOnce(secondRound());
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

  it('credits the stock side, whichever currency it is', async () => {
    discovers({ [LP]: ['1'] });
    mockMulticaller.execute
      .mockResolvedValueOnce(firstRound({ '1': { owner: LP } }))
      .mockResolvedValueOnce(secondRound());
    const asStock = await strategy('s', '4663', {}, [LP], base, 77_000_000);

    discovers({ [LP]: ['1'] });
    mockMulticaller.execute
      .mockResolvedValueOnce(firstRound({ '1': { owner: LP } }))
      .mockResolvedValueOnce(secondRound());
    const asWeth = await strategy(
      's',
      '4663',
      {},
      [LP],
      { ...base, stock: WETH },
      77_000_000
    );
    expect(asStock[LP]).toBeGreaterThan(0);
    expect(asWeth[LP]).toBeGreaterThan(0);
    expect(asStock[LP]).not.toBe(asWeth[LP]);
  });

  it('scores a non-holder as a measured zero without crediting weight', async () => {
    discovers({ [LP]: ['1'] });
    mockMulticaller.execute
      .mockResolvedValueOnce(firstRound({ '1': { owner: LP } }))
      .mockResolvedValueOnce(secondRound());
    const res = await strategy('s', '4663', {}, [LP, STRANGER], base, 77_000_000);
    expect(res[STRANGER]).toBe(0);
    expect(res[LP]).toBeGreaterThan(0);
  });

  it('returns measured zeros and reads no pool when discovery finds nothing', async () => {
    discovers({});
    const res = await strategy('s', '4663', {}, [LP], base, 77_000_000);
    expect(res).toEqual({ [LP]: 0 });
    expect(mockMulticaller.execute).not.toHaveBeenCalled();
  });

  it('skips a zero-liquidity position', async () => {
    discovers({ [LP]: ['1'] });
    mockMulticaller.execute
      .mockResolvedValueOnce(firstRound({ '1': { owner: LP, liq: '0' } }))
      .mockResolvedValueOnce(secondRound());
    const res = await strategy('s', '4663', {}, [LP], base, 77_000_000);
    expect(res[LP]).toBe(0);
  });

  it('skips an uninitialised pool rather than dividing by zero', async () => {
    discovers({ [LP]: ['1'] });
    mockMulticaller.execute
      .mockResolvedValueOnce(firstRound({ '1': { owner: LP } }))
      .mockResolvedValueOnce(secondRound('0x0'));
    const res = await strategy('s', '4663', {}, [LP], base, 77_000_000);
    expect(res[LP]).toBe(0);
  });

  it('resolves a string snapshot to a block before scanning or reading', async () => {
    discovers({ [LP]: ['1'] });
    const provider = { getBlockNumber: jest.fn().mockResolvedValue(77_123_456) };
    mockMulticaller.execute
      .mockResolvedValueOnce(firstRound({ '1': { owner: LP } }))
      .mockResolvedValueOnce(secondRound());
    await strategy('s', '4663', provider, [LP], base, 'latest');
    expect(provider.getBlockNumber).toHaveBeenCalled();
    const maxTo = Math.max(...mockGetLogs.mock.calls.map(c => c[0].toBlock));
    expect(maxTo).toBeLessThanOrEqual(77_123_456);
    const { Multicaller } = jest.requireMock('../../utils');
    for (const call of (Multicaller as jest.Mock).mock.calls) {
      expect(call[3]).toEqual({ blockTag: 77_123_456 });
    }
  });
});
