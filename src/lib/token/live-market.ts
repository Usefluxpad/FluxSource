/**
 * Live market data providers for token detail pages (server-side only).
 *
 * Providers (both keyless, free tiers — no credentials exist to leak):
 * - DexScreener  https://api.dexscreener.com/latest/dex/tokens/{mint}
 *   → identity (name/symbol/logo), current venue + pair address, price USD,
 *     price changes m5/h1/h6/h24, volumes m5/h1/h6/h24, buys/sells per window,
 *     liquidity, FDV, market cap. Rate limit 300 req/min — cached 30s/mint.
 * - GeckoTerminal https://api.geckoterminal.com/api/v2/...
 *   → pool discovery fallback + REAL OHLCV candles per pool
 *     (minute 1/5/15, hour 1/4, day). Rate limit 30 req/min — cached.
 *
 * Honesty rules: every metric is passed through from the provider response
 * verbatim; anything the provider did not supply stays null/unavailable.
 * Provider shapes are validated before use; failures degrade to "unavailable"
 * states rather than partial guesses.
 */
import { fetchJson } from "@/lib/discovery/http";
import type { VenueKind } from "./trades";

/* ------------------------------------------------------------- caching ---- */

const cache = new Map<string, { at: number; ttl: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

async function cachedJson<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T | null> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.value as T;
  const pending = inflight.get(key);
  if (pending) return (await pending) as T;
  const p = (async () => {
    try {
      const value = await loader();
      if (value != null) {
        if (cache.size > 300) {
          let n = 0;
          for (const k of cache.keys()) {
            if (n++ >= 150) break;
            cache.delete(k);
          }
        }
        cache.set(key, { at: Date.now(), ttl: ttlMs, value });
      }
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p as Promise<unknown>);
  try {
    return await p;
  } catch {
    // Provider failure → null (unavailable); the last good cache entry,
    // if any, is still served via peekCache by the caller helpers.
    return null;
  }
}

/** Last good value for a key regardless of TTL (stale-serving on outages). */
function peekCache<T>(key: string): T | null {
  const hit = cache.get(key);
  return hit ? (hit.value as T) : null;
}

/** Test hook. */
export function __resetLiveMarketCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/* ------------------------------------------------------------ dexscreener -- */

interface DexPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { symbol?: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Record<string, { buys?: number; sells?: number } | undefined>;
  volume?: Record<string, number | undefined>;
  priceChange?: Record<string, number | undefined>;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  labels?: string[];
  info?: { imageUrl?: string };
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

async function dexScreenerPairs(mint: string): Promise<DexPair[] | null> {
  return cachedJson(`ds:${mint}`, 30_000, async () => {
    const body = await fetchJson<{ pairs?: DexPair[] | null; schemaVersion?: string }>(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeoutMs: 10_000, retries: 1 },
    );
    if (!body || !Array.isArray(body.pairs) || body.pairs.length === 0) return null;
    return body.pairs.filter((p) => p && typeof p === "object");
  });
}

/** Raw pairs (cached) for richer callers; null when the mint is unknown. */
export async function dexScreenerPairsFor(mint: string): Promise<DexPair[] | null> {
  const pairs = await dexScreenerPairs(mint);
  if (pairs && pairs.length > 0) return pairs;
  return peekCache<DexPair[]>(`ds:${mint}`);
}

function bestPairFrom(pairs: DexPair[] | null): DexPair | null {
  if (!pairs || pairs.length === 0) return null;
  return [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
}

/* --------------------------------------------------------- geckoterminal -- */

interface GtPool {
  address?: string;
  name?: string;
}

async function geckoPools(mint: string): Promise<GtPool[] | null> {
  return cachedJson(`gt-pools:${mint}`, 60_000, async () => {
    const body = await fetchJson<{
      data?: { attributes?: { address?: string; name?: string } }[];
    }>(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools`, {
      timeoutMs: 10_000,
      retries: 1,
    });
    const list = body?.data ?? [];
    if (list.length === 0) return null;
    return list.slice(0, 5).map((d) => ({
      address: d.attributes?.address,
      name: d.attributes?.name,
    }));
  });
}

async function geckoPoolFor(mint: string): Promise<GtPool | null> {
  const pools = await geckoPools(mint);
  if (pools && pools.length > 0) return pools[0];
  return peekCache<GtPool[]>(`gt-pools:${mint}`)?.[0] ?? null;
}

/** UI timeframe → GeckoTerminal OHLCV path + aggregate. */
const GT_TF: Record<string, { timeframe: string; aggregate: number; limit: number }> = {
  "1m": { timeframe: "minute", aggregate: 1, limit: 180 },
  "5m": { timeframe: "minute", aggregate: 5, limit: 180 },
  "15m": { timeframe: "minute", aggregate: 15, limit: 180 },
  "1h": { timeframe: "hour", aggregate: 1, limit: 180 },
  "4h": { timeframe: "hour", aggregate: 4, limit: 180 },
  "1d": { timeframe: "day", aggregate: 1, limit: 180 },
};

export interface OhlcvCandle {
  /** Bucket start, unix SECONDS. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Provider volume for the bucket (USD, as supplied by GeckoTerminal). */
  volume: number;
}

async function geckoOhlcv(poolAddress: string, tf: string): Promise<OhlcvCandle[] | null> {
  const spec = GT_TF[tf];
  if (!spec || !poolAddress) return null;
  return cachedJson(`gt-ohlcv:${poolAddress}:${tf}`, 30_000, async () => {
    const body = await fetchJson<{ data?: { attributes?: { ohlcv_list?: [number, number, number, number, number, number][] } } }>(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/${spec.timeframe}?aggregate=${spec.aggregate}&limit=${spec.limit}&currency=usd`,
      { timeoutMs: 12_000, retries: 1 },
    );
    const list = body?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list) || list.length === 0) return null;
    // GeckoTerminal returns [timestamp(s), o, h, l, c, volume] newest-first;
    // rows with null OHLC (no trades in that bucket) are dropped — never filled.
    const candles = list
      .filter((row) => Array.isArray(row) && row.length >= 6 && row[0] > 0)
      .map((row) => ({
        time: Math.floor(Number(row[0])),
        open: num(row[1]),
        high: num(row[2]),
        low: num(row[3]),
        close: num(row[4]),
        volume: num(row[5]) ?? 0,
      }))
      .filter((c): c is OhlcvCandle => c.open != null && c.high != null && c.low != null && c.close != null)
      .sort((a, b) => a.time - b.time);
    return candles.length > 0 ? candles : null;
  });
}

/** Public: normalized OHLCV for a pool address (or null when unavailable). */
export async function providerCandles(
  poolAddress: string,
  tf: string,
): Promise<{ candles: OhlcvCandle[]; source: "geckoterminal" } | null> {
  const candles = await geckoOhlcv(poolAddress, tf);
  if (candles && candles.length > 0) return { candles, source: "geckoterminal" };
  return null;
}

/* ------------------------------------------------------- venue resolution -- */

const DEX_LABELS: Record<string, string> = {
  pumpfun: "Pump.fun",
  pumpswap: "PumpSwap",
  raydium: "Raydium",
  orca: "Orca",
  meteora: "Meteora",
  "raydium-launchlab": "Raydium LaunchLab",
  launchlab: "Raydium LaunchLab",
};

function dexLabel(dexId: string | null, labels?: string[]): string {
  if (dexId && DEX_LABELS[dexId]) return DEX_LABELS[dexId];
  if (labels?.some((l) => /launchlab/i.test(l))) return "Raydium LaunchLab";
  return dexId ? dexId.charAt(0).toUpperCase() + dexId.slice(1) : "Unknown DEX";
}

function venueKindFromDex(dexId: string | null, labels?: string[]): VenueKind {
  if (dexId === "pumpfun") return "pump-curve";
  if (dexId === "pumpswap") return "pumpswap-pool";
  if (dexId === "raydium-launchlab" || dexId === "launchlab") return "launchlab-curve";
  if (dexId === "raydium") {
    return labels?.some((l) => /launchlab/i.test(l)) ? "launchlab-curve" : "cpmm-pool";
  }
  if (dexId) return "external-pool";
  return "unknown";
}

export interface LiveVenue {
  kind: VenueKind;
  /** DEX identifier as reported by the provider. */
  dexId: string | null;
  dexLabel: string;
  /** Pool / pair / curve account hosting current trading. */
  address: string | null;
  quoteSymbol: string | null;
  /** Where this venue resolution came from. */
  source: "dexscreener" | "geckoterminal" | "onchain" | "none";
}

export interface LiveMarketMetrics {
  priceUsd: number | null;
  priceNative: number | null;
  changesPct: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  volumeUsd: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  txns: {
    m5: { buys: number; sells: number } | null;
    h1: { buys: number; sells: number } | null;
    h6: { buys: number; sells: number } | null;
    h24: { buys: number; sells: number } | null;
  };
  liquidityUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
}

export interface LiveMarket {
  mint: string;
  /** True when a provider recognized this mint (name/price/pair). */
  available: boolean;
  identity: { name: string | null; symbol: string | null; imageUrl: string | null; pairCreatedAt: number | null } | null;
  venue: LiveVenue;
  metrics: LiveMarketMetrics | null;
  /** Provider notes for honest UI states. */
  notes: string[];
}

/** Full live-market resolution for one mint (providers only, no RPC). */
export async function resolveLiveMarket(mint: string): Promise<LiveMarket> {
  const notes: string[] = [];
  const emptyVenue: LiveVenue = { kind: "unknown", dexId: null, dexLabel: "Unknown DEX", address: null, quoteSymbol: null, source: "none" };
  const empty: LiveMarket = { mint, available: false, identity: null, venue: emptyVenue, metrics: null, notes };

  const pairs = await dexScreenerPairsFor(mint);
  const pair = bestPairFrom(pairs);

  // GeckoTerminal is the venue fallback when DexScreener has no pair.
  let gtPool: GtPool | null = null;
  if (!pair) {
    gtPool = await geckoPoolFor(mint);
    if (!gtPool) notes.push("No DEX pair found for this mint on DexScreener or GeckoTerminal.");
  }

  if (!pair && !gtPool) return empty;

  const dexId = pair?.dexId ?? null;
  const venue: LiveVenue = pair
    ? {
        kind: venueKindFromDex(dexId, pair.labels),
        dexId,
        dexLabel: dexLabel(dexId, pair.labels),
        address: pair.pairAddress ?? null,
        quoteSymbol: pair.quoteToken?.symbol ?? null,
        source: "dexscreener",
      }
    : {
        kind: gtPool?.name && /launchlab/i.test(gtPool.name) ? "launchlab-curve" : "external-pool",
        dexId: null,
        dexLabel: gtPool?.name ? dexLabelFromName(gtPool.name) : "DEX pool",
        address: gtPool?.address ?? null,
        quoteSymbol: null,
        source: "geckoterminal",
      };

  const metrics: LiveMarketMetrics | null = pair
    ? {
        priceUsd: num(pair.priceUsd),
        priceNative: num(pair.priceNative),
        changesPct: {
          m5: num(pair.priceChange?.m5),
          h1: num(pair.priceChange?.h1),
          h6: num(pair.priceChange?.h6),
          h24: num(pair.priceChange?.h24),
        },
        volumeUsd: {
          m5: num(pair.volume?.m5),
          h1: num(pair.volume?.h1),
          h6: num(pair.volume?.h6),
          h24: num(pair.volume?.h24),
        },
        txns: {
          m5: pair.txns?.m5 ? { buys: pair.txns.m5.buys ?? 0, sells: pair.txns.m5.sells ?? 0 } : null,
          h1: pair.txns?.h1 ? { buys: pair.txns.h1.buys ?? 0, sells: pair.txns.h1.sells ?? 0 } : null,
          h6: pair.txns?.h6 ? { buys: pair.txns.h6.buys ?? 0, sells: pair.txns.h6.sells ?? 0 } : null,
          h24: pair.txns?.h24 ? { buys: pair.txns.h24.buys ?? 0, sells: pair.txns.h24.sells ?? 0 } : null,
        },
        liquidityUsd: num(pair.liquidity?.usd),
        fdvUsd: num(pair.fdv),
        marketCapUsd: num(pair.marketCap),
      }
    : null;

  const identity = pair
    ? {
        name: pair.baseToken?.name ?? null,
        symbol: pair.baseToken?.symbol ?? null,
        imageUrl: pair.info?.imageUrl ?? null,
        pairCreatedAt: typeof pair.pairCreatedAt === "number" ? pair.pairCreatedAt : null,
      }
    : gtPool?.name
      ? { name: gtPool.name.split(" / ")[0] ?? null, symbol: null, imageUrl: null, pairCreatedAt: null }
      : null;

  return { mint, available: true, identity, venue, metrics, notes };
}

function dexLabelFromName(name: string): string {
  if (/launchlab/i.test(name)) return "Raydium LaunchLab";
  if (/pumpswap/i.test(name)) return "PumpSwap";
  if (/pump/i.test(name)) return "Pump.fun";
  if (/raydium/i.test(name)) return "Raydium";
  return "DEX pool";
}
