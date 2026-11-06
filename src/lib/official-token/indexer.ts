import type { ClusterId } from "../constants";
import { getOfficialTokenConfig, type OfficialTokenConfig } from "./config";
import {
  classifyTransaction,
  networkFeeLamports,
  type ActivityRecord,
  type ClassifiedTransaction,
} from "./classify";
import type { OfficialTokenStore } from "./store";

/**
 * Read-only on-chain indexer for the official-$FLUX treasury dashboard.
 *
 * Scans the transaction history of each configured treasury wallet over the
 * existing RPC architecture, classifies confirmed transactions, and stores
 * them idempotently (dedupe by signature + entry key). This module performs
 * READS only — it never builds, signs, or submits anything.
 *
 * Failure model:
 * - RPC failures are contained per wallet and recorded in the index state;
 *   stored rows are never deleted on failure (stale data degrades honestly).
 * - Database write failures after a confirmed fetch are recorded and the
 *   pipeline reconciles before retrying: the next run re-derives the same
 *   rows from chain and upserts idempotently.
 */

/** Structural Connection subset the indexer needs (testable). */
export interface IndexerConnection {
  getSignaturesForAddress(
    address: string,
    options?: { limit?: number; before?: string },
  ): Promise<{ signature: string; err: unknown; slot?: number }[]>;
  getParsedTransaction(
    signature: string,
    options?: unknown,
  ): Promise<ClassifiedTransaction | null>;
  getSignatureStatuses(
    signatures: string[],
  ): Promise<{ value: ({ err: unknown; slot?: number } | null)[] }>;
}

export interface IndexResult {
  network: ClusterId;
  walletsScanned: number;
  signaturesScanned: number;
  written: number;
  duplicates: number;
  verified: number;
  errors: string[];
  lastReconciledAt: Date | null;
  /** Signatures fetched but not yet parsed (too new) — retried next run. */
  pending: number;
}

/** Page size for each getSignaturesForAddress call. */
const SCAN_PAGE_SIZE = 100;
/** Hard cap on pages per wallet per run (rate-limit friendly). */
const MAX_PAGES_PER_WALLET = 10;
const RECONCILE_BATCH = 200;

export async function indexTreasuryActivity(opts: {
  connection: IndexerConnection;
  store: OfficialTokenStore;
  config?: OfficialTokenConfig;
  maxPagesPerWallet?: number;
}): Promise<IndexResult> {
  const config = opts.config ?? getOfficialTokenConfig();
  const now = new Date();
  const result: IndexResult = {
    network: config.network,
    walletsScanned: 0,
    signaturesScanned: 0,
    written: 0,
    duplicates: 0,
    verified: 0,
    errors: [],
    lastReconciledAt: null,
    pending: 0,
  };

  const configured = config.wallets.filter((w) => w.address !== null);
  if (configured.length === 0) return result;
  if (!config.enabled) return result; // master switch (FLUXPAD_OFFICIAL_ENABLED)

  const roleByAddress = new Map<string, string>();
  for (const w of configured) roleByAddress.set(w.address as string, w.role);

  for (const wallet of configured) {
    const address = wallet.address as string;
    result.walletsScanned += 1;
    try {
      // Cursor-based catch-up: paginate until the page's OLDEST signature
      // is already stored (overlap boundary) or history ends, capped by
      // MAX_PAGES_PER_WALLET so one run never hammers the RPC. This covers
      // gaps larger than one page and retries signatures that were too
      // new to fetch on a previous run (they remain unstored).
      const maxPages = opts.maxPagesPerWallet ?? MAX_PAGES_PER_WALLET;
      let lastSignature: string | null = null;
      let before: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const sigs = await opts.connection.getSignaturesForAddress(address, {
          limit: SCAN_PAGE_SIZE,
          ...(before ? { before } : {}),
        });
        result.signaturesScanned += sigs.length;
        if (sigs.length === 0) break; // history end
        lastSignature = lastSignature ?? sigs[0].signature;
        const known = await opts.store.knownSignatures(sigs.map((s) => s.signature));
        const fresh = sigs.filter((s) => !known.has(s.signature));
        for (const sigInfo of fresh) {
          // A landed-but-errored transaction is still real on-chain
          // history: classify it; aggregation only counts confirmed rows.
          const tx = await opts.connection.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          });
          if (!tx) {
            result.pending += 1; // too new — retried on the next run
            continue;
          }
          const records = attachFee(
            tx,
            classifyTransaction(tx, {
              signature: sigInfo.signature,
              network: config.network,
              roleByAddress,
            }),
          );
          const upsert = await opts.store.upsertActivities(records);
          result.written += upsert.written;
          result.duplicates += upsert.duplicates;
        }
        // Pagination stop conditions: history end, or the page's OLDEST
        // signature is already stored (overlap boundary reached —
        // everything older was seen on a previous run).
        const oldest = sigs[sigs.length - 1];
        if (sigs.length < SCAN_PAGE_SIZE) break;
        if (known.has(oldest.signature)) break;
        before = oldest.signature; // keep paginating deeper
      }
      await opts.store.setIndexState(address, {
        lastRunAt: now,
        lastStatus: "ok",
        lastError: null,
        lastSignature,
      });
    } catch (err) {
      // Contained: other wallets keep scanning; stored data stays as-is.
      result.errors.push(`${wallet.role}: ${errorMessage(err)}`);
      try {
        await opts.store.setIndexState(address, {
          lastRunAt: now,
          lastStatus: "error",
          lastError: errorMessage(err),
        });
      } catch {
        result.errors.push(`${wallet.role}: index-state write failed; reconcile required`);
      }
    }
  }

  // Reconciliation pass: re-verify stored signatures against the node.
  try {
    const stored = await opts.store.allSignatures(RECONCILE_BATCH);
    if (stored.length > 0) {
      const statuses = await opts.connection.getSignatureStatuses(stored);
      const confirmedSigs = stored.filter(
        (sig, i) => statuses.value[i] != null && statuses.value[i]?.err == null,
      );
      result.verified = await opts.store.markOnChainVerified(confirmedSigs, now);
    }
    await opts.store.setIndexState("reconcile", {
      lastReconciledAt: now,
      lastStatus: "ok",
      lastError: null,
    });
    const state = await opts.store.getIndexState("reconcile");
    result.lastReconciledAt = state?.lastReconciledAt ?? now;
  } catch (err) {
    result.errors.push(`reconcile: ${errorMessage(err)}`);
    try {
      await opts.store.setIndexState("reconcile", {
        lastStatus: "error",
        lastError: errorMessage(err),
      });
    } catch {
      result.errors.push("reconcile: index-state write failed");
    }
  }

  return result;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
}

function attachFee(tx: ClassifiedTransaction, records: ActivityRecord[]): ActivityRecord[] {
  const fee = networkFeeLamports(tx);
  if (fee == null || records.length === 0) return records;
  return records.map((r) => ({
    ...r,
    detail: { ...(r.detail ?? {}), networkFeeLamports: fee },
  }));
}