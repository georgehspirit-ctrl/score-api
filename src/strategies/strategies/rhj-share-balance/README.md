# rhj-share-balance

Voting power for Robinhood Assets Jersey (RHJ) tokenised stocks on Robinhood
Chain (chain id 4663), measured in **shares**, not in raw token units.

```json
{
  "address": "0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931",
  "symbol": "CRWD",
  "decimals": 18
}
```

## Why `erc20-balance-of` is wrong for these tokens

An RHJ token's `balanceOf` is **not** a share count. The token carries a
per-token, issuer-mutable scaling factor and exposes the share count through a
separate view:

```solidity
uint256 private constant DENOMINATOR = 1 ether;         // 1e18

function balanceOfUI(address account) public view returns (uint256) {
    return Math.mulDiv(balanceOf(account), uiMultiplier(), DENOMINATOR);
}
```

So the correct voting weight is

```
shares = floor(balanceOf(holder) * uiMultiplier() / 1e18)
```

`Math.mulDiv` with no rounding argument truncates toward zero, so the remainder
is discarded — never rounded up, never carried. This strategy reproduces that
exactly with 256-bit integer arithmetic.

### The CRWD example

CRWD went through a 4:1 split. Its `uiMultiplier()` is `4000000000000000000`
(4.0). At block `62000000`, the Uniswap v4 PoolManager
`0x8366a39CC670B4001A1121B8F6A443A643e40951` held:

| read | value |
| --- | --- |
| `balanceOf` | `37313039042191719225` (37.313039 raw units) |
| `uiMultiplier` | `4000000000000000000` |
| `balanceOfUI` | `149252156168766876900` (149.252156 shares) |

Re-derive it yourself — every number in this file is a live `eth_call`, and the
block is part of the claim:

```
curl -s https://robinhood-chain.gateway.tenderly.co -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{
        "to":"0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931",
        "data":"0x70a082310000000000000000000000008366a39cc670b4001a1121b8f6a443a643e40951"
      },"0x3b20b80"]}'
# 0x...205d28b50e01e7b39 = 37313039042191719225
```

`erc20-balance-of` would hand that holder **37.31**. Its real weight is
**149.25**. Every CRWD holder would get exactly one quarter of their
entitlement, and the tally would still look completely plausible.

The error is not always this loud. NVDA's multiplier is
`1000775159164630595` (1.000775…), which understates every NVDA holder by
0.0775% — small enough to pass a sanity check and large enough to flip a close
vote. 19 of the ~194 RHJ tokens currently have a multiplier other than 1.0, and
the set changes.

## Why both reads must be at the record block

`uiMultiplier()` is a function of `block.timestamp`, not of any transaction:

```solidity
function uiMultiplier() public view returns (uint256) {
    if (block.timestamp >= $._effectiveAt && $._newMultiplier != 0)
        return $._newMultiplier;
    ...
}
```

The issuer *schedules* a change in advance and it then flips itself at a
wall-clock instant — no transaction, no log, no state write. For NVDA the flip
landed between two adjacent blocks:

```
blk 58958492  ts 1788998429  uiMultiplier 1.000000000000000000  balanceOfUI 29326133381176238082734
blk 58958493  ts 1788998430  uiMultiplier 1.000775159164630595  balanceOfUI 29348865802229836061862
```

with an **identical** raw `balanceOf` across the two blocks and no transaction
touching the token in either. Consequences:

- The strategy reads `balanceOf` **and** `uiMultiplier` at the same `blockTag`.
  Pairing a historical balance with a current multiplier silently corrupts every
  past tally, and nothing in the result would look wrong.
- A `'latest'` snapshot is resolved to a **concrete block number** before any
  call is made. `'latest'` cannot be passed through: `Multicaller` pages the
  call list at 500 calls per `eth_call` and fires the pages concurrently, and
  each page's `'latest'` is resolved independently by the node. `uiMultiplier`
  is call 0, so it always sits in the first page; with 500+ voters the
  remaining balances arrive from later blocks. Pinning the height up front also
  makes a preview score reproducible.
- A record date must be pinned to a **block number**. A record date expressed as
  a date/time is ambiguous within one second.
- Multiplier moves are not monotone and are not always corporate actions: WEEK
  went 1.0 → 2.0 and back to 1.0 fifteen minutes later.

A pending change can never rewrite the past — `updateMultiplier` requires
`effectiveAt >= block.timestamp` — so a historical snapshot is stable forever.
But a pending change *is* publicly visible on-chain before it takes effect, so
if your record block sits inside that window you will tally pre-split weights
for an action the market has already priced. Check `effectiveAt()` against the
record block's timestamp before publishing a tally. (`newUIMultiplier()` is not
a usable "is something pending" test — it returns 1e18 when nothing was ever
scheduled.)

## Precision

The multiply and divide are exact 256-bit integer operations, so the share count
is computed wei-for-wei identically to `balanceOfUI`. The only lossy step is the
final conversion to a JS `number`, which every Snapshot strategy performs
because scores are floats end to end. A double carries ~15.95 significant
decimal digits, so an 18-decimal share count is faithful to roughly 1e-16
relative error (e.g. `34159.399924293411976927` → `34159.399924293415`).

What this strategy deliberately avoids is doing the multiplication in floating
point. Converting the balance to a number first and then multiplying by the
multiplier compounds the rounding error, and on a 4.0 multiplier amplifies it
fourfold.

## Not handled here, on purpose

- **Pooled custody.** The Uniswap v4 PoolManager holds ~40% of the fleet's
  supply and is the largest holder on 192 of ~194 tokens; Morpho Blue holds
  collateral on 23 more. A plain balance snapshot hands most of the float to two
  contracts. Deciding whether to exclude them or resolve LP/collateral positions
  back to beneficial owners is a governance question, not a strategy question —
  compose this with an exclusion list or a custody-resolving strategy.
- **Blocked addresses.** `isBlocked(address)` lives on the shared registry
  `0xe10b6f6B275de231345c20D14Ab812db62151b00`, not on the token, and it gates
  transfers only — a blocked holder keeps their full balance and reads normally.
  Whether a frozen account keeps voting power is a policy decision; if you want
  them excluded, make it an explicit, documented filter pinned to the record
  block, not a side effect of which function got called.
