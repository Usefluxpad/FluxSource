/**
 * Discovery runtime — bounded on-demand ingestion with per-source TTL caches.
 *
 * - No background timers or daemon loops: refreshes happen inside API
 *   requests, at most one per source per TTL window; concurrent requests
 *   share a single in-flight promise per source (no duplicate subscriptions).
 * - Provider outages degrade to the last cached feed with `degraded: true`
 *   and stale flags; FluxPad registry records are read from the local
 *   database and are never affected by provider outages.
 * - All provider hosts are official documented endpoints; credentials are not
 *   used for the read paths (no keys exist), so none can leak.
 */
import { currentNetworkRaw } from "../network-env";
import { resolveServerNetworkConfig, getConnection } from "@/lib/connection";
import { Connection } from "@solana/web3.js";
import { clusterApiEndpoint, type ClusterId } from "../constants";
import { fetchPumpGlobals, scanPumpProgram, enrichPumpCurves } from "./pumpfun";
import { fetchPumpswapPools } from "./pumpswap";
import { fetchLaunchLabMints } from "./launchlab";
import { fetchRaydiumCpmmPools, fetchSolPriceUsd } from "./raydium";
import { fetchFluxpadLaunches } from "./fluxpad";
import { mergeFeeds, tabTokens, applyFilter, sortTokens, searchTokens, paginate, applySolPrice, applyScannerFilters, type DiscoveryFilter, type DiscoveryResponse } from "./index";
import type { DiscoveredToken, DiscoverySort, DiscoveryTab, SourceFeed } from "./types";

const TTL: Record<string, number> = {
  "pumpfun.curve": 45_000,
  "pumpfun.pool": 60_000,
  "launchlab.curve": 45_000,
  "raydium.cpmm": 60_000,
  fluxpad: 10_000,
};

/** Pump.fun curve freshness TTL (mirrors the TTL table above). */
const PUMP_CURVE_TTL_MS = TTL["pumpfun.curve"];

/** Bounded accumulator of recently created Pump.fun curve tokens across
 * refreshes — the raw scan window (~20 signatures) rarely contains a create
 * event, which made the curve feed flicker empty. Oldest entries are evicted;
 * accumulated entries older than the TTL are served with stale: true. */
const curveRegistry = new Map<string, DiscoveredToken>();

/** Public cluster connection (documented endpoint constant) for the fallback
 * tier of expensive RPC scans (e.g. the PumpSwap pool scan, which throughput
 * -limited providers reject outright). One per cluster, process-lifetime. */
const publicConnections = new Map<string, Connection>();
function publicConnection(cluster: ClusterId): Connection {
  let c = publicConnections.get(cluster);
  if (!c) {
    c = new Connection(clusterApiEndpoint(cluster), "confirmed");
    publicConnections.set(cluster, c);
  }
  return c;
}

interface CacheEntry {
  feed: SourceFeed;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<SourceFeed>>();
/** Last successful feed per source — served (clearly labeled unhealthy +
 * stale) while a provider is down, so listing data degrades gracefully
 * instead of vanishing. */
const lastGoodFeeds = new Map<string, SourceFeed>();
const failureCounts = new Map<string, number>();
const FAILURE_BASE_MS = 15_000;
const FAILURE_MAX_MS = 60_000;

async function withCache(
  key: string,
  source: SourceFeed["source"],
  refresh: () => Promise<SourceFeed>,
): Promise<SourceFeed> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.feed;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = (async () => {
    let feed: SourceFeed;
    let failureError: unknown = null;
    try {
      const fetched = await refresh();
      if (!fetched.ok) {
        // Provider-level failure surfaced as an error feed (providers never
        // throw): treated identically to a thrown failure below.
        failureError = fetched.error ?? "provider failed";
        feed = { ...fetched };
      } else {
        feed = fetched;
      }
    } catch (err) {
      failureError = err;
      feed = {
        source,
        tokens: [] as DiscoveredToken[],
        fetchedAt: now,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (failureError !== null) {
      // Provider genuinely unavailable. Health must reflect reality (never
      // "healthy from cache"), while the last valid feed stays listed and
      // clearly labeled stale. The failure window backs off with consecutive
      // failures (15s → 30s → 60s cap) so bursts never hammer a struggling
      // provider.
      const errorMessage =
        failureError instanceof Error ? failureError.message : String(failureError);
      failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
      const failures = failureCounts.get(key) ?? 1;
      const failureMs = Math.min(FAILURE_BASE_MS * 2 ** (failures - 1), FAILURE_MAX_MS);
      const lastGood = lastGoodFeeds.get(key);
      const merged: SourceFeed = lastGood
        ? { ...lastGood, ok: false, error: errorMessage }
        : { ...feed, ok: false, error: errorMessage };
      cache.set(key, { feed: merged, expiresAt: now + failureMs });
      return merged;
    }
    failureCounts.delete(key);
    lastGoodFeeds.set(key, feed);
    cache.set(key, { feed, expiresAt: now + (TTL[key] ?? 30_000) });
    return feed;
  })();
  inFlight.set(key, p);
  try {
    return await p;
  } finally {
    inFlight.delete(key);
  }
}

export interface DiscoveryQuery {
  tab: DiscoveryTab;
  filter: DiscoveryFilter;
  sort: DiscoverySort;
  q: string;
  page: number;
  pageSize: number;
  /** FluxPad-tab sub-filters (only applied when tab === "fluxpad"). */
  launchRoute: "all" | "pump" | "launchlab";
  launchStatus: "all" | "pending" | "graduated";
}

/** Launch route for a verified FluxPad record, from record identity only. */
export function launchRouteOf(t: DiscoveredToken): "pump" | "launchlab" | null {
  if (t.source === "pumpfun.curve" || t.source === "pumpfun.pool") return "pump";
  if (t.source === "launchlab.curve" || t.source === "raydium.cpmm") return "launchlab";
  // FluxPad registry provenance carries the full route token
  // (`pump_pumpswap` / `launchlab_cpmm`) — match on the route prefix.
  const m = /fluxpad-registry\((pump|launchlab)[^)]*\)/.exec(t.provenance ?? "");
  return m ? (m[1] as "pump" | "launchlab") : null;
}

function applyLaunchFilters(tokens: DiscoveredToken[], route: DiscoveryQuery["launchRoute"], status: DiscoveryQuery["launchStatus"]): DiscoveredToken[] {
  return tokens.filter((t) => {
    if (route !== "all" && launchRouteOf(t) !== route) return false;
    if (status === "pending" && t.status !== "verified-launch") return false;
    if (status === "graduated" && !(t.status === "graduated" || t.status === "pool")) return false;
    return true;
  });
}

export async function getDiscovery(
  query: DiscoveryQuery,
  scannerFilters?: import("./index").ScannerFilters,
): Promise<DiscoveryResponse> {
  // Server-side reads use the dedicated provider (Alchemy when configured).
  const cfg = resolveServerNetworkConfig(currentNetworkRaw());
  const connection = getConnection(cfg);
  const cluster = cfg.cluster === "mainnet-beta" ? "mainnet-beta" : "devnet";
  const now = Date.now();

  const feeds: SourceFeed[] = await Promise.all([
    // Pump.fun curve discovery: incremental scan + live Global for honest math.
    // A failed scan throws so the bounded error-cache below engages — without
    // this, every request would repeat the slow rate-limited refresh sequence.
    withCache("pumpfun.curve", "pumpfun.curve", async () => {
      const scan = await scanPumpProgram(connection, pumpCursor(), { now });
      if (!scan.feed.ok) throw new Error(scan.feed.error ?? "pump_scan_failed");
      const globals = await fetchPumpGlobals(connection);
      const enriched = await enrichPumpCurves(connection, scan.feed.tokens, globals);
      // The scan window (last ~20 program signatures) rarely contains a create
      // event, so the raw feed flickers empty. A bounded in-memory registry
      // accumulates recently created curve tokens across refreshes; entries
      // older than the freshness TTL are served with stale: true (never
      // re-fetched silently — the UI labels them).
      for (const t of enriched) curveRegistry.set(t.mint, t);
      if (curveRegistry.size > 300) {
        const keep = [...curveRegistry.values()].sort((a, b) => b.firstSeenAt - a.firstSeenAt).slice(0, 250);
        curveRegistry.clear();
        for (const t of keep) curveRegistry.set(t.mint, t);
      }
      const accumulated = [...curveRegistry.values()].map((t) => ({
        ...t,
        stale: now - t.fetchedAt > PUMP_CURVE_TTL_MS,
      }));
      return { ...scan.feed, tokens: accumulated };
    }),
    withCache("pumpfun.pool", "pumpfun.pool", () =>
      fetchPumpswapPools(connection, {
        now,
        fallbackConnection: publicConnection(cluster),
      }),
    ),
    withCache("launchlab.curve", "launchlab.curve", () => fetchLaunchLabMints(cluster, { sort: "new", now })),
    withCache("raydium.cpmm", "raydium.cpmm", () => fetchRaydiumCpmmPools(cluster, { now })),
    // FluxPad records come from the local DB — always fresh, never cached stale.
    fetchFluxpadLaunches(now),
  ]);
  const solPriceUsd = await withCache("raydium.solprice", "raydium.cpmm", async () => {
    const price = await fetchSolPriceUsd(cluster);
    return {
      source: "raydium.cpmm" as const,
      tokens: [] as DiscoveredToken[],
      fetchedAt: now,
      ok: price != null,
      error: price == null ? "price_unavailable" : null,
      priceUsd: price,
    };
  });
  const solPrice = (solPriceUsd as SourceFeed & { priceUsd?: number | null }).priceUsd ?? null;

  const merged = applySolPrice(mergeFeeds(feeds, now, Math.min(...Object.values(TTL))), solPrice);
  const tabbed = tabTokens(merged, query.tab);
  const scanned =
    scannerFilters &&
    Object.values(scannerFilters).some((v) => v != null)
      ? applyScannerFilters(tabbed, scannerFilters, now)
      : tabbed;
  const relayed =
    query.tab === "fluxpad"
      ? applyLaunchFilters(scanned, query.launchRoute, query.launchStatus)
      : scanned;
  const filtered = applyFilter(relayed, query.filter, now);
  const searched = searchTokens(filtered, query.q);
  const sorted = sortTokens(searched, query.sort);
  const page = paginate(sorted, query.page, query.pageSize);

  return {
    tokens: page,
    meta: {
      fetchedAt: now,
      degraded: feeds.some((f) => !f.ok),
      sources: feeds.map((f) => ({
        source: f.source,
        ok: f.ok,
        error: f.error,
        count: f.tokens.length,
        fetchedAt: f.fetchedAt,
        stale: now - f.fetchedAt > (TTL[f.source] ?? 30_000),
      })),
    },
    page: query.page,
    pageSize: query.pageSize,
    total: sorted.length,
  };
}

// Module-level bounded cursor for the pump program scan (see pumpfun.ts).
let _pumpCursor: Map<string, number> | null = null;
function pumpCursor(): Map<string, number> {
  if (!_pumpCursor) _pumpCursor = new Map();
  return _pumpCursor;
}

export function clearDiscoveryCache(): void {
  cache.clear();
  inFlight.clear();
  lastGoodFeeds.clear();
  failureCounts.clear();
  _pumpCursor = null;
}
