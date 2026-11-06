# Hostinger Production Environment Setup — FluxPad

Complete, code-verified checklist of every environment variable the FluxPad
production deployment needs on Hostinger (Next.js 15, Node.js 22, Solana
Mainnet, SQLite). Derived from a full source scan of `src/`, `prisma/`,
`next.config.mjs` and `package.json` — nothing here is assumed.

Legend for the tables:

- **Required?** — `REQUIRED` (app degrades or misbehaves without it),
  `RECOMMENDED` (feature works better), `OPTIONAL` (safe to omit),
  `DO NOT SET` (dead or platform-injected variable).
- **Local value?** — whether your current `.env.local` already has a value
  you can copy (`SET` / `empty` / `—`).
- **Exposure** — `PUBLIC` (inlined into the browser bundle — never a secret)
  or `SERVER` (read only on the server — keep secret).
- **Reload** — what a change requires on Hostinger: `REBUILD` (full
  `npm run build` after changing — `NEXT_PUBLIC_*` is inlined at build time)
  or `RESTART` (server-side variables are read at runtime; restarting the
  Node.js app is enough).

## How environment loading works on Hostinger

- `NEXT_PUBLIC_*` values are **inlined into the client bundle at build
  time**. Changing them without rebuilding has NO effect.
- Server-side variables (`ALCHEMY_*`, `PINATA_*`, `SOLANA_RPC_URL`,
  `DATABASE_URL`, `FLUXPAD_OFFICIAL_*`) are read at **runtime** — a restart
  of the Node.js application is enough.
- Hostinger (VPS "Node.js app" in hPanel) lets you define environment
  variables in the app settings; they are injected into the process.
  Alternatively you can place a `.env` file next to the app — Next.js loads
  `.env` / `.env.local` at server start (restart applies changes).
- `NODE_ENV` is set to `production` by the platform / `next start`.

## Deployment steps (no script changes required)

```bash
npm install --legacy-peer-deps   # runs `prisma generate` automatically (postinstall)
npm run build                    # next build
npm run start                    # next start (serves on $PORT / 3000)
```

- Node.js **>= 20** required (`package.json` engines); Node 22 is fine.
- `--legacy-peer-deps` is required (documented peer-dependency conflict).
- Never run `npm run build` while `next dev` or another `next start` is
  using the same `.next` directory.

## A. Core application

| Variable | Required? | Purpose | Local value? | Hostinger value | Exposure | Reload |
|---|---|---|---|---|---|---|
| `NODE_ENV` | Platform-managed | Runtime mode for Next.js/Prisma logging | — | `production` (set by platform / `next start`) | public | restart |

No other core variables exist. The application name is fixed ("FluxPad") in
`src/app/layout.tsx` — there is no `NEXT_PUBLIC_APP_NAME` variable in the
code (a `NEXT_PUBLIC_APP_NAME` entry in `.env.local` is dead and must not
be migrated).

## B. Solana network and RPC

| Variable | Required? | Purpose | Local value? | Hostinger value | Exposure | Reload |
|---|---|---|---|---|---|---|
| `NEXT_PUBLIC_FLUXPAD_NETWORK` | **REQUIRED** | Active Solana cluster for client + server (`devnet` \| `mainnet-beta`) | SET | `mainnet-beta` (copy local) | PUBLIC | **REBUILD** |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | RECOMMENDED | Browser RPC endpoint. Use the relative proxy path `/api/rpc` so browser traffic flows through the server-side Alchemy proxy (key never reaches the browser) | SET | copy local **if it is `/api/rpc` or a public URL** — never a credentialed URL | PUBLIC | **REBUILD** |
| `SOLANA_RPC_URL` | OPTIONAL | Server-side custom RPC, used when Alchemy is not configured (falls back to the public cluster endpoint, which is rate-limited) | empty | omit unless you have a dedicated non-Alchemy endpoint | SERVER | restart |

Server-side RPC precedence (verified in `src/lib/connection.ts`):
`ALCHEMY_SOLANA_RPC_URL` → `ALCHEMY_API_KEY` (constructs
`https://solana-mainnet.g.alchemy.com/v2/<key>`) → `SOLANA_RPC_URL` →
public cluster endpoint.

## C. Alchemy providers (server-side only — never `NEXT_PUBLIC_*`)

| Variable | Required? | Purpose | Local value? | Hostinger value | Exposure | Reload |
|---|---|---|---|---|---|---|
| `ALCHEMY_SOLANA_RPC_URL` | RECOMMENDED | Full Alchemy RPC URL used for all server-side reads (discovery, reconciliation, tx confirmation, `/api/rpc` proxy) | SET | copy local unchanged | **SERVER (secret)** | restart |
| `ALCHEMY_API_KEY` | OPTIONAL | Bare Alchemy key — used only when `ALCHEMY_SOLANA_RPC_URL` is unset (the full URL is constructed from it); also derives the WebSocket endpoint | SET | copy local unchanged | **SERVER (secret)** | restart |
| `ALCHEMY_SOLANA_WS_URL` | OPTIONAL | WebSocket endpoint for subscriptions (no feature uses it today; wired for future use) | SET | copy local unchanged | **SERVER (secret)** | restart |

Copy the values from `.env.local` unchanged. To obtain them: Alchemy
Dashboard → Apps → your Solana app (Mainnet) → API Key / HTTP + WSS URLs
(https://dashboard.alchemy.com). Keep them out of any `NEXT_PUBLIC_*`
variable — the code and tests enforce this.

## D. Jupiter / Swap integration

**Not present in the codebase.** A full case-insensitive source scan finds
zero Jupiter references; swap-related UI is PumpSwap / Raydium market data
and the built-in launch flow (Pump.fun → PumpSwap, Raydium LaunchLab →
CPMM). **No swap/Jupiter variables are required.** If a Jupiter integration
is added later, document its variables here.

## E. Pinata / IPFS (metadata + artwork uploads)

| Variable | Required? | Purpose | Local value? | Hostinger value | Exposure | Reload |
|---|---|---|---|---|---|---|
| `PINATA_JWT` | REQUIRED for artwork uploads | Bearer token for Pinata uploads (`POST /api/upload` → IPFS). Without it the API returns an honest `503 upload_not_configured`; everything else keeps working | SET | copy local unchanged | **SERVER (secret)** | restart |
| `PINATA_GATEWAY` | OPTIONAL | Preferred IPFS gateway used to DISPLAY uploaded/metadata assets (falls back to `ipfs.io`) | SET | copy local unchanged | public (host name, not a secret) | restart |

To obtain `PINATA_JWT`: https://app.pinata.cloud → Account → API Keys →
New Key (Admin) → copy the JWT. The upload size cap is fixed at 10 MB in
code (`src/lib/metadata.ts`) and is not configurable — an
`UPLOAD_MAX_BYTES` entry would be dead and must not be migrated.

## F. Official FluxPad token (FluxPad naming only)

All seven variables are read server-side at runtime
(`src/lib/official-token/config.ts` via `getOfficialTokenConfig(process.env)`)
— **restart only, no rebuild**. Empty values count as unset; the dashboard
renders honest "configuration needed" states.

| Variable | Required? | Purpose | Local value? | Hostinger value | Exposure | Reload |
|---|---|---|---|---|---|---|
| `FLUXPAD_OFFICIAL_ENABLED` | REQUIRED (official-token + treasury features) | Master switch — `true` or `1` enables the official-token card/treasury | SET | copy local (`true`) | public (flag) | restart |
| `FLUXPAD_OFFICIAL_NETWORK` | RECOMMENDED | Network override for official-token reads (falls back to `NEXT_PUBLIC_FLUXPAD_NETWORK`) | SET | copy local (`mainnet-beta`) | public | restart |
| `FLUXPAD_OFFICIAL_CREATOR_WALLET` | RECOMMENDED | W1 — official $FLUX creator-fee receiver (public Solana address) | SET | copy local unchanged — **do not invent** | public address | restart |
| `FLUXPAD_OFFICIAL_BUYBACK_TREASURY` | RECOMMENDED | W2 — dedicated buyback treasury (public address) | SET | copy local unchanged | public address | restart |
| `FLUXPAD_OFFICIAL_OPS_TREASURY` | OPTIONAL | W3 — operations & reserve treasury | empty | omit or leave empty until finalized | public address | restart |
| `FLUXPAD_OFFICIAL_DEV_WALLET` | OPTIONAL | W4 — development wallet (transparency listing only) | empty | omit or leave empty | public address | restart |
| `FLUXPAD_OFFICIAL_MINT` | **KEEP EMPTY until you provide the verified mint** | The ONLY source of the official $FLUX mint. While empty: card shows `CA NOT OFFICIAL YET` + "Official $FLUX mint has not been configured yet.", copy disabled | empty | **leave empty** | public address once set | restart |

Hard rules (enforced by code + tests):

- The mint is read **exclusively** from `FLUXPAD_OFFICIAL_MINT`. There is NO
  legacy fallback — `FLUXPAD_OFFICIAL_MINT` is never consulted and its old
  value must never be reused as the $FLUX mint.
- Setting the variable does NOT make a token official: a syntactically
  valid address shows `NOT YET VERIFIED` until explicit on-chain
  verification marks it official. An invalid value renders an
  `INVALID CONFIGURATION` error state (raw value never exposed).
- The literal string `REPLACE_WITH_OFFICIAL_FLUX_MINT` is treated exactly
  like an unset value.
- **Do not configure any legacy `DOTPAD_OFFICIAL_*` / `RELAY_OFFICIAL_*` variable
  on Hostinger.** Legacy fallback reads were removed from the code — those names
  are no longer consulted anywhere, so setting them would have no effect.
  Configure only the `FLUXPAD_OFFICIAL_*` variables above.

## G. Treasury and wallet configuration

Fully covered by section F — the treasury dashboard (W1–W4) reads the same
`FLUXPAD_OFFICIAL_*` wallet variables. There are no separate treasury
variables. All wallet values are PUBLIC Solana addresses (never private
keys — the schema and code store/validate public keys only).

## H. Database / SQLite

| Variable | Required? | Purpose | Local value? | Hostinger value | Exposure | Reload |
|---|---|---|---|---|---|---|
| `DATABASE_URL` | **REQUIRED for registry/dashboard persistence** | Prisma datasource; provider is SQLite (`prisma/schema.prisma`: `provider = "sqlite"`) | SET (`file:` URL) | `file:` URL — see persistence rules below | SERVER (filesystem path, not credentials) | restart |
| `POSTGRES_DATABASE_URL` | DO NOT SET (SQLite deployment) | Consumed only by the optional PostgreSQL variant (`prisma/postgres/`) | empty | omit — PostgreSQL requires your explicit approval and is NOT part of this migration | SERVER | — |

Behavior verified in code (`src/lib/db.ts`):

- Without `DATABASE_URL` the app still runs — registry/dashboard routes
  return honest `503` responses; the core client-side launch flow works.
- **SQLite `file:` URLs are auto-resolved to an absolute location** before
  the Prisma client is created. Order: (1) if the file already exists at
  the schema-relative (`<app>/prisma/<path>`) or cwd-relative location,
  that existing file wins (records are never orphaned); (2) otherwise the
  schema-relative location is used and its parent directory is created.
- ⚠️ Prisma resolves relative `file:` paths against the `prisma/`
  directory, so a local-style value like `file:./prisma/dev.db` would point
  at `<app>/prisma/prisma/dev.db` on the server. **Use `file:./dev.db`**
  (resolves to `<app>/prisma/dev.db`) **or an absolute path**
  (`file:/absolute/path/prod.db`) on Hostinger.
- **Schema bootstrap is automatic**: on first use, missing tables are
  created from the committed `prisma/sqlite-bootstrap.sql` and the init
  migration is recorded in `_prisma_migrations`, so a later
  `prisma migrate deploy` (optional; `npm run prisma:migrate`) is a no-op.
  No manual SQL is needed on a fresh deployment.
- `prisma generate` runs automatically during `npm install` (`postinstall`),
  generating the SQLite client from the committed schema — **no build or
  start script changes are required**.

## I. Application URL and production settings

| Variable | Required? | Purpose | Local value? | Hostinger value | Exposure | Reload |
|---|---|---|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | **REQUIRED** | Origin for `metadataBase` — resolves relative OG/Twitter image URLs (`/fluxpad-banner.jpg`) to absolute ones in `src/app/layout.tsx` | SET (`http://localhost:3300` locally) | `https://<your-production-domain>` — **change it from localhost** | PUBLIC | **REBUILD** |
| `VERCEL_PROJECT_PRODUCTION_URL` | DO NOT SET (Hostinger) | Vercel-only origin injection; on non-Vercel hosts it stays unset and `NEXT_PUBLIC_APP_URL` is used instead (verified fallback in `layout.tsx`) | not needed | omit | public | — |

⚠️ Without a correct `NEXT_PUBLIC_APP_URL`, social-preview images resolve
against `http://localhost:3300` (the code fallback) — broken share previews.

## J. Optional integrations and dead variables

| Variable | Classification | Note |
|---|---|---|
| `NEXT_PUBLIC_APP_NAME` | **Dead — do not migrate** | Not read anywhere in `src/` (app name is fixed in `layout.tsx`) |
| `UPLOAD_MAX_BYTES` | **Dead — do not migrate** | Upload cap is fixed at 10 MB in `src/lib/metadata.ts`, not env-configurable |
| `VERCEL_OIDC_TOKEN` | Dead on Hostinger | Vercel platform-injected; not read by application code |
| `DEBUG`, `PRISMA_*`, `NO_COLOR`, `DOTENV_*` | Library internals | Referenced by Prisma/dotenv internals only — never set these manually |

## Hostinger SQLite persistence — decision checklist

These facts MUST be confirmed in hPanel before the first production deploy
(they cannot be determined from the codebase):

1. **Does the application directory persist across application restarts?**
   On a Hostinger VPS running a Node.js app as a service, the project
   directory persists — restarts keep the database file.
2. **What happens on redeployment (git pull / re-upload)?** If the deploy
   replaces the application directory (fresh clone), a database stored
   inside the app directory is DELETED with it. In that case you MUST use
   an absolute `file:` URL pointing OUTSIDE the app directory, e.g.
   `DATABASE_URL=file:/home/<user>/fluxpad-data/prod.db` — create that
   directory once and confirm the exact path in hPanel (do not assume any
   specific path exists).
3. **Disk type**: SQLite needs a real local filesystem. On a VPS
   (NVMe/SSD local disk) this is satisfied. On shared hosting with
   network-mounted storage, concurrent SQLite writes can corrupt — use a
   VPS plan for production.
4. **Backups**: SQLite is a single file — back it up by copying it while
   the app is stopped (or with `sqlite3 .backup`). Schedule periodic
   copies; the database file must NEVER be committed to Git (`.gitignore`
   already excludes `*.db`).

Quick decision tree:

- App directory persists across redeploys → `DATABASE_URL=file:./dev.db`
  is fine (resolves to `<app>/prisma/dev.db`).
- Redeploy recreates the app directory → use an absolute path outside it,
  e.g. `file:/home/<user>/fluxpad-data/prod.db` (confirm the real path in
  hPanel first).

## Security audit (pre-deployment)

Verified against the committed repository (`FluxPadTrade/dotfun`, branch
`main`) and the local working tree:

- `.env.local` / `.env` are git-ignored (`.env*` with `!.env.example`) and
  are **not present in the committed tree** (verified by a full
  `git ls-tree` scan of the pushed HEAD).
- No API keys, private keys, seed phrases, database files, or backup files
  are committed (pattern-scanned before upload).
- Browser-exposed variables are exactly: `NEXT_PUBLIC_FLUXPAD_NETWORK`
  (network name), `NEXT_PUBLIC_SOLANA_RPC_URL` (a relative `/api/rpc`
  proxy path or public URL — **never** a credentialed URL; code comments
  and tests enforce this), `NEXT_PUBLIC_APP_URL` (a public domain). No
  secrets.
- All secrets (`ALCHEMY_API_KEY`, `ALCHEMY_SOLANA_RPC_URL`,
  `ALCHEMY_SOLANA_WS_URL`, `PINATA_JWT`) are server-side only and must be
  entered in Hostinger's environment settings (or a server-side `.env`),
  never in a `NEXT_PUBLIC_*` variable and never in client code.
- Wallet/treasury values are PUBLIC addresses — safe to expose by design.

## Post-deployment verification checklist

After the first deploy on Hostinger (in this order):

1. `GET /` returns 200 and shows the FluxPad logo/banner and branding.
2. `GET /status` shows **Solana Mainnet** (`NEXT_PUBLIC_FLUXPAD_NETWORK`
   was set before the build — otherwise rebuild).
3. `GET /api/official-token/token` returns `"status":"placeholder"`,
   `"displayValue":"Official $FLUX mint has not been configured yet."`,
   `"copyable":false`, `"badgeLabel":"CA NOT OFFICIAL YET"` while
   `FLUXPAD_OFFICIAL_MINT` is empty — never a placeholder string.
4. `GET /api/launches` returns 200 → confirms the SQLite database is
   reachable (a 503 with a `[db] DATABASE_URL` log line means the variable
   is missing/invalid on the server).
5. The homepage official $FLUX card shows the honest not-configured state;
   Copy Address is disabled.
6. Wallet connection works in the browser (browser RPC = the `/api/rpc`
   proxy → server-side Alchemy). `POST /api/rpc` with an allowlisted
   method (e.g. `getHealth`) returns 200; non-allowlisted methods get 403
   by design.
7. `GET /treasury` renders the honest configuration state from the
   `FLUXPAD_OFFICIAL_*` values.
8. Open Graph preview (paste the URL into a social composer) resolves
   images against the production domain (`NEXT_PUBLIC_APP_URL` was set
   before the build).
9. Check the application logs on the first registry request — a one-time
   "[db] SQLite schema bootstrapped" message is expected on a fresh
   database.
10. When the verified $FLUX mint arrives later: set
    `FLUXPAD_OFFICIAL_MINT=<verified mint>` on Hostinger and RESTART only —
    the card picks it up through the API without a rebuild and shows
    `NOT YET VERIFIED` until on-chain verification marks it official.

## Quick reference — the exact minimum set

Required to match current local functionality (copy values from
`.env.local` where marked; never print or share them):

```
NEXT_PUBLIC_FLUXPAD_NETWORK=mainnet-beta
NEXT_PUBLIC_SOLANA_RPC_URL=/api/rpc
NEXT_PUBLIC_APP_URL=https://<your-production-domain>
DATABASE_URL=file:./dev.db             # or an absolute path per the persistence rules
PINATA_JWT=<copy from .env.local>      # artwork uploads
PINATA_GATEWAY=<copy from .env.local>  # optional but recommended
ALCHEMY_SOLANA_RPC_URL=<copy from .env.local>
ALCHEMY_API_KEY=<copy from .env.local>
ALCHEMY_SOLANA_WS_URL=<copy from .env.local>   # optional
FLUXPAD_OFFICIAL_ENABLED=true
FLUXPAD_OFFICIAL_NETWORK=mainnet-beta
FLUXPAD_OFFICIAL_CREATOR_WALLET=<copy from .env.local>
FLUXPAD_OFFICIAL_BUYBACK_TREASURY=<copy from .env.local>
FLUXPAD_OFFICIAL_MINT=                  # intentionally EMPTY until the verified mint exists
```

Do NOT set: `FLUXPAD_OFFICIAL_*` (legacy), `NEXT_PUBLIC_FLUXPAD_NETWORK`
(legacy), `NEXT_PUBLIC_APP_NAME`, `UPLOAD_MAX_BYTES`,
`VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_OIDC_TOKEN`,
`POSTGRES_DATABASE_URL`.

Build/restart rule of thumb: after changing any `NEXT_PUBLIC_*` or
`NEXT_PUBLIC_APP_URL` → full `npm run build` + restart. After changing any
server-side variable (`ALCHEMY_*`, `PINATA_*`, `DATABASE_URL`,
`FLUXPAD_OFFICIAL_*`, `SOLANA_RPC_URL`) → restart only.

— End of document. Generated from a source-level audit of FluxPad @ `main`
(`c111026`), repository `FluxPadTrade/dotfun`.

