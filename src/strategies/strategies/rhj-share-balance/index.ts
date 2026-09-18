import { getAddress } from '@ethersproject/address';
import { BigNumber, BigNumberish } from '@ethersproject/bignumber';
import { formatUnits } from '@ethersproject/units';
import { Multicaller } from '../../utils';

const abi = [
  'function balanceOf(address account) external view returns (uint256)',
  'function uiMultiplier() external view returns (uint256)'
];

/**
 * Morpho Blue's position getter. `collateral` is the third return value.
 *
 * A holder who posts their stock as collateral no longer holds the token — the
 * Morpho singleton does — so `balanceOf` returns zero and, until this existed,
 * they could not vote at all. They had not sold anything and had not stopped
 * owning the position; they had borrowed against it, which is the one thing a
 * shareholder is most obviously still a shareholder while doing. Eighteen
 * wallets were in exactly that state when this was written.
 */
const morphoAbi = [
  'function position(bytes32 id, address user) external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)'
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
  options: {
    address: string;
    decimals: number;
    symbol?: string;
    /** Morpho Blue singleton. Omit and the strategy behaves exactly as before. */
    morpho?: string;
    /** Market ids whose collateralToken is `address`. Frozen into the proposal. */
    markets?: string[];
  },
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

  const extraCollateral: Record<string, BigNumber> = {};

  const multi = new Multicaller(network, provider, abi, { blockTag });

  // Read once per call, not once per holder - the multiplier is a property of
  // the token, not of the holder.
  multi.call(MULTIPLIER_KEY, options.address, 'uiMultiplier', []);
  addresses.forEach(address =>
    multi.call(getAddress(address), options.address, 'balanceOf', [address])
  );

  /**
   * Collateral counts, and it is read at the SAME pinned block as everything else.
   *
   * The market list is passed in rather than discovered: Morpho Blue keeps no
   * enumerable registry on-chain, so the alternative is scanning CreateMarket logs
   * on every scoring call. Freezing the ids into the proposal is both cheaper and
   * more honest — the ballot then states exactly which markets were counted, and a
   * reader can check each one rather than trust a list that could change under them.
   * The cost is that a market created after a ballot opens is not in it.
   */
  const markets = (options.markets ?? []).filter(Boolean);
  const collateralKey = (a: string, id: string) => `${a}|${id}`;
  if (options.morpho && markets.length) {
    const morpho = new Multicaller(network, provider, morphoAbi, { blockTag });
    addresses.forEach(address =>
      markets.forEach(id =>
        morpho.call(collateralKey(getAddress(address), id), options.morpho as string, 'position', [id, address])
      )
    );
    const positions: Record<string, any> = await morpho.execute();
    for (const [key, pos] of Object.entries(positions)) {
      const [address] = key.split('|');
      // A revert would have thrown; a market that simply has no position for this
      // wallet returns zeros, which adds nothing and needs no special case.
      const collateral = BigNumber.from(pos?.collateral ?? pos?.[2] ?? 0);
      if (!collateral.isZero()) {
        extraCollateral[address] = (extraCollateral[address] ?? BigNumber.from(0)).add(collateral);
      }
    }
  }

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
      parseFloat(
        formatUnits(
          // Wallet balance plus anything of theirs Morpho is holding. Summed BEFORE
          // the multiplier so the split/dividend restatement applies once, to the
          // whole position, exactly as it would if the tokens had never moved.
          toShares(BigNumber.from(balance).add(extraCollateral[address] ?? 0), uiMultiplier),
          options.decimals
        )
      )
    ])
  );
}
