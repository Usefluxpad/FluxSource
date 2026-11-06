# RelayPad Official $RELAY — Implementation Plan (Draft for approval)

**Status:** DRAFT — planning only. Not approved; not implemented. No wallets generated, no keys created, no transactions submitted.
**Date:** 2026-10-14
**Addresses:** **All wallet addresses are placeholders.** None have been provided yet; none are invented. Every `<...>` value below must be filled with a **public** address you supply later. No private keys or seed phrases ever appear in project files or configuration.

**Change log vs. `docs/RELAY_OFFICIAL_TOKEN_TREASURY_PREPARATION.md` (Phase 0):**

1. **Wallet architecture updated to four distinct roles** per the owner's decision: W1 (creator-fee receiver), W2 (buyback treasury), W3 (operations & reserve), **W4 (development wallet — new, deliberately outside the fee/allocation system)**. The Phase 0 three-wallet recommendation is superseded; the dev-wallet separation the Phase 0 doc argued for (§7 "dev wallet ≠ creator-fee recipient") is now an explicit fourth role rather than an unnamed hygiene rule.
2. The minimum-viable two-account arrangement (Phase 0 §3) is **retired**; the launch-day baseline is now W1 (+ W3 recommended before the first allocation split).
3. Allocation policy unchanged (40/35/15/10 bps split); W4 is excluded from it by design (§6).
4. Signing-authority analysis added per role: which roles need signing keys and which need only a public address (§5).
5. Protocol-specific launch-signer analysis added (§4): the one place a dev wallet could accidentally end up permanently involved in the official token.

---

## 1. Wallet role definitions

| Role | Name | Public address | Custody (planned) | Responsibilities |
|---|---|---|---|---|
| **W1** | Official $RELAY creator-fee receiver | `<W1_PUBLIC_ADDRESS>` — placeholder | Hardware wallet | Recorded as the token's `creator` at launch (permanent fee recipient). Receives 100% of official-$RELAY creator fees after sweep/collect. Signs fee collection and the per-batch allocation transfers to W2/W3. |
| **W2** | Dedicated buyback treasury | `<W2_PUBLIC_ADDRESS>` — placeholder | Managed signing-service account (policy-capped) | Receives only the approved buyback slice (40% policy). Signs swaps (SOL→$RELAY on the verified canonical pool) and SPL burns of the purchased $RELAY — via the signing service, never an unrestricted server key. |
| **W3** | Operations & reserve treasury | `<W3_PUBLIC_ADDRESS>` — placeholder | Hardware wallet; multisig (2-of-3) as revenue grows | Receives 35% ops + 15% reserve + 10% growth slices. Pays infrastructure, RPC, monitoring, emergencies. Holds the config-change authority (recorded, authorized policy changes). |
| **W4** | Development wallet | `<W4_PUBLIC_ADDRESS>` — placeholder | Existing personal/dev custody (your choice) | Day-to-day development and administrative signing only. **Not connected to the creator-fee allocation system:** receives no fee slices, signs no collection/allocation/buyback/burn transactions, and must never be recorded as the official token's `creator` (see §4). |

Funding notes: W1 and W2 need small SOL float for transaction fees; W3 funds W1's float. W4 is self-funded for development costs (devnet SOL is free from a faucet) and is never funded from creator-fee allocations. Token accounts (ATAs) created automatically for any of these wallets are **not** separate wallets.

---

## 2. Is W4 actually necessary as a separate wallet?

**Verdict: W4 is not required by the $RELAY architecture or by any protocol — it is optional operational hygiene. A reasonable choice, but honest about what it buys.**

| Intended W4 responsibility | Does it require a separate wallet? |
|---|---|
| Day-to-day development signing (devnet test launches, test transactions, tooling) | No protocol requires it. Any wallet can sign devnet tests. A separate key simply keeps test-signing habits off the treasury keys. |
| Administrative operations (deploy config, admin endpoints, monitoring setup) | No. These require operator authentication in the app, not a blockchain key at all. |
| Acting as launch payer while W1 is recorded as `creator` | Technically possible on Pump (§4) but **not recommended** as W4's role — see §4. |
| Receiving creator fees or controlling buybacks | **Explicitly excluded by this plan.** W4 has no financial role. |

What a separate W4 genuinely provides:

1. **Compromise-surface isolation.** A development wallet is used interactively (dApp connections, frequent low-stakes signing) and is therefore the most likely key to be exposed. Keeping it distinct means its compromise costs nothing from the fee stream or reserves.
2. **Clean accounting.** No dev/test activity ever appears in W1/W2/W3 balances, so the official-fee revenue trail stays trivially verifiable.
3. **Zero cost.** W4 needs no special custody — it can be the wallet you already use for development, just never given a $RELAY role.

When W4 would be unnecessary: if all development testing moves to per-test devnet throwaway keypairs and administrative operations are authenticated without a blockchain key, W4 has no remaining responsibilities and the role can be dropped. **The plan works identically with or without W4; nothing downstream depends on it.**

---

## 3. Protocol-specific reasons the development wallet could be involved in launching — and the trap to avoid

Verified protocol facts (audit §3; `PUMP_CREATOR_FEE_README.md`, `PUMP_PROGRAM_README.md`, `@pump-fun/pump-sdk`):

- Pump's `create_v2` takes a **`creator` argument and a `user` (payer/signer)** that *may be different*; the docs say the `creator` pubkey "will receive all the creator fees for that coin" and that the creator **does not need to sign**.
- **RelayPad's current adapter (`src/lib/adapters/pump.ts`) passes `creator: user`** — the wallet that signs the launch becomes the permanent fee recipient.

Consequences:

1. **The protocol does not require the dev wallet for anything.** No pump.fun or PumpSwap rule involves a development wallet. W1 alone can be both signer and creator.
2. **The trap:** if the official $RELAY launch were executed through the existing RelayPad flow with the **dev wallet connected**, the **dev wallet would become the permanent, unchangeable fee recipient** — exactly the outcome this architecture prevents. This is the only protocol-specific way W4 could ever "be involved": accidentally, by being the launch signer under the current adapter.
3. **Two safe launch paths (choose one before launch):**
   - **Path A (recommended, zero code change):** launch **from W1 itself** — W1 signs `create_v2` and is recorded as `creator`. W4 is not involved at all.
   - **Path B (requires a small adapter change):** a different wallet (W4 or a launch operator) signs as `user`/payer while the adapter passes `creator: W1`. This keeps W1's key offline during the launch but adds an adapter change and coordination. Only worth it if W1's custody policy forbids interactive signing.
4. **Devnet rehearsal:** W4 (or any devnet keypair) may freely execute devnet test launches — different network, no permanence, no connection to the official token.
5. **LaunchLab note (only if Route B were ever used):** the SDK records the signing wallet (`owner`) as the curve's `creator` — the same "signer becomes fee recipient" rule applies, so the same trap exists there.

## 4. Signing authority vs. public-address-only roles

| Role / action | Needs the private key (signs)? | Needs only the public address? | Notes |
|---|---|---|---|
| W1 as `creator` at launch | **No** (verified: the creator argument does not sign) | **Yes** — W1's public address goes into `create_v2` | Under Path A, W1 *additionally* signs as the launch payer |
| Fee sweep (buckets → creator vault) | Any payer (permissionless) | — | Not a W1 signature |
| Fee collect (vault → W1) | **Yes — W1 signs** `collect_creator_fee(_v2)` / `collect_coin_creator_fee` | — | No permissionless collect-to-arbitrary-destination exists |
| Allocation transfers W1 → W2 / W1 → W3 | **Yes — W1 signs** (hardware) | W2/W3 need only their public addresses as destinations | The human-controlled funding valve |
| Receive an allocation slice | No | **Yes** — destination public address only | Applies to W2 and W3 |
| Buyback swap (SOL → $RELAY) | **Yes — W2 signs**, via the signing service | — | Service policy caps apply |
| Burn purchased $RELAY | **Yes — W2 signs**, via the signing service | — | Standard SPL burn instruction |
| W3 ops payments | **Yes — W3 signs** its own disbursements | — | Human/hardware |
| W4 — anything in the fee/buyback system | **No — excluded by design** | W4's address is not needed anywhere in the system | Signs only development/admin activity unrelated to $RELAY revenue |

Summary: **W1's key is required for collection and allocation; W2's key is required (inside the signing service) for swap and burn; W3's key is required for its own payments; W4 requires no signing authority anywhere in this system.** Public addresses alone suffice for the launch's `creator` argument, allocation-transfer destinations, and all configuration references.

---

## 5. Allocation policy (unchanged split; W4 excluded)

Per-batch split of **verified, collected** official-$RELAY creator fees (basis points — proposed, not approved):

| Slice | bps | Destination |
|---|---|---|
| Official $RELAY buyback & burn | 4000 | W2 |
| Development & operations | 3500 | W3 |
| Treasury reserves | 1500 | W3 |
| Liquidity & ecosystem growth | 1000 | W3 |
| **Total** | **10000** | validated to sum exactly |

**W4's exclusion is structural, not just a note:** the allocator's destination allowlist contains only W2 and W3 public addresses; W4 cannot appear in any allocation policy version, and any config attempt to add it fails validation. The "Development & operations" slice funds development *expenses* (infra, tooling, services paid by W3) — it is not paid to W4 the wallet. W4 remains free to be topped up manually by you from W3 if you ever want that; it is never automatic.

Same design principles as Phase 0 §9 (restated briefly): integer-safe bps math with remainder handling; eligible revenue = fees actually received and verified on-chain minus collection costs; over-allocation refused; every batch recorded in an append-only ledger under a policy-version id; percentage changes require an authorized, recorded policy change — and remain possible at any time **without touching the mint or the fee recipient**.

## 6. Configuration placeholders (future `RELAY_OFFICIAL_*` block — NOT applied)

Server-side only (never `NEXT_PUBLIC_*`); public addresses and policy numbers only; no secrets.

```bash
# --- Identity (addresses are PUBLIC, non-secret placeholders) -----------------
RELAY_OFFICIAL_ENABLED=false
RELAY_OFFICIAL_NETWORK=mainnet-beta
RELAY_OFFICIAL_MINT=<after-launch>                # official $RELAY mint (post-launch)
RELAY_OFFICIAL_CREATOR_WALLET=<W1_PUBLIC_ADDRESS> # permanent fee recipient (pre-launch)
RELAY_OFFICIAL_BUYBACK_TREASURY=<W2_PUBLIC_ADDRESS>
RELAY_OFFICIAL_OPS_TREASURY=<W3_PUBLIC_ADDRESS>
RELAY_OFFICIAL_TOKEN_PROGRAM=TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb # Token-2022

# --- Allocation policy (W2/W3 destinations only; W4 cannot be added) ----------
RELAY_OFFICIAL_ALLOCATION_BUYBACK_BPS=4000
RELAY_OFFICIAL_ALLOCATION_OPS_BPS=3500
RELAY_OFFICIAL_ALLOCATION_RESERVE_BPS=1500
RELAY_OFFICIAL_ALLOCATION_GROWTH_BPS=1000         # must sum to exactly 10000

# --- Buyback execution limits (enforced by the signing service) ---------------
RELAY_OFFICIAL_MIN_BUYBACK_LAMPORTS=
RELAY_OFFICIAL_MAX_BUYBACK_TX_LAMPORTS=
RELAY_OFFICIAL_MAX_DAILY_SPEND_LAMPORTS=
RELAY_OFFICIAL_MAX_SLIPPAGE_BPS=
RELAY_OFFICIAL_MIN_POOL_QUOTE_LIQUIDITY_LAMPORTS=
RELAY_OFFICIAL_ALLOWED_SWAP_PROGRAMS=pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA

# --- Safety state -------------------------------------------------------------
RELAY_OFFICIAL_BUYBACK_PAUSED=true                # starts paused; enabling is an
                                                  # explicit authorized act
```

Deliberately absent: any W4 setting. The dev wallet has no configuration surface in the official-token system. Validation at load (future `config.ts`): every address parses as a base58 `PublicKey`; allocation bps sum to 10,000; caps positive and ordered; mint/pool verified on-chain against program ownership before first use.

---

## 7. Phased implementation plan (each phase requires separate explicit approval)

- **Phase 0 — wallet & custody preparation (you, no code):** create/confirm W1 (hardware, first priority — permanent role), W3 (hardware; ideally before the first allocation split), decide launch Path A vs. B (§3), decide fee-sharing question (recommend: not used), finalize launch parameters (name, symbol, artwork, initial buy). W2 deferred until automation is approved. W4 exists already or not, as you prefer.
- **Phase 1 — launch readiness (small code/ops, approved separately):** optionally the Path-B adapter change (pass `creator: W1` while another wallet pays); devnet rehearsal of the full flow; launch-parameter verification. Then **the launch itself** — one-time, W1-involved, human-signed.
- **Phase 2 — post-launch verification & pinning (read-only):** verify mint (Token-2022, 6 decimals, mint authority = pump mint-authority PDA), `BondingCurve.creator == W1`, later the canonical pool via `PumpAdapter.verifyPool`; pin addresses in config; record in the registry.
- **Phase 3 — fee collector & ledger:** vault-balance reads; permissionless sweep job; W1-signed collect (manual/hardware initially); integer-safe allocation batches to W2/W3; append-only ledger with dedupe keys; reconciliation job with auto-pause. Devnet first, then mainnet read-only, then small live batches.
- **Phase 4 — buyback-and-burn worker:** signing-service onboarding for W2; pre-trade checks (pause, thresholds, caps, slippage, liquidity); swap on the verified canonical pool; SPL burn; verification; manual approval for the first cycles; then capped automation.
- **Phase 5 — transparency:** public page reading only on-chain state + ledger records.

## 8. Security rules (standing)

1. Never paste a seed phrase or private key into Cline or any chat; never generate keys during planning or implementation chats.
2. No private keys in project files, `.env*`, `NEXT_PUBLIC_*` variables, or plaintext on the application server.
3. W1 custody: hardware; the key signs collections and allocation transfers, nothing else.
4. W2 custody: managed signing service with per-tx cap, daily cap, destination/instruction allowlist (verified canonical pool swap + SPL burn), and a kill switch. The application server never sees the key.
5. W3 custody: hardware → multisig as revenue grows; holds the config-change authority and the emergency pause.
6. W4: never referenced by the official-token system; no signing authority; no allocation eligibility.
7. Explicit authorization before any real transaction; the pipeline starts **paused**; pausing never blocks protocol-safe sweeps/collections.
8. Every transaction reconciled on-chain against the ledger; mismatch ⇒ alert + auto-pause.

## 9. What you must provide (checklist — public addresses and non-secret config only)

| # | Item | When |
|---|---|---|
| 1 | **W1 public address** + custody confirmation | **Before launch (permanent)** |
| 2 | Launch parameters (name, symbol, artwork/metadata, initial buy, mayhemMode=false) | Before launch |
| 3 | Launch path decision (A: launch from W1; B: payer + adapter change) | Before launch |
| 4 | Fee-sharing decision (recommend: not used) | Before launch |
| 5 | W3 public address | Ideally before launch; required before the first allocation split |
| 6 | W2 public address + signing-service selection/policy | Before allocation splits / before automated buybacks |
| 7 | Allocation percentages (proposed 4000/3500/1500/1000) | Before the first allocation batch |
| 8 | Caps: max buyback per tx, daily spend, slippage, min liquidity | Before automated buybacks |
| 9 | Official mint address | Read from the launch transaction (not provided by you) |
| 10 | Canonical pool address | Read via `verifyPool` (not provided by you) |
| 11 | RPC/deployment config for the worker | Before production deployment |

No private keys or seed phrases are ever requested; wallets are created by you, outside this workspace.

## 10. Open questions

1. Launch path A vs. B (§3) — affects whether a small adapter change is needed.
2. Signing-service product for W2 and its policy format.
3. Worker hosting (Vercel cron vs. external runner).
4. Alerting channel and recipients.
5. W3 multisig upgrade threshold.
6. Final numeric values for all caps/thresholds (placeholders until real revenue data).

## 11. Approval gate

**Nothing below this line happens without your explicit approval of this plan (or an amended version).** In particular: no code changes, no adapter change (Path B), no environment additions, no database migrations, no launch, no collection, no buybacks, no burns. On approval, the next step is scoping Phase 1 (and, if Path B, the adapter change) as its own reviewable unit.

---

*Status: DRAFT implementation plan reflecting the owner's four-wallet decision (W1 fee receiver / W2 buyback treasury / W3 ops & reserve / W4 dev wallet, structurally excluded). All addresses are placeholders. No wallets, keys, transactions, source-code changes, environment changes, or deployments were performed.*




