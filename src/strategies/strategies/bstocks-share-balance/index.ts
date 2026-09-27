import { getAddress } from '@ethersproject/address';
import { BigNumber, BigNumberish } from '@ethersproject/bignumber';
import { formatUnits } from '@ethersproject/units';
import { Multicaller } from '../../utils';
// The share arithmetic is imported, not reimplemented. See "SAME MODEL AS RHJ" below: the two
// issuers restate balances identically, so a second copy of the mulDiv could only ever drift
// away from the live one.
import { toShares } from '../rhj-share-balance';

const abi = [
  'function balanceOf(address account) external view returns (uint256)',
  'function uiMultiplier() external view returns (uint256)'
];

const registryAbi = [
  'function tierOf(address token) external view returns (uint8)'
];

/**
 * bStocks share balance — BNB Smart Chain (56).
 *
 * bStocks are tokenized shares issued by BTech Holdings Limited. This computes a holder's
 * share count at a proposal's record block, the same quantity `rhj-share-balance` computes on
 * Robinhood Chain.
 *
 * ── SAME MODEL AS RHJ. VERIFIED ON CHAIN, NOT ASSUMED ─────────────────────────────────────
 *
 * bStocks were expected to be rebasing — balances restated in place, no multiplier, so
 * `balanceOf` could be read as shares directly. They are NOT. Every bStock exposes
 * `uiMultiplier()` and `balanceOfUI()`, exactly like RHJ, and `balanceOf` is RAW shares.
 *
 * The proof is NVDAB's first dividend, which took effect at block 120970451
 * (2026-09-10 00:00:00 UTC). Reading the token through the multicall this strategy uses, at the
 * two blocks either side of it, for the PancakeSwap pool 0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C:
 *
 *   block       uiMultiplier          balanceOf               floor(balance*mult/1e18)
 *   120970450   1000000000000000000   5544913841234058720298  5544913841234058720298
 *   120970451   1000778223752807865   5544913841234058720298  5549229024892580163605
 *
 * `balanceOf` does not move by one wei across the dividend. Only the multiplier moves. So:
 *
 *   - reading `balanceOf` as the share count makes the dividend INVISIBLE — identical weight
 *     before and after a corporate action that really did change what holders own;
 *   - the entitlement actually rose 0.0778% here, and a split would be far larger (4x on a 4:1).
 *     Small enough to survive a spot check, large enough to decide a close vote, silent either way.
 *
 * It is also not uniform across tickers: NVDAB, AAPLB and QQQB have multipliers above 1e18 while
 * TSLAB, COINB, MSTRB, BMNRB and SPCXB are still exactly 1e18. A test written against one of the
 * latter passes under either model and proves nothing — test against one whose multiplier moved.
 *
 * Confirmed independently against four live holders at head, where
 * `balanceOfUI(h) == floor(balanceOf(h) * uiMultiplier() / 1e18)` and `!= balanceOf(h)` for all
 * four (0x…dEaD, the two PancakeSwap pools and the Uniswap pool). Same 1e18 denominator, same
 * floor, same wei as RHJ's `balanceOfUI`.
 *
 * The bStocks marketing copy calls it "a built-in rebase mechanism … Multiplier", which reads as
 * either model. The chain is the authority, and the chain says multiplier.
 *
 * NO EVENT MARKS THE CHANGE. The dividend block's timestamp is exactly midnight UTC and the
 * holder's balance is untouched, i.e. the multiplier flips on a timestamp comparison with no
 * transaction, no log and no state write — the same mechanism documented in `rhj-share-balance`.
 * A dividend therefore cannot be detected by watching logs; the only correct way to know the
 * multiplier for a ballot is to read it AT that ballot's record block, which is what this does.
 *
 * ── SO WHY A SEPARATE STRATEGY AT ALL ─────────────────────────────────────────────────────
 *
 * The arithmetic is shared by import. What differs is everything around it, and none of it
 * belongs in the live RHC strategy:
 *
 *   - Authenticity. RHJ tokens live on a chain where nobody else deploys; BSC is open, and
 *     impersonators exist right now. `0x94aa91E490FF7555c8703608C2a9bF4B548e1402` calls itself
 *     "Tesla Tokenized bStocks" with symbol TSLAB, and is not one: 8 decimals, no proxy, no
 *     multiplier. Symbol and name are worthless as identity here, so this strategy checks the
 *     registry and, optionally, the issuer's beacon.
 *   - Collateral. RHJ counts Morpho Blue positions. BSC lending is Venus and Lista, a different
 *     interface, wired separately.
 */

/** Every genuine bStock is an EIP-1967 BEACON proxy sharing one beacon, which is the strongest
 *  on-chain authenticity signal available: all nine confirmed bStocks point at this address,
 *  and none of the impersonators do. */
export const BSTOCKS_BEACON = '0x156d6dce9a4f6139a3406f1f021f1a4880de93a3';

/** EIP-1967 beacon slot: keccak256("eip1967.proxy.beacon") - 1. Note BEACON, not the more
 *  familiar implementation slot — bStocks leave the implementation slot empty, so checking that
 *  one instead reads zero on a genuine token and would reject all of them. */
const BEACON_SLOT =
  '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

/**
 * ARCHIVE CANARY.
 *
 * Voting power is read at a historical block, and a pruned node has two ways to respond:
 *
 *   - it errors  → loud, scoring fails, fine.
 *   - it answers from head → every balance and the multiplier are today's, the tally is wrong,
 *     and nothing indicates it.
 *
 * On RHJ a wrong configuration at least trips over `uiMultiplier()` reverting. A stale-state RPC
 * trips over nothing: the reads succeed and the numbers look ordinary. So probe for the
 * dangerous case with a positive test. At a block before the token was deployed a node serving
 * real historical state MUST return empty code; bytecode from that block proves it is answering
 * from head, and the only correct response is to refuse to score.
 *
 * Block 1 is a safe universal probe on BSC — the chain launched in 2020 and every bStock was
 * deployed years later, so no bStock has code at block 1 on any archive node. `deployBlock`
 * narrows it but is not required.
 *
 * An error from the probe is deliberately NOT a failure. A node that refuses the call is not
 * lying about it, and the reads that follow are on the same endpoint at the same block tag — if
 * it cannot serve those either, they throw on their own. Failing here on a network blip would
 * take scoring down for a reason unrelated to the data.
 */
async function assertServesHistoricalState(
  provider: any,
  token: string,
  blockTag: number,
  deployBlock?: number
): Promise<void> {
  const probe = deployBlock && deployBlock > 1 ? deployBlock - 1 : 1;
  if (probe >= blockTag) return;

  let code: string;
  try {
    code = await provider.getCode(token, probe);
  } catch {
    return;
  }

  if (code && code !== '0x' && code !== '0x0') {
    const bytes = (code.length - 2) / 2;
    throw new Error(
      `RPC is not serving historical state: ${token} reports ${bytes} bytes of code at block ` +
        `${probe}, before it was deployed. Balances read "at block ${blockTag}" would actually ` +
        `be head balances, and the tally would be wrong without failing. Point this network at ` +
        `an archive node.`
    );
  }
}

/** Confirm the token is the issuer's, by the beacon it delegates to at the record block. */
async function assertIssuerBeacon(
  provider: any,
  token: string,
  blockTag: number,
  expected: string
): Promise<void> {
  const raw = await provider.getStorageAt(token, BEACON_SLOT, blockTag);
  const found = `0x${raw.slice(-40)}`;
  if (found.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `${token} is not a bStock: EIP-1967 beacon slot holds ${found} at block ${blockTag}, ` +
        `expected ${expected}. Tokens that copy the bStocks name and symbol exist on BSC — ` +
        `identity is the beacon and the registry, never the symbol.`
    );
  }
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
    /**
     * OnRecord Registry on this chain. When set, the token must hold `requireTier` at the
     * pinned block or scoring fails. Strongly recommended: it is what makes the on-chain
     * whitelist load-bearing rather than decorative.
     */
    registry?: string;
    /** Required registry tier. 1 = TIER_SHARE (default), 2 = TIER_PRE_SHARE (Four.meme 4Stock). */
    requireTier?: number;
    /** Expected beacon. Defaults to the bStocks beacon; pass null-ish to skip the check. */
    beacon?: string | false;
    /** Token deployment block. Narrows the archive canary; optional. */
    deployBlock?: number;
  },
  snapshot: string | number
): Promise<Record<string, number>> {
  if (!options.address) throw new Error('address parameter is required');

  // Resolve 'latest' to a concrete height ONCE, before any read.
  //
  // The multiplier and the balances must come from the SAME block. Reading a current multiplier
  // against historical balances silently corrupts the tally, and the multiplier moves without a
  // Transfer — NVDAB's sat at exactly 1e18 and is now 1.000778…, so "no transfers happened" is
  // not evidence that nothing changed.
  //
  // A literal 'latest' cannot express that invariant and must never reach the Multicaller.
  // Multicaller hands its call list to snapshot.js's multicall, which pages it at `limit` calls
  // per eth_call (default 500) and fires the pages concurrently with the same options object, so
  // 'latest' is re-resolved once per page: `uiMultiplier` is call 0 and always lands in page 0,
  // while the 500th voter onward lands in a later eth_call resolving against its own head. One
  // dividend between two pages and part of the electorate is scored on the pre-change multiplier
  // against post-change balances.
  //
  // This path is routine: src/scores.ts rewrites any snapshot above the current head to 'latest',
  // and that head is cached for 120s.
  const blockTag =
    typeof snapshot === 'number' ? snapshot : await provider.getBlockNumber();

  const { address, deployBlock } = options;
  await assertServesHistoricalState(provider, address, blockTag, deployBlock);

  const beacon = options.beacon === undefined ? BSTOCKS_BEACON : options.beacon;
  if (beacon) await assertIssuerBeacon(provider, address, blockTag, beacon);

  // Registry check stands alone and runs before any balance is read, so a misconfigured ballot
  // fails with an error naming the tier instead of surfacing later as an odd-looking tally.
  if (options.registry) {
    const required = options.requireTier ?? 1;
    const reg = new Multicaller(network, provider, registryAbi, { blockTag });
    reg.call('tier', options.registry, 'tierOf', [options.address]);
    const { tier } = await reg.execute();
    const found = Number(tier);
    if (found !== required) {
      throw new Error(
        found === 0
          ? `${options.address} is not listed in the registry ${options.registry} at block ` +
            `${blockTag}. Only a whitelisted token can carry voting weight.`
          : `${options.address} is listed at tier ${found} but this strategy scores tier ` +
            `${required}. Tier 2 is a Four.meme 4Stock — it tracks a share without being one, ` +
            `and must not be counted as share weight.`
      );
    }
  }

  const multi = new Multicaller(network, provider, abi, { blockTag });
  // Read once per call, not once per holder — the multiplier belongs to the token.
  // MULTIPLIER_KEY is not a 0x address, so it cannot collide with a voter key.
  const MULTIPLIER_KEY = 'uiMultiplier';
  multi.call(MULTIPLIER_KEY, options.address, 'uiMultiplier', []);
  addresses.forEach(address =>
    multi.call(getAddress(address), options.address, 'balanceOf', [address])
  );

  const result: Record<string, BigNumberish> = await multi.execute();
  const { [MULTIPLIER_KEY]: uiMultiplier, ...balances } = result;

  // A genuine bStock returns 1e18 when no corporate action has been applied, so it never yields
  // 0 here. A token that is not one reverts and Multicaller throws — which is what we want. A
  // silent fallback to the raw balance would produce a plausible but wrong tally, which is the
  // single worst outcome available.
  if (!uiMultiplier || BigNumber.from(uiMultiplier).isZero()) {
    throw new Error(
      `uiMultiplier() returned 0 for ${options.address} at block ${blockTag}`
    );
  }

  // `toShares` is RHJ's exact-integer mulDiv, imported so the two chains cannot diverge.
  // The one lossy step is the final parseFloat, which every balance strategy in this repo
  // accepts: Snapshot scores are JS numbers and the whole pipeline downstream (sums, quorum,
  // delegation) is float, so anything wider would be discarded. Doing the multiply in floating
  // point instead is what is NOT acceptable — it compounds rounding and moves large holders by
  // whole wei.
  return Object.fromEntries(
    Object.entries(balances).map(([address, balance]) => [
      address,
      parseFloat(formatUnits(toShares(balance, uiMultiplier), options.decimals))
    ])
  );
}
