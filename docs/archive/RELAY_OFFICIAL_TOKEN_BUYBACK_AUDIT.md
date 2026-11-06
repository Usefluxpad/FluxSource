# RelayPad Official Token ($RELAY) — Creator-Fee Buyback & Burn Audit

**Status:** AUDIT ONLY — no implementation, no transactions, no code changes.
**Audit date:** 2026-10-14 (session date). Documentation and live on-chain values retrieved on this date.
**Scope:** RelayPad's own official token ($RELAY) only. This is not a feature design for user-launched tokens.
**Evidence labels used throughout:** **[VERIFIED-REPO]** (read from this repository), **[VERIFIED-DOCS]** (quoted from official protocol documentation fetched during this audit), **[ASSUMPTION]**, **[UNRESOLVED]**.

---

## 1. Executive summary

1. **No official $RELAY token exists today in any verifiable form.** No mint address, network, creator wallet, fee recipient, pool, or fee configuration for an official RelayPad token exists in the repository, its environment files, or its database schema. **The token has not been launched through RelayPad, and its mint cannot be verified. No address is invented anywhere in this report.**
2. **The proposed funding mechanism is technically feasible on both routes**, but under different terms. On **Pump.fun**, the wallet passed as `creator` at token creation receives all creator fees for that coin — pre-graduation (bonding-curve creator vault) and post-graduation (canonical PumpSwap pool). If RelayPad launches $RELAY from a RelayPad-controlled wallet (the "treasury"), RelayPad legitimately receives those fees. Collection is **permissionless** (any payer can sweep the vaults), but the **destination is fixed to the creator wallet/ATA** — so the treasury must be the launch creator wallet.
3. On **Raydium LaunchLab**, creator fees also accrue in two phases (bonding-curve vault, then CPMM creator fee), but the revenue terms depend on on-chain platform/AMM config values RelayPad does not control, and a 2026-08-17 program upgrade removed the creator's locked-LP share for new migrations (assigned to the platform instead).
4. **Recommendation: launch official $RELAY via Pump.fun → PumpSwap (Route A).** It has the clearest documented creator-fee terms, a single canonical destination pool, permissionless destination-constrained collection (automation without hot keys for the sweep step), and the smallest integration delta for RelayPad's existing adapter.
5. Buyback-and-burn itself needs **no new program**: purchase $RELAY on the canonical pool with standard swaps, then burn with the standard SPL/Token-2022 `burn` instruction. Security hinges on treasury custody, allocation limits, slippage guards, and reconciliation — detailed in §9.

---

## 2. Does the official $RELAY token already exist?

**Answer: No verifiable official $RELAY token was found. State of the evidence:**

| Item | Finding | Evidence |
|---|---|---|
| Official mint address | **Not found.** No mint address for an official RelayPad token exists anywhere in the repo | **[VERIFIED-REPO]** scoped grep over the entire `relaypad/` tree (src, configs, docs, artifacts) for `RELAY`, `buyback`, `burn`, `treasury`, `creator`, `fee` |
| Token network | **N/A — no token** | — |
| Decimals / supply | **N/A.** RelayPad's launch flow mints 1,000,000,000 supply at 6 decimals for *user* tokens (`pump.ts` create_v2, `launchlab.ts` `decimals: 6`), but no decision or record exists for $RELAY | **[VERIFIED-REPO]** |
| Creator wallet / fee recipient | **Not configured.** `.env` and `.env.local` contain only RPC/Alchemy/DB/Pinata/app-name settings — no token, treasury, or fee-recipient variables | **[VERIFIED-REPO]** |
| Existing liquidity pools / pairs | **None known.** The discovery layer indexes *third-party* tokens only; no RelayPad-owned mint is recorded in the launch registry schema (`creatorWallet` refers to user launches) | **[VERIFIED-REPO]** |
| Current launch route for $RELAY | **None — not launched** | — |
| Existing fee configuration | **None for $RELAY.** The only fee config in the repo is *read-only protocol introspection* (see §3/§4) | **[VERIFIED-REPO]** |
| Existing buyback / burn implementation | **None.** No buyback, burn, treasury, or fee-collection code exists | **[VERIFIED-REPO]** |

**Ticker caveat honored:** "RELAY" is a common ticker; multiple unrelated tokens share it. Without an official mint published by RelayPad, **any** on-chain `RELAY` ticker must be treated as an impostor. This report therefore treats the official $RELAY as **not yet launched**, and everything below is a *pre-launch* design conditioned on RelayPad performing the launch itself from a controlled wallet.

> **Consequence:** the single most important pre-launch decision is that **the wallet passed as `creator` at token creation becomes the permanent fee recipient** (§3.2, §5). This cannot be casually changed later.

---

## 3. Creator-fee mechanics — Pump.fun → PumpSwap (Route A)

Evidence sources: official `pump-public-docs` (`PUMP_CREATOR_FEE_README.md`, `PUMP_SWAP_CREATOR_FEE_README.md`, `FEE_PROGRAM_README.md`, `FEE_RECIPIENTS.md`, `PUMP_PROGRAM_README.md`), the pinned official SDK `@pump-fun/pump-sdk@4.0.0` (README + IDL read from `node_modules` in this repo), and a **live read-only RPC fetch** of the mainnet `Global` and `FeeConfig` accounts performed during this audit (no transactions submitted).

### 3.1 How fees accrue (verified)

- Every buy/sell on a **non-completed bonding curve** charges a protocol fee **plus a creator fee**. The creator fee accrues **in the quote mint (SOL)** into a per-coin `creator_vault` PDA seeded `[b"creator-vault", BondingCurve.creator]` **[VERIFIED-DOCS]**.
- On **canonical PumpSwap pools** (created by the Pump program's `migrate` instruction for completed curves — exactly the destination of a graduated launch), each swap additionally charges a `coin_creator_fee`, accruing into `coin_creator_vault_ata` keyed by `Pool::coin_creator` **[VERIFIED-DOCS]**.
- Post-graduation accrual **continues on the canonical pool**. The protocol docs state who receives fees: "all non-completed Pump bonding curves; all canonical PumpSwap pools" — and who does not: "coins already migrated to Raydium … normal PumpSwap pools which are not created by Pump program `migrate`" **[VERIFIED-DOCS]**.

### 3.2 Who receives the fees (verified)

- `BondingCurve::creator` is populated **from the `creator` argument of `create`/`create_v2`**. The docs are explicit: *"be careful what `creator` pubkey you pass to the `create` instruction, as that pubkey will receive all the creator fees for that coin"* **[VERIFIED-DOCS]**.
- The `creator` argument **does not have to sign** and may differ from `user` (the payer): *"In general, user and creator are the same pubkey, but they can be different"* **[VERIFIED-DOCS]** (`PUMP_PROGRAM_README.md`).
- **Consequence for official $RELAY:** RelayPad can legitimately designate a RelayPad-controlled wallet as the token's `creator` — either by performing the launch from a RelayPad ops wallet (creator = payer = treasury), or by passing the treasury as `creator` while another wallet pays. There is no third-party platform cut of the creator fee on this route.

### 3.3 Fee rates (verified live on mainnet, 2026-10-14, read-only)

| Account | Field | Value |
|---|---|---|
| `Global` | `feeBasisPoints` (protocol fallback) | **95 bps** |
| `Global` | `creatorFeeBasisPoints` (fallback) | **5 bps** |
| `Global` | `creatorFeeConfigurable` | **true** |
| `Global` | `maxConfigurableCreatorFeeBps` | **300** |
| `Global` | `createV2Enabled` | **true** |
| `FeeConfig` (pump-fees) | current tier: `protocolFeeBps` | **95 bps** |
| `FeeConfig` | current tier: `creatorFeeBps` | **30 bps (0.30% of swap volume)** |
| `FeeConfig` | current tier: `lpFeeBps` | **0 bps** |

The **effective creator fee is 30 bps** while the `FeeConfig` exists (the `Global` values are only the fallback). Fees are tiered by market cap (`FEE_PROGRAM_README.md`); the live config currently holds a single tier. **Caveat [ASSUMPTION]:** the tier table is pump.fun-controlled and can change at any time; RelayPad's adapter already reads the config live (`pump.ts` `loadConfig`) — pricing logic must always read on-chain, never hardcode.

### 3.4 Can the fee rate be customized for official $RELAY? (verified)

- `Global.creatorFeeConfigurable = true` (cap `maxConfigurableCreatorFeeBps = 300`) lets a coin carry `BondingCurve.creatorFeeBps`. **However**, per the SDK README: *"only a coin quoted through `QuoteControl` stores one: on a SOL or USDC quote the create-time value is ignored and a CTO refuses it (6091)"* **[VERIFIED-SDK]**.
- `can_edit_creator_fee` is *"reserved, always false"*; changing a custom rate requires contacting pump.fun's CTO team **[VERIFIED-DOCS]**.
- **Consequence:** on the standard SOL quote, official $RELAY's creator fee is **fixed by the protocol schedule (30 bps today)**. RelayPad cannot raise it via the create call. `creatorFeeConfigurable` only matters if RelayPad ever requests a QuoteControl listing.

### 3.5 Collection and withdrawal rules (verified)

- **Sweep (curve/pool bucket → creator vault):** `sweep_creator_fee` (pump) and `sweep_pool_creator_fee` (pump-amm) are **permissionless** — *any payer* can trigger them; they are destination-constrained (they pay the coin's creator vault) **[VERIFIED-SDK]**.
- **Collect (vault → creator wallet):** `collect_creator_fee` / `collect_creator_fee_v2` and pump-amm's `collect_coin_creator_fee` **require the `creator` to sign**; funds land only in the creator's wallet/ATA **[VERIFIED-DOCS + VERIFIED-SDK]**.
- **Fee sharing:** `update_fee_shares(_v2)` lets the creator split creator fees among shareholders — *"Reward split can be setup once and once only"* **[VERIFIED-SDK]**. This is the only on-chain way to change *who ultimately receives* RelayPad's creator fees after launch; it could route 100% to a treasury wallet.
- **Operational block:** an un-swept creator bucket **blocks** `distribute_creator_fees(_v2)`, `admin_cto`, fee-sharing creation and `update_fee_shares(_v2)` (`CreatorFeesNotSwept` / `PoolCreatorFeesNotSwept`) — the sweep must be included first in the same transaction **[VERIFIED-SDK]**.
- **Creator/recipient changes:** no protocol path exists to change `BondingCurve::creator` for a normal launch (the admin `set_creator` instruction is reserved for pump.fun's backend servicing of legacy coins) **[VERIFIED-DOCS]**. **The creator chosen at launch is effectively permanent** → pre-launch decision (§5).

### 3.6 Liquidity / LP note (verified)

At graduation, migration to PumpSwap **burns the LP tokens** (`PUMP_PROGRAM_README.md`: "The LP tokens received from the PumpSwap pool are then burnt"). RelayPad would receive **no LP fee stream** on this route — the only token-owner revenue is the creator fee.

### 3.7 Does RelayPad's existing integration support this? (verified)

`src/lib/adapters/pump.ts` builds the launch with the official SDK (`createV2Instruction` / `createV2AndBuyInstructions`) passing `creator: user` (the signing wallet). For the official $RELAY launch this means: **launch from a RelayPad-controlled wallet and the treasury automatically becomes the permanent fee recipient — zero adapter change required for the launch itself.** The adapter already surfaces `creatorFeeConfigurable` from `Global` (read-only introspection). No swap/burn code exists yet (that is the future buyback worker, §7).

---

## 4. Creator-fee mechanics — Raydium LaunchLab → Raydium CPMM (Route B)

Evidence sources: official Raydium docs (`products/launchlab/creator-fees`, `user-flows/how-creator-fees-work`, `products/launchlab/tips-and-gotchas/launchlab-cpmm-fee-reference`, `products/launchlab/platform-config`, `products/cpmm/fees`), the pinned official SDK `@raydium-io/raydium-sdk-v2@0.2.74-alpha` (layouts/type declarations read from `node_modules`), a live read-only fetch of the mainnet LaunchLab `LaunchpadConfig` PDA, and Raydium's official REST endpoint (`api-v3.raydium.io/main/cpmm-config`).

### 4.1 Phase 1 — bonding-curve creator fees (verified)

- While the token trades on the curve, *"each buy and sell can charge a creator-fee component"* accruing **in the quote token** in a **per-creator, per-quote-mint vault**. The rate is **`PlatformConfig.creator_fee_rate` — set by the platform, not by the token creator** **[VERIFIED-DOCS]**.
- Claim path: `ClaimCreatorFee` (SDK types `ClaimCreatorFee` / `ClaimMultiCreatorFee` in `lib/raydium/launchpad/type.d.ts`), **creator-signed**. *"Graduation stops new bonding-curve accrual but does not erase an unclaimed balance."* **[VERIFIED-DOCS]**
- On-chain `LaunchpadConfig` (SOL-quoted, curve type 0 / index 0), read live this audit: `tradeFeeRate = 2500` (0.25% of volume), `maxShareFeeRate = 10000` (1%), `migrateFee = 0`, `minFundRaisingB = 24_000_000_000` (24 SOL graduation target), `curveType = 0`, config PDA `6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX` **[VERIFIED-ONCHAIN]**.
- Program caps **[VERIFIED-DOCS]** (`PlatformConfig` reference): `MAX_CREATOR_FEE_RATE = 5000` → **0.5% of volume max** for the curve-phase creator fee; platform `fee_rate` capped at `50000` → 5%.
- **[UNRESOLVED]** The *actual* `creator_fee_rate` of Raydium's default mainnet platform config was not read during this audit (the PlatformConfig PDA requires Raydium's platform admin key as a derivation seed; it is not published in the SDK constants). It is a single RPC read at launch time. RelayPad's adapter decodes `LaunchpadConfig` but **not** `PlatformConfig`; reading it must be added before relying on this route.

### 4.2 Migration (verified — materially unfavorable change)

- All new launches graduate to **CPMM** (`migrateType: "cpmm"`; RelayPad's adapter already hard-codes this).
- **2026-08-17 upgrade:** *"For migrations executed after the upgrade, it combines platform_scale + creator_scale … the LP-Lock program creates one Fee Key NFT for platform_nft_wallet"* — **the creator's locked-LP fee share was removed and is now assigned to the platform**. The docs warn integrators: *"do not display creator_scale as a creator Fee Key percentage"* **[VERIFIED-DOCS]**.
- **Consequence:** a $RELAY launch on Route B today would earn **no LP-fee stream** — only the curve-phase creator fee (platform-set, ≤0.5%) plus the CPMM creator fee (§4.3).

### 4.3 Phase 2 — CPMM creator fees (verified)

- CPMM charges a **separate creator fee** at `AmmConfig.creator_fee_rate`, *"independent of the trade fee"*, accrued to `PoolState.creator_fees_token*` (`creatorFeesMintA` / `creatorFeesMintB` in `CpmmPoolInfoLayout`), **active only when the pool was created with `enable_creator_fee = true`**, with a `creator_fee_on` mode choosing which side of the swap pays (LaunchLab: `CpmmCreatorFeeOn` = `OnlyTokenB (0)` / `BothToken (1)`) **[VERIFIED-DOCS + VERIFIED-SDK]**.
- Live Raydium REST config (`api-v3.raydium.io/main/cpmm-config`): every UI-visible mainnet CPMM config has **`creatorFeeRate = 500` → 0.05% of swap volume** (tradeFeeRate 2500–40000; protocol takes 120000 and fund 40000 **of the trade fee**) **[VERIFIED-ONCHAIN]**. Which config a migration uses is chosen by `PlatformConfig.cpConfigId` — **[ASSUMPTION]** Raydium's default platform most likely binds a standard config (`D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2`: 0.25% trade / 0.05% creator), to be verified on-chain before launch.
- **2026-09-19 upgrade:** *"the accrued creator fee is split once more at collection time: a configurable share is moved into the pool's protocol bucket and only the remainder reaches the creator"* — from `AmmConfig.creator_fee_share_rate` (`CpmmConfigInfoLayout.creatorFeeShareRate`) or a per-creator `CreatorFeeShare` PDA **[VERIFIED-DOCS + VERIFIED-SDK]**. **[UNRESOLVED]** the current share-rate value must be read on-chain at launch time.
- The CPMM pool creator is: *"the original launch creator when `PlatformConfig.platform_cp_creator` is the default pubkey; or the configured platform_cp_creator otherwise"* **[VERIFIED-DOCS]** (`platformCpCreator` in the SDK's `PlatformConfig` layout). Launching through Raydium's own default platform (RelayPad's adapter passes no `platformId` on mainnet) therefore records the **launch creator (RelayPad's wallet) as the CPMM fee beneficiary** — unless Raydium's default platform sets a non-default `platform_cp_creator` **[UNRESOLVED — one RPC read at launch]**.

### 4.4 Collection (verified)

- CPMM: `CollectCreatorFee` (creator-signed) **or** `CollectCreatorFeePermissionless` — *"any payer can trigger the destination-constrained permissionless path that pays the creator's canonical ATAs"* **[VERIFIED-DOCS]**; SDK types `CollectCreatorFees` / `CollectMultiCreatorFees` (`lib/raydium/cpmm/type.d.ts`).
- Curve phase: `ClaimCreatorFee` requires the **creator's signature** — no permissionless path is documented for the bonding-curve vault.

### 4.5 Does RelayPad's existing integration support this? (verified)

`src/lib/adapters/launchlab.ts` launches via `raydium.launchpad.createLaunchpad(...)` with `migrateType: "cpmm"` and does **not** pass `shareFeeRate` / `shareFeeReceiver` / `platformFeeRate` / `creatorFeeOn` (SDK defaults apply). The adapter decodes `LaunchpadConfig` but **not** `PlatformConfig`, and does not read the CPMM `AmmConfig` creator-fee fields. For the official $RELAY launch this is workable (launch from the treasury wallet → creator of record = treasury), but the integration delta needed to *guarantee and verify* creator-fee revenue on this route is meaningfully larger than on Route A (§10).

---

## 5. The proposed fee recipient and treasury requirements

**Answer to the core audit question: yes — the funding source is legitimate on both routes, conditioned on the launch being performed by/for RelayPad from a RelayPad-controlled wallet.**

What must be true **before** the official $RELAY launch (these decisions are effectively permanent):

| Requirement | Route A (Pump) | Route B (LaunchLab) |
|---|---|---|
| Creator of record = RelayPad treasury | The `creator` argument of `create_v2` (or the signing wallet, if RelayPad launches from the treasury wallet). **Verified:** creator need not sign; docs warn to choose it deliberately. | The wallet that signs `createLaunchpad` becomes `LaunchpadPool.creator` (SDK layout field `creator`). RelayPad must launch from the treasury wallet or from a launcher that passes the treasury. |
| Who receives curve-phase fees | Creator vault PDA of `BondingCurve.creator`. | Per-creator, per-quote-mint vault of `LaunchpadPool.creator`. |
| Who receives post-graduation fees | `Pool::coin_creator` of the canonical pool (set from the curve's creator / Metaplex creator metadata). | CPMM `pool_creator` = launch creator **unless** the platform config sets a non-default `platformCpCreator` — must be read before launch. |
| Fee rate | Protocol schedule, 30 bps today (verified live). Not RelayPad-controlled on SOL quotes. | Curve: `PlatformConfig.creator_fee_rate` (platform-set, cap 0.5%). CPMM: `AmmConfig.creator_fee_rate` (0.05% in visible configs) minus the protocol share taken at collection. Not RelayPad-controlled without registering its own platform. |
| Change after launch | Not possible (fee-sharing setup is one-time only). | Not possible for the creator of record; platform parameters belong to Raydium/its platform admin. |

**Treasury requirements:**

1. **Dedicated wallet** whose only balances are official-$RELAY creator fees and buyback float. It must never be the same key as any RelayPad operational/admin wallet, and it must never hold mint authority (it doesn't — both protocols keep mint authority with the curve/migration authority).
2. **Custody:** key derived from a seed phrase stored offline (multi-share backup); the private key must never sit in a server env var or plaintext file (see §9).
3. **Signer roles:** a separate **executor** key (hot, minimal funding) may run permissionless sweeps and trigger destination-constrained permissionless collections, but **collect-from-vault (Route A), curve-phase claims (Route B), swaps and burns always need the treasury's signature.**
4. **One-time fee-sharing option (Route A):** RelayPad could set a sharing config routing e.g. 100% of creator fees to the treasury as a named shareholder. Since it is one-time-only and irreversible, treat it as an alternative, not a requirement; the default (creator = treasury) is simpler.
5. Everything above applies **only to the official $RELAY token**. RelayPad does not receive creator fees for user-launched tokens — those belong to each user's wallet as configured at launch. No feature is proposed or implied for user tokens.

---

## 6. Can creator-fee collection be automated?

**Yes — collection is automatable, with different signer requirements per phase.**

| Step | Route A (Pump) | Route B (LaunchLab/CPMM) |
|---|---|---|
| Sweep protocol-held buckets into the creator vault | Permissionless (`sweep_creator_fee`, `sweep_pool_creator_fee`) — **automatable without any treasury key** | Not documented as permissionless for the curve vault (`ClaimCreatorFee` is creator-signed); CPMM side has the permissionless path |
| Collect vault → treasury wallet | Creator-signed (`collect_creator_fee(_v2)`, `collect_coin_creator_fee`) | CPMM: permissionless destination-constrained collect pays the recorded creator's canonical ATAs (**automatable**); curve vault: creator-signed |
| Any protocol restriction | Un-swept buckets block distribution ops (sweep first); no minimum to collect; collection is idempotent-friendly (zero balance → zero-op) | Fees accrue per quote mint; claim works before or after graduation; CPMM collection deducts the protocol share of creator fees at settlement |
| Separate signing authority | Treasury signature needed for collect + swap + burn | Treasury signature needed for curve claim + swap + burn |

**How fees reach the treasury (Route A, the recommended flow):**

1. Traders pay the creator fee on the curve / canonical pool → fee lands in the protocol's bucket → any payer (RelayPad's keyless executor) sweeps it into the treasury's `creator_vault`.
2. A scheduled job (or the treasury signer, manually) calls `collect_creator_fee(_v2)` / `collect_coin_creator_fee`, moving the vault balance into the treasury wallet. `getCreatorVaultBalanceBothPrograms` / `getCreatorVaultQuoteBalances` from the official SDK report exactly what is waiting, per program and per quote mint — this is the verification primitive for step 3 of the proposed flow ("the system verifies the received amount").
3. From the treasury wallet, buybacks and burns execute (§7).

**Manual withdrawal is not required** — but treasury signing is. A fully unattended pipeline therefore requires the treasury key to be available to a signing service; a semi-automated pipeline (executor sweeps automatically, treasury signer approves batched collect+buy+burn) is the safer default (§7, §9).

---

## 7. Proposed $RELAY buyback-and-burn architecture (design only — not implemented)

No new on-chain program is needed. The mechanism is a **server-side worker** composed of documented, permissionless/standard instructions:

```
[trading activity on the official $RELAY curve / canonical pool]
        │  creator fee (30 bps of volume today)
        ▼
[creator fee buckets] ─(permissionless sweep, keyless executor)→ [treasury creator vault]
        │                    collect (treasury-signed)
        ▼
[treasury wallet: SOL] ── allocation X% ──▶ [buyback budget]
        │  accumulate until ≥ min threshold
        ▼
[swap SOL → $RELAY on the canonical pool]   (single approved route, slippage-capped)
        │
        ▼
[treasury: $RELAY] ─(SPL burn instruction)→ [supply reduced, on-chain verifiable]
        │
        ▼
[reconciliation job: compare on-chain balances vs. internal ledger; publish records]
```

### 7.1 Component design

1. **Fee collector** — scheduled job: read `getCreatorVaultBalanceBothPrograms(treasury)`; sweep (`sweep_creator_fee`, `sweep_pool_creator_fee`) when buckets are nonzero; collect into the treasury wallet when the vault exceeds a small floor (avoids dust transactions). Include the sweep-first rule to avoid `CreatorFeesNotSwept` blocks.
2. **Allocation gate** — server config (not a secret) holding: `buybackAllocationBps` (1000/2500/5000/7500), `minExecutionLamports`, `maxTradeLamports`, `maxSlippageBps`, `minPoolQuoteLiquidity`, `paused` flag. Only the buyback share of **verified collected** fees is eligible; the remainder stays available for operating expenses and reserves (§8).
3. **Buyback executor** — when budget ≥ threshold: fetch the **verified canonical pool** via RelayPad's existing `PumpAdapter.verifyPool` (already checks the pool is owned by `PUMP_AMM_PROGRAM_ID` and pairs the mint with the expected quote — discovery alone is never trusted), simulate the swap, enforce slippage caps, then swap SOL→$RELAY via the official `@pump-fun/pump-swap-sdk` buy instructions (a single hard-allowlisted route; aggregators can be added later behind the same allowlist).
4. **Burn** — the standard SPL Token `burn` instruction from the treasury's $RELAY ATA. Burning is preferable to sending to a "burn address": it is provably final (supply decreases), needs no trusted destination address, and requires no allowlist. A burn-destination address is the fallback if burns are ever blocked.
5. **Verification & ledger** — after each transaction: confirm the signature, re-read balances, and persist an append-only record (the existing `LaunchEvent`-style dedupe pattern in the Prisma schema is the template): `feeCollectedLamports`, `buybackSpentLamports`, `relaysPurchased`, `relaysBurned`, `poolUsed`, signatures. Duplicate execution is prevented by a unique dedupe key per (budget-cycle, step).
6. **Public dashboard (future phase)** — reads only from the on-chain ledger + mint supply, so displayed numbers are independently verifiable.

### 7.2 Execution cadence — recommendation

| Option | Assessment |
|---|---|
| After every fee collection | ❌ High tx + slippage cost; per-trade buyback effects are noise-sized; widens the manipulation surface. |
| Once per day | Acceptable, but creates a predictable daily order that can be front-run. |
| Once per week | ✅ Reasonable default: batches enough size to matter, low overhead, less predictable than daily. |
| When a treasury threshold is reached | ✅ Best primary trigger — make it volume-proportional (e.g. ≥ 5 SOL of eligible budget **and** ≥ 3 days since the last buyback) so activity scales with volume. |
| Manually approved batches | ✅ Required **initially** (first cycles) and as the override when the emergency pause is used. |

**Recommended combination:** *threshold-triggered, at most weekly, human-approved for the first cycles, then semi-automated with an emergency pause* — with hard caps on trade size so no single buyback is large relative to pool depth.

---

## 8. Hypothetical tokenomics — buyback allocation scenarios

> **Everything in this section is hypothetical arithmetic, not actual or projected RelayPad revenue.** Actual results depend on trading volume, the protocol fee schedule at the time, $RELAY's price, available liquidity, slippage, and transaction costs. **No price appreciation or return is promised or implied; buybacks do not guarantee any price outcome.**

Fee-mechanics context (verified): on Route A the creator fee is 0.30% of volume, so $X of monthly creator fees corresponds to roughly $333 of monthly trading volume per dollar of fees (e.g. $10,000/month in creator fees ≈ $3.3M monthly volume). On Route B, curve-phase fees are platform-set (≤0.5%) and CPMM fees are 0.05% minus the protocol share taken at collection — meaningfully lower post-graduation revenue per unit of volume.

Assume (hypothetically) fixed monthly operating costs of **$4,000** (infra, RPC, monitoring) paid from the same fee stream, and a buyback allocation `A` of eligible revenue.

| Allocation | $1,000 /mo fees | $10,000 /mo fees | $50,000 /mo fees |
|---|---|---|---|
| **10%** buyback | $100 to buyback; $900 left vs. $4,000 costs → **net –$3,100** | $1,000; $9,000 left → net +$5,000 | $5,000; net +$41,000 |
| **25%** buyback | $250; $750 left → net –$3,250 | $2,500; net +$3,500 | $12,500; net +$33,500 |
| **50%** buyback | $500; $500 left → net –$3,500 | $5,000; net +$1,000 | $25,000; net +$21,000 |
| **75%** buyback | $750; $250 left → net –$3,750 | $7,500; net **–$1,500** | $37,500; net +$8,500 |

Trade-offs:

- **10%** — maximum operating buffer and treasury reserve; weakest buyback signal; defensible only while fees barely cover costs.
- **25%** — a middle path: meaningful buybacks while retaining operating headroom and reserves.
- **50%** — strong buyback commitment; viable only once fees comfortably exceed costs; leaves little reserve for fee-schedule changes (e.g. pump.fun revising the 30 bps down) or incident costs.
- **75%** — aggressive; at moderate fee levels it starves operations and reserves (net-negative at $10k/mo above). Not recommended.

**Recommendation:** start at **25%**, allow allocations to be *reduced* but never promise them upward, and revisit quarterly against actual fee data. Liquidity note: a $5,000 buyback into a thin pool moves price materially (constant-product slippage) — hence the `maxTradeLamports` cap and `minPoolQuoteLiquidity` gate in §7.1. At $1,000/mo fee levels, batch for longer (e.g. monthly) so a buyback is worth its transaction overhead.

---

## 9. Security requirements — risks and mitigations

| Risk | Mitigation |
|---|---|
| Treasury private-key exposure | Key never stored plaintext on the application server (explicitly out of scope for this design). Treasury key derived from an offline seed, kept in a signing service or used manually for batch approval; hot executor holds **no** treasury authority. |
| Unauthorized transfers | The treasury's authority is needed for collect/swap/burn; nothing else can move fees (protocol enforces destination constraints — sweeps pay the vault of the recorded creator). Server-side signing service enforces a per-transaction and daily lamport cap and an allowlist of instruction types. |
| Wrong token mint / fake $RELAY | The official mint address is pinned in server config at launch, cross-checked on-chain (mint authority = curve/migration authority, canonical pool verified via `PumpAdapter.verifyPool` — program-owner check, not discovery). Any other `RELAY` ticker is treated as an impostor. |
| Fake / malicious swap route | Hard-allowlisted route only: swap directly against the verified canonical pool via the official `@pump-fun/pump-swap-sdk`. No ad-hoc routes; any aggregator added later must pass the same verification + a review gate. |
| Excessive slippage / MEV / sandwich | Max slippage bps config; trade-size caps; batched execution rather than continuous; optional private RPC/Jito tip channel for the swap txs; simulate first, then send with `preflight` off and reconcile after. |
| Price manipulation around buybacks | Irregular (threshold-triggered) schedule, capped trade size, and public reporting of every buyback (deterrence through transparency). Never quote the pool's own price as truth — re-read reserves on-chain. |
| Duplicate execution | Idempotency/dedupe key per (cycle, step), mirroring the existing `(launchId, kind, dedupeKey)` unique constraint in the Prisma schema. |
| Failed transactions | Confirm at `confirmed` commitment, treat `UNRESOLVED` as unknown until reconciled (the existing launch-status pattern); retry sweeps/collections freely (idempotent in effect), never blind-retry swaps without re-simulation. |
| RPC outages | Server-side reads already prefer the dedicated Alchemy endpoint with a fallback chain (`src/lib/connection.ts`); the worker must tolerate an unreachable RPC by doing nothing rather than guessing state. |
| Inaccurate accounting | Reconciliation job compares on-chain vault/wallet/mint-supply deltas against the internal ledger every run; discrepancies raise alerts and pause the pipeline. |
| Fee-schedule changes (protocol risk) | Worker reads `FeeConfig`/`AmmConfig` live; if the creator-fee rate drops to 0, the pipeline halts by design (no eligible revenue) — the allocation gate must never draw from other funds. |
| Emergency shutdown | A single `paused` switch in the allocation gate plus an ops runbook: pause ⇒ no new buys/burns; sweeps/collections may continue (they are safe, destination-constrained); treasury can be rotated only pre-launch (see §11). |

**Architecture requirement:** the executor never holds the treasury key; the treasury signer (manual or signing service) sees exactly one batched transaction bundle (collect → swap → burn) with all amounts pre-computed and simulated before approval.

---

## 10. Recommended launch route for official $RELAY

**Recommendation: launch official $RELAY via Pump.fun → PumpSwap (Route A).**

| Criterion | Route A — Pump.fun → PumpSwap | Route B — LaunchLab → CPMM |
|---|---|---|
| Creator-fee collection | Curve + canonical pool, both documented; live 30 bps verified | Curve vault (platform-set rate) + CPMM (0.05%, protocol share carved out at collection) |
| Fee-recipient configuration | Creator argument at create; creator may differ from payer; RelayPad fully controls it | Creator = signing wallet; beneficiary also depends on platform config (`platformCpCreator`) RelayPad does not control |
| Fee persistence after graduation | Explicitly documented on canonical pools | CPMM creator fee documented, but gated by `enable_creator_fee`, `creator_fee_on`, and the collection-time protocol share; LP-fee stream removed by the 2026-08-17 upgrade |
| Buyback funding reliability | **High** — one rate (30 bps), one vault, one canonical pool, permissionless sweep | **Lower** — rate split across platform config + AmmConfig + share-rate, with unresolved on-chain values to confirm |
| Liquidity / trading | 100% of LP burned at migration; single canonical pool to verify and trade against | CPMM pool; locked-LP share goes to the platform Fee Key |
| Integration complexity | Minimal — RelayPad's pump adapter already builds the launch with the official SDK; treasury-as-creator needs no code change | Larger — must add `PlatformConfig`/AmmConfig reads and verify the creator-of-record chain |
| Security | Destination-constrained permissionless sweeps; collection requires treasury signature | Similar end-state but with more config surface to verify |
| Operational costs | Comparable (one launch tx; sweeps/collects cheap) | Comparable |

Route A has the clearest documented terms, the highest verified creator-fee rate, and the smallest integration delta. Route B remains fully supported in RelayPad for *user* launches; this recommendation is only about RelayPad's own official token.

---

## 11. Missing information and unresolved questions

1. **Official $RELAY does not exist yet** — all treasury/launch parameters (mint, treasury wallet, metadata, initial buy) are decisions to be made at launch, not facts.
2. **Treasury key custody design** — who signs collects/swaps/burns, and through what interface (signing service vs. manual), needs an explicit ops decision.
3. Route B specifics (only if Route B is ever reconsidered): Raydium default-platform `creator_fee_rate`, `platform_cp_creator`, the migration's `cpConfigId`/`AmmConfig.creator_fee_rate`, and `creator_fee_share_rate` — four on-chain reads, all doable at launch time.
4. **Fee-schedule stability** — pump.fun's 30 bps creator fee and Raydium's configs can change at any time; the design reads them live, but revenue projections must be re-validated periodically.
5. **Legal/accounting treatment** of buying and burning one's own token with fee revenue (jurisdiction, accounting policy, disclosure wording) — outside this audit's scope, flagged for review.
6. **Whether pump.fun's fee-sharing config should be used** to route fees to a named treasury shareholder instead of creator = treasury (irreversible one-time setup; decide before launch).
7. **Burn-destination fallback** choice, if the plain `burn` instruction is ever inadequate (it is expected to be adequate — Token-2022 burn works for RelayPad-launched tokens).
8. Dashboard/attestation scope (future): which data is published and how often.

---

## 12. Phased implementation plan (for later approval — nothing implemented now)

- **Phase 0 — decisions (no code):** confirm treasury wallet + custody model; confirm launch route (Route A), network, supply/decimals expectations; decide allocation %, thresholds, caps; legal/accounting review.
- **Phase 1 — launch readiness:** perform the official $RELAY launch from the treasury wallet using the existing launch flow (or a small ops script built on `PumpAdapter`); pin and publish the mint address; record the launch in the registry.
- **Phase 2 — fee collector:** read-only vault balance reporting (`getCreatorVaultBalanceBothPrograms`), permissionless sweep job, treasury-signed collect job, plus the reconciliation ledger model (Prisma, append-only, dedupe keys). Devnet rehearsal first.
- **Phase 3 — buyback-and-burn worker:** allocation gate with limits; verified-pool swap via the official pump-swap SDK; SPL burn; full on-chain verification and alerting; manual batch approval for the first cycles; emergency pause.
- **Phase 4 — transparency:** public page reading only on-chain state + ledger records; quarterly tokenomics review against actual fee data.

Each phase requires explicit approval and its own plan; nothing here has been implemented.

---

## 13. Official documentation links and source-code references

Official pump.fun docs (fetched live during this audit):
- https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_CREATOR_FEE_README.md — bonding-curve creator fees, creator vault, `creator` argument warning
- https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_CREATOR_FEE_README.md — canonical-pool coin creator fees, `collect_coin_creator_fee`
- https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_PROGRAM_README.md — market-cap-tiered fee schedule, `computeFeesBps`
- https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_RECIPIENTS.md — protocol/buyback fee-recipient tables (protocol fees, not creator fees)
- https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md — program/Global account, `migrate`, LP burn

Official SDKs (pinned in `package.json`, read from `node_modules` in this repo):
- `@pump-fun/pump-sdk@4.0.0` — README sections "Configurable creator fee", "Creator fees", "Fee Sharing", "Sweeps"; exports `sweepCreatorFeeInstruction`, `sweepPoolCreatorFeeInstruction`, `collectCoinCreatorFeeInstructions(_V2/AllQuotes)`, `getCreatorVaultBalanceBothPrograms`, `getCreatorVaultQuoteBalances`, `buildDistributeCreatorFeesInstructions`, `creatorVaultPda`, `canonicalPumpPoolPda`
- `@raydium-io/raydium-sdk-v2@0.2.74-alpha` — `lib/raydium/launchpad/layout.d.ts` (`LaunchpadConfig`, `LaunchpadPool`, `PlatformConfig` incl. `creatorFeeRate`, `platformCpCreator`, `cpmmCreatorFeeOn`), `lib/raydium/launchpad/type.d.ts` (`CreateLaunchPad.shareFeeRate/shareFeeReceiver`, `ClaimCreatorFee`), `lib/raydium/cpmm/layout.d.ts` (`CpmmConfigInfoLayout.creatorFeeRate/creatorFeeShareRate`, `CpmmPoolInfoLayout.enableCreatorFee/creatorFeesMintA/B`), `lib/raydium/cpmm/type.d.ts` (`CollectCreatorFees`, `CollectMultiCreatorFees`)

Official Raydium docs (fetched live during this audit):
- https://docs.raydium.io/products/launchlab/creator-fees — curve vault vs. CPMM counters, 2026-08-17 upgrade, claim paths, integrator checklist
- https://docs.raydium.io/user-flows/how-creator-fees-work — two-phase creator fees, platform_cp_creator, fee-flow summary
- https://docs.raydium.io/products/launchlab/tips-and-gotchas/launchlab-cpmm-fee-reference — full fee lifecycle and gotchas
- https://docs.raydium.io/products/launchlab/platform-config — `MAX_CREATOR_FEE_RATE = 5000`, fee caps, `platform_cp_creator` ambiguity
- https://docs.raydium.io/products/cpmm/fees — CPMM creator-fee accrual, `CollectCreatorFee` / `CollectCreatorFeePermissionless`, 2026-09-19 collection-time protocol share
- https://api-v3.raydium.io/main/cpmm-config — live CPMM config values (`creatorFeeRate: 500` etc.)

On-chain reads performed during this audit (read-only, via official SDKs + the project's Alchemy mainnet endpoint):
- Pump `Global` and `FeeConfig` (values in §3.3)
- LaunchLab `LaunchpadConfig` PDA `6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX` (values in §4.1)

Repository references (this project):
- `src/lib/adapters/pump.ts` — Route A launch, `creator: user`, `loadConfig` reads `creatorFeeConfigurable`
- `src/lib/adapters/launchlab.ts` — Route B launch, `migrateType: "cpmm"`, decodes `LaunchpadConfig`
- `src/lib/adapters/types.ts` — route adapter contract
- `prisma/schema.prisma` — `Launch`/`LaunchEvent` patterns reusable for the future buyback ledger
- `.env` / `.env.local` — confirmed free of any token/treasury configuration (nothing to inherit)

---

*End of audit. Status: AUDIT ONLY — no code modified, no transactions submitted, no tokens launched, bought, or burned. Awaiting explicit approval of an implementation plan before any phase above begins.*











