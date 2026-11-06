/**
 * Discovery aggregator — merges provider feeds into the Explore model.
 *
 * Design: on-demand ingestion with a bounded TTL cache per source (no
 * background timers, no unbounded loops). Every request that hits the API
 * route either reuses a fresh cache or triggers exactly one bounded refresh
 * per source; a failing provider degrades to its last cached feed plus an
 * error flag — it never corrupts FluxPad launch records, which come from the
 * local database.
 *
 * Dedupe: by mint, keeping the most informative record. FluxPad attribution
 * is sticky — a mint with a verified FluxPad launch record carries
 * `fluxpadLaunchId` in every feed it appears in, but tab membership is by
 * record identity, so a token is never double-counted across feeds.
 */
import type {
  DiscoveredToken,
  DiscoverySort,
  DiscoveryTab,
  SourceFeed,
} from "./types";

export interface DiscoveryMeta {
  fetchedAt: number;
  sources: { source: string; ok: boolean; error: string | null; count: number; fetchedAt: number; stale: boolean }[];
  degraded: boolean;
}

export interface DiscoveryResponse {
  tokens: DiscoveredToken[];
  meta: DiscoveryMeta;
  page: number;
  pageSize: number;
  total: number;
}

/** Merge feeds into deduped records with FluxPad attribution applied. */
export function mergeFeeds(feeds: SourceFeed[], now = Date.now(), ttlMs = 30_000): DiscoveredToken[] {
  const byMint = new Map<string, DiscoveredToken>();
  const fluxpadByMint = new Map<string, DiscoveredToken>();
  for (const f of feeds) {
    for (const t of f.tokens) {
      if (f.source === "fluxpad") fluxpadByMint.set(t.mint, t);
    }
  }
  for (const f of feeds) {
    for (const t of f.tokens) {
      const record: DiscoveredToken = { ...t, stale: now - f.fetchedAt > ttlMs };
      const attributed = fluxpadByMint.get(t.mint);
      if (attributed) {
        record.fluxpadLaunchId = attributed.fluxpadLaunchId;
        if (attributed.poolAddress && !record.poolAddress) record.poolAddress = attributed.poolAddress;
        if (attributed.curveProgress != null && record.curveProgress == null) {
          record.curveProgress = attributed.curveProgress;
        }
      }
      const existing = byMint.get(t.mint);
      if (!existing) {
        byMint.set(t.mint, record);
        continue;
      }
      // Prefer the record with more verified information; graduated/pool
      // state wins over a stale curve snapshot, but the earliest known
      // creation time and FluxPad attribution are preserved.
      const rank = (x: DiscoveredToken) => (x.source === "fluxpad" ? 3 : x.status === "pool" ? 2 : 1);
      const winner = rank(record) >= rank(existing) ? record : existing;
      const loser = winner === record ? existing : record;
      byMint.set(t.mint, {
        ...winner,
        createdAt: winner.createdAt ?? loser.createdAt,
        imageUrl: winner.imageUrl ?? loser.imageUrl,
        fluxpadLaunchId: winner.fluxpadLaunchId ?? loser.fluxpadLaunchId,
        creatorWallet: winner.creatorWallet ?? loser.creatorWallet,
        name: winner.name === "Unknown" ? loser.name : winner.name,
        symbol: winner.symbol === "???" ? loser.symbol : winner.symbol,
      });
    }
  }
  return [...byMint.values()];
}
export function tabTokens(all: DiscoveredToken[], tab: DiscoveryTab): DiscoveredToken[] {
  switch (tab) {
    case "all":
      return all;
    case "new-launches":
      return all.filter((t) => t.status === "curve" || t.status === "verified-launch");
    case "new-pools":
      return all.filter((t) => t.status === "pool");
    case "pumpfun":
      return all.filter((t) => t.source === "pumpfun.curve");
    case "pumpswap":
      return all.filter((t) => t.source === "pumpfun.pool");
    case "launchlab":
      return all.filter((t) => t.source === "launchlab.curve");
    case "cpmm":
      return all.filter((t) => t.source === "raydium.cpmm");
    case "trending":
      // Honest trending: only tokens with a provider-supplied 24h metric rank,
      // by volume then change; tokens without metrics cannot "trend".
      return all
        .filter((t) => t.volume24hUsd != null || t.change24h != null)
        .sort(
          (a, b) => (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1) || (b.change24h ?? -1) - (a.change24h ?? -1),
        );
    case "graduating":
      // Actively approaching graduation: curve tokens at/above 80% progress.
      return all.filter(
        (t) => t.status === "curve" && t.curveProgress != null && t.curveProgress >= 80,
      );
    case "graduated":
      // Graduated tokens: migrated to a destination pool (PumpSwap / CPMM).
      return all.filter((t) => t.status === "pool" || t.status === "graduated");
    case "fluxpad":
      // FluxPad tab: only records with a verified FluxPad launch id.
      return all.filter((t) => t.fluxpadLaunchId != null);
  }
}

/** Live-scanner filters (Phase 7). Only filters backed by real provider data
 * are applied; a filter on unavailable data narrows strictly (never shows
 * tokens that merely lack the metric... they are EXCLUDED as unknown). */
export interface ScannerFilters {
  /** Min/max market cap or FDV in USD (provider-supplied only). */
  minMarketCapUsd?: number | null;
  maxMarketCapUsd?: number | null;
  /** Minimum pool/curve liquidity in the quote asset. */
  minLiquidityQuote?: number | null;
  /** Minimum provider-supplied 24h volume in USD. */
  minVolume24hUsd?: number | null;
  /** Maximum token age in hours (from createdAt/firstSeenAt). */
  maxAgeHours?: number | null;
  /** Minimum bonding-curve progress 0..100 (curve tokens only). */
  minCurveProgress?: number | null;
}

export function applyScannerFilters(
  tokens: DiscoveredToken[],
  f: ScannerFilters,
  now = Date.now(),
): DiscoveredToken[] {
  return tokens.filter((t) => {
    if (f.minMarketCapUsd != null && (t.marketCapUsd == null || t.marketCapUsd < f.minMarketCapUsd)) return false;
    if (f.maxMarketCapUsd != null && (t.marketCapUsd == null || t.marketCapUsd > f.maxMarketCapUsd)) return false;
    if (f.minLiquidityQuote != null && (t.liquidityQuote == null || t.liquidityQuote < f.minLiquidityQuote)) return false;
    if (f.minVolume24hUsd != null && (t.volume24hUsd == null || t.volume24hUsd < f.minVolume24hUsd)) return false;
    if (f.minCurveProgress != null && (t.curveProgress == null || t.curveProgress < f.minCurveProgress)) return false;
    if (f.maxAgeHours != null) {
      const ts = (t.createdAt ?? Math.floor(t.firstSeenAt / 1000)) * 1000;
      if (now - ts > f.maxAgeHours * 3_600_000) return false;
    }
    return true;
  });
}

/** Sub-filters under the tabs (mirroring the reference UI's compact filters). */
export type DiscoveryFilter = "all" | "movers" | "new" | "market-cap" | "oldest" | "last-trade";

export function applyFilter(tokens: DiscoveredToken[], filter: DiscoveryFilter, now = Date.now()): DiscoveredToken[] {
  switch (filter) {
    case "all":
      return tokens;
    case "movers":
      // Only tokens with a verified 24h change can be "movers".
      return tokens.filter((t) => t.change24h != null);
    case "new":
      // Created (or first seen) within the last 24h.
      return tokens.filter((t) => {
        const ts = t.createdAt ? t.createdAt * 1000 : t.firstSeenAt;
        return now - ts <= 86_400_000;
      });
    case "market-cap":
      return tokens.filter((t) => t.marketCapUsd != null);
    case "oldest":
      return tokens; // ordering handled by sortTokens
    case "last-trade":
      return tokens; // ordering handled by sortTokens
  }
}

const SORT_KEY = {
  newest: (t: DiscoveredToken) => (t.createdAt ? t.createdAt * 1000 : t.firstSeenAt),
  oldest: (t: DiscoveredToken) => (t.createdAt ? t.createdAt * 1000 : t.firstSeenAt),
  "movers-up": (t: DiscoveredToken) => t.change24h ?? -Infinity,
  "movers-down": (t: DiscoveredToken) => t.change24h ?? -Infinity,
  "market-cap": (t: DiscoveredToken) => t.marketCapUsd ?? -Infinity,
  "last-trade": (t: DiscoveredToken) => (t.createdAt ? t.createdAt * 1000 : t.firstSeenAt),
} as const;

export function sortTokens(tokens: DiscoveredToken[], sort: DiscoverySort): DiscoveredToken[] {
  const key = SORT_KEY[sort] ?? SORT_KEY.newest;
  const sorted = [...tokens].sort((a, b) => key(b) - key(a)); // desc by default
  if (sort === "oldest") sorted.reverse();
  return sorted;
}

export function searchTokens(tokens: DiscoveredToken[], q: string): DiscoveredToken[] {
  const query = q.trim().toLowerCase();
  if (!query) return tokens;
  return tokens.filter(
    (t) =>
      t.name.toLowerCase().includes(query) ||
      t.symbol.toLowerCase().includes(query) ||
      t.mint.toLowerCase().includes(query),
  );
}

export function paginate(tokens: DiscoveredToken[], page: number, pageSize: number): DiscoveredToken[] {
  const p = Math.max(1, page);
  return tokens.slice((p - 1) * pageSize, p * pageSize);
}

/** Convert SOL-denominated valuations to USD when a documented SOL price exists. */
export function applySolPrice(tokens: DiscoveredToken[], solPriceUsd: number | null): DiscoveredToken[] {
  if (solPriceUsd == null || solPriceUsd <= 0) return tokens;
  return tokens.map((t) => {
    const mcSol = (t as DiscoveredToken & { marketCapSol?: number }).marketCapSol;
    if (t.marketCapUsd == null && mcSol != null) {
      return { ...t, marketCapUsd: mcSol * solPriceUsd, valuation: t.valuation ?? "fdv" };
    }
    return t;
  });
}
