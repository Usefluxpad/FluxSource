/**
 * SOL/USD price source for USD conversions.
 * Chain: DexScreener (highest-liquidity WSOL pair) → Jupiter tokens v2 →
 * Jupiter price v2 → Coinbase spot. Cached 60s. Never invents a value —
 * callers receive null when no verified source is reachable.
 */
import { fetchJson } from "@/lib/discovery/http";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const REFRESH_MS = 60_000;

let cached: { usd: number; source: string; at: number } | null = null;
let inflight: Promise<{ usd: number; source: string } | null> | null = null;

async function fetchOnce(): Promise<{ usd: number; source: string } | null> {
  // DexScreener: the deepest WSOL pair's USD price (works on restricted networks).
  try {
    const d = await fetchJson<{ pairs?: { priceUsd?: string; liquidity?: { usd?: number } }[] }>(
      `https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`,
      { timeoutMs: 7000, retries: 1 },
    );
    const best = (d?.pairs ?? [])
      .filter((p) => Number.isFinite(Number(p.priceUsd)) && Number(p.priceUsd) > 0)
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const p = Number(best?.priceUsd);
    if (Number.isFinite(p) && p > 0) return { usd: p, source: "dexscreener" };
  } catch {
    // fall through
  }
  // Jupiter tokens v2 search (carries usdPrice).
  try {
    const j = await fetchJson<{ data?: { usdPrice?: number }[] }>(
      `https://lite-api.jup.ag/tokens/v2/search?query=${SOL_MINT}`,
      { timeoutMs: 7000, retries: 1 },
    );
    const p = Number(j?.data?.[0]?.usdPrice);
    if (Number.isFinite(p) && p > 0) return { usd: p, source: "jupiter-tokens" };
  } catch {
    // fall through
  }
  // Jupiter price v2.
  try {
    const j = await fetchJson<{ data?: Record<string, { price?: string }> }>(
      `https://lite-api.jup.ag/price/v2?ids=${SOL_MINT}`,
      { timeoutMs: 6000, retries: 1 },
    );
    const p = Number(j?.data?.[SOL_MINT]?.price);
    if (Number.isFinite(p) && p > 0) return { usd: p, source: "jupiter" };
  } catch {
    // fall through
  }
  // Coinbase spot.
  try {
    const c = await fetchJson<{ data?: { amount?: string } }>(
      "https://api.coinbase.com/v2/prices/SOL-USD/spot",
      { timeoutMs: 6000, retries: 1 },
    );
    const p = Number(c?.data?.amount);
    if (Number.isFinite(p) && p > 0) return { usd: p, source: "coinbase" };
  } catch {
    // all sources failed
  }
  return null;
}

/** Cached SOL/USD; returns null when no verified source is reachable. */
export async function getSolUsd(): Promise<{ usd: number; source: string } | null> {
  const now = Date.now();
  if (cached && now - cached.at < REFRESH_MS) {
    return { usd: cached.usd, source: cached.source };
  }
  if (!inflight) {
    inflight = fetchOnce()
      .then((r) => {
        if (r) cached = { usd: r.usd, source: r.source, at: Date.now() };
        return r;
      })
      .finally(() => {
        inflight = null;
      });
  }
  const r = await inflight;
  // Serve the stale-but-real cached value while refresh is in flight.
  if (r) return r;
  return cached ? { usd: cached.usd, source: cached.source } : null;
}

/** Non-blocking peek for synchronous metric computation. */
export function peekSolUsd(): { usd: number; source: string } | null {
  return cached ? { usd: cached.usd, source: cached.source } : null;
}

/** Kick off a background refresh (fire-and-forget). */
export function refreshSolUsd(): void {
  void getSolUsd();
}
