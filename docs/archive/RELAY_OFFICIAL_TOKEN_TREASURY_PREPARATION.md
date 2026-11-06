# RelayPad Official $RELAY — Treasury Preparation (Phase 0)

**Status:** PLANNING ONLY. No wallets generated, no keys created, no transactions submitted, no application code or environment changed.
**Date:** 2026-10-14
**Inputs:** `docs/RELAY_OFFICIAL_TOKEN_BUYBACK_AUDIT.md` (completed). `docs/RELAY_OFFICIAL_TOKEN_BUYBACK_IMPLEMENTATION_PLAN.md` is referenced but **does not exist yet** — it should be written after this document is approved.
**Scope:** RelayPad's own official $RELAY token only. Nothing here applies to user-launched tokens.

---

## 1. Executive summary

1. **You need 3 wallets, created in this order: (1) the official-$RELAY creator/fee-recipient wallet, (2) the operations & reserve treasury, (3) the buyback treasury.** The buyback treasury can be deferred until automated buybacks are actually approved — but the creator/fee-recipient wallet **must exist and be secured before the token launches**, because the Pump.fun `creator` chosen at launch becomes the permanent fee recipient for official $RELAY.
2. The audit's verified findings hold: on **Pump.fun → PumpSwap** (the recommended route), the `creator` argument at token creation permanently designates who receives creator fees; fees accrue in SOL; sweeps are permissionless; collection, swaps and burns require the recipient's signature. No on-chain configuration by RelayPad is needed beyond choosing that wallet.
3. The proposed allocation (40% buyback / 35% dev & ops / 15% reserve / 10% growth = 10,000 bps exactly) is a **post-collection policy**, not an on-chain setting: it can be changed at any time later **without touching the token mint or the fee recipient**.
4. Security model: the creator/fee-recipient and ops/reserve treasuries are **hardware-wallet custody** (multisig as revenue grows); the buyback treasury is the only wallet an automated worker ever touches, and only through a **managed signing service with hard caps** — never an unrestricted key on the application server.
5. Nothing is implemented. Every future step (launch, collection, buyback, burn) remains pending your explicit approval.

---

## 2. Recommended wallet count

**Three wallets (plus a signing service, not a wallet, for automation).**

Why not fewer or more:

- **Two would merge buyback funds with operating funds.** The audit's security model (§9) requires the automated worker to touch only the approved buyback budget. If the fee recipient is also the buyback wallet, the only thing separating "funds the robot may spend" from "funds the robot must never spend" is server-side accounting — one bug away from overspend. A dedicated buyback treasury that only ever holds the 40% slice is the control boundary.
- **A fourth (separate liquidity/growth) wallet is not justified yet.** The 10% growth slice can live in the ops/reserve treasury until ecosystem spending actually starts; splitting it early adds custody overhead with no benefit at current scale.
- **Token accounts are not wallets.** The official $RELAY token account (ATA) of each wallet, and any future $RELAY buyback ATA, are created automatically by the SPL/Token-2022 program and are **not counted** as wallets. PDAs (protocol-derived addresses) are not user wallets either.
- **The launch payer is not a separate wallet.** The audit verified the creator does not need to sign and may differ from the payer; RelayPad's adapter currently passes the signing wallet as `creator` (`pump.ts`), so the cleanest zero-code-change path is to **perform the launch itself from Wallet 1**. If RelayPad later prefers to launch from a different device/wallet, a small adapter change could pass a distinct `creator` — that is optional, not required.

---

## 3. Minimum viable arrangement (2 accounts)

Suitable for: launch day and the manual phase before any automation exists.

| # | Account | Custody | Roles |
|---|---|---|---|
| M1 | **Official $RELAY creator / fee-recipient / manual treasury** | Hardware wallet (single key) | Receives 100% of creator fees; funds the manual buybacks (collect → swap → burn executed by hand); holds ops/reserve float |
| M2 | Your existing personal/development wallet | Your existing custody | Launch operator ONLY if launching is done from a different device — must **never** be recorded as the token's `creator` |

What is **not** required at minimum: a separate buyback wallet (manual buybacks run directly from M1), a signing service (no automation yet), a multisig (revenue is small early).

Limitations you accept at this stage: no automation, single-key custody, mixing of revenue slices inside one wallet (mitigated by the ledger, not by custody). Acceptable only until fee collection actually starts.

---

## 4. Recommended arrangement for RelayPad (3 accounts + 1 signing service)

| # | Account | Custody | Roles |
|---|---|---|---|
| W1 | **Official $RELAY creator / fee recipient** | Hardware wallet (Ledger/Trezor-derived key), offline-leaning | Receives 100% of official-$RELAY creator fees (curve + canonical PumpSwap pool vaults, after sweeps/collect). Signs: fee collection, the W1→W2/W3 allocation transfers, and (in the manual phase) buyback/burn transactions. |
| W2 | **Buyback treasury** | Managed signing service account (or dedicated keypair in a signing service — **never** a plaintext key on the app server) | Receives only the approved buyback slice (40% policy). Holds the SOL budget the future buyback worker is allowed to spend, plus the purchased $RELAY until burn. Hard-capped by the signing service policy. |
| W3 | **Operations & reserve treasury** | Hardware wallet now; upgrade to a 2-of-3 multisig (e.g. Squads) when revenue supports it | Receives the 35% dev/ops + 15% reserve + 10% growth slices. Pays infra, RPC, monitoring, emergency costs. |

Signing service: the **automation custody method**, not a wallet you create — RelayPad's worker asks the service (which holds W2's key under its own policy engine) to sign pre-authorized, capped transaction bundles. Examples of the pattern: a managed key-management service with policy rules (spend caps, destination allowlists, approval thresholds). Choose the concrete vendor/product in the implementation plan.

## 5. Higher-security arrangement (for larger revenue)

Same three roles, hardened:

- **W1 → 2-of-N multisig treasury** with hardware-key signers. Note the trade-off: Pump's `collect_creator_fee` requires the **creator wallet's signature** — a multisig creator means every collection is a multisig proposal (slower, but no single-key risk). Alternative: keep W1 single-key and use Pump's **one-time fee-sharing config** to route 100% of creator fees to a multisig shareholder — verified one-time-only and irreversible in the audit; decide before launch, because it cannot be re-done.
- **W2 → programmatic vault with enforced caps** (e.g. Squads with spending-limit policy, or a small RelayPad-controlled vault program): the worker's key can only sign transfers/limits defined on-chain, rather than trusting service policy alone.
- **W3 → multisig (2-of-3 or 3-of-5)** with a separate emergency-recovery signer.
- Add a **config-change authority**: any change to allocation percentages, caps, or allowed routes requires a recorded, authorized change (multisig proposal or signed ops attestation logged in the ledger) — see §9.

---

## 6. Purpose of each wallet

| Wallet | Receives | Signs | Never does |
|---|---|---|---|
| **W1 — Official $RELAY creator / fee recipient** | All official-$RELAY creator fees (post-sweep/collect, in SOL) | `collect_creator_fee(_v2)` / `collect_coin_creator_fee`; allocation transfers to W2/W3; manual buybacks in the early phase | Never holds mint authority (the protocol controls it); never signs user-launch flows; never holds unrelated funds |
| **W2 — Buyback treasury** | The approved buyback allocation only (40% policy) | Swaps SOL→$RELAY on the verified canonical pool; SPL burn of the purchased $RELAY | Never receives un-allocated revenue; never pays operating costs; never controlled by an unrestricted server key |
| **W3 — Operations & reserve treasury** | 35% dev/ops + 15% reserve + 10% growth slices | Infra payments; emergency disbursements; future ecosystem spending | Never touched by the automated worker; never used for token launches |

Funding note: W1 and W2 need small SOL float for transaction fees (collect/swap/burn each cost ~0.000005–0.0001 SOL plus ATA rent); W3 funds W1's float. Do not overfund W2 — its balance should track the unspent buyback budget, not idle reserves.

## 7. Can the dev wallet and the creator-fee recipient be the same?

**No — create a dedicated wallet for W1.** Reasons:

1. **Permanence:** the audit verified the Pump.fun `creator` cannot be changed post-launch for a normal launch; whatever wallet is recorded becomes the public, permanent fee recipient. You do not want a personal/development key occupying that slot forever.
2. **Risk isolation:** a development wallet is used interactively (signing test transactions, connecting to dApps) — a higher-compromise-risk profile than a treasury key. Mixing roles means a compromise of dev habits compromises the protocol's revenue stream.
3. **Accounting:** the audit requires a "verifiable source of creator-fee revenue"; a wallet whose only inflows are official-$RELAY creator fees makes reconciliation trivial. A mixed personal wallet does not.
4. **No conflict exists today:** RelayPad's codebase holds **no** server-side wallet (all signing is client-side via the user's browser wallet), so there is no existing "dev wallet" inside the project to conflate — the choice is fully free.
5. Acceptable transient overlap: during the manual phase, W1 may execute manual buybacks (that is W1 acting as interim treasury, documented in §3), but personal/dev wallets should never share W1's role.

## 8. Treasury custody recommendations

| Custody type | Best for | Notes |
|---|---|---|
| **Hardware wallet (single key)** | W1 and W3 at current scale; M1 in the minimum arrangement | Keys never touch any online machine; transactions are built in software and confirmed on-device. Recommended default now. |
| **Multisignature treasury (e.g. Squads)** | W3 as revenue grows; W1 in the higher-security arrangement | Adds approval quorums and on-chain policy; slows every signature — appropriate when stakes justify it. |
| **Dedicated programmatic wallet (keypair in a managed signing service)** | W2 only | Required for any automation. The key lives in the service's enclave with policy rules (caps, destination allowlist), not in RelayPad's server. |
| **Managed transaction-signing service** | W2 (and batched W1 collections later) | The bridge between "human approves a policy" and "machine executes within it". RelayPad's worker submits pre-built transactions; the service signs only what its policy allows. |
| **Plaintext key on the application server** | ❌ Never | Explicitly rejected by the audit (§9) and this plan. |
| **NEXT_PUBLIC_* env key** | ❌ Never | Inlined into browser bundles; also rejected by the existing project conventions (`connection.ts` comments). |

**Security rules adopted for this phase (restating your constraints as standing rules):** never paste a seed phrase or private key into Cline; never generate keys during planning; never store keys in project files; never put keys in `NEXT_PUBLIC_*` variables; never store unrestricted plaintext keys on the server; never give the worker unrestricted treasury access; require explicit authorization before any real transaction; include spending limits, emergency pause, and transaction monitoring in the future design.

**How automation can work without unrestricted control:** the worker builds (but cannot sign) transaction bundles; the signing service holds W2's key and enforces: per-transaction cap, daily cap, destination allowlist (only the verified canonical pool program and the burn instruction), and a kill switch. W1 remains human/hardware custody: it controls how much flows *into* W2 at all (the allocation transfer in §14 step 8 is the human-controlled funding valve).

---

## 9. Creator-fee allocation proposal (40 / 35 / 15 / 10)

Proposed policy split of eligible, verified creator-fee revenue (basis points):

| Slice | bps | Destination | Notes |
|---|---|---|---|
| Official $RELAY buyback & burn | 4000 | W2 | Funds the future worker; the only slice automation may spend |
| Development & operations | 3500 | W3 | Infra, RPC, monitoring, incident costs |
| Treasury reserves | 1500 | W3 | Buffer for fee-schedule changes and emergencies |
| Liquidity & ecosystem growth | 1000 | W3 | Held for future ecosystem/liquidity initiatives |
| **Total** | **10000** | — | Validated to sum exactly to 10,000 |

**Design principles for the allocation system (not implemented):**

1. **Integer-safe accounting:** all policy values in basis points (u64/i64 math); allocation of an amount `X` uses floor division with the **remainder added to the largest slice** (or carried to the next batch) so no satoshi is lost or double-counted; totals validated to sum to exactly 10,000 at config load.
2. **Eligible revenue only:** allocations apply to fees **actually received and verified on-chain** (vault→W1 collections confirmed by signature), minus collection transaction costs — never to projected or uncollected fees.
3. **Never over-allocate:** the allocator reads W1's verified balance delta per batch and refuses to allocate more than was received; the buyback slice is capped additionally by W2's policy caps.
4. **Record every allocation decision:** append-only ledger rows (batch id, period, received amount, per-slice amounts, tx signatures) mirroring the existing `LaunchEvent` dedupe pattern.
5. **Authorized changes:** allocation percentages, thresholds, caps, and allowed routes live in a **versioned policy record**; changing them requires explicit authorization (multisig proposal in the higher-security arrangement; a signed ops change + recorded approval initially). The active policy version id is stamped onto every ledger entry.

**How percentages can change later without touching the mint or fee recipient:** the on-chain facts (mint, `creator`, fee schedule) are fixed by the launch; the allocation is a **RelayPad-side policy applied after collection**. W1 receives 100% of fees regardless of policy; the split into W2/W3 slices happens per batch under the current policy version. Changing 40/35/15/10 to any other sum-to-100% split is a configuration + ledger operation only — no on-chain migration, no new token, no fee-recipient change. (Contrast: Pump's one-time fee-sharing config **is** on-chain and irreversible — one more reason to keep the default creator-receives-everything setup and handle splits in RelayPad.)

## 10. Public-address checklist (what you will eventually provide)

Only **public keys / non-secret configuration** — never seed phrases or private keys.

| # | Item | Class* | Who/when |
|---|---|---|---|
| 1 | W1 creator/fee-recipient public address | **A** | You, before launch — must be finalized before the token is created |
| 2 | Custody method for W1 (+ hardware device confirmed) | **A** | You, before launch |
| 3 | Decision: use Pump fee-sharing config or not (default: not) | **A** | You, before launch (irreversible either way once set) |
| 4 | Launch parameters (name, symbol, metadata URI, initial buy, mayhemMode=false) | **A** | You, before launch |
| 5 | W3 ops/reserve public address | **A/B** | Best before launch (needed for the first allocation split); strictly needed by fee collection |
| 6 | W2 buyback-treasury public address + signing-service policy | **C/D** | Before fee collection can be split (C) and before automated buybacks (D) |
| 7 | Official $RELAY mint address (from the launch transaction) | **B** | After launch; verified on-chain, then pinned in config |
| 8 | Canonical PumpSwap pool address (from `verifyPool`) | **B** | After graduation; verified on-chain |
| 9 | Approved allocation percentages (initial: 4000/3500/1500/1000 bps) | **C** | Before first allocation batch |
| 10 | Maximum buyback amount per transaction | **D** | Before any automated buyback |
| 11 | Daily spending limit | **D** | Before any automated buyback |
| 12 | Slippage limit (bps) | **D** | Before any automated buyback |
| 13 | Minimum pool liquidity requirement | **D** | Before any automated buyback |
| 14 | Preferred RPC configuration (server-side; Alchemy already configured) | **E** | Before production deployment; confirm paid tier + fallback |
| 15 | Signing-service selection + its policy document | **D** | Before any automated signing |
| 16 | Emergency-pause procedure + who holds the pause authority | **D** | Before any automated buyback |
| 17 | Mainnet deployment configuration (hosting, secrets store, cron/worker schedule) | **E** | Before production deployment |

\* Classes: **A** = required before the token launch · **B** = required after the mint exists · **C** = required before fee collection/allocation · **D** = required before automated buybacks · **E** = required before production deployment.

**Irreversible after launch (decide now, verify twice):**

- **The official mint itself** (fixed forever).
- **The `creator`/fee-recipient wallet (W1's address)** — the audit verified no protocol path to change it for a normal launch.
- **A fee-sharing config, if used** — one-time-only and cannot be re-run (the audit recommends *not* using it; keep splits server-side).
- Everything else in the checklist (W2/W3 addresses, percentages, caps, RPC) remains changeable configuration.

---

## 11. Future configuration design (example with placeholders — NOT applied anywhere)

Following RelayPad's existing conventions: server-side-only env variables (never `NEXT_PUBLIC_*` — they are inlined into browser bundles), validated at load, with secrets kept out entirely (no keys here — only public addresses and policy numbers). Suggested namespace: `RELAY_OFFICIAL_*`, distinct from user-launch settings.

```bash
# =============================================================================
# RelayPad OFFICIAL $RELAY — treasury & buyback configuration (FUTURE EXAMPLE)
# Not applied in this phase. Every address below is a PLACEHOLDER — the real
# values are public keys you provide after creating the wallets. NO private
# keys or seed phrases ever belong in this block or anywhere else server-side.
# All settings are server-side only (never NEXT_PUBLIC_*).
# =============================================================================

# --- Identity (Class A/B; addresses are PUBLIC, non-secret) -------------------
RELAY_OFFICIAL_ENABLED=false                       # master switch, default off
RELAY_OFFICIAL_NETWORK=mainnet-beta                # the launch network
RELAY_OFFICIAL_MINT=               <after launch>  # official $RELAY mint (Class B)
RELAY_OFFICIAL_CREATOR_WALLET=     <W1 public key> # fee recipient (Class A, permanent)
RELAY_OFFICIAL_BUYBACK_TREASURY=   <W2 public key> # buyback treasury (Class C/D)
RELAY_OFFICIAL_OPS_TREASURY=       <W3 public key> # ops/reserve treasury (Class A/B)
RELAY_OFFICIAL_TOKEN_PROGRAM=      TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb  # Token-2022

# --- Allocation policy (Class C; changeable via authorized policy version) ---
RELAY_OFFICIAL_ALLOCATION_BUYBACK_BPS=4000
RELAY_OFFICIAL_ALLOCATION_OPS_BPS=3500
RELAY_OFFICIAL_ALLOCATION_RESERVE_BPS=1500
RELAY_OFFICIAL_ALLOCATION_GROWTH_BPS=1000          # must sum to exactly 10000

# --- Buyback execution limits (Class D; enforced by the signing service) ------
RELAY_OFFICIAL_MIN_BUYBACK_LAMPORTS=               # e.g. 5_000_000_000 (5 SOL)
RELAY_OFFICIAL_MAX_BUYBACK_TX_LAMPORTS=            # per-transaction cap
RELAY_OFFICIAL_MAX_DAILY_SPEND_LAMPORTS=           # rolling daily cap
RELAY_OFFICIAL_MAX_SLIPPAGE_BPS=                   # e.g. 100 (1%)
RELAY_OFFICIAL_MIN_POOL_QUOTE_LIQUIDITY_LAMPORTS=  # refuse buys into thin pools
RELAY_OFFICIAL_ALLOWED_SWAP_PROGRAMS=pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
RELAY_OFFICIAL_BURN_INSTRUCTION=SPL_BURN           # standard SPL Token burn

# --- Safety state -------------------------------------------------------------
RELAY_OFFICIAL_BUYBACK_PAUSED=true                 # DEFAULT PAUSED; enabling is
                                                   # an explicit authorized act
```

Notes:

- These are **placeholders**; no real address exists yet and none is invented. `RELAY_OFFICIAL_BUYBACK_PAUSED=true` is deliberate: the mechanism starts disabled and is explicitly enabled only after every Class-D item is satisfied.
- Secrets never enter this block: W2 signing happens inside the external signing service; W1 signing happens on hardware. RelayPad's server holds **only public addresses and policy numbers** — matching the audit's rule that no private key is ever stored server-side.
- Runtime validation (future `config.ts`): every address must parse as a base58 `PublicKey`; `ALLOCATION_*` must sum to 10,000; caps must be positive and ordered (`MAX_BUYBACK_TX_LAMPORTS ≤ MAX_DAILY_SPEND_LAMPORTS`); `MINT`/pool addresses are additionally verified on-chain against program ownership before first use (reusing `PumpAdapter.verifyPool`).

## 12. Launch-readiness requirements

Before the official $RELAY launch can happen (all Class-A items + verification):

1. **W1 exists, custody confirmed** (hardware wallet initialized, seed backed up offline in multiple shares, address recorded and double-checked on-device).
2. **W3 address exists** (or the decision that W3 is deferred and W1 temporarily holds all slices — minimum arrangement §3).
3. **Fee-sharing decision:** default is **not** to create a Pump fee-sharing config (keeps the server-side allocation flexible; fee-sharing is one-time-only).
4. **Launch parameters finalized:** name, symbol (`RELAY`), metadata (artwork uploaded via the existing Pinata flow), optional initial buy amount, `mayhemMode: false` (per the audit's design), Token-2022, 6 decimals, 1B supply — consistent with RelayPad's existing launch flow.
5. **Launch mechanics decided:** perform the launch **from W1 itself** using the existing UI/flow (zero adapter change — the signing wallet becomes `creator`), or (later, with a small adapter change) launch from another payer while passing W1 as `creator`. Recommendation: launch from W1 for simplicity and proof-of-ownership.
6. **Test rehearsal on devnet:** run the full flow (create → curve → graduation simulation → verification reads) on devnet first, per the audit's Phase plan.
7. **Post-launch verification plan ready:** verify the mint account (Token-2022, 6 decimals, mint authority = pump mint-authority PDA), record the mint address from the confirmed transaction, pin it, then verify `BondingCurve.creator == W1` on-chain and (after graduation) the canonical pool via `verifyPool`.

---

## 13. Security and signing architecture (future design)

**Signing authority map (who can sign what):**

| Operation | Signer | Custody | Automation? |
|---|---|---|---|
| Official $RELAY launch (`create_v2` + optional first buy) | W1 (or another payer passing W1 as `creator`) | Hardware | Never — one-time human act |
| Fee sweep (protocol buckets → creator vault) | Any payer (permissionless) | RelayPad server (keyless or a low-value executor float) | ✅ Safe to automate (destination-constrained by protocol) |
| Fee collect (vault → W1) | W1 | Hardware | Manual/hardware-approved initially; batched via signing service only later |
| Allocation transfer (W1 → W2 / W3) | W1 | Hardware | Manual initially; policy-approved later |
| Swap (W2's SOL → $RELAY, canonical pool only) | W2 | Signing service with caps | Automatable **after** Class-D items |
| Burn ($RELAY → supply reduction) | W2 | Signing service with caps | Automatable **after** Class-D items |
| Policy/config changes | W3 authority (recorded) | Hardware/multisig | Manual, always |

**Defense layers for the automated path (design commitments, not implemented):**

1. **Custody:** W2's key lives only in the signing service enclave with policy rules (per-tx cap, daily cap, destination allowlist, instruction allowlist: swap-on-verified-pool + burn). The RelayPad application server never holds or sees the key.
2. **Route allowlist:** swaps are built only against the verified canonical PumpSwap pool (program-owner-checked via `PumpAdapter.verifyPool`, reusing existing `PUMPSWAP_PROGRAM_ID`/`PUMPSWAP_GLOBAL_CONFIG` constants). No aggregator, no arbitrary pools.
3. **Pre-trade checks (server-side, no key needed):** pause flag off; budget ≥ `MIN_BUYBACK_LAMPORTS`; amount ≤ per-tx and daily caps; pool quote liquidity ≥ `MIN_POOL_QUOTE_LIQUIDITY_LAMPORTS`; simulated swap output within `MAX_SLIPPAGE_BPS`.
4. **Determinism & dedupe:** every batch has an id; ledger rows use unique `(batchId, step)` dedupe keys (same pattern as `(launchId, dedupeKey)` in the Prisma schema) so replays cannot double-spend.
5. **Reconciliation:** after each bundle, server-side reads compare: W2 SOL delta vs. spent, W2 $RELAY ATA delta vs. purchased, mint supply delta vs. burned. Any mismatch raises an alert and **auto-pauses** the pipeline (reads on-chain state as truth, per the project's existing reconcile pattern in `src/lib/reconcile.ts`).
6. **Emergency pause:** a single switch (config + signing-service kill switch); pausing stops new swaps/burns but never blocks sweeps or collections (they are safe and destination-constrained). Pause authority recorded in the checklist (item 16).
7. **Monitoring/alerts:** worker events feed the alerting channel; alerts on: collection received, allocation executed, buyback executed, burn executed, reconciliation mismatch, pause engaged, RPC/provider failure.

## 14. Future operational workflow (proposed — not implemented)

| # | Step | Mode | Notes |
|---|---|---|---|
| 1 | Launch the official $RELAY token | **Manual (W1 signs)** | One-time human act via the existing launch flow |
| 2 | Verify the official mint address | ✅ Automatable (read-only) | Mint authority = pump mint-authority PDA; Token-2022; 6 decimals |
| 3 | Verify the creator-fee recipient | ✅ Automatable (read-only) | `BondingCurve.creator == W1`; later `Pool::coin_creator == W1` |
| 4 | Collect eligible creator fees per protocol rules | Semi | Sweeps ✅ automatable (permissionless); collect = W1 signature (manual initially) |
| 5 | Reconcile received revenue vs. on-chain balances | ✅ Automatable (read-only) | SDK vault-balance reads + W1 balance deltas; alerts on mismatch |
| 6 | Calculate the approved allocation | ✅ Automatable | Pure integer math under the active policy version |
| 7 | Record the accounting entries | ✅ Automatable | Append-only ledger, dedupe keys |
| 8 | Transfer the buyback allocation to W2 | **Manual approval initially** | W1 hardware signs W1→W2 (and W1→W3) transfers per batch |
| 9 | Execute a buyback after security & liquidity checks | **Manual first cycles → automated** | Requires: unpaused, budget ≥ threshold, caps ok, liquidity ok, simulation ok |
| 10 | Verify the amount of $RELAY purchased | ✅ Automatable | W2 $RELAY ATA delta + swap event |
| 11 | Burn the purchased tokens (SPL burn instruction) | **Manual first cycles → automated** | W2 signs; supply provably decreases |
| 12 | Verify the burn on-chain | ✅ Automatable | Mint supply delta vs. ledger |
| 13 | Publish accurate, verifiable statistics | ✅ Automatable (read-only) | Reads only on-chain state + ledger; no projected numbers |

Automation rollout rule: steps 4/6/7/5/10/12/13 can run unattended from day one (all read-only or protocol-safe); steps 1, 8, 9, 11 stay **human-approved until the first several cycles pass reconciliation cleanly** — then steps 9 and 11 may move to capped automation via the signing service.

---

## 15. Proposed future source-code changes (NOT created in this phase)

| Proposed file / module | Responsibility | Dependencies | Sensitive? | Tests | Authorization |
|---|---|---|---|---|---|
| `src/lib/relay-official/config.ts` | Load + validate the `RELAY_OFFICIAL_*` block; integer-safe policy types; bps-sum validation; address parsing | `@solana/web3.js`, `zod` (already in deps) | No (public config only) | Unit: bps math, sum validation, bad-address rejection | Read-only |
| `src/lib/relay-official/collector.ts` | Vault balance reads (`getCreatorVaultBalanceBothPrograms`); build sweep + collect instructions | `@pump-fun/pump-sdk`, `connection.ts` | **Yes** (builds W1-signed txs; server only builds) | Unit: instruction build shapes; sweep-first ordering; zero-balance no-op | Worker + W1 signer |
| `src/lib/relay-official/allocator.ts` | Verified-revenue batches; floor-division bps split with remainder handling; ledger writes | `config.ts`, Prisma | No | Unit: allocation math incl. remainders/rounding; over-allocation refusal | Policy version |
| `src/lib/relay-official/buyback.ts` | Verified canonical pool fetch (`PumpAdapter.verifyPool` reuse); swap build via official pump-swap SDK; caps & slippage pre-checks; simulation | `adapters/pump.ts`, `@pump-fun/pump-swap-sdk` | **Yes** | Unit: cap/slippage gates; pool verification; sim failure handling | Signing service (W2) |
| `src/lib/relay-official/burn.ts` | SPL/Token-2022 burn instruction build + supply-delta verification | `@solana/spl-token` | **Yes** | Unit: burn build; supply verification math | Signing service (W2) |
| `src/lib/relay-official/reconcile.ts` | On-chain vs. ledger comparison per batch; auto-pause on mismatch | `connection.ts`, Prisma | No (read-only) | Unit: match/mismatch paths; alert triggers | Worker |
| `src/lib/relay-official/signer.ts` | Signing-service adapter interface (submit bundle, query status); manual/hardware path for W1 | External signing service API | **Yes** (handles signed payloads) | Unit: interface contract; refusal paths | Explicit authorization per bundle |
| `src/app/api/relay-official/*` | Admin endpoints: status (read-only), pause/unpause, batch review/approval | Next.js route handlers, `rpc-proxy-policy.ts` patterns | **Yes** | Integration tests with auth rejection paths | Operator auth (defined in the implementation plan) |
| `prisma/schema.prisma` (additive models) | `RelayOfficialLedgerEntry` (append-only, dedupe key), `RelayOfficialPolicyVersion` | Prisma | No | Schema + unit tests on dedupe | DB migration approval |
| Worker/scheduler entrypoint | Periodic collector/reconciler runs | Hosting (Vercel cron or external runner — decided in the implementation plan) | Semi (no keys; builds only) | Integration: schedule no-op when paused | Class-D checklist |

Explicitly **not** proposed: any server-side key storage; any change to user-launch adapters' fee behavior; any `NEXT_PUBLIC_*` addition.

---

## 16. Unresolved questions

1. **Signing-service selection for W2** (product, policy format, kill-switch mechanics) — required before Class-D items can be finalized.
2. **W3 upgrade timing to multisig** — at what monthly revenue level does 2-of-3 become justified?
3. **Whether the launch is performed from W1 directly** (recommended, zero code change) or via a distinct payer with a small adapter change to pass `creator: W1`.
4. **Fee-sharing config:** confirm the default "do not use" decision (irreversible if ever created).
5. **Worker hosting model:** Vercel cron (the project deploys to Vercel today) vs. an external runner — affects the scheduler design and RPC egress.
6. **Alerting channel** (email/Telegram/webhook) and who receives them.
7. **Exact initial numeric policy values** (thresholds, caps, slippage) — placeholders until real fee revenue is observed.
8. **The implementation plan itself** (`docs/RELAY_OFFICIAL_TOKEN_BUYBACK_IMPLEMENTATION_PLAN.md`) — does not exist yet; it should incorporate this document's wallet/config decisions after your approval.

## 17. Next steps for you

1. **Approve or amend this wallet architecture** (3 wallets: W1 creator/fee recipient — W2 buyback treasury — W3 ops/reserve, with W2 deferred until automation).
2. **Create W1 on a hardware wallet** and record its public address (never share the seed with anyone, including Cline). This is the first and only wallet required immediately.
3. **Create (or designate) W3** — a second hardware-wallet account is sufficient initially.
4. **Decide the fee-sharing question** (recommend: not used) and finalize launch parameters (name, symbol, artwork, initial buy).
5. Then we can draft the **implementation plan** (Phase 0 → launch → collector → worker) for your approval — still without touching any application code.

---

## Summary table — what you must prepare

| Wallet/account | Required? | Purpose | When needed | What I must provide |
|---|---|---|---|---|
| **W1 — Official $RELAY creator / fee recipient** | **Yes — first priority** | Receives 100% of official-$RELAY creator fees; signs collections & allocation transfers; permanent role recorded at launch | **Before the token launch (Class A)** | Hardware wallet; its public address; custody confirmation |
| **W3 — Operations & reserve treasury** | Yes (can defer to first collection) | Holds 35% ops + 15% reserve + 10% growth slices; pays infra | Before fee collection (Class C; ideally Class A) | Hardware wallet (or multisig later); its public address |
| **W2 — Buyback treasury** | Deferred | Holds only the 40% buyback slice; the sole wallet automation may spend; executes swap + burn | Before allocation splits (Class C) and before automated buybacks (Class D) | Signing-service account; its public address; service policy (caps, allowlists) |
| Signing service (for W2) | Deferred | Policy-enforced signing for automated buyback/burn | Before automated buybacks (Class D) | Vendor/product choice + policy document |
| Official $RELAY mint | N/A — created at launch | The token itself | After launch (Class B) | Nothing — read from the confirmed launch transaction |
| Canonical PumpSwap pool | N/A — created at graduation | Verified swap venue for buybacks | After graduation (Class B) | Nothing — read via `verifyPool` |
| Executor float (optional) | Optional | Pays SOL fees for permissionless sweep/collect runs | Before fee collection (Class C) | A tiny low-value wallet or W1-funded schedule |

**Create W1 first.** It is the only wallet that must exist before the launch, its role is permanent, and every downstream step (collection, allocation, buybacks) keys off it.

---

*End of Phase 0 preparation. Status: PLANNING ONLY — no wallets generated, no keys created, no transactions submitted, no application code, environment, database, or deployment settings changed. The development server on port 3210 was not touched. Awaiting your explicit approval before any implementation planning begins.*








