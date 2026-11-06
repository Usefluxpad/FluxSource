# FluxPad architecture notes

## Route separation

`RouteAdapter` (src/lib/adapters/types.ts) is the shared contract: loadConfig,
prepareLaunch, readCurveState, verifyPool. Everything above the adapters
(wallet wiring, submission, UI) is protocol-agnostic; everything inside an
adapter is protocol-specific. Pump and LaunchLab logic never mix — shared UX,
separated transaction building.

## Transaction flow

1. **Client builds.** Both SDKs construct transactions in the browser. The
   mint keypair (standard or vanity) signs locally; the wallet signs as
   fee-payer via wallet-adapter.
2. **Engine submits** (src/lib/tx-engine.ts): simulation where possible,
   preflight enabled, retries only when *nothing* was accepted, explicit
   resolution of ambiguous signatures before any retry, typed error taxonomy.
3. **Chain is truth.** Success requires the mint account to exist on-chain.
   Graduation/pool status are read from protocol accounts by the adapters.
4. **Registry records observations** (Prisma). `LaunchEvent` rows are
   idempotent (`(launchId, dedupeKey)` unique), so retries/duplicates are
   harmless. `resolveLaunch` (src/lib/reconcile.ts) re-reads the chain and
   only records transitions backed by account reads.

## Vanity engine

`vanity-core.ts` is pure and worker-safe. The worker (`vanity-worker.ts`)
runs bounded batches of `Keypair.generate()` (CSPRNG via @solana/web3.js),
streams progress, transfers the found secret buffer once, and is killed on
cancel/unmount. No persistence anywhere.

## Why adapters differ

- Pump: Token-2022, 6 decimals, create_v2, optional bundled create+buy,
  migration handled by pump.fun's protocol; canonical PumpSwap pool PDA
  verified after `isBondingCurveMigrated`.
- LaunchLab: SPL/Token-2022 via config, `createLaunchpad` with
  `migrateType: "cpmm"`, `extraSigners: [mintKeypair]` required, graduation by
  Raydium's migration wallet, CPMM pool discovered via Raydium's launch-mint
  service and verified on-chain against the CPMM program owner.
