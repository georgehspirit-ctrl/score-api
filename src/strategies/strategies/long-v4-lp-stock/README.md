# long-v4-lp-stock

Voting power for a **Uniswap v4 liquidity provider**: the amount of the *stock token* actually
inside their position at the record block, credited to whoever owned the position then.

```json
{
  "name": "long-v4-lp-stock",
  "params": {
    "stock": "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    "symbol": "NVDA",
    "decimals": 18,
    "positions": ["1", "2", "3"]
  }
}
```

## Why it exists

A holder who provides liquidity in a Long.xyz pool no longer holds the stock token in their wallet
— the PoolManager does. `balanceOf` returns nothing for them, so before this they had **no voting
weight at all**, despite the shares being theirs, withdrawable at will, and exposed to the exact
corporate action on the ballot.

This is the same gap `rhj-share-balance` closed for Morpho collateral, and the same argument:
posting an asset somewhere does not stop you owning it.

## The method

For each position id, every read pinned to the record block:

1. **`getPoolAndPositionInfo(tokenId)`** on the PositionManager → the PoolKey
   (`currency0`, `currency1`, `fee`, `tickSpacing`, `hooks`) and a packed word carrying
   `tickLower` and `tickUpper`.
2. **Skip unless `currency0` or `currency1` is the stock.** A Long pool pairs a launched token
   against a numeraire; only the numeraire side is a share. Which side it is decides which amount
   is credited, and taking the wrong one is wrong by the pool price — orders of magnitude on a
   concentrated position.
3. **`poolId = keccak256(abi.encode(PoolKey))`.** The PositionManager's packed word carries only
   the **upper 200 bits** of this; using it as the id reads a different pool's storage, which does
   not fail — it returns a plausible price for the wrong market. Verified: for position 1 the
   computed id is `0xdb2c…13a5` and the packed word is `0xdb2c20421239d46bb30a7a73029b7f9b7f166489bfb972057d`,
   exactly its top 200 bits.
4. **Price from raw storage.** The PoolManager exposes `extsload` and nothing else —
   `getSlot0(bytes32)` is a helper in Uniswap's off-chain `StateLibrary`, not a function on the
   contract, and calling it reverts. So:
   `stateSlot = keccak256(abi.encode(poolId, 6))`, then `extsload(stateSlot)` → `sqrtPriceX96` in
   the low 160 bits, current tick in the next 24.
5. **`getPositionLiquidity(tokenId)`** → `L`.
6. **The band integral**, exact integer arithmetic, with `sqrtP` clamped into `[sqrtA, sqrtB]` so
   the three price cases collapse into one formula and no branch can go negative:

   ```
   amount0 = L·2^96·(sqrtB − sqrtP) / (sqrtP·sqrtB)
   amount1 = L·(sqrtP − sqrtA) / 2^96
   ```

   | price | the position holds |
   | --- | --- |
   | below the band | entirely `currency0` |
   | inside the band | both, split at the current price |
   | above the band | entirely `currency1` |

7. **`ownerOf(tokenId)` at the record block** is credited — never at head. A position NFT that
   changed hands after the record date scores to whoever held it **on** the record date, exactly
   as a transferred share would.

### Fees are not counted

Uncollected fees sit outside the liquidity band and are not share exposure until collected.
Counting them would credit weight for a quantity no corporate action touches. Only principal
inside the band is scored.

## How this was verified, not assumed

Three independent cross-checks against Robinhood Chain, all on live position #1 and its pool:

- **`POOLS_SLOT = 6`** — the derived slot yields `sqrtPriceX96 = 870035308126306014629383180975`
  at tick `47926`. A wrong slot constant returns zero or nonsense, and a nonsense price silently
  mis-splits every position in the pool.
- **Two contracts agree on one number.** The word at `stateSlot + 3` is `50,000,000,000,000`, which
  is exactly what `getPositionLiquidity(1)` returns from the PositionManager — different contract,
  different storage layout, same value.
- **The tick brackets the price.** `sqrtRatioAtTick(47926) ≤ sqrtPriceX96 < sqrtRatioAtTick(47927)`.
  This is the check that actually proves the TickMath: a floating-point `Math.pow` version
  reproduces the published constants at tick 0 / MIN / MAX and **fails this**, because the error
  only appears away from the anchors. `getSqrtRatioAtTick` is therefore the on-chain bit-twiddling
  algorithm reimplemented exactly, magic constants included — they are a fixed-point form of
  `1.0001^(-2^i)` and must not be "tidied".

## Why positions are passed in

The v4 PositionManager is **not enumerable**: `tokenOfOwnerByIndex` reverts and
`supportsInterface(0x780e9d63)` is false. There is no way to ask the chain which positions an
address holds — only `balanceOf`, which gives a count and no ids. The alternatives are scanning
3.5M `Transfer` logs on every scoring call, or freezing the ids into the proposal.

Freezing them is cheaper and more honest, and it is the same decision `rhj-share-balance` made for
Morpho market ids: the ballot states exactly which positions were counted and a reader can check
each one, rather than trusting a list that could change under them. The cost is that a position
opened after the ballot is not in it — which is correct anyway, since weight is a fact about the
record block.

## Robinhood Chain addresses

| | |
| --- | --- |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |

Both defaults; both overridable. The PositionManager's `poolManager()` returns the PoolManager
above, so the pair is self-consistent rather than two addresses someone wrote down.

## Precision

The band arithmetic is exact 256-bit integer maths. The one lossy step is the final `parseFloat`,
which every balance strategy here accepts: Snapshot scores are JS numbers and the whole pipeline
downstream (sums, quorum, delegation) is float, so anything wider would be discarded. What is *not*
acceptable is doing the band maths in floating point — the error compounds against `L`, which for a
concentrated position is enormous, so a 1e-12 relative slip becomes whole tokens of voting weight.
