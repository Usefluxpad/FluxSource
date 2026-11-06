# FluxPad manual production smoke test

> **Run only with explicit human approval.** Never conduct unapproved
> real-money transactions. Complete the devnet pass first.

## 0. Preconditions

- [ ] `.env.local` configured; `NEXT_PUBLIC_FLUXPAD_NETWORK` deliberately set
- [ ] `DATABASE_URL` reachable (`npx prisma migrate deploy` succeeded)
- [ ] `npm run build` and `npm test` pass
- [ ] Wallet funded with ≥ 0.1 SOL above intended buy amounts
- [ ] Approval noted: date, approver, network, budget cap

## 1. Devnet pass (both routes)

For each route (A: Pump, B: LaunchLab):

1. Connect wallet on `/create` → verify address shown in Settings and the
   network badge matches the intended cluster.
2. Fill token details, upload small artwork → verify returned metadata URI is
   reachable and contains the image URL.
3. Select route → verify the route card shows "available" with real program
   addresses and decoded config values.
4. (Optional) Vanity: 2-char prefix → verify address matches, cancel works.
5. Build transaction → verify review shows mint address, tx count, fee
   breakdown, route notes.
6. Sign in wallet → inspect the transaction in the wallet BEFORE approving:
   program IDs must match the documented addresses for the route.
7. After confirmation: mint address page shows CONFIRMED → CURVE_TRADING;
   verify mint exists on the explorer; verify bonding curve account exists
   (Route A: `bonding-curve` PDA; Route B: LaunchLab pool PDA).
8. Reject the signature once with a fresh draft → verify the UI reports
   WALLET_REJECTED and does not mark anything as launched.

## 2. Failure-path checks

- [ ] Insufficient balance → clear INSUFFICIENT_FUNDS error, no registry entry
      marked confirmed.
- [ ] Simulated stale blockhash (pause on the review screen >2 min) → retry
      with fresh blockhash or honest UNRESOLVED status.
- [ ] Duplicate submit protection: same form resubmission does not create a
      duplicate registry row (idempotency key).

## 3. Mainnet pass (only after devnet pass)

Repeat steps 1–8 with small amounts. Additionally:

- [ ] Confirm route availability on mainnet config accounts (Route B config
      must exist for SOL curve type 0 index 0).
- [ ] Confirm estimated fees match actual spend within tolerance.
- [ ] Record signatures of both launches in this document.

| Route | Signature | Mint | Result |
| --- | --- | --- | --- |
| A |  |  |  |
| B |  |  |  |
