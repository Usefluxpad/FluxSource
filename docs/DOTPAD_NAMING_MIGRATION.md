# FluxPad Naming Migration (current) + historical DotPad plan

> **Current phase (FluxPad):** all official-token variables now live under the
> `FLUXPAD_OFFICIAL_*` names, with priority `FLUXPAD_*` -> `DOTPAD_*` -> legacy
> `RELAY_*`. The network variable is `NEXT_PUBLIC_FLUXPAD_NETWORK` with the
> same fallback chain. See `.env.example` for the full map. The $FLUX mint is
> read ONLY from `FLUXPAD_OFFICIAL_MINT` and is intentionally left empty until
> a verified $FLUX mint is provided by the owner - old DOT/RELAY mints are
> never reused. Legacy fallbacks remain active so existing deployments keep
> working unchanged.

---

## Historical: DotPad Naming Migration Plan

Status: **proposed — not applied to runtime configuration yet.** The deployed
website keeps reading the existing (RelayPad-era) variable names so the current
production deployment cannot break from this rebranding phase. No secret values
are listed here, only names.

## Current (runtime) variable names in use

| Current name | Purpose | Rename candidate |
| --- | --- | --- |
| `NEXT_PUBLIC_RELAYPAD_NETWORK` | Solana network selector (`devnet` / `mainnet-beta`) | `NEXT_PUBLIC_DOTPAD_NETWORK` |
| `RELAY_OFFICIAL_ENABLED` | Master switch for the official-token dashboard (default off) | `DOTPAD_OFFICIAL_ENABLED` |
| `RELAY_OFFICIAL_NETWORK` | Network override for the treasury dashboard | `DOTPAD_OFFICIAL_NETWORK` |
| `RELAY_OFFICIAL_CREATOR_WALLET` | W1 creator-fee receiver (public address) | `DOTPAD_OFFICIAL_CREATOR_WALLET` |
| `RELAY_OFFICIAL_BUYBACK_TREASURY` | W2 buyback treasury (public address) | `DOTPAD_OFFICIAL_BUYBACK_TREASURY` |
| `RELAY_OFFICIAL_OPS_TREASURY` | W3 operations & reserve treasury (public address) | `DOTPAD_OFFICIAL_OPS_TREASURY` |
| `RELAY_OFFICIAL_DEV_WALLET` | W4 development wallet (public address) | `DOTPAD_OFFICIAL_DEV_WALLET` |
| `RELAY_OFFICIAL_MINT` | Legacy $RELAY mint (historical on-chain configuration) | **do not reuse** — replaced by the variable below |
| `DOTPAD_OFFICIAL_MINT` | **New.** Official $DOT mint — read by the code as of this phase | (already implemented as the only mint source) |

Variables that are not RelayPad-branded and therefore stay unchanged:
`DATABASE_URL`, `POSTGRES_DATABASE_URL`, `SOLANA_RPC_URL`, `ALCHEMY_API_KEY`,
`ALCHEMY_SOLANA_RPC_URL`, `ALCHEMY_SOLANA_WS_URL`, `PINATA_JWT`, `PINATA_GATEWAY`,
`NEXT_PUBLIC_SOLANA_RPC_URL`, `NEXT_PUBLIC_APP_URL`, `VERCEL_PROJECT_PRODUCTION_URL`.

## What already changed in this phase (code behavior)

- The official-token display now reads the mint **only** from
  `DOTPAD_OFFICIAL_MINT`. Because that variable is not set yet anywhere, the
  official $DOT dashboard renders its honest "CA NOT OFFICIAL YET /
  configuration needed" states and copying stays disabled.
- The schema bootstrap runs **lazily on first database use** (single-flight per
  process, from `getDb()`); there is no startup hook — the instrumentation
  entry was removed because Next's dev bundling cannot resolve Node builtins
  from it (edge-runtime instrumentation variant), which broke `next dev`.
  Production behavior is unchanged: the bootstrap check is a single
  `sqlite_master` query per process start.
- The legacy `RELAY_OFFICIAL_MINT` value is intentionally **not** reused as the
  $DOT mint: displaying the old $RELAY mint under a $DOT label would misrepresent
  the token identity. The placeholder constant
  `RELAY_OFFICIAL_MINT_PLACEHOLDER` ("REPLACE_WITH_OFFICIAL_RELAY_MINT") is kept
  verbatim because it is compared against environment values and is rendered
  only in the explicit not-announced state.
- Treasury wallet reads (`RELAY_OFFICIAL_*_WALLET`) are unchanged: the treasury
  wallet addresses themselves must not change.

## Recommended rollout (when the new mint is ready)

1. Owner provides the verified $DOT mint; set `DOTPAD_OFFICIAL_MINT` (and, if
   desired, `DOTPAD_OFFICIAL_ENABLED=true`) in the hosting environment only.
2. Optional compat window: change the code to read
   `DOTPAD_OFFICIAL_* ?? RELAY_OFFICIAL_*` for the remaining wallet/switch
   variables for one release, then migrate the hosting values to the new names.
3. After the hosting environment uses the new names, remove the legacy fallback
   reads and deprecate the old names in `.env.example`.

## Intentionally unchanged "relaypad" references

- Discovery source id `relaypad`, the `relaypadLaunchId` field, and the
  `relaypad-registry(...)` provenance values: API contract + historical record
  meaning (labels in the UI now read "DotPad Launches" / "DotPad").
- `RelaypadError` / `toRelaypadError` / `RelaypadNetworkConfig`: internal type
  and class identifiers (public behavior unchanged).
- Social URLs (`https://x.com/RelayPadHQ`, `https://github.com/Relaypad`) and the
  GitHub repository name: social handles and the repository are not renamed in
  this phase.
- Image assets (`/relaypad-logo-transparent.png`, `/relaypad-banner.jpg`): the
  original logo and banner files stay in place; they will be replaced by the
  owner in a later phase.
- Historical comments and docs mentioning RelayPad (docs/, marketing/,
  artifacts/): not part of the website UI.
