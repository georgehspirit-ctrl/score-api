# uniswap-lp-stock

Counts a holder's Uniswap LP positions toward a stock's ballot, crediting the amount of the **stock
token** sitting inside each position at the snapshot block. Positions are discovered automatically,
from the chain, for every pool — not hand-listed.

This is the general version of `long-v4-lp-stock`. That strategy proved the amount maths on one
pool family with positions frozen into the proposal; this one keeps that maths verbatim and adds
on-chain discovery, so the claim "OnRecord counts Uniswap LP positions" is true without anyone
curating a list.

## Parameters

| param             | required | meaning |
|-------------------|----------|---------|
| `stock`           | yes      | The stock token whose ballot this is. A position counts only if one side of its pool **is** this token, and only that side is credited. |
| `decimals`        | yes      | Stock token decimals (18 on Robinhood Chain). |
| `symbol`          | no       | Display only. |
| `positionManager` | no       | v4 PositionManager. Default `0x58daec3116aae6D93017bAAea7749052E8a04fA7`. |
| `poolManager`     | no       | v4 PoolManager. Default `0x8366a39CC670B4001A1121B8F6A443A643e40951`. |
| `rpcUrl`          | no       | Endpoint the discovery log scan reads from. Default `https://rpc.mainnet.chain.robinhood.com`. |

## The method

For each voter, at the snapshot block:

1. **Discover.** `eth_getLogs` on the PositionManager for `Transfer(to = voter)`, from genesis to the
   snapshot block, in adaptive spans (10M wide, halving on any range / result-limit / timeout
   complaint, never skipping a span). The PositionManager is an ERC-721 whose `Transfer` has `to`
   indexed, so this returns every position id the voter ever received — no index, no database.
2. **Confirm ownership at the block.** `ownerOf(tokenId)` must equal the voter at the snapshot block.
   Discovery finds ids ever *received*; only the ones still held at the block count.
3. **Confirm the pool is this stock's.** `getPoolAndPositionInfo(tokenId)` gives the PoolKey; keep
   the position only if `currency0` or `currency1` is the `stock` token.
4. **Read the position and the price.** `getPositionLiquidity(tokenId)` for L; `poolId =
   keccak256(abi.encode(PoolKey))`; `extsload(keccak256(abi.encode(poolId, 6)))` for slot0 →
   `sqrtPriceX96`.
5. **Credit the stock side.** The constant-product band integral gives the amount of each currency
   in the position; the voter is credited the `stock`-side amount. Exact 256-bit integer arithmetic;
   the only float step is the final cast to a Snapshot score.

Steps 2–5 are `long-v4-lp-stock` unchanged — `poolIdOf`, `poolStateSlot`, `decodeSlot0`,
`decodeTicks`, `getSqrtRatioAtTick`, `amountsForLiquidity` are imported from it, not re-implemented.

## What it does and does not count

- **Fees are not counted.** Only principal inside the liquidity band is stock exposure; uncollected
  fees are not credited.
- **Contract-owned positions get nothing.** Only a position whose `ownerOf` is a voting address is
  credited. Locked launch liquidity and vault-held LP are owned by contracts, which do not vote, so
  they score zero — unless such a contract is itself wired as a counted venue, and none is.
- **No double counting with wallet balance.** The stock in a pool is held by the PoolManager, not in
  the voter's wallet, so a wallet-balance strategy and this one count disjoint tokens.

## Discovery is additive only

A log scan can only surface more candidate ids; it can never invent a position. Every credited
number — ownership, liquidity, price — is read from the chain at the snapshot block. A missed id
undercounts one holder; it can never credit weight that is not on chain. The default discovery
endpoint errors at its block-span cap rather than truncating a wide query silently (the Tenderly
gateway truncates without erroring, which would undercount), and the scan splits on that error.

## Chain scope

Robinhood Chain (4663) has **only Uniswap v4**: the v2 factory address holds no code, the canonical
v3 factory address holds an unrelated contract with no `PoolCreated` history, and the v4 PoolManager
has tens of thousands of pools. There are no v2/v3 LP positions to count here; if either is ever
deployed, a branch is added rather than shipped as dead code.
