// Mock dependencies before importing the strategy
const mockMulticaller = {
  call: jest.fn(),
  execute: jest.fn()
};

jest.mock('../../utils', () => ({
  Multicaller: jest.fn().mockImplementation(() => mockMulticaller)
}));

import { getAddress } from '@ethersproject/address';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Multicaller } from '../../utils';
import { strategy, toShares } from './index';

const ONE = '1000000000000000000';
const FOUR = '4000000000000000000';
// NVDA, a real on-chain value that is not a round number
const NVDA = '1000775159164630595';

const CRWD = '0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931';
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const MORPHO = '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010';

/**
 * The single set of on-chain readings this strategy's documentation stands on,
 * all taken at block 62,000,000 (0x3b20b80) on chain 4663 and reproducible with
 * a plain `eth_call` against https://robinhood-chain.gateway.tenderly.co.
 *
 * Everything below - the README table, examples.json's pinned snapshot and the
 * strategy fixtures - is asserted against these, so a figure can never drift
 * away from the block it claims to come from again. Do not "tidy" a value here:
 * change one only by re-reading the chain at BLOCK.
 */
const CHAIN = {
  BLOCK: 62000000,
  crwd: {
    token: CRWD,
    holder: POOL_MANAGER,
    balanceOf: '37313039042191719225',
    uiMultiplier: FOUR,
    balanceOfUI: '149252156168766876900'
  },
  nvda: {
    token: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
    holder: MORPHO,
    balanceOf: '2872817599586810454279',
    uiMultiplier: NVDA,
    balanceOfUI: '2875044490477442237430'
  }
};

const mockProvider = { call: jest.fn(), getBlockNumber: jest.fn() };
const options = { address: CRWD, decimals: 18 };

describe('rhj-share-balance arithmetic', () => {
  // shares = floor(raw * m / 1e18). Asserted as exact decimal strings so a
  // float round-trip anywhere in the chain would fail the test.

  it('is the identity when the multiplier is exactly 1e18', () => {
    expect(toShares('12345678901234567890', ONE).toString()).toBe(
      '12345678901234567890'
    );
  });

  it('quadruples the balance on a 4:1 split (CRWD)', () => {
    // CRWD / Uniswap v4 PoolManager at block 62,000,000:
    // balanceOf 37.313039042191719225 -> balanceOfUI 149.2521561687668769
    expect(toShares(CHAIN.crwd.balanceOf, FOUR).toString()).toBe(
      CHAIN.crwd.balanceOfUI
    );
  });

  it('floors a non-round multiplier, discarding the remainder (NVDA)', () => {
    // NVDA / Morpho Blue at block 62,000,000. raw * m leaves a remainder of
    // 376814601172066005 wei, which balanceOfUI truncates rather than rounds.
    const raw = CHAIN.nvda.balanceOf;
    expect(toShares(raw, NVDA).toString()).toBe(CHAIN.nvda.balanceOfUI);
    expect(toShares(raw, NVDA).toString()).toBe('2875044490477442237430');
    // Rounding half-up would give ...431, so this pins the direction.
    expect(toShares(raw, NVDA).toString()).not.toBe('2875044490477442237431');
  });

  it('truncates wei-level dust rather than rounding it up', () => {
    // 1 wei * 1.000775... = 1.000775... wei -> 1 wei
    expect(toShares('1', NVDA).toString()).toBe('1');
    // and a multiplier below 1.0 can floor a dust balance to nothing
    expect(toShares('1', '999999999999999999').toString()).toBe('0');
  });

  it('returns zero for a zero balance whatever the multiplier is', () => {
    expect(toShares('0', ONE).toString()).toBe('0');
    expect(toShares('0', FOUR).toString()).toBe('0');
    expect(toShares('0', NVDA).toString()).toBe('0');
  });

  it('keeps full precision on a very large balance', () => {
    // 1e12 tokens. Way past 2**53, so any float round-trip loses digits.
    expect(toShares('1000000000000000000000000000000', NVDA).toString()).toBe(
      '1000775159164630595000000000000'
    );
    // Whole fleet raw supply scale, with a remainder.
    expect(toShares('3713709620000000000000000', NVDA).toString()).toBe(
      '3716588336046719804397823'
    );
  });
});

describe('rhj-share-balance strategy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires the address parameter', async () => {
    await expect(
      strategy('s', '4663', mockProvider, [POOL_MANAGER], {} as any, 62000000)
    ).rejects.toThrow('address parameter is required');
  });

  it('reads balances and the multiplier at the snapshot block', async () => {
    mockMulticaller.execute.mockResolvedValue({
      uiMultiplier: CHAIN.crwd.uiMultiplier,
      [POOL_MANAGER]: CHAIN.crwd.balanceOf
    });

    const result = await strategy(
      's',
      '4663',
      mockProvider,
      [POOL_MANAGER],
      options,
      CHAIN.BLOCK
    );

    expect(Multicaller).toHaveBeenCalledWith(
      '4663',
      mockProvider,
      expect.any(Array),
      { blockTag: CHAIN.BLOCK }
    );
    // 149252156168766876900 wei of shares, as a JS double
    expect(result).toEqual({ [POOL_MANAGER]: 149.25215616876687 });
    // A numeric snapshot is used verbatim: no head lookup, no drift.
    expect(mockProvider.getBlockNumber).not.toHaveBeenCalled();
  });

  it('reads the multiplier once, not once per holder', async () => {
    mockMulticaller.execute.mockResolvedValue({
      uiMultiplier: FOUR,
      [POOL_MANAGER]: '38022751808053153575',
      [MORPHO]: '1000000000000000000'
    });

    await strategy(
      's',
      '4663',
      mockProvider,
      [POOL_MANAGER, MORPHO],
      options,
      62000000
    );

    const multiplierCalls = mockMulticaller.call.mock.calls.filter(
      call => call[2] === 'uiMultiplier'
    );
    expect(multiplierCalls).toHaveLength(1);
    // 1 multiplier + 1 balance per holder, in a single multicall round-trip
    expect(mockMulticaller.call).toHaveBeenCalledTimes(3);
    expect(mockMulticaller.execute).toHaveBeenCalledTimes(1);
  });

  it("resolves a 'latest' snapshot to a concrete block number", async () => {
    // Regression: 'latest' must never reach the Multicaller. snapshot.js pages
    // the call list at 500 calls per eth_call and resolves each page's 'latest'
    // independently, so the multiplier (call 0, page 0) and the balances from
    // call 500 onward could land on different blocks - and the RHJ multiplier
    // flips between adjacent blocks with no transaction.
    mockProvider.getBlockNumber.mockResolvedValue(62218490);
    mockMulticaller.execute.mockResolvedValue({
      uiMultiplier: FOUR,
      [POOL_MANAGER]: '38022751808053153575'
    });

    const result = await strategy(
      's',
      '4663',
      mockProvider,
      [POOL_MANAGER],
      options,
      'latest'
    );

    expect(mockProvider.getBlockNumber).toHaveBeenCalledTimes(1);
    expect(Multicaller).toHaveBeenCalledWith(
      '4663',
      mockProvider,
      expect.any(Array),
      { blockTag: 62218490 }
    );
    const { blockTag } = (Multicaller as unknown as jest.Mock).mock.calls[0][3];
    expect(typeof blockTag).toBe('number');
    expect(blockTag).not.toBe('latest');
    expect(result).toEqual({ [POOL_MANAGER]: 152.0910072322126 });
  });

  it('pins every multicall page to one block when paging kicks in', async () => {
    // 500 voters is 501 calls, which snapshot.js splits into two eth_calls at
    // its default limit of 500. Both pages carry the same options object, so
    // the guarantee has to come from the blockTag being a fixed height.
    mockProvider.getBlockNumber.mockResolvedValue(62218490);
    // All-lowercase hex, so getAddress() accepts it as an unchecksummed input.
    const voters = [...Array(500).keys()].map(
      i => `0x${(i + 1).toString(16).padStart(40, '0')}`
    );
    mockMulticaller.execute.mockResolvedValue(
      Object.fromEntries([
        ['uiMultiplier', FOUR],
        ...voters.map(v => [getAddress(v), ONE])
      ])
    );

    await strategy('s', '4663', mockProvider, voters, options, 'latest');

    // 1 multiplier + 500 balances: past the 500-call page boundary.
    expect(mockMulticaller.call).toHaveBeenCalledTimes(501);
    const { blockTag } = (Multicaller as unknown as jest.Mock).mock.calls[0][3];
    expect(Number.isInteger(blockTag)).toBe(true);
  });

  it('does not include the multiplier key in the scores', async () => {
    mockMulticaller.execute.mockResolvedValue({
      uiMultiplier: ONE,
      [POOL_MANAGER]: '12345678901234567890'
    });

    const result = await strategy(
      's',
      '4663',
      mockProvider,
      [POOL_MANAGER],
      options,
      62000000
    );

    expect(Object.keys(result)).toEqual([POOL_MANAGER]);
    expect(result[POOL_MANAGER]).toBe(12.345678901234567);
  });

  it('returns 0 for a holder with no balance', async () => {
    mockMulticaller.execute.mockResolvedValue({
      uiMultiplier: CHAIN.nvda.uiMultiplier,
      [POOL_MANAGER]: '0',
      [MORPHO]: CHAIN.nvda.balanceOf
    });

    const result = await strategy(
      's',
      '4663',
      mockProvider,
      [POOL_MANAGER, MORPHO],
      { address: CHAIN.nvda.token, decimals: 18 },
      CHAIN.BLOCK
    );

    expect(result).toEqual({
      [POOL_MANAGER]: 0,
      // 2875044490477442237430 wei of shares, as a JS double
      [MORPHO]: 2875.044490477442
    });
  });

  it('returns checksummed keys for lowercase input addresses', async () => {
    mockMulticaller.execute.mockResolvedValue({
      uiMultiplier: FOUR,
      [POOL_MANAGER]: '38022751808053153575'
    });

    const result = await strategy(
      's',
      '4663',
      mockProvider,
      [POOL_MANAGER.toLowerCase()],
      options,
      62000000
    );

    expect(mockMulticaller.call).toHaveBeenCalledWith(
      POOL_MANAGER,
      CRWD,
      'balanceOf',
      [POOL_MANAGER.toLowerCase()]
    );
    expect(Object.keys(result)).toEqual([POOL_MANAGER]);
  });

  it('throws instead of falling back when the multiplier is 0', async () => {
    mockMulticaller.execute.mockResolvedValue({
      uiMultiplier: '0',
      [POOL_MANAGER]: '38022751808053153575'
    });

    await expect(
      strategy('s', '4663', mockProvider, [POOL_MANAGER], options, 62000000)
    ).rejects.toThrow('uiMultiplier() returned 0');
  });
});

describe('rhj-share-balance documented evidence', () => {
  // The README's worked example is the whole argument for this strategy: it is
  // what a reviewer re-derives with an eth_call before trusting a tally. It has
  // already drifted off its block once (the table quoted a balance that is only
  // true ~12k blocks later), which is indistinguishable from a broken
  // multiplier to anyone checking. These tests tie the prose, the shipped
  // example and the fixtures to one block and one set of readings.
  const readme = readFileSync(join(__dirname, 'README.md'), 'utf8');
  const examples = JSON.parse(
    readFileSync(join(__dirname, 'examples.json'), 'utf8')
  );
  const manifest = JSON.parse(
    readFileSync(join(__dirname, 'manifest.json'), 'utf8')
  );

  const row = (label: string): string => {
    const match = readme.match(
      new RegExp(`^\\|\\s*\`${label}\`\\s*\\|\\s*\`(\\d+)\``, 'm')
    );
    if (!match) throw new Error(`no \`${label}\` row in the README table`);
    return match[1];
  };

  it('quotes the block its numbers were actually read at', () => {
    expect(readme).toContain(`At block \`${CHAIN.BLOCK}\``);
    expect(examples[0].snapshot).toBe(CHAIN.BLOCK);
    expect(examples[1].snapshot).toBe(CHAIN.BLOCK);
  });

  it('quotes the CRWD readings that the chain returns at that block', () => {
    expect(row('balanceOf')).toBe(CHAIN.crwd.balanceOf);
    expect(row('uiMultiplier')).toBe(CHAIN.crwd.uiMultiplier);
    expect(row('balanceOfUI')).toBe(CHAIN.crwd.balanceOfUI);
  });

  it('quotes a table that is internally consistent', () => {
    // Catches a hand-edited cell even if the chain reading itself moved.
    expect(toShares(row('balanceOf'), row('uiMultiplier')).toString()).toBe(
      row('balanceOfUI')
    );
  });

  it('attributes the reading to the token and holder it was taken from', () => {
    expect(readme).toContain(CHAIN.crwd.token);
    expect(readme).toContain(CHAIN.crwd.holder);
    expect(examples[0].strategy.params.address).toBe(CHAIN.crwd.token);
    expect(examples[0].addresses).toContain(CHAIN.crwd.holder);
    expect(examples[1].strategy.params.address).toBe(CHAIN.nvda.token);
    expect(examples[1].addresses).toContain(CHAIN.nvda.holder);
  });

  it('quotes the NVDA multiplier used by the fixtures', () => {
    expect(readme).toContain(CHAIN.nvda.uiMultiplier);
  });

  it('names an author that resolves as a github account', () => {
    // test/strategies/unit/strategy.test.ts asserts that
    // api.github.com/users/<author> is not a 404, and strategy.yml is the
    // only job that ever runs these examples against live chain 4663. The
    // manifest shipped with "rhc-vote" - a repo name, not an account - so
    // that job went red before it ever touched the chain.
    //
    // Kept offline here, so it is pinned to a login verified to exist
    // (api.github.com/users/georgehspirit-ctrl -> 200, id 243522517).
    // Changing it means re-checking the new login against that endpoint.
    expect(manifest.author).toBe('georgehspirit-ctrl');
  });
});
