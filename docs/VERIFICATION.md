# Verification notes (honest scope)

This file records what FluxPad *does* and *does not* claim to have verified.

## Runtime verification session (latest)

Performed against the running application on this machine:

- **Dependencies**: complete (documented install command `npm install --legacy-peer-deps`).
- **Database**: no PostgreSQL server exists in this environment (nothing
  listens on 5432; no service, no install, no Docker). Per the documented
  constraint path, local development uses Prisma's **SQLite** provider
  (`file:./prisma/dev.db`); the schema/models are identical and the provider
  is annotated in `prisma/schema.prisma`. Migration `20261013005509_init`
  was created and applied; `prisma migrate dev` reports the database in sync.
  Production should point `DATABASE_URL` at PostgreSQL and switch the provider
  back to `"postgresql"`.
- **Server**: `next dev` verified on **http://localhost:3210** (port 3000 is
  occupied by an unrelated application on this machine); production
  `next build` + `next start` also verified. A clean build must be produced
  with the dev server stopped — building while `next dev` is running corrupts
  `.next` (observed: 500 responses from the production server until rebuild).
- **Pages verified over HTTP** (status 200 + FluxPad branding): `/`,
  `/create`, `/tokens`, `/dashboard`, `/settings`, `/tokens/<record-id>`.
  Registry records created during verification render on the tokens list and
  detail pages.
- **Registry API verified**: create (200), duplicate idempotency key (200,
  no duplicate row), list + creator filter (200), invalid symbol (400
  `validation_failed`), missing record (404), event recording idempotent
  (duplicate event → exactly one timeline entry), upload without credentials
  (503 honest `upload_not_configured`).
- **Known cosmetic issue**: pages that call `notFound()` render the correct
  not-found boundary, but Next's streamed dynamic rendering keeps the HTTP
  status at 200 in both dev and prod (the API routes correctly return 404).
- **Runtime fixes applied during verification** (smallest-change policy):
  1. LaunchLab adapter now passes `platformId:
     DEVNET_PROGRAM_ID.LAUNCHPAD_PLATFORM` on devnet — the SDK's default
     Raydium platform account does not exist on devnet and `createLaunchpad`
     failed with "platform id not found" without it.
  2. Server pages (`/tokens`, `/tokens/[mint]`, `/launch/[sig]`) read the
     registry through Prisma directly instead of HTTP self-fetching via
     `NEXT_PUBLIC_APP_URL`, which could hit a wrong service when the
     configured port is occupied.

## Protocol verification (devnet, no transactions submitted)

Devnet RPC verified reachable (`getSlot` succeeded). Script:
`scripts/protocol-check.js` (mirrors adapter logic 1:1).

**Route A — Pump (verified on devnet):**
- Program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` Global account loads
  live: `feeBasisPoints=95`, `createV2Enabled=true`,
  `initialVirtualSolReserves=1_000_000_000`.
- `createV2Instruction` builds a valid transaction: program ID matches the
  documented address, the mint keypair signs locally, message serializes
  (743 bytes), plus a create+buy bundle path via `createV2AndBuyInstructions`.
- Simulation executes and surfaces on-chain failures honestly (an unfunded
  payer fails with `AccountNotFound` — simulation ≠ confirmation, and nothing
  was submitted).
- Curve-state read for an unknown mint fails with the typed PROTOCOL error
  (no fabricated state).

**Route B — LaunchLab (verified on devnet):**
- Devnet program `DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6` is deployed
  with a live SOL-quoted config (configId `7ZR4zD7PYfY2XxoG1Gxcy2EgEeGYrpxrwzPuwdUBssEt`,
  curveType 0, tradeFeeRate 2500, minFundRaisingB 1).
- `createLaunchpad` (migrateType cpmm, extraSigners=[mintKeypair], devnet
  platformId) builds 1 V0 transaction requiring 2 signatures (payer + mint);
  the mint and LaunchLab program are in the account keys. **Nothing is
  executed.**
- Curve-state read for an unknown mint fails with the typed PROTOCOL error.

**Not yet verified (requires a funded devnet wallet + explicit human approval):**
- Submitting and confirming a real launch on either route (see
  docs/SMOKE_TEST_GUIDE.md). Do not conduct an on-chain launch without
  approval.
- Graduation observation and destination-pool verification on live curves.
- Wallet-adapter browser signing of the SDK-built transactions.
- Metadata upload with real PINATA_JWT credentials.

## SDK inventory (verified during development)

- `@pump-fun/pump-sdk@4.0.0` — `createV2Instruction`, `createV2AndBuyInstructions`,
  `OnlinePumpSdk.fetchGlobal`, `decodeBondingCurve`, `bondingCurvePda`,
  `isBondingCurveMigrated`, `canonicalPumpPoolPda`, `getBuyTokenAmountFromSolAmount`.
- `@raydium-io/raydium-sdk-v2@0.2.74-alpha` — `Raydium.load`,
  `launchpad.createLaunchpad`, `TxVersion.V0`, `getPdaLaunchpadConfigId`,
  `getPdaLaunchpadPoolId`, `LaunchpadConfig.decode`, `LaunchpadPool.decode`
  (field names verified by decoding a zeroed buffer), program IDs.
- LaunchLab usage cross-checked against the official demo repo.

## Vanity Mint CA Generator (latest session)

Reused the existing engine (`vanity-core.ts`, `vanity-worker.ts`,
`use-vanity-mint.ts`) and polished the two UI entry points:

- **Standalone page** `/vanity` (sidebar: "Vanity Mint Generator") and the
  create-flow panel "Generate Custom CA" (`src/components/launch/vanity-panel.tsx`,
  rendered by `src/app/create/page.tsx`).
- **Pattern kinds**: prefix, suffix, contains — with an optional
  case-insensitive match (Base58 addresses contain both cases; the generated
  address keeps its real case and is always verified against the actual key).
- **Controls**: Start / Pause / Resume / Cancel / Discard with honest
  cumulative attempt counters (resume continues the search; attempts and
  elapsed time accumulate, nothing resets silently).
- **Live metrics**: attempts, elapsed time, measured attempts/sec. The
  difficulty estimate (≈33ⁿ attempts) is labelled as an estimate; no
  completion time is promised, and progress never fakes.

**Security model (unchanged, verified):**
- Real ed25519 keypairs via `Keypair.generate()` in a Web Worker; the secret
  key is transferred once to the launching tab's memory and nowhere else.
- Nothing persisted (no DB, localStorage, or network calls); workers are
  terminated on pause/cancel/unmount.
- Export is explicit and user-confirmed (`export-keypair.ts`): Solana-CLI-format
  JSON download, with the secret-key warning displayed in the UI.
- Launch flow re-verifies the mint address against the keypair before review
  (`use-launch-flow.ts`) and aborts on mismatch.

**Launch-route compatibility (SDK inspection):**
- **Pump.fun → PumpSwap**: `PumpAdapter` accepts `mintKeypair` and
  `tx.partialSign(mintKeypair)`; `supportsVanityMint: true`. The mint keypair
  signs locally before the wallet signs.
- **Raydium LaunchLab → CPMM**: `LaunchLabAdapter` passes `mintA:
  mintKeypair.publicKey` with required `extraSigners: [mintKeypair]` plus
  `ensureMintSignature` on the built V0 transaction; `supportsVanityMint: true`.
- Users who skip the generator keep the standard random-mint flow
  (`vanityKeypair ?? Keypair.generate()`).

**Verification this session:** `tsc --noEmit` exit 0; unit suite 49/49
(6 files) including a new case-insensitive suffix search test that verifies
the found address against its keypair round-trip; `/vanity` served 200 over
HTTP with the full UI (kind selector, case toggle, security warning).

## Mainnet migration (Alchemy)

`NEXT_PUBLIC_FLUXPAD_NETWORK` migrated to `mainnet-beta` with Alchemy as the
dedicated server-side RPC. Verified live: `node scripts/rpc-check.js` →
`provider: alchemy`, real `getSlot` OK (mainnet slot returned, key redacted in
all output).

Per-layer mapping when cluster = `mainnet-beta`:
- **Server RPC** (`resolveServerNetworkConfig`): `ALCHEMY_SOLANA_RPC_URL`
  (solana-mainnet.g.alchemy.com) — discovery + reconcile + tx confirmation.
- **Discovery hosts**: Raydium API v3 → `api-v3.raydium.io`; LaunchLab Mint
  API → `launch-mint-v1.raydium.io` (documented mainnet hosts).
- **LaunchLab adapter**: `programFor("mainnet-beta")` → `LAUNCHPAD_PROGRAM`
  (`LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`); Raydium SDK loads with
  `cluster: "mainnet"`; the devnet-only `platformId` override is skipped.
- **Pump adapter**: mainnet Pump program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`)
  and PumpSwap (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`) are the
  unconditional constants — correct for mainnet.
- **Wallet/browser connection**: keyless public mainnet endpoint
  (`NEXT_PUBLIC_SOLANA_RPC_URL` or `api.mainnet-beta.solana.com`) — the Alchemy
  key is never exposed to the client bundle (requirement).
- **Reconciliation**: `resolveServerNetworkConfig(launch.network)` → Alchemy
  mainnet for on-chain lifecycle verification.

**Devnet testing preserved**: setting `NEXT_PUBLIC_FLUXPAD_NETWORK=devnet`
reverts every layer to Devnet (public devnet RPC or a `SOLANA_RPC_URL`, devnet
Raydium hosts, `DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM` + devnet platform config).

**Safety**: no real transactions were submitted; the only mainnet RPC calls are
read-only (`getSlot`, plus discovery/reconcile reads). Alchemy credentials live
in gitignored `.env.local` only and are redacted from all tool output.

## PumpSwap discovery CU optimization (Alchemy rate-limit fix)

The PumpSwap `pumpfun.pool` feed was the dominant Alchemy compute-unit
consumer: every refresh ran one full `getProgramAccounts` scan over **every**
PumpSwap pool on mainnet (tens of thousands) plus 12
`getMultipleAccountsInfo` calls reading 480 accounts (4 per pool × 120).

Optimizations (all honest — no suppressed errors, no fabricated data):
1. **Pool-list cache (10 min TTL)** — the expensive GPA scan only discovers
   new pools; liquidity refresh reuses the cached decoded pool list and skips
   the scan entirely (`poolListFromCache` in the run stats).
2. **Immutable mint-decimals cache (process lifetime)** — mint decimals never
   change; after warm-up each pool needs only its 2 vault accounts, halving
   the keys per pool.
3. **Trimmed data slice** 200 → 160 bytes (everything actually decoded).
4. **Larger batch size** — 100 keys per `getMultipleAccountsInfo` (provider
   safe) instead of 40.
5. **Capped pool list** 120 → 60 (still representative for the New Pools tab).

Measured RPC volume per refresh (`lastPumpswapRpcStats()`, unit-tested with a
counting stub):
- **Before**: 1 GPA scan (all pools) + 12 multi-calls = 13 calls, 481 accounts
  read, every 60 s.
- **After (cold)**: 1 GPA scan (60 slices × 160 B) + ~3 multi-calls.
- **After (steady state, within pool-list TTL)**: **0 GPA + 2 multi-calls**
  (60 pools × 2 vaults = 120 keys in 2 batches) — an order-of-magnitude
  reduction in call count and scanned bytes; the GPA scan frequency drops 10×.

Bounded backoff, Retry-After handling, per-source error feeds, degraded
banner, and stale/fresh flags are unchanged. Raydium CPMM discovery (documented
REST) is unaffected. Measured live: with the fix, the pumpfun.pool feed
reports `ok` again once the pool list is cached; the Alchemy free-tier 429
appears only on cold scans and recovers on the next bounded retry.

## Mainnet launch-readiness audit (no transactions submitted)

Both routes verified for mainnet consistency:
- **Pump.fun → PumpSwap**: mainnet program IDs are the unconditional constants
  (Pump `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, PumpSwap
  `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`); `loadConfig` reads the live
  Global account and fails honestly per cluster; `create_v2` (Token-2022,
  metadata pointer = mint — mint/metadata authority arrangement is
  program-controlled by the SDK instructions); mint keypair signs via
  `tx.partialSign` before wallet signature; explicit compute-unit budget;
  honest fee breakdown (initial buy + rent/fees estimate).
- **Raydium LaunchLab → CPMM**: `programFor("mainnet-beta")` →
  `LAUNCHPAD_PROGRAM` (`LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`); SDK
  loads with `cluster: "mainnet"`; config account validated live before
  building; required `extraSigners: [mintKeypair]` +
  `ensureMintSignature`; graduation executed by Raydium's migration wallet
  (detected/verified, never executed by FluxPad).
- **Network consistency**: one network config flows everywhere —
  `loadConfig(connection, network.cluster)` and
  `prepareLaunch({ cluster: network.cluster })`; launch intent is persisted
  with `network: network.cluster`; reconciliation reads the same cluster via
  the Alchemy resolver.
- **Confirmation**: `submitAndConfirm` with stale-blockhash retry + landed-
  signature resolution; post-confirm `getAccountInfo(mint)` gates success.
- **Vanity matching**: `use-launch-flow.ts:194-196` aborts if the confirmed
  mint differs from the requested vanity address.
- **No end-to-end mainnet launch has been executed** — both routes remain
  "code-verified + read-only verified", not transaction-verified.

## Browser RPC architecture (proxy)

**Before:** the browser (wallet connection, blockhash fetch, transaction
submission, confirmation polling, post-confirm mint read) all used the public
`api.mainnet-beta.solana.com` endpoint — heavily rate-limited, the main
launch-reliability bottleneck on Mainnet.

**After:** `NEXT_PUBLIC_SOLANA_RPC_URL=/api/rpc` points the browser at
FluxPad's own **server-side RPC proxy** (`src/app/api/rpc/route.ts`):
- Forwards browser JSON-RPC (single or batch) to `ALCHEMY_SOLANA_RPC_URL`
  server-side. The key never appears in the request path, response, HTML,
  bundles, source maps, or logs.
- **Strict method allowlist** (`src/lib/rpc-proxy-policy.ts`, unit-tested):
  exactly the methods the launch flow needs — getHealth, getVersion,
  getEpochInfo, getBlockHeight, getSlot, getLatestBlockhash,
  getFeeForMessage, getMinimumBalanceForRentExemption, simulateTransaction,
  sendTransaction, getSignatureStatuses, getAccountInfo,
  getMultipleAccounts, getBalance, getTransaction,
  getTokenAccountsByOwner, getTokenSupply. Expensive indexing methods
  (getProgramAccounts, getLogs, …) are rejected (403) so anonymous traffic
  cannot burn provider compute units.
- POST only (405 on GET), JSON-RPC shape validation, 64 KB body limit,
  15 s upstream timeout, `no-store`, honest 502/503 errors that never echo
  the upstream URL or credentials.
- **Signing stays in the browser wallet** — the proxy only carries JSON-RPC;
  the transaction engine confirms by HTTP polling (getSignatureStatuses), no
  WebSocket subscriptions anywhere, so the proxy fully supports the flow.
- `resolveBrowserRpcEndpoint`/`resolveBrowserNetworkConfig`
  (`src/lib/connection.ts`) absolutize the relative path against the page
  origin (SSR falls back to the public endpoint), keep Mainnet selection
  intact, and are unit-tested.
- Launch adapters, transaction building, signing, and launch logic are
  unchanged. No automatic transaction retries were added (the existing
  landed-signature-safe retry policy in tx-engine is preserved).
- Verified: client-bundle scan of all 77 `.next/static` files (chunks +
  source maps) — the Alchemy key value appears in **none** of them.

## Unit tests

`npm test` — 51 tests across 6 files, all passing (discovery aggregation incl.
dedupe/tab classification/honest-null filters/sort/search/pagination/SOL→USD,
vanity engine incl. cancellation/bounds + case-insensitive suffix round-trip,
PumpSwap discovery RPC-volume cache behavior with a counting stub, metadata
validation, tx engine with stubbed connections, adapter contracts, documented
PDA fixtures).
Strict typecheck (`tsc --noEmit`) passes with no errors.

## Live-token-discovery verification scope (this session)

Verified by direct execution on this machine:
- `tsc --noEmit` → exit 0 (no type errors).
- `vitest run` → 6 files / 48 tests, all passing, exit 0.
- Unit coverage of the Explore data model: dedupe by mint, FluxPad
  attribution stickiness, new-launch vs new-pool classification,
  movers require a verified 24h change, market-cap sort ranks missing values
  last, pagination bounds, FDV-vs-MC labelling via `applySolPrice`.

Not yet exercised in this session (requires a running server):
- HTTP-level verification of `/api/discovery` tabs/search/sort/pagination and
  `/api/launches` attribution — use the manual steps below.
- Live provider behaviour (Pump program scan, LaunchLab Mint API, Raydium
  API v3) — the adapters degrade honestly to N/A / stale when a provider or
  the RPC is unreachable; that degradation path is unit-tested indirectly but
  the live fetch itself is environment-dependent.

Manual verification (run from `fluxpad/`, dev server must be stopped first):
```
npm run build
npm start -- -p 3210
curl "http://localhost:3210/api/discovery?tab=all&pageSize=5"
curl "http://localhost:3210/api/discovery?tab=fluxpad&launchRoute=pump&launchStatus=pending"
curl "http://localhost:3210/api/discovery?tab=pumpfun&sort=market-cap&q=sol"
curl "http://localhost:3210/api/discovery?tab=new-pools"
```
Expect: `tokens[]` with only verified fields populated, `meta.sources[]`
per-feed `ok/error/stale`, and honest empty arrays (never fabricated rows)
when a provider is unreachable.


## Verified during development

- **SDK inventory (real packages, real APIs):**
  - `@pump-fun/pump-sdk@4.0.0` — inspected `dist/index.d.ts`:
    `PUMP_SDK.createV2Instruction`, `PUMP_SDK.createV2AndBuyInstructions`,
    `OnlinePumpSdk.fetchGlobal`, `PUMP_SDK.decodeBondingCurve`,
    `bondingCurvePda`, `isBondingCurveMigrated`, `canonicalPumpPoolPda`,
    `getBuyTokenAmountFromSolAmount`, `PUMP_AMM_PROGRAM_ID`.
  - `@raydium-io/raydium-sdk-v2@0.2.74-alpha` — runtime introspection:
    `Raydium.load`, `raydium.launchpad.createLaunchpad`, `TxVersion.V0`,
    `getPdaLaunchpadConfigId`, `getPdaLaunchpadPoolId`, `LaunchpadConfig.decode`
    / `LaunchpadPool.decode` (field names verified by decoding a zeroed
    buffer), `LAUNCHPAD_PROGRAM` (LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj),
    devnet program (DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6), CPMM
    program (CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C).
  - LaunchLab usage cross-checked against the official demo repo
    (`raydium-sdk-V2-demo/src/launchpad/createMint.ts`, `poolInfo.ts`).
- **PDA/derivation unit tests** (`src/tests/constants.test.ts`).
- **Vanity engine unit tests** incl. cancellation, bounds, round-trip identity.
- **Transaction engine unit tests** with stubbed connections: success,
  wallet rejection mapping, on-chain failure mapping, stale-blockhash retry
  with landed-signature resolution, UNRESOLVED semantics.
- **Production build, lint, strict typecheck, unit suite** — see repo runs.

## Live token discovery (Explore)

Resumed and completed in this session. The Explore page (`/tokens`) renders
`ExplorePanel` over `GET /api/discovery`.

**Data sources (all documented, official; no website-scraping endpoints):**

| Feed | Source | Method | Cadence |
| --- | --- | --- | --- |
| `pumpfun.curve` | Pump program (on-chain) | Bounded `getSignaturesForAddress` + `getTransaction` with `@pump-fun/pump-sdk` `decodeCreateEventBc`; curve state via `OnlinePumpSdk.fetchBondingCurve`; progress/FDV against live `Global` | TTL cache 45s |
| `pumpfun.pool` | PumpSwap AMM program (on-chain) | `getProgramAccounts` with documented pool size filter + data slice; vault balances/mint decimals batch-read | TTL cache 60s |
| `launchlab.curve` | Raydium LaunchLab Mint API | `GET launch-mint-v1[-devnet].raydium.io/get/list?sort=new` (documented REST) | TTL cache 45s |
| `raydium.cpmm` | Raydium API v3 | `GET api-v3[-devnet].raydium.io/pools/info/list?poolType=cpmm…` + `/mint/price` for SOL→USD | TTL cache 60s |
| `fluxpad` | Local registry (Prisma) | Only `status >= CONFIRMED` records with verified `mintAddress` + `signature` | always fresh |

**Runtime (`src/lib/discovery/runtime.ts`):** bounded on-demand ingestion with
per-source TTL caches, shared in-flight promises (no duplicate fetches), stale
fallback on provider failure with `degraded` + per-source `ok/error/stale`
reporting, and 429/5xx backoff with bounded retries + timeouts in
`discovery/http.ts`. No credentials are used on read paths, so none can leak.

**Honesty rules (enforced end-to-end):** numeric metrics are `null` when no
defensible source exists and render "N/A"; curve prices are distinguished from
pool prices (curve = bonding-curve price, pool = pool reserves); FDV is
labelled FDV (curve full-supply valuation) and only provider-supplied market
caps are labelled MC; volume is reported only when a provider supplies it
(never synthesized from a snapshot); new launches and new pools are separate
record types; every row shows its data source, provenance and last-updated
time; stale rows are flagged.

**UI (`src/components/discovery/explore-panel.tsx`):** seven tabs (All /
Movers / New Launches / New Pools / Pump.fun / LaunchLab / FluxPad Launches),
server-side search (350ms debounce), sort picker, filter pills, pagination
(25/page), per-source freshness strip, degraded-provider banner, and honest
empty states — the FluxPad tab's empty state links to `/create` and states
that Pump/LaunchLab tokens are never attributed to FluxPad. FluxPad-tab
sub-filters (route: Pump/LaunchLab, lifecycle: Pending/Graduated) run
server-side (`launchRoute`/`launchStatus` query params) derived strictly from
record identity (`source` / `fluxpad-registry(...)` provenance).

**Graduation/lifecycle:** Pump curves carry the `complete` flag → `graduated`,
and PumpSwap pool presence is verified on-chain separately; LaunchLab records
map documented lifecycle states conservatively and CPMM destination pools are
verified via Raydium API v3 pool records. FluxPad launch records preserve the
full lifecycle (`CONFIRMED → CURVE_TRADING → GRADUATION_DETECTED →
POOL_VERIFIED`) and keep their identity when the same mint appears in provider
feeds (sticky `fluxpadLaunchId`, no double counting).

**Deduplication:** `mergeFeeds` keys records by mint, prefers the most
informative record (pool > curve, FluxPad records win attribution), preserves
earliest creation time and richer metadata. Unit-tested in
`src/tests/discovery.test.ts`.



## NOT verified automatically (requires humans / funded keys / live services)

1. **End-to-end transaction execution on devnet for both routes.** Requires a
   funded devnet wallet and a reachable RPC. The Pump bonding-curve program
   and LaunchLab devnet deployment/config availability must be confirmed
   against the live cluster at run time — FluxPad's `loadConfig` fails
   honestly with a typed `PROTOCOL` error when either is missing.
2. **Vanity mints through real transactions.** The engine and signer wiring
   are implemented and unit-tested; an on-chain vanity launch on each route
   still needs the manual smoke test before being claimed as verified.
3. **Graduation observation.** A curve reaching its threshold organically is a
   long-running, market-dependent event. Graduation detection code paths are
   implemented against live accounts but require such an event (or a fully
   funded curve) to observe end-to-end.
4. **Raydium launch-mint discovery service.** CPMM pool discovery uses
   `launch-mint-v1.raydium.io` (the endpoint used by Raydium's own demo) plus
   on-chain verification. Service availability from your deployment is an
   external dependency; failure degrades to "not verified yet", never to a
   fabricated pool.
5. **Wallet-adapter signing of SDK-built versioned transactions** on real
   browser wallets (Phantom/Solflare) — implemented per adapter docs, to be
   exercised in the smoke test.

## Reliability fixes (latest session)

**Raydium HTTP 500 — root cause found and fixed (evidence-based).** Direct
probes of both `api-v3-devnet.raydium.io` and `api-v3.raydium.io` returned
`500 {"success":false,"msg":"query poolType type error"}` — a parameter bug,
not a provider outage. The official docs (api-reference/api-v3/overview.mdx)
specify: `poolType` enum is all/concentrated/standard/... (no "cpmm"), the
sort parameter is `poolSortField` (not `sortField`), and page size is
`pageSize` (not `size`). The CPMM adapter was corrected to
`poolType=standard&poolSortField=liquidity&sortType=desc&page=N&pageSize=N`
and now returns **60 live CPMM pools on devnet** (`ok:true` in `/api/discovery` meta).

**Pump RPC 429 — bounded reliability improvements.**
- Transaction fetches during the incremental scan are sequential with
  exponential backoff + jitter on 429 (≈500ms/1s, +0–250ms jitter, max 3
  attempts, then the signature is honestly skipped this round).
- Curve-state enrichment is sequential with 100ms pacing (was concurrent
  `Promise.all` per mint — the main overload source) and stops the pass early
  on rate limits; tokens keep their create-event snapshots (nulls stay null).
- A failed scan/feed now throws into the runtime's bounded error-cache
  (15s), so request bursts never repeat the slow rate-limited refresh sequence.
- Provider REST calls honor `Retry-After` (seconds or HTTP-date, capped 5s)
  with jittered exponential backoff.

**Recommended (not configured here):** a paid RPC endpoint (`SOLANA_RPC_URL` /
`NEXT_PUBLIC_SOLANA_RPC_URL` in `.env.local`, e.g. Helius or QuickNode)
removes the public-devnet 429 ceiling for the Pump program scan. Keys must
stay server-side. With the public endpoint (no key), `pumpfun.curve`
legitimately reports 0 tokens while rate-limited — honest absence, never
fabricated curves.

## Testing strategy

- Unit: `npm test` (Vitest, no network).
- Integration: point `NEXT_PUBLIC_SOLANA_RPC_URL` at a devnet RPC and use the
  smoke-test guide with explicit human approval before any transaction.
- Mainnet: disabled by default; never conduct unapproved real-money
  transactions during testing.

## Official-token production readiness (Phase 1)

Phase 1 hardening for the treasury system is documented in
`docs/archive/RELAY_OFFICIAL_PRODUCTION_READINESS.md`: public-API error sanitization,
raw invalid-env values stripped from responses, a DB-backed refresh gate on
top of the per-process single-flight guard, expanded indexer/concurrency
tests, and the verified launch creator-fee semantics (pump-sdk IDL).
PostgreSQL remains UNVERIFIED — see that document for the exact migration
work required before any production deploy.
