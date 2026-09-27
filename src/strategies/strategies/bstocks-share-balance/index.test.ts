// Mock dependencies before importing the strategy
const mockMulticaller = {
  call: jest.fn(),
  execute: jest.fn()
};

jest.mock('../../utils', () => ({
  Multicaller: jest.fn().mockImplementation(() => mockMulticaller)
}));

import { Multicaller } from '../../utils';
import { toShares } from '../rhj-share-balance';
import { BSTOCKS_BEACON, strategy } from './index';

const NVDAB = '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436';
const REGISTRY = '0x1111111111111111111111111111111111111111';
/** "Tesla Tokenized bStocks", symbol TSLAB, live on BSC and NOT a bStock. */
const FAKE_TSLAB = '0x94aa91E490FF7555c8703608C2a9bF4B548e1402';

const ONE = '1000000000000000000';

/**
 * The on-chain readings this strategy's documentation stands on. All taken on BNB Smart Chain
 * (56) and reproducible with a plain eth_call against an ARCHIVE endpoint — at the time of
 * writing the only keyless one that serves historical state is
 * https://bsc-mainnet.public.blastapi.io; the binance dataseeds, publicnode, 1rpc, blockrazor
 * and meowrpc all reject historical calls.
 *
 * NVDAB's first dividend took effect at block 120970451 (2026-09-10 00:00:00 UTC). The pair of
 * blocks either side of it is the whole reason this strategy applies a multiplier rather than
 * reading balanceOf as shares: the balance is IDENTICAL across the boundary and only the
 * multiplier moves. Do not "tidy" a value here — change one only by re-reading the chain.
 */
const CHAIN = {
  DEPLOY_BLOCK: 102441275,
  DIVIDEND_BLOCK: 120970451,
  /** PancakeSwap NVDAB/USDT pool, the holder these numbers were read for. */
  holder: '0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C',
  balanceOf: '5544913841234058720298',
  before: {
    block: 120970450,
    uiMultiplier: '1000000000000000000',
    shares: '5544913841234058720298'
  },
  after: {
    block: 120970451,
    uiMultiplier: '1000778223752807865',
    shares: '5549229024892580163605'
  }
};

function makeProvider(overrides: Record<string, any> = {}) {
  return {
    getBlockNumber: jest.fn().mockResolvedValue(124385050),
    // Empty code before deployment: a real archive node's answer, so the canary passes.
    getCode: jest.fn().mockResolvedValue('0x'),
    getStorageAt: jest
      .fn()
      .mockResolvedValue('0x000000000000000000000000' + BSTOCKS_BEACON.slice(2)),
    ...overrides
  };
}

const options = { address: NVDAB, decimals: 18 };

describe('bstocks-share-balance shares the RHJ arithmetic', () => {
  // The strategy imports toShares rather than reimplementing it, so these assert that the
  // shared function reproduces the bStocks readings too. If bStocks ever genuinely diverged
  // from RHJ, this is the test that would break first.

  it('is the identity before a corporate action (multiplier exactly 1e18)', () => {
    expect(toShares(CHAIN.balanceOf, CHAIN.before.uiMultiplier).toString()).toBe(
      CHAIN.before.shares
    );
    // and the shares equal the raw balance in that case, by definition
    expect(CHAIN.before.shares).toBe(CHAIN.balanceOf);
  });

  it('restates the same balance upward after NVDAB dividend', () => {
    expect(toShares(CHAIN.balanceOf, CHAIN.after.uiMultiplier).toString()).toBe(
      CHAIN.after.shares
    );
  });

  /**
   * This is the regression test for the bug this strategy exists to avoid. bStocks were
   * expected to rebase; if they did, balanceOf would differ across the dividend and the
   * multiplier would be irrelevant. It does not differ, so treating balanceOf as the share
   * count silently discards the dividend.
   */
  it('proves balanceOf alone would make the dividend invisible', () => {
    expect(CHAIN.after.shares).not.toBe(CHAIN.before.shares);
    // Same input balance on both sides — the ONLY thing that changed is the multiplier.
    const gained =
      BigInt(CHAIN.after.shares) - BigInt(CHAIN.before.shares);
    expect(gained).toBe(4315183658521443307n);
    // 0.0778% — small enough to pass a spot check, big enough to decide a close vote.
    expect(Number(gained) / Number(BigInt(CHAIN.balanceOf))).toBeCloseTo(
      0.000778223752807865,
      12
    );
  });
});

describe('bstocks-share-balance strategy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMulticaller.execute.mockReset();
  });

  it('requires the address parameter', async () => {
    await expect(
      strategy('s', '56', makeProvider(), [CHAIN.holder], {} as any, CHAIN.DIVIDEND_BLOCK)
    ).rejects.toThrow('address parameter is required');
  });

  it('scores the holder at the record block, multiplier applied', async () => {
    mockMulticaller.execute.mockResolvedValue({
      uiMultiplier: CHAIN.after.uiMultiplier,
      [CHAIN.holder]: CHAIN.balanceOf
    });
    const provider = makeProvider();

    const result = await strategy(
      's',
      '56',
      provider,
      [CHAIN.holder],
      options,
      CHAIN.after.block
    );

    expect(Multicaller).toHaveBeenCalledWith('56', provider, expect.any(Array), {
      blockTag: CHAIN.after.block
    });
    expect(result).toEqual({ [CHAIN.holder]: 5549.22902489258 });
    // A numeric snapshot is used verbatim — no head lookup, no drift.
    expect(provider.getBlockNumber).not.toHaveBeenCalled();
  });

  it('scores strictly lower one block earlier, on the same balance', async () => {
    mockMulticaller.execute.mockResolvedValue({
      uiMultiplier: CHAIN.before.uiMultiplier,
      [CHAIN.holder]: CHAIN.balanceOf
    });

    const result = await strategy(
      's',
      '56',
      makeProvider(),
      [CHAIN.holder],
      options,
      CHAIN.before.block
    );

    expect(result[CHAIN.holder]).toBeLessThan(5549.22902489258);
    expect(result).toEqual({ [CHAIN.holder]: 5544.913841234059 });
  });

  it('reads the multiplier once, not once per holder', async () => {
    const second = '0xDD9d5164CcBc57bE377a964Fc064135b03D06177';
    mockMulticaller.execute.mockResolvedValue({
      uiMultiplier: CHAIN.after.uiMultiplier,
      [CHAIN.holder]: CHAIN.balanceOf,
      [second]: '269410211310524118730'
    });

    await strategy('s', '56', makeProvider(), [CHAIN.holder, second], options, 120970451);

    const multiplierCalls = mockMulticaller.call.mock.calls.filter(
      call => call[2] === 'uiMultiplier'
    );
    expect(multiplierCalls).toHaveLength(1);
    // 1 multiplier + 1 balance per holder, one multicall round-trip
    expect(mockMulticaller.call).toHaveBeenCalledTimes(3);
  });

  it('resolves a string snapshot to a concrete block before reading', async () => {
    mockMulticaller.execute.mockResolvedValue({
      uiMultiplier: CHAIN.after.uiMultiplier,
      [CHAIN.holder]: CHAIN.balanceOf
    });
    const provider = makeProvider();

    await strategy('s', '56', provider, [CHAIN.holder], options, 'latest');

    expect(provider.getBlockNumber).toHaveBeenCalled();
    // 'latest' must never reach the Multicaller: multicall pages concurrently and each page
    // would re-resolve it against its own head, so a dividend between two pages would score
    // part of the electorate on the wrong multiplier.
    expect(Multicaller).toHaveBeenCalledWith('56', provider, expect.any(Array), {
      blockTag: 124385050
    });
  });

  it('refuses a zero multiplier rather than falling back to the raw balance', async () => {
    mockMulticaller.execute.mockResolvedValue({
      uiMultiplier: '0',
      [CHAIN.holder]: CHAIN.balanceOf
    });

    await expect(
      strategy('s', '56', makeProvider(), [CHAIN.holder], options, 120970451)
    ).rejects.toThrow('uiMultiplier() returned 0');
  });

  describe('archive canary', () => {
    it('refuses to score when the RPC answers historical calls from head', async () => {
      // Bytecode at a block before deployment can only mean the node is serving head state,
      // which would make every balance today's balance without any error.
      const provider = makeProvider({
        getCode: jest.fn().mockResolvedValue('0x60806040523480156100')
      });

      await expect(
        strategy('s', '56', provider, [CHAIN.holder], options, CHAIN.after.block)
      ).rejects.toThrow('not serving historical state');
    });

    it('probes deployBlock - 1 when given one, and block 1 otherwise', async () => {
      mockMulticaller.execute.mockResolvedValue({
        uiMultiplier: ONE,
        [CHAIN.holder]: '0'
      });

      const withDeploy = makeProvider();
      await strategy(
        's',
        '56',
        withDeploy,
        [CHAIN.holder],
        { ...options, deployBlock: CHAIN.DEPLOY_BLOCK },
        CHAIN.after.block
      );
      expect(withDeploy.getCode).toHaveBeenCalledWith(NVDAB, CHAIN.DEPLOY_BLOCK - 1);

      const withoutDeploy = makeProvider();
      await strategy('s', '56', withoutDeploy, [CHAIN.holder], options, CHAIN.after.block);
      expect(withoutDeploy.getCode).toHaveBeenCalledWith(NVDAB, 1);
    });

    it('does not fail scoring when the node merely refuses the probe', async () => {
      // Refusing is safe; lying is not. If the endpoint cannot serve the record block either,
      // the balance reads that follow throw on their own.
      mockMulticaller.execute.mockResolvedValue({
        uiMultiplier: CHAIN.after.uiMultiplier,
        [CHAIN.holder]: CHAIN.balanceOf
      });
      const provider = makeProvider({
        getCode: jest.fn().mockRejectedValue(new Error('missing trie node'))
      });

      await expect(
        strategy('s', '56', provider, [CHAIN.holder], options, CHAIN.after.block)
      ).resolves.toEqual({ [CHAIN.holder]: 5549.22902489258 });
    });

    it('skips the probe when the record block predates the token', async () => {
      mockMulticaller.execute.mockResolvedValue({ uiMultiplier: ONE, [CHAIN.holder]: '0' });
      const provider = makeProvider();

      await strategy('s', '56', provider, [CHAIN.holder], options, 1);

      expect(provider.getCode).not.toHaveBeenCalled();
    });
  });

  describe('issuer beacon', () => {
    it('rejects a token that copies the bStocks name and symbol', async () => {
      // FAKE_TSLAB calls itself "Tesla Tokenized bStocks" with symbol TSLAB and is not one.
      const provider = makeProvider({
        getStorageAt: jest.fn().mockResolvedValue('0x' + '0'.repeat(64))
      });

      await expect(
        strategy(
          's',
          '56',
          provider,
          [CHAIN.holder],
          { ...options, address: FAKE_TSLAB },
          CHAIN.after.block
        )
      ).rejects.toThrow('is not a bStock');
    });

    it('reads the beacon at the record block, not at head', async () => {
      mockMulticaller.execute.mockResolvedValue({
        uiMultiplier: CHAIN.after.uiMultiplier,
        [CHAIN.holder]: CHAIN.balanceOf
      });
      const provider = makeProvider();

      await strategy('s', '56', provider, [CHAIN.holder], options, CHAIN.after.block);

      expect(provider.getStorageAt).toHaveBeenCalledWith(
        NVDAB,
        expect.any(String),
        CHAIN.after.block
      );
    });

    it('can be switched off for a token that is not a bStock', async () => {
      mockMulticaller.execute.mockResolvedValue({
        uiMultiplier: ONE,
        [CHAIN.holder]: CHAIN.balanceOf
      });
      const provider = makeProvider();

      await strategy(
        's',
        '56',
        provider,
        [CHAIN.holder],
        { ...options, beacon: false },
        CHAIN.after.block
      );

      expect(provider.getStorageAt).not.toHaveBeenCalled();
    });

    it('accepts a differently-cased beacon', async () => {
      mockMulticaller.execute.mockResolvedValue({
        uiMultiplier: ONE,
        [CHAIN.holder]: '0'
      });
      const provider = makeProvider({
        getStorageAt: jest
          .fn()
          .mockResolvedValue(
            '0x000000000000000000000000' + BSTOCKS_BEACON.slice(2).toUpperCase()
          )
      });

      await expect(
        strategy('s', '56', provider, [CHAIN.holder], options, CHAIN.after.block)
      ).resolves.toBeDefined();
    });
  });

  describe('registry tier', () => {
    it('refuses a token that is not listed at all', async () => {
      mockMulticaller.execute.mockResolvedValue({ tier: 0 });

      await expect(
        strategy(
          's',
          '56',
          makeProvider(),
          [CHAIN.holder],
          { ...options, registry: REGISTRY },
          CHAIN.after.block
        )
      ).rejects.toThrow('is not listed in the registry');
    });

    /**
     * A Four.meme 4Stock is listed, deliberately, at tier 2. Listed is not the same as
     * share-weighted, and conflating the two is how a meme token ends up voting a real proxy.
     */
    it('refuses a tier-2 4Stock when scoring share weight', async () => {
      mockMulticaller.execute.mockResolvedValue({ tier: 2 });

      await expect(
        strategy(
          's',
          '56',
          makeProvider(),
          [CHAIN.holder],
          { ...options, registry: REGISTRY },
          CHAIN.after.block
        )
      ).rejects.toThrow('must not be counted as share weight');
    });

    it('accepts a tier-2 token when tier 2 is what was asked for', async () => {
      mockMulticaller.execute
        .mockResolvedValueOnce({ tier: 2 })
        .mockResolvedValueOnce({
          uiMultiplier: ONE,
          [CHAIN.holder]: CHAIN.balanceOf
        });

      const result = await strategy(
        's',
        '56',
        makeProvider(),
        [CHAIN.holder],
        { ...options, registry: REGISTRY, requireTier: 2, beacon: false },
        CHAIN.after.block
      );

      expect(result).toEqual({ [CHAIN.holder]: 5544.913841234059 });
    });

    it('checks the registry before reading any balance', async () => {
      mockMulticaller.execute.mockResolvedValue({ tier: 0 });

      await strategy(
        's',
        '56',
        makeProvider(),
        [CHAIN.holder],
        { ...options, registry: REGISTRY },
        CHAIN.after.block
      ).catch(() => undefined);

      // Only the tierOf call was ever queued — no balanceOf, no uiMultiplier.
      const queued = mockMulticaller.call.mock.calls.map(c => c[2]);
      expect(queued).toEqual(['tierOf']);
    });

    it('reads the tier at the record block', async () => {
      mockMulticaller.execute.mockResolvedValue({ tier: 0 });
      const provider = makeProvider();

      await strategy(
        's',
        '56',
        provider,
        [CHAIN.holder],
        { ...options, registry: REGISTRY },
        CHAIN.after.block
      ).catch(() => undefined);

      expect(Multicaller).toHaveBeenCalledWith('56', provider, expect.any(Array), {
        blockTag: CHAIN.after.block
      });
    });
  });
});
