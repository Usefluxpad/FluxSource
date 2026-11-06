# FluxPad Branding & Environment Migration

Current state: the product is **FluxPad**, the brand ticker is **$FLUX**, and
every application-read environment variable uses the `FLUXPAD_*` /
`NEXT_PUBLIC_FLUXPAD_*` naming. There are no legacy fallback reads left in the
code: legacy variable names are **not consulted anywhere** (covered by tests).

## Active variable names (the only names the code reads)

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_FLUXPAD_NETWORK` | Solana network selector (`devnet` / `mainnet-beta`) — build-time for client bundles |
| `FLUXPAD_OFFICIAL_ENABLED` | Master switch for the official-token dashboard (default off) |
| `FLUXPAD_OFFICIAL_NETWORK` | Network override for the official-token/treasury reads |
| `FLUXPAD_OFFICIAL_CREATOR_WALLET` | W1 creator-fee receiver (public address) |
| `FLUXPAD_OFFICIAL_BUYBACK_TREASURY` | W2 buyback treasury (public address) |
| `FLUXPAD_OFFICIAL_OPS_TREASURY` | W3 operations & reserve treasury (public address) |
| `FLUXPAD_OFFICIAL_DEV_WALLET` | W4 development wallet (public address) |
| `FLUXPAD_OFFICIAL_MINT` | **The only** source of the official $FLUX mint |

The official $FLUX mint is read **exclusively** from `FLUXPAD_OFFICIAL_MINT`
and stays empty until the owner supplies a verified mint. Historical
RelayPad/DotPad-era mint values are **never** reused as the $FLUX mint — a new
official token must never silently inherit an old token's on-chain identity.
No placeholder address is substituted; the honest "CA NOT OFFICIAL YET" state
renders while the variable is empty.

Unrelated infrastructure variables keep their neutral names unchanged:
`DATABASE_URL`, `POSTGRES_DATABASE_URL`, `SOLANA_RPC_URL`, `ALCHEMY_API_KEY`,
`ALCHEMY_SOLANA_RPC_URL`, `ALCHEMY_SOLANA_WS_URL`, `PINATA_JWT`,
`PINATA_GATEWAY`, `NEXT_PUBLIC_SOLANA_RPC_URL`, `NEXT_PUBLIC_APP_URL`,
`NEXT_PUBLIC_APP_NAME`, `PUMPPORTAL_API_KEY`, `PUMP_LIVE_*`,
`RPC_GATEWAY_*`, `VERCEL_PROJECT_PRODUCTION_URL`.

## Branding migration history (name generations)

| Generation | Product | Variable prefix | Official token |
| --- | --- | --- | --- |
| 1 (historical) | RelayPad | `NEXT_PUBLIC_RELAYPAD_*`, `RELAY_OFFICIAL_*` | $RELAY (never launched) |
| 2 (historical) | DotPad | `NEXT_PUBLIC_DOTPAD_*`, `DOTPAD_OFFICIAL_*` | $DOT (never launched) |
| 3 (current) | **FluxPad** | `NEXT_PUBLIC_FLUXPAD_*`, `FLUXPAD_OFFICIAL_*` | **$FLUX** (mint pending owner verification) |

## What was migrated in the final cleanup

- **Environment files:** `.env.local` legacy `DOTPAD_*` keys were removed where
  a `FLUXPAD_*` twin already held the live value (values preserved
  byte-for-byte in the twin); `.env.example` now contains FluxPad names only.
- **Resolvers:** `src/lib/network-env.ts` and
  `src/lib/official-token/config.ts` read FluxPad variables only — no
  `DOTPAD_*` / `RELAY_*` / `RELAY_OFFICIAL_*` fallbacks remain, and tests
  assert the legacy names are ignored.
- **Internal identifiers:** `src/lib/relay-official/` →
  `src/lib/official-token/`, API routes `/api/relay-official/*` →
  `/api/official-token/*`, `getRelayOfficialConfig` →
  `getOfficialTokenConfig`, `RelaypadError`/`RelaypadNetworkConfig` →
  `FluxpadError`/`FluxpadNetworkConfig`, summary fields `relayPurchased` /
  `relayBurned` → `fluxPurchased` / `fluxBurned`, discovery source id
  `relaypad` → `fluxpad` (with `fluxpadLaunchId` and `fluxpad-registry(...)`
  provenance). All consumers live in this repository and were updated.
- **User-visible branding:** metadata, headers, dashboards, official-token
  card, treasury, docs and README use FluxPad/$FLUX exclusively.
- **Watchlist storage:** the localStorage key moved from
  `relaypad:watchlist` to `fluxpad:watchlist` with a one-time migration that
  preserves existing user watchlists.

## Intentionally remaining references (not active branding)

- **Prisma model names** `relayOfficialActivity` / `relayOfficialIndexState`
  (`prisma/schema.prisma` + generated client): database schema identifiers.
  Renaming them would require a migration; explicitly out of scope.
- **Git history:** commit messages from the RelayPad/DotPad eras are
  immutable history and are not rewritten.
- **`docs/archive/RELAY_OFFICIAL_*.md`:** historical design/audit records for
  the official-token treasury system, preserved byte-for-byte as archived
  planning documents. They are not part of the active documentation set.
- **`tools/build-brand-assets.mjs`:** a RelayPad-era asset-generation tool
  kept for provenance; it does not run in the app and its outputs were
  superseded by the official Flux assets in `public/`.
- **`marketing/relaypad-x-campaign/`:** archived X/Twitter campaign drafts
  from the RelayPad/DotPad eras (not part of the application; kept locally).
- **Third-party identifiers:** Pump.fun, Raydium, LaunchLab, GeckoTerminal,
  DexScreener, Alchemy, Pinata names are external protocols and stay as-is.
