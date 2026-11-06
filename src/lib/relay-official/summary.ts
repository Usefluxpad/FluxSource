import type { ClusterId } from "../constants";
import { getRelayOfficialConfig, type RelayOfficialConfig } from "./config";
import { SOL_ASSET, type ActivityType } from "./classify";
import type { RelayOfficialStore } from "./store";
import { publicErrorReason, logSafeDetail } from "./sanitize";

/**
 * Overview metrics for the public treasury dashboard.
 *
 * Aggregates come only from VERIFIED stored activity (confirmed rows that
 * were themselves verified against the node); balances come from live RPC
 * reads. Missing configuration and RPC failures render as explicit
 * "unavailable" states — never invented numbers.
 */

/** Structural Connection subset needed for balance reads (testable). */
export interface BalanceConnection {
  getBalance(address: string, commitment?: string): Promise<number>;
  getTokenAccountsByOwner(
    owner: string,
    filter: { mint: string },
    options?: Record<string, unknown>,
  ): Promise<{ value: { pubkey: string }[] }>;
  getParsedAccountInfo(
    address: string,
  ): Promise<{
    value: {
      data:
        | { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } } }
        | unknown;
    } | null;
  }>;
}

export interface WalletBalance {
  role: string;
  address: string | null;
  configured: boolean;
  /** SOL lamports balance, or null when unavailable. */
  lamports: number | null;
  /** $RELAY token balance (raw), or null when unavailable/unconfigured. */
  relayBalance: string | null;
  relayDecimals: number | null;
  balanceError: string | null;
}

export interface TreasurySummary {
  network: ClusterId;
  configured: boolean;
  wallets: WalletBalance[];
  totals: {
    /** Verified creator fees collected into W1 (lamports). */
    feesCollected: string | null;
    /** Verified treasury transfers (SOL in → out of the treasury set). */
    transfers: string | null;
    /** Verified $RELAY purchased via swaps by W2 (raw units). */
    relayPurchased: string | null;
    /** Verified $RELAY burned (raw units). */
    relayBurned: string | null;
  };
  activityCounts: Record<ActivityType, number>;
  lastReconciledAt: string | null;
  errors: string[];
}

async function readSolBalance(
  conn: BalanceConnection,
  address: string,
): Promise<number | null> {
  return conn.getBalance(address, "confirmed");
}

async function readRelayBalance(
  conn: BalanceConnection,
  owner: string,
  mint: string,
): Promise<{ amount: string | null; decimals: number | null; error: string | null }> {
  try {
    const accounts = await conn.getTokenAccountsByOwner(owner, { mint });
    if (!accounts.value || accounts.value.length === 0) {
      return { amount: null, decimals: null, error: null }; // no ATA yet
    }
    const info = await conn.getParsedAccountInfo(accounts.value[0].pubkey);
    const parsed = (
      info.value?.data as
        | { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } } }
        | undefined
    )?.parsed?.info?.tokenAmount;
    return {
      amount: parsed?.amount ?? null,
      decimals: typeof parsed?.decimals === "number" ? parsed.decimals : null,
      error: null,
    };
  } catch (err) {
    // Public payload gets a coarse reason only; full detail stays in the
    // server log (URLs stripped so no endpoint/credential is captured).
    console.error(
      "[relay-official/summary] $FLUX balance read failed:",
      logSafeDetail(err),
    );
    return {
      amount: null,
      decimals: null,
      error: publicErrorReason(err),
    };
  }
}

export async function buildTreasurySummary(opts: {
  balanceConnection: BalanceConnection | null;
  store: RelayOfficialStore | null;
  config?: RelayOfficialConfig;
}): Promise<TreasurySummary> {
  const config = opts.config ?? getRelayOfficialConfig();
  const errors: string[] = [];

  const wallets: WalletBalance[] = [];
  for (const w of config.wallets) {
    const base: WalletBalance = {
      role: w.role,
      address: w.address,
      configured: w.address !== null,
      lamports: null,
      relayBalance: null,
      relayDecimals: null,
      balanceError: null,
    };
    if (w.address && opts.balanceConnection) {
      try {
        base.lamports = await readSolBalance(opts.balanceConnection, w.address);
      } catch (err) {
        // Public payload gets a coarse reason only (never provider text that
        // could carry endpoints/keys); full detail stays in the server log.
        console.error(
          "[relay-official/summary] SOL balance read failed:",
          logSafeDetail(err),
        );
        base.balanceError = publicErrorReason(err);
        errors.push(`${w.role}: SOL balance unavailable`);
      }
      if (config.mint) {
        const relay = await readRelayBalance(opts.balanceConnection, w.address, config.mint);
        base.relayBalance = relay.amount;
        base.relayDecimals = relay.decimals;
        if (relay.error) errors.push(`${w.role}: $FLUX balance unavailable`);
      }
    }
    wallets.push(base);
  }

  const activityCounts = {} as Record<ActivityType, number>;
  let feesCollected: string | null = null;
  let transfers: string | null = null;
  let relayPurchased: string | null = null;
  let relayBurned: string | null = null;

  if (opts.store) {
    try {
      // All aggregates are asset/mint-scoped so SOL and token units are
      // never mixed, and restricted to rows re-verified against the node.
      const verifiedOnly = { verifiedOnly: true } as const;
      const feeTotals = await opts.store.totalsByType("fee_collect", verifiedOnly);
      activityCounts.fee_collect = feeTotals.count;
      feesCollected = feeTotals.totalInput; // SOL lamports only (fee_collect is always SOL)
      const transferTotals = await opts.store.totalsByType(
        "transfer",
        { asset: SOL_ASSET, ...verifiedOnly },
      );
      activityCounts.transfer = transferTotals.count;
      transfers = transferTotals.totalInput; // SOL lamports only
      if (config.mint) {
        const swapTotals = await opts.store.totalsByType(
          "swap",
          { asset: config.mint, ...verifiedOnly },
        );
        activityCounts.swap = swapTotals.count;
        relayPurchased = swapTotals.totalOutput; // $RELAY output only
        const burnTotals = await opts.store.totalsByType(
          "burn",
          { asset: config.mint, ...verifiedOnly },
        );
        activityCounts.burn = burnTotals.count;
        relayBurned = burnTotals.totalInput; // $RELAY burned only
      }
      activityCounts.other = (
        await opts.store.totalsByType("other", verifiedOnly)
      ).count;
    } catch (err) {
      console.error(
        "[relay-official/summary] aggregates failed:",
        logSafeDetail(err),
      );
      errors.push(`aggregates unavailable: ${publicErrorReason(err)}`);
    }
  }

  let lastReconciledAt: string | null = null;
  if (opts.store) {
    try {
      const state = await opts.store.getIndexState("reconcile");
      lastReconciledAt = state?.lastReconciledAt?.toISOString() ?? null;
    } catch {
      errors.push("reconciliation state unavailable");
    }
  }

  return {
    network: config.network,
    configured: config.anyWalletConfigured,
    wallets,
    totals: {
      feesCollected,
      transfers,
      relayPurchased,
      relayBurned,
    },
    activityCounts,
    lastReconciledAt,
    errors,
  };
}

/** Exported for tests. */
export { SOL_ASSET, readRelayBalance, readSolBalance };