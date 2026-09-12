# CLAUDE.md

Fork of `snapshot-labs/score-api`, the voting-power engine of a self-hosted Snapshot
deployment for a shareholder voting product on Robinhood Chain (RHC, chain id 4663).
Deploys to Railway from GitHub.

## HARD RULES, NON-NEGOTIABLE

- The user never runs anything on their machine. Never output a command for them to
  run locally. No npm, no git clone, no CLI, no scripts, no downloads. Their machine
  holds wallets. Zero risk.
- All work happens in the cloud session and in Railway. Deploys are
  Railway-from-GitHub only.
- Never ask for, log, or handle private keys or seed phrases. Secrets are Railway
  environment variables the user sets; refer to them by name only.
- Before anything that involves a wallet, funds, secrets, a paid API, or an external
  account, stop and ask. List exactly what you need, why, and where the user enters
  it. Do not proceed until answered.

## Read-only

This service computes voting power and holds no keys. It must never be given a
signer.

## RHC facts, verified on-chain

- Chain id 4663 — `eth_chainId` returns `0x1237`.
- Multicall3 is at the canonical `0xcA11bde05977b3631167028862bE2a173976CA11` and is
  present from block 0, so it is a genesis predeploy and `start: 0` in networks.json
  is right.
- `erc20-balance-of` through Multicall3 at a historical block returns the same value
  as a direct `balanceOf` at that block. This was checked against a real holder, not
  assumed — it is the record-date snapshot the whole product rests on.
- `block.number` inside the EVM does **not** track the RPC block height (25.8M vs
  61.5M at the time of writing). Never take a record block from
  `Multicall3.getBlockNumber()`; use the RPC height, which is what Snapshot passes as
  the block tag.

## RPC

`src/helpers/provider.ts` builds every RPC URL as `${BROVIDER_URL}/${chainId}`, so
`BROVIDER_URL` must point at a brovider, never at a plain RPC endpoint. The default,
`https://rpc.snapshot.org`, already serves `/4663` **with archive state** — verified
by an `eth_call` at an old block. Leave `BROVIDER_URL` unset unless that stops being
true.

The public RHC endpoint `https://rpc.mainnet.chain.robinhood.com` is **not** an
archive node — a historical `eth_call` returns `metadata is not found`. It cannot
back this service. `https://robinhood-chain.gateway.tenderly.co` does serve archive
state if a fallback is ever needed.

## Strategies

Strategies are vendored in-tree at `src/strategies/strategies/`. There is no
dependency on the separate `snapshot-strategies` package — do not add one.

## Environment

| Name | Notes |
| --- | --- |
| `PORT` | 3003 |
| `DATABASE_URL` | Redis, not MySQL |
| `BROVIDER_URL` | optional, see above |

`@snapshot-labs/snapshot.js` is pinned to `^0.17.2` — the first published version
whose `networks.json` carries RHC 4663.

## Reporting

After each task: what you did, what's blocked, what you need from the user, in that
order. Short.
