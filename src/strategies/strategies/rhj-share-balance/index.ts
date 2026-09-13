import { getAddress } from '@ethersproject/address';
import { BigNumber, BigNumberish } from '@ethersproject/bignumber';
import { formatUnits } from '@ethersproject/units';
import { Multicaller } from '../../utils';

const abi = [
  'function balanceOf(address account) external view returns (uint256)',
  'function uiMultiplier() external view returns (uint256)'
];

/**
 * The RHJ `Stock` implementation scales the UI/share value with a hard-coded
 * source-level constant:
 *
 *   uint256 private constant DENOMINATOR = 1 ether;   // 1e18
 *   function balanceOfUI(address a) public view returns (uint256) {
 *     return Math.mulDiv(balanceOf(a), uiMultiplier(), DENOMINATOR);
 *   }
 *
 * The denominator is NOT derived from `decimals()`. Every RHJ token is 18
 * decimals today, but even if one were not, the divisor stays 1e18. Do not
 * replace this with 10 ** options.decimals.
 */
const DENOMINATOR = BigNumber.from('1000000000000000000');

// Key used for the single, shared uiMultiplier() read. It is not a 0x address,
// so it can never collide with a voter key.
const MULTIPLIER_KEY = 'uiMultiplier';

/**
 * shares = floor(rawBalance * uiMultiplier / 1e18)
 *
 * Exact integer arithmetic on purpose. `BigNumber.div` truncates toward zero,
 * which for non-negative operands is the same floor that OpenZeppelin's
 * `Math.mulDiv` (no rounding argument) performs on-chain. The remainder is
 * discarded, never rounded up and never carried - matching `balanceOfUI`
 * wei-for-wei.
 */
export function toShares(
  balance: BigNumberish,
  uiMultiplier: BigNumberish
): BigNumber {
  return BigNumber.from(balance).mul(uiMultiplier).div(DENOMINATOR);
}

export async function strategy(
  space: string,
  network: string,
  provider: any,
  addresses: string[],
  options: { address: string; decimals: number; symbol?: string },
  snapshot: string | number
): Promise<Record<string, number>> {
  if (!options.address) throw new Error('address parameter is required');

  // Both reads MUST happen at the record block. Reading a current multiplier
  // against a historical balance silently corrupts every past tally: the RHJ
  // multiplier flips on `block.timestamp >= effectiveAt` with no transaction,
  // no log and no state write, so "latest" can differ from the record block
  // even when not a single Transfer happened in between.
  //
  // The literal string 'latest' does NOT express that invariant, so it must
  // never reach the Multicaller. `Multicaller` hands its call list to
  // snapshot.js's multicall, which pages it at `limit` calls per eth_call
  // (default 500, snapshot.js/src/multicall/index.ts) and fires the pages
  // concurrently, each carrying the same options object. A literal 'latest' is
  // therefore re-resolved by the node once per page: `uiMultiplier` is call 0
  // and so always lands in page 0, while the 500th voter onward (call index
  // 500+) lands in a later eth_call that resolves against its own head. A flip
  // between two pages and part of the electorate is scored on the pre-flip
  // multiplier against post-flip balances - 4x wrong on a CRWD-class split.
  //
  // This is a routine path, not an exotic one: src/scores.ts silently rewrites
  // any snapshot above the current head to 'latest', and that head is cached
  // for 120s while RHC produces ~10 blocks/second, so a proposal scored soon
  // after its record block takes it. A shareholder vote with >= 500 voters is
  // the normal case, and 500 voters is already 501 calls, i.e. two pages.
  //
  // Resolving the tag to a concrete height once pins the multiplier and every
  // balance page to the same block, and makes a 'latest' score reproducible.
  const blockTag =
    typeof snapshot === 'number' ? snapshot : await provider.getBlockNumber();

  const multi = new Multicaller(network, provider, abi, { blockTag });

  // Read once per call, not once per holder - the multiplier is a property of
  // the token, not of the holder.
  multi.call(MULTIPLIER_KEY, options.address, 'uiMultiplier', []);
  addresses.forEach(address =>
    multi.call(getAddress(address), options.address, 'balanceOf', [address])
  );

  const result: Record<string, BigNumberish> = await multi.execute();

  const { [MULTIPLIER_KEY]: uiMultiplier, ...balances } = result;

  // `uiMultiplier()` returns 1e18 when nothing was ever scheduled, so a genuine
  // RHJ token never yields 0 here. If the configured address is not an RHJ
  // token the call reverts and Multicaller throws - which is what we want. A
  // silent fallback to the raw balance would produce a plausible-looking but
  // wrong tally.
  if (!uiMultiplier || BigNumber.from(uiMultiplier).isZero()) {
    throw new Error(
      `uiMultiplier() returned 0 for ${options.address} at block ${blockTag}`
    );
  }

  // Precision: the multiply/divide above is exact 256-bit integer math, so no
  // error is introduced while computing the share count. The single lossy step
  // is the final `parseFloat` - Snapshot scores are JS numbers and the whole
  // pipeline (sums, quorum, delegation) is float, so returning anything wider
  // would be discarded downstream anyway. An IEEE-754 double carries ~15.95
  // significant decimal digits, so an 18-decimal share count is faithful to
  // roughly 1e-16 relative error, e.g. 34159.399924293411976927 shares comes
  // back as 34159.399924293415 (~4e-12 shares off). That is the same limit
  // every other balance strategy in this repo accepts.
  //
  // What is NOT acceptable, and the reason for `toShares`, is doing the
  // multiply in floating point: converting the raw balance to a number first
  // and then multiplying by 4.0 compounds the rounding error and can move the
  // result by whole wei on large holders.
  return Object.fromEntries(
    Object.entries(balances).map(([address, balance]) => [
      address,
      parseFloat(formatUnits(toShares(balance, uiMultiplier), options.decimals))
    ])
  );
}
