# bstocks-share-balance

Voting power for **bStocks** — tokenized shares issued by BTech Holdings Limited on BNB Smart
Chain (56). Returns the holder's share count as restated to a proposal's record block.

```json
{
  "name": "bstocks-share-balance",
  "params": {
    "address": "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436",
    "symbol": "NVDAB",
    "decimals": 18,
    "registry": "0x…",
    "deployBlock": 102441275
  }
}
```

## What it computes

```
shares = floor(balanceOf(holder) * uiMultiplier() / 1e18)
```

Both reads are pinned to the same record block.

## bStocks use a multiplier, not a rebase

This was the one thing that had to be checked rather than assumed, and the assumption was wrong.
bStocks were expected to rebase — balances restated in place, no multiplier — which would have
meant reading `balanceOf` directly as the share count. They do not. Every bStock exposes
`uiMultiplier()` and `balanceOfUI()`, exactly like the RHJ tokens on Robinhood Chain, and
`balanceOf` holds **raw shares**.

NVDAB's first dividend took effect at block **120970451** (2026-09-10 00:00:00 UTC). Read either
side of it, for the PancakeSwap NVDAB/USDT pool `0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C`:

| block | `uiMultiplier()` | `balanceOf` | `floor(balance × mult / 1e18)` |
| --- | --- | --- | --- |
| 120970450 | 1000000000000000000 | 5544913841234058720298 | 5544913841234058720298 |
| 120970451 | 1000778223752807865 | 5544913841234058720298 | 5549229024892580163605 |

The balance does not move by one wei. Only the multiplier moves. So reading `balanceOf` as the
share count makes a dividend **invisible** — identical voting weight before and after a corporate
action that really did change what holders own. Here that is 0.0778%; a 4:1 split would be 4×.
Small enough to survive a spot check, large enough to decide a close vote, silent either way.

It is not uniform across tickers, either. At the time of writing NVDAB, AAPLB and QQQB have
multipliers above 1e18 while TSLAB, COINB, MSTRB, BMNRB and SPCXB are still exactly 1e18 — so a
test written against one of the latter passes under *both* models and proves nothing. Test
against a ticker whose multiplier has actually moved.

Confirmed independently at head against four live holders, where
`balanceOfUI(h) == floor(balanceOf(h) × uiMultiplier() / 1e18)` and `!= balanceOf(h)` for all
four. Same 1e18 denominator, same floor, same wei as RHJ.

The issuer's own copy calls it "a built-in rebase mechanism … Multiplier", which reads as either
model. The chain settles it.

### No event marks a dividend

The dividend block's timestamp is exactly midnight UTC and the holder's balance is untouched: the
multiplier flips on a timestamp comparison, with no transaction, no log and no state write. A
dividend cannot be detected by watching logs, and "no transfers happened" is not evidence that
nothing changed. The only correct way to know the multiplier for a ballot is to read it **at that
ballot's record block**, which is what this strategy does.

## Relationship to `rhj-share-balance`

The arithmetic is *imported* from `rhj-share-balance`, not copied, so the two chains cannot drift
apart on the one calculation that must never differ. What is different here is everything around
it:

**Authenticity.** RHJ tokens live on a chain where nobody else deploys. BSC is open, and
impersonators exist right now — `0x94aa91E490FF7555c8703608C2a9bF4B548e1402` calls itself "Tesla
Tokenized bStocks" with symbol `TSLAB` and is not one: 8 decimals, not a proxy, no multiplier.
Symbol and name are worthless as identity, so this strategy checks two things that cannot be
spoofed by metadata:

- **the registry** (`registry`, `requireTier`) — the token must hold the required tier in the
  on-chain OnRecord Registry at the record block. This is what makes the whitelist load-bearing
  rather than decorative. Tier 1 is an issuer-backed share; tier 2 is a Four.meme 4Stock, which
  tracks a share without being one and must never be scored as share weight.
- **the issuer beacon** (`beacon`) — every genuine bStock is an EIP-1967 **beacon** proxy pointing
  at `0x156d6dce9a4f6139a3406f1f021f1a4880de93a3`. Note *beacon*, not the more familiar
  implementation slot: bStocks leave the implementation slot empty, so checking that one instead
  reads zero on a genuine token and would reject all of them.

**Collateral.** RHJ counts Morpho Blue positions. BSC lending is Venus and Lista, a different
interface, wired separately.

## The archive canary

Voting power is read at a historical block, and a pruned node has two ways to respond: it errors,
which is loud and fine; or it answers from head, which makes every balance today's balance and
produces a wrong tally with no error anywhere.

So the strategy runs a positive test rather than trusting the endpoint. At a block before the
token was deployed, a node serving real historical state **must** return empty code. Bytecode from
that block proves the node is answering from head, and scoring refuses. `deployBlock` narrows the
probe; otherwise it uses block 1, which is safe on BSC because the chain launched in 2020 and every
bStock was deployed years later.

An *error* from the probe is deliberately not a failure. A node that refuses the call is not lying
about it, and the reads that follow are on the same endpoint at the same block tag — if it cannot
serve those either, they throw on their own. Failing here on a network blip would take scoring
down for a reason unrelated to the data.

### BSC archive endpoints are scarce

Of fourteen keyless BSC endpoints tested, exactly one served historical state:
`https://bsc-mainnet.public.blastapi.io`. The Binance dataseeds, `bsc-rpc.publicnode.com`,
`1rpc.io/bnb`, `bsc.blockrazor.xyz`, `bsc.meowrpc.com` and the defibit and ninicoin dataseeds all
reject historical calls outright. That one working endpoint is Alchemy's public tier and
rate-limits `eth_getLogs`, so production should point at a keyed archive provider; treat the public
URL as a fallback, not the plan.

## Parameters

| param | required | meaning |
| --- | --- | --- |
| `address` | yes | the bStock **proxy** on BSC |
| `decimals` | yes | 18 for every genuine bStock; formatting only |
| `symbol` | no | display only |
| `registry` | no, recommended | OnRecord Registry; enforces the tier at the record block |
| `requireTier` | no | `1` share (default), `2` pre-share / 4Stock |
| `beacon` | no | expected beacon; defaults to the bStocks beacon, `false` disables |
| `deployBlock` | no | narrows the archive canary |

## Precision

`toShares` is exact 256-bit integer `mulDiv`, floored, matching `balanceOfUI` wei for wei. The one
lossy step is the final `parseFloat`, which every balance strategy here accepts: Snapshot scores
are JS numbers and the whole pipeline downstream (sums, quorum, delegation) is float, so anything
wider would be discarded. What is *not* acceptable is doing the multiply in floating point — it
compounds rounding and moves large holders by whole wei.
