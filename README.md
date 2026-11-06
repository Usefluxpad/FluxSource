# FluxPad — One Launchpad. Two Routes.

FluxPad is a standalone Solana token launchpad with **two launch routes**:

- **Route A — Pump.fun bonding curve → PumpSwap** (official `@pump-fun/pump-sdk`, `create_v2`)
- **Route B — Raydium LaunchLab bonding curve → Raydium CPMM** (official `@raydium-io/raydium-sdk-v2`, `launchpad.createLaunchpad`)

Users choose the ecosystem; FluxPad builds the correct route-specific
transaction, shows fees and details **before signing**, submits with safe
retries, and tracks the token lifecycle (curve trading → graduation → verified
destination pool) using **on-chain state as the sole source of truth**.

## Stack

| Layer | Choice |
| --- | --- |
| App | Next.js 15 (App Router), React 19, TypeScript (strict) |
| Styling | Tailwind CSS (light-first "Electric Blue" system, dark mode) |
| Wallet | `@solana/wallet-adapter-react` (Phantom, Solflare) — user-signed only |
| Solana | `@solana/web3.js` 1.98.x, `@solana/spl-token` |
| Pump route | `@pump-fun/pump-sdk` **4.0.0** (pinned) |
| Raydium route | `@raydium-io/raydium-sdk-v2` **0.2.74-alpha** (pinned) |
| Persistence | PostgreSQL + Prisma (launch records, lifecycle audit, upload audit) |
| Uploads | Server-side IPFS pinning via Pinata (credentials stay on the server) |
| Tests | Vitest (unit) — see below for integration scope |

## Quick start

```bash
npm install --legacy-peer-deps
cp .env.example .env.local        # fill in DATABASE_URL / RPC / PINATA_JWT
npm run prisma:generate
npx prisma migrate deploy         # or: npx prisma migrate dev
npm run dev                       # http://localhost:3000
```

Scripts:

```bash
npm run build        # production build (also runs type checking)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint (next config)
npm test             # vitest unit suite
```

## Feature map

| Area | Status |
| --- | --- |
| Wallet connect (Phantom/Solflare), devnet default | Implemented |
| Shared creation flow (validate → upload → config → build → review → sign → confirm → verify) | Implemented |
| Route A: Pump `create_v2`, optional create+buy, curve tracking, PumpSwap pool verification | Implemented (see verification notes) |
| Route B: LaunchLab `createLaunchpad` (cpmm), config validation, curve tracking, CPMM verification | Implemented (see verification notes) |
| Vanity mint engine (Web Worker, cancellable, ephemeral keys, honest difficulty) | Implemented |
| Metadata/artwork upload with server-side credentials + audit log | Implemented (requires `PINATA_JWT`) |
| PostgreSQL/Prisma launch registry, idempotent events, on-chain reconciliation | Implemented (requires `DATABASE_URL`) |
| Dashboard, token pages, launch status, settings, error/loading/empty states | Implemented |
| Automated unit tests (vanity, metadata, tx engine, adapters, PDA fixtures) | Implemented — run `npm test` |
| Live token market data on token pages (DexScreener/GeckoTerminal venue resolution, provider OHLCV charts, honest unavailable states) | Implemented |
| PumpPortal-powered live trending feed (keyless tier via on-chain RPC poller) | Implemented |
| Light / Dark / System theming (persisted preference) | Implemented |
| End-to-end devnet transaction execution for both routes | **Requires a funded devnet wallet + RPC; see docs/VERIFICATION.md** |

## Architecture

```
src/
  app/                    # Next.js App Router pages + API routes
    api/launches/         # registry CRUD + idempotent event/reconcile endpoint
    api/upload/           # server-side Pinata IPFS upload (validated, audited)
  components/             # brand, design system, wallet UI, launch flow UI
  hooks/
    use-launch-flow.ts    # shared launch orchestration (both routes)
    use-vanity-mint.ts    # Web Worker harness for vanity search
  lib/
    adapters/
      types.ts            # RouteAdapter contract (both routes implement it)
      pump.ts             # Route A: pump-sdk create_v2 (+buy), curve, PumpSwap verify
      launchlab.ts        # Route B: LaunchLab createLaunchpad, curve, CPMM verify
      index.ts            # lazy registry
    tx-engine.ts          # submit/confirm with safe retries + error taxonomy
    reconcile.ts          # server-side lifecycle reconciliation (chain = truth)
    vanity/               # pure vanity search core (worker-safe)
    metadata.ts           # zod validation shared by client + server
    constants.ts          # documented program IDs + PDA derivations
    db.ts                 # lazy Prisma client (graceful degradation)
  workers/vanity-worker.ts
prisma/schema.prisma      # Launch, LaunchEvent (idempotent), UploadAudit
docs/                     # verification, smoke-test guide, architecture notes
```

## Security model

- **No custody.** The server never signs user transactions. Only the wallet
  signs (plus the locally-generated mint keypair, held in tab memory only).
- **Vanity keys never leave the worker/page memory.** No storage, no logging,
  no network. Refresh loses them — the UI says so.
- **Upload credentials** (`PINATA_JWT`) are server-only; uploads are validated
  (type, size, URI) and audited.
- **Safe retries:** a submitted signature is always resolved before any retry;
  idempotency keys prevent duplicate launch records.
- **Honest status:** a launch is "confirmed" only when the mint account exists
  on-chain; graduation/pool status come from protocol accounts, never from the
  database's own judgment.
- Test networks are the default (`NEXT_PUBLIC_FLUXPAD_NETWORK=devnet`);
  mainnet requires an explicit config change.

## What is *not* verified automatically

See [docs/VERIFICATION.md](docs/VERIFICATION.md) for the honest list:
devnet/mainnet transaction execution, graduation observability (long-running
curve), Raydium discovery-service availability, and the manual smoke-test
guide ([docs/SMOKE_TEST_GUIDE.md](docs/SMOKE_TEST_GUIDE.md)).
