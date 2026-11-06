/**
 * Shared refresh gate for the public treasury summary endpoint.
 *
 * `?refresh=1` triggers the read-only on-chain indexer (RPC reads +
 * idempotent cache writes). To keep any number of server instances from
 * doing redundant scans, the decision is layered:
 *
 * 1. Per-process single-flight flag + per-process time throttle (route
 *    module state) — always active, cheap, and exact within one process.
 * 2. A DB-backed throttle keyed as `"refresh"` in RelayOfficialIndexState
 *    (shared by every instance through the existing database) — best-effort
 *    cross-instance dedupe. It is a timestamp gate, NOT a distributed lock:
 *    two instances checking at the same instant may both proceed, which is
 *    safe because indexing is idempotent (unique (signature, entryKey) +
 *    P2002-tolerant upserts). A true distributed lock (advisory locks, Redis)
 *    is intentionally out of scope for this phase.
 */

export const REFRESH_MIN_INTERVAL_MS = 20_000;
/** Index-state key under which the last refresh timestamp is recorded. */
export const REFRESH_STATE_KEY = "refresh";

export interface RefreshGateInput {
  /** FLUXPAD_OFFICIAL_ENABLED master switch. */
  enabled: boolean;
  /** At least one wallet address configured. */
  anyWalletConfigured: boolean;
  /** A store (database) is available. */
  hasStore: boolean;
  /** Another refresh is already running in this process. */
  inFlight: boolean;
  /** Epoch ms of this process's last refresh start (0 = never). */
  localLastRunAt: number;
  /** DB-recorded last refresh start, or null when unknown/unavailable. */
  dbLastRunAt: Date | null;
  /** Current epoch ms (injectable for tests). */
  now: number;
}

/** Pure decision: may this request start a refresh scan? */
export function shouldRunRefresh(input: RefreshGateInput): boolean {
  if (!input.enabled || !input.anyWalletConfigured || !input.hasStore || input.inFlight) {
    return false;
  }
  if (input.now - input.localLastRunAt < REFRESH_MIN_INTERVAL_MS) return false;
  if (
    input.dbLastRunAt &&
    input.now - input.dbLastRunAt.getTime() < REFRESH_MIN_INTERVAL_MS
  ) {
    return false;
  }
  return true;
}
