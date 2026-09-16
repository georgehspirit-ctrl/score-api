# bloc-twab

Weight is the **time-weighted average balance** of a community token across a
ballot's voting window, not a balance at one block.

```
weight = (1 / (t_end − t_start)) · ∫ balance(t) dt
```

`snapshot` is the window's start — the proposal's own block. The end is the current
head while the ballot is open, and the sequencer re-scores once at close and freezes
the result, so the tally is the integral over the whole window.

## What this means for a holder

- Buy the token and you can sign straight away; the instruction records immediately.
- Weight grows for as long as you keep holding.
- Selling stops the accrual. It does not take back what was already earned.
- Holding the full window is the only way to score your full balance.

## How the curve is built

One archive `balanceOf` per voter at the start block, then every `Transfer` log
touching those voters, applied in order, with each block's own timestamp. The curve
is exact and piecewise-constant — it is not sampled, because an hourly sample is
both more RPC calls and coarse enough to miss a complete round trip.

Anyone can recompute a weight from public data: the start block, the token address,
and the voter's address are all on the proposal. `scripts/bloc-twab-verify.mjs` in
the site repo does exactly that, independently of this code, and prints the balance
series it used.

## Precision

Balances are integrated in wei with exact 256-bit integer arithmetic; the only lossy
step is the final conversion to a JS number, which every Snapshot strategy shares.
A balance is never clamped: if a log were missed the subtraction would underflow and
throw, rather than quietly scoring a wrong number.
