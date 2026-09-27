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
const SECOND_HOLDER = '0xDD9d5164CcBc57bE377a964Fc064135b03D06177';

const ONE = '1000000000000000000';

/**
 * The on-chain readings this strategy's documentation stands on. All taken on BNB
 * Smart Chain (56) and reproducible with a plain eth_call against an ARCHIVE
 * endpoint — rpc.snapshot.org/56 serves them, and of fourteen keyless endpoints
 * tested only bsc-mainnet.public.blastapi.io does too; the binance dataseeds,
 * publicnode, 1rpc, blockrazor and meowrpc all reject historical calls.
 *
 * NVDAB's first dividend took effect at block 120970451 (2026-09-10 00:00:00 UTC).
 * The pair of blocks either side of it is the whole reason this strategy applies a
 * multiplier rather than reading balanceOf as shares: the balance is IDENTICAL
 * across the boundary and only the multiplier moves. Do not "tidy" a value here —
 * change one only by re-reading the chain.
 */
const CHAIN = {
  DEPLOY_BLOCK: 102441275,
  /** PancakeSwap NVDAB/USDT pool, the holder these numbers were read for. */
  holder: '0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C',
  balanceOf: '5544913841234058720298',
  before: {
    block: 120970450,
    uiMultiplier: ONE,
    shares: '5544913841234058720298'
  },
  after: {
    block: 120970451,
    uiMultiplier: '1000778223752807865',
    shares: '5549229024892580163605'
  }
};

/** The two share counts above, as the JS doubles the strategy returns. */
const SCORE = {
  before: 5544.913841234059,
  after: 5549.22902489258
};

const HEAD = 124385050;

const options = { address: NVDAB, decimals: 18 };

const beaconWord = (addr: string) =>
  `0x000000000000000000000000${addr.slice(2)}`;

function makeProvider(overrides: Record<string, any> = {}) {
  return {
    getBlockNumber: jest.fn().mockResolvedValue(HEAD),
    // Empty code before deployment: a real archive node's answer, canary passes.
    getCode: jest.fn().mockResolvedValue('0x'),
    getStorageAt: jest.fn().mockResolvedValue(beaconWord(BSTOCKS_BEACON)),
    ...overrides
  };
}

type RunArgs = {
  provider?: any;
  opts?: Record<string, unknown>;
  rawOpts?: any;
  block?: number | string;
  holders?: string[];
};

const run = ({ provider, opts, rawOpts, block, holders }: RunArgs = {}) =>
  strategy(
    's',
    '56',
    provider ?? makeProvider(),
    holders ?? [CHAIN.holder],
    rawOpts ?? ({ ...options, ...opts } as any),
    block ?? CHAIN.after.block
  );

const expectPinnedTo = (provider: any, block: number) =>
  expect(Multicaller).toHaveBeenCalledWith('56', provider, expect.any(Array), {
    blockTag: block
  });

const resolveBalances = (uiMultiplier: string, balance = CHAIN.balanceOf) =>
  mockMulticaller.execute.mockResolvedValue({
    uiMultiplier,
    [CHAIN.holder]: balance
  });

describe('bstocks-share-balance shares the RHJ arithmetic', () => {
  // The strategy imports toShares rather than reimplementing it, so these assert
  // that the shared function reproduces the bStocks readings too. If bStocks ever
  // genuinely diverged from RHJ, this is the test that would break first.

  it('is the identity before a corporate action (multiplier 1e18)', () => {
    const shares = toShares(CHAIN.balanceOf, CHAIN.before.uiMultiplier);
    expect(shares.toString()).toBe(CHAIN.before.shares);
    // and the shares equal the raw balance in that case, by definition
    expect(CHAIN.before.shares).toBe(CHAIN.balanceOf);
  });

  it('restates the same balance upward after the NVDAB dividend', () => {
    const shares = toShares(CHAIN.balanceOf, CHAIN.after.uiMultiplier);
    expect(shares.toString()).toBe(CHAIN.after.shares);
  });

  /**
   * The regression test for the bug this strategy exists to avoid. bStocks were
   * expected to rebase; if they did, balanceOf would differ across the dividend
   * and the multiplier would be irrelevant. It does not differ, so treating
   * balanceOf as the share count silently discards the dividend.
   */
  it('proves balanceOf alone would make the dividend invisible', () => {
    expect(CHAIN.after.shares).not.toBe(CHAIN.before.shares);
    // Same input balance on both sides — only the multiplier changed.
    const gained = BigInt(CHAIN.after.shares) - BigInt(CHAIN.before.shares);
    expect(gained).toBe(4315183658521443307n);
    // 0.0778%: small enough to pass a spot check, big enough to decide a vote.
    const ratio = Number(gained) / Number(BigInt(CHAIN.balanceOf));
    expect(ratio).toBeCloseTo(0.000778223752807865, 12);
  });
});

describe('bstocks-share-balance strategy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMulticaller.execute.mockReset();
  });

  it('requires the address parameter', async () => {
    await expect(run({ rawOpts: {} })).rejects.toThrow(
      'address parameter is required'
    );
  });

  it('scores the holder at the record block, multiplier applied', async () => {
    resolveBalances(CHAIN.after.uiMultiplier);
    const provider = makeProvider();

    const result = await run({ provider });

    expectPinnedTo(provider, CHAIN.after.block);
    expect(result).toEqual({ [CHAIN.holder]: SCORE.after });
    // A numeric snapshot is used verbatim — no head lookup, no drift.
    expect(provider.getBlockNumber).not.toHaveBeenCalled();
  });

  it('scores strictly lower one block earlier, same balance', async () => {
    resolveBalances(CHAIN.before.uiMultiplier);

    const result = await run({ block: CHAIN.before.block });

    expect(result[CHAIN.holder]).toBeLessThan(SCORE.after);
    expect(result).toEqual({ [CHAIN.holder]: SCORE.before });
  });

  it('reads the multiplier once, not once per holder', async () => {
    mockMulticaller.execute.mockResolvedValue({
      uiMultiplier: CHAIN.after.uiMultiplier,
      [CHAIN.holder]: CHAIN.balanceOf,
      [SECOND_HOLDER]: '269410211310524118730'
    });

    await run({ holders: [CHAIN.holder, SECOND_HOLDER] });

    const calls = mockMulticaller.call.mock.calls;
    expect(calls.filter(c => c[2] === 'uiMultiplier')).toHaveLength(1);
    // 1 multiplier + 1 balance per holder, one multicall round-trip
    expect(mockMulticaller.call).toHaveBeenCalledTimes(3);
  });

  it('resolves a string snapshot to a block before reading', async () => {
    resolveBalances(CHAIN.after.uiMultiplier);
    const provider = makeProvider();

    await run({ provider, block: 'latest' });

    expect(provider.getBlockNumber).toHaveBeenCalled();
    // 'latest' must never reach the Multicaller: multicall pages concurrently
    // and each page would re-resolve it against its own head, so a dividend
    // between two pages scores part of the electorate on the wrong multiplier.
    expectPinnedTo(provider, HEAD);
  });

  it('refuses a zero multiplier rather than using the raw balance', async () => {
    resolveBalances('0');

    await expect(run()).rejects.toThrow('uiMultiplier() returned 0');
  });

  describe('archive canary', () => {
    it('refuses when the RPC answers historical calls from head', async () => {
      // Bytecode at a block before deployment can only mean the node is serving
      // head state, which makes every balance today's balance with no error.
      const provider = makeProvider({
        getCode: jest.fn().mockResolvedValue('0x60806040523480156100')
      });

      await expect(run({ provider })).rejects.toThrow(
        'not serving historical state'
      );
    });

    it('probes deployBlock - 1 when given one, block 1 otherwise', async () => {
      resolveBalances(ONE, '0');

      const withDeploy = makeProvider();
      await run({
        provider: withDeploy,
        opts: { deployBlock: CHAIN.DEPLOY_BLOCK }
      });
      const probed = CHAIN.DEPLOY_BLOCK - 1;
      expect(withDeploy.getCode).toHaveBeenCalledWith(NVDAB, probed);

      const withoutDeploy = makeProvider();
      await run({ provider: withoutDeploy });
      expect(withoutDeploy.getCode).toHaveBeenCalledWith(NVDAB, 1);
    });

    it('does not fail when the node merely refuses the probe', async () => {
      // Refusing is safe; lying is not. If the endpoint cannot serve the record
      // block either, the balance reads that follow throw on their own.
      resolveBalances(CHAIN.after.uiMultiplier);
      const provider = makeProvider({
        getCode: jest.fn().mockRejectedValue(new Error('missing trie node'))
      });

      await expect(run({ provider })).resolves.toEqual({
        [CHAIN.holder]: SCORE.after
      });
    });

    it('skips the probe when the record block predates the token', async () => {
      resolveBalances(ONE, '0');
      const provider = makeProvider();

      await run({ provider, block: 1 });

      expect(provider.getCode).not.toHaveBeenCalled();
    });
  });

  describe('issuer beacon', () => {
    it('rejects a token that copies the bStocks name and symbol', async () => {
      // FAKE_TSLAB calls itself "Tesla Tokenized bStocks" and is not one.
      const provider = makeProvider({
        getStorageAt: jest.fn().mockResolvedValue(`0x${'0'.repeat(64)}`)
      });

      const promise = run({ provider, opts: { address: FAKE_TSLAB } });
      await expect(promise).rejects.toThrow('is not a bStock');
    });

    it('reads the beacon at the record block, not at head', async () => {
      resolveBalances(CHAIN.after.uiMultiplier);
      const provider = makeProvider();

      await run({ provider });

      expect(provider.getStorageAt).toHaveBeenCalledWith(
        NVDAB,
        expect.any(String),
        CHAIN.after.block
      );
    });

    it('can be switched off for a token that is not a bStock', async () => {
      resolveBalances(ONE);
      const provider = makeProvider();

      await run({ provider, opts: { beacon: false } });

      expect(provider.getStorageAt).not.toHaveBeenCalled();
    });

    it('accepts a differently-cased beacon', async () => {
      resolveBalances(ONE, '0');
      const upper = BSTOCKS_BEACON.toUpperCase().replace('0X', '0x');
      const provider = makeProvider({
        getStorageAt: jest.fn().mockResolvedValue(beaconWord(upper))
      });

      await expect(run({ provider })).resolves.toBeDefined();
    });
  });

  describe('registry tier', () => {
    it('refuses a token that is not listed at all', async () => {
      mockMulticaller.execute.mockResolvedValue({ tier: 0 });

      const promise = run({ opts: { registry: REGISTRY } });
      await expect(promise).rejects.toThrow('is not listed in the registry');
    });

    /**
     * A Four.meme 4Stock is listed, deliberately, at tier 2. Listed is not the
     * same as share-weighted, and conflating the two is how a meme token ends up
     * voting a real proxy.
     */
    it('refuses a tier-2 4Stock when scoring share weight', async () => {
      mockMulticaller.execute.mockResolvedValue({ tier: 2 });

      const promise = run({ opts: { registry: REGISTRY } });
      await expect(promise).rejects.toThrow('must not be counted as share');
    });

    it('accepts a tier-2 token when tier 2 is what was asked for', async () => {
      mockMulticaller.execute
        .mockResolvedValueOnce({ tier: 2 })
        .mockResolvedValueOnce({
          uiMultiplier: ONE,
          [CHAIN.holder]: CHAIN.balanceOf
        });

      const result = await run({
        opts: { registry: REGISTRY, requireTier: 2, beacon: false }
      });

      expect(result).toEqual({ [CHAIN.holder]: SCORE.before });
    });

    it('checks the registry before reading any balance', async () => {
      mockMulticaller.execute.mockResolvedValue({ tier: 0 });

      await run({ opts: { registry: REGISTRY } }).catch(() => undefined);

      // Only the tierOf call was queued — no balanceOf, no uiMultiplier.
      const queued = mockMulticaller.call.mock.calls.map(c => c[2]);
      expect(queued).toEqual(['tierOf']);
    });

    it('reads the tier at the record block when the registry existed', async () => {
      mockMulticaller.execute.mockResolvedValue({ tier: 0 });
      const provider = makeProvider();

      await run({ provider, opts: { registry: REGISTRY } }).catch(
        () => undefined
      );

      expectPinnedTo(provider, CHAIN.after.block);
    });

    /**
     * The case that broke the first live end-to-end run.
     *
     * Balances are pinned to the record block because a balance is a fact about that
     * moment. A registry entry is not — it records whether a token is an issuer-backed
     * share, which is a property of the token. Pinning it anyway means a ballot whose
     * record date predates the registry's own deployment reads an address with no code
     * and reverts. The BSC registry was deployed far above NVDAB's first dividend, so
     * every backtest failed on a bare tierOf CALL_EXCEPTION with nothing explaining it.
     */
    it('falls back to head when the registry did not exist yet', async () => {
      mockMulticaller.execute.mockResolvedValue({ tier: 1 });
      const provider = makeProvider({
        getCode: jest.fn().mockResolvedValue('0x')
      });

      await run({ provider, opts: { registry: REGISTRY } }).catch(
        () => undefined
      );

      expect(Multicaller).toHaveBeenCalledWith('56', provider, expect.any(Array), {
        blockTag: 'latest'
      });
    });

    it('names head, not the record block, when it fell back', async () => {
      mockMulticaller.execute.mockResolvedValue({ tier: 0 });
      const provider = makeProvider({
        getCode: jest.fn().mockResolvedValue('0x')
      });

      await expect(
        run({ provider, opts: { registry: REGISTRY } })
      ).rejects.toThrow(/did not exist at block/);
    });

    /**
     * A bare CALL_EXCEPTION out of ethers names nothing at all. The two causes that
     * actually happen are a wrong address and a registry predating tiers — the RHC one is
     * immutable and has no tierOf — so the message says both.
     */
    it('says which registry and why when tierOf reverts', async () => {
      mockMulticaller.execute.mockRejectedValue(
        new Error('call revert exception')
      );

      await expect(run({ opts: { registry: REGISTRY } })).rejects.toThrow(
        /tierOf.*failed against registry/
      );
      await expect(run({ opts: { registry: REGISTRY } })).rejects.toThrow(
        /deployed before tiers existed/
      );
    });
  });
});
