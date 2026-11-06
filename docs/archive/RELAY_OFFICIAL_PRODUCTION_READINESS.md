# RelayPad Official $RELAY — Production Readiness (Phase 1)

**Status:** Phase 1 hardening applied. No financial execution exists or was added. No wallets configured, no keys touched, no transactions submitted.
**Date:** 2026-10-15
**Scope:** official-$RELAY treasury system only (`src/lib/relay-official/`, `/api/relay-official/*`, `/treasury`).

---

## 1. What Phase 1 changed

| Change | Files | Why |
|---|---|---|
| Public API error sanitization | `src/lib/relay-official/sanitize.ts` (new), `src/lib/relay-official/summary.ts`, `src/app/api/relay-official/summary/route.ts`, `src/app/api/relay-official/wallets/route.ts` | Raw RPC messages (which can carry provider endpoint URLs and embedded API keys) are no longer returned by any public endpoint. |
| Raw invalid env values removed from responses | `summary/route.ts` (`publicInvalidRoles`), `treasury-dashboard.tsx` (type narrowed to `{role}`) | `invalid` now lists only WHICH role is misconfigured; the raw value stays server-side (`config.invalid`) for diagnostics. The dashboard never displayed the value, so behavior is unchanged visually. |
| Cross-instance refresh dedupe | `src/lib/relay-official/refresh-gate.ts` (new), `summary/route.ts` | `?refresh=1` is now gated by a per-process throttle + single-flight flag AND a DB-backed timestamp gate (`RelayOfficialIndexState`, key `"refresh"`) shared by all instances through the existing database. The claim is written BEFORE the scan runs, so failed scans also count toward the window and request bursts cannot hammer the RPC. |
| Hardened indexer/refresh test coverage | `src/tests/relay-official.test.ts` | New suites for pending transactions, reconciliation-failure containment, duplicate-upsert counting, the refresh gate, and sanitization. |
| Production-readiness documentation | this document | Records verified facts, deliberate limitations, and the exact remaining production work. |

**Deliberately NOT changed:** classification semantics, launch semantics, store schema, rate-limiter behavior (memory), no new infrastructure (no Redis/queue/lock service).

## 2. Rate limiting and refresh concurrency — honest limitation record

- The per-IP limiter (`PerIpRateLimiter`, `src/lib/rpc-proxy-policy.ts`) is **process-local memory**. On multi-instance deployments each instance has an independent budget (60 req/min/IP); aggregate throughput scales with instance count. The code documents this (`rpc-proxy-policy.ts:71-72`, `api-guard.ts:16-17`).
- **Production requirement (must be provided by the hosting platform, not this codebase):** a platform-level per-IP rate limit / WAF rule in front of `/api/relay-official/*` so the effective limit is global. Without it, the local limiter is a load bound only — it is NOT a security control.
- IP extraction trusts `x-real-ip` / `cf-connecting-ip` (platform-set) and falls back to `x-forwarded-for` (client-spoofable without a trusted proxy) or `"local"`, which is never blocked. Deployments must ensure the platform sets the trusted headers.
- The DB-backed refresh gate is **best-effort dedupe, not a distributed lock**: two instances checking at the same instant may both scan. That is safe (indexing is idempotent — unique `(signature, entryKey)` + P2002-tolerant upserts) and bounded (10 pages × 100 signatures per wallet per run). A true cross-instance lock (Redis/advisory locks) is intentionally deferred; it would add infrastructure without changing correctness.

## 3. Indexing and reconciliation guarantees (tested)

| Guarantee | Test |
|---|---|
| Failed transactions are stored as `failed` and never aggregated | `marks a transaction whose result contains an error as failed`, `aggregates totals over confirmed rows only` |
| Pending (null-RPC) transactions are never stored and are retried | `treats null RPC transactions as pending: never stored, retried next run` |
| Reconciliation only marks rows verified when the node reports success; status-failure is contained, data kept, state recorded | `reconciles stored rows against the node…`, `contains getSignatureStatuses failures…` |
| Duplicate `(signature, entryKey)` upserts are counted, never written twice; distinct occurrences stay distinct rows | `duplicate upserts of the same (signature, entryKey)…` |
| RPC failures per wallet are contained; stored rows survive; recovery is idempotent | `contains RPC failures per wallet…`, `reconciles after a database write failure…` |
| Cursor catch-up across pages stops at known overlap; bounded per run | `catches up across pages with the before-cursor…` |
| Burns are recognized ONLY from real `burn`/`burnChecked` instructions; transfers (even to dead addresses) are never burns | `never classifies a token transfer to an address as a burn` |
| Coverage limit is honest: ≤ 10 pages × 100 signatures per wallet per run (`indexer.ts`), older history fills in on later runs | code + cursor test |

## 4. PostgreSQL readiness — Phase 2 results (2026-10-15)

**Strategy implemented: an isolated PostgreSQL provider package at `prisma/postgres/`.** The SQLite tree (`prisma/schema.prisma`, `prisma/migrations/*`, lock file) was NOT modified — verified unchanged; `prisma migrate status` against the local SQLite dev DB still reports "2 migrations found … Database schema is up to date!".

**What now exists (see `prisma/postgres/README.md` for full details):**

| Artifact | How it was produced | Verification |
|---|---|---|
| `prisma/postgres/schema.prisma` | **Derived** from `prisma/schema.prisma` (models byte-identical; only generator output + datasource differ: `provider = "postgresql"`, `url = env("POSTGRES_DATABASE_URL")`) | `prisma validate` → **exit 0, "schema is valid"** (Prisma 6.16.2 PostgreSQL connector) |
| `prisma/postgres/migrations/00000000000000_init/migration.sql` | **Generated by Prisma's own PostgreSQL connector** (`prisma migrate diff --from-empty --to-schema-datamodel … --script`) — genuine PG DDL (`TIMESTAMP(3)`, `JSONB`, native enums, `CREATE SCHEMA "public"`), NOT a reinterpretation of SQLite SQL | Determinism: re-running the diff reproduces the file **byte-identically**; structural parity vs the SQLite dashboard baseline: identical 25-column `RelayOfficialActivity` set and identical treasury index set incl. the unique `(signature, entryKey)` index |
| `prisma/postgres/migrations/migration_lock.toml` | `provider = "postgresql"` | — |
| `prisma/postgres/generated-client/` | `prisma generate --schema prisma/postgres/schema.prisma` (isolated `output`) | **exit 0**; runtime SQLite client in `node_modules/.prisma` verified untouched (mtime + provider still `sqlite`) |

**Why the dedicated `POSTGRES_DATABASE_URL` variable:** the SQLite dev `DATABASE_URL` is never reused or clobbered; the two provider trees cannot collide. `.env.example` documents it.

**Runtime verification against a live PostgreSQL: STILL INCOMPLETE — explicitly not claimed.** No PostgreSQL server exists on this machine (port 5432 closed, no service, no Docker, no psql — re-probed this phase). What remains to be executed once a staging/test database is available (dedicated empty DB only, never production):
1. `prisma migrate deploy --schema prisma/postgres/schema.prisma` on the empty DB (applies the committed PG baseline).
2. Observe the unique `(signature, entryKey)` constraint and the store's `P2002` → duplicate-counting path on PostgreSQL (provider-independent by Prisma's contract, unit-tested on SQLite; must be observed once on the real provider).
3. Confirm index creation in `pg_indexes` and run one index-scan sanity check on realistic volumes.

## 5. Launch creator-fee handling — verified behavior (no code change)


**Evidence: installed `@pump-fun/pump-sdk` IDL (`node_modules/@pump-fun/pump-sdk/dist/index.d.ts`, `createV2` instruction block).**

- `create_v2` **accounts**: `mint` (writable, **signer**), `mintAuthority` (PDA), `bondingCurve` (PDA), `associatedBondingCurve` (PDA), `global` (PDA), `user` (writable, **signer**), `systemProgram`, `tokenProgram` (Token-2022 program address), `associatedTokenProgram`, `eventAuthority` (PDA), `program`.
- `creator` is **NOT an account** — it is an instruction **argument** (`"name": "creator"; "type": "pubkey"`). The creator wallet does **not** need to sign the create instruction; the only required signers are the mint keypair and `user`.
- The `create_v2` IDL docs add: a `holderReward` coin assigns the creator role to the mint's `holder-rewards` PDA instead (RelayPad passes `holderReward: false`, so that path is not taken).
- Current adapter behavior (`src/lib/adapters/pump.ts:110,135,156`): `const user = signer.publicKey` and `creator: user` — **the creator defaults to the connected/signing wallet**. Therefore:
  - **Path A (no code change):** perform the launch transaction from W1 → W1 is permanently the creator and fee recipient.
  - **Path B (adapter change, now SDK-verified as feasible):** pass `creator: <W1 public key>` while `user` remains the paying wallet. Verified feasible by the IDL (creator is data, not a signer account). This change is deliberately NOT made in Phase 1; it should be made (if at all) as its own reviewed change before launch, together with a re-check of current on-chain program behavior at launch time.
- **Not re-verified this session (documented in the audit, remains DOCS-based):** post-graduation collection (`collect_coin_creator_fee`) requiring the creator's signature, and permissionless sweeps whose destination is fixed to the creator. Re-confirm against the live program docs at launch time.

## 6. Financial execution boundary (unchanged)

`src/lib/relay-official/` contains zero occurrences of `sendTransaction`, `signTransaction`, `serializeTransaction`, `requestAirdrop`, or `Keypair`. The system remains read-only tracking + reconciliation. No collection, allocation, swap, burn, scheduler, or signing code exists or was added. Public APIs cannot initiate financial operations.

## 7. Remaining blockers before a mainnet launch

1. Wallet configuration (public addresses only) — the immediate, safe next step.
2. `RELAY_OFFICIAL_ENABLED` decision at deploy time (currently unset → indexer off).
3. Platform-level rate limiting in front of the public APIs (§2).
4. PostgreSQL runtime verification (§4): apply the committed PG baseline with `migrate deploy` against a dedicated empty staging database, observe `P2002` on PostgreSQL once, and confirm indexes in `pg_indexes`. All migration FILES are prepared and offline-verified; only live execution remains.
5. Launch-path decision: Path A (launch from W1) vs Path B (adapter change, SDK-verified feasible) — decide before launch; if B, implement and review as its own change.
6. Live classification verification against real treasury-wallet history once wallets exist (PumpSwap program-level signature lookups are an Alchemy free-tier limitation; wallet-level lookups work).
7. Production build produced with the dev server stopped (`.next` conflict documented in VERIFICATION.md).

---

*Phase 2 complete: PostgreSQL provider package prepared and offline-verified (validate + deterministic connector-generated baseline + isolated client generation + structural parity + untouched SQLite dev environment). Runtime verification against a live PostgreSQL remains explicitly INCOMPLETE — no PostgreSQL server exists in this environment. No wallets configured, no keys requested or created, no transactions submitted, no financial execution enabled, no databases created or modified.*

