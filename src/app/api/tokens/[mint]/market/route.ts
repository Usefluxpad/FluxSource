import { currentNetworkRaw } from "@/lib/network-env";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveServerNetworkConfig, getConnection } from "@/lib/connection";
import { fetchTokenMarket, aggregateCandles, activityWindows, candleSecondsFor } from "@/lib/token/trades";
import { resolveLiveMarket } from "@/lib/token/live-market";

export const dynamic = "force-dynamic";

/**
 * GET /api/tokens/[mint]/market — live token analytics.
 *
 * Two cooperating sources, both real:
 * 1. Providers (DexScreener/GeckoTerminal) resolve the CURRENT venue for ANY
 *    mint (Pump.fun curve, PumpSwap pool, LaunchLab, Raydium CPMM, Orca,
 *    Meteora, …) and supply price/volume/liquidity/FDV metrics.
 * 2. The bounded on-chain swap scanner decodes real trades over the resolved
 *    venue account (works for any AMM — classification is venue-agnostic).
 *
 * Unavailable metrics stay unavailable — never fabricated. A short module
 * cache (15s on-chain, 30s providers) bounds request rates per mint.
 */

const querySchema = z.object({
  interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).default("5m"),
  maxTx: z.coerce.number().int().min(5).max(20).default(20),
});
// rev 6 — provider venue resolution + live market metrics

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { expiresAt: number; payload: unknown }>();

export async function GET(req: NextRequest, ctx: { params: Promise<{ mint: string }> }) {
  const { mint } = await ctx.params;
  // Bounded mint shape (base58 pubkey).
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return NextResponse.json({ error: "invalid_mint" }, { status: 400 });
  }
  const parsed = querySchema.safeParse({
    interval: new URL(req.url).searchParams.get("interval") ?? undefined,
    maxTx: new URL(req.url).searchParams.get("maxTx") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  }
  const interval = parsed.data.interval;
  if (candleSecondsFor(interval) == null) {
    return NextResponse.json({ error: "invalid_interval" }, { status: 400 });
  }

  // Providers resolve the venue + market metrics for ANY mint. Failures
  // degrade gracefully (live.available = false) and the on-chain resolver
  // below still runs.
  const live = await resolveLiveMarket(mint);

  // Trades payload is interval-independent — cache it; candles derive per
  // interval from the same bounded trade set.
  const cacheKey = `${mint}:${parsed.data.maxTx}:${live.venue.address ?? "none"}`;
  const cached = cache.get(cacheKey);
  const now = Date.now();
  let tradesPayload: unknown;
  if (cached && cached.expiresAt > now) {
    tradesPayload = cached.payload;
  } else {
    const cfg = resolveServerNetworkConfig(currentNetworkRaw());
    const connection = getConnection(cfg);
    tradesPayload = await fetchTokenMarket(connection, mint, {
      maxTx: parsed.data.maxTx,
      interval: "5m",
      // Provider-resolved venue wins: it reflects the CURRENT trading venue
      // (e.g. the PumpSwap pool after graduation, an Orca/Raydium pool for
      // external tokens) even when no PDA is derivable from the mint.
      venueOverride:
        live.venue.address != null ? { kind: live.venue.kind, address: live.venue.address } : undefined,
    });
    cache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, payload: tradesPayload });
    if (cache.size > 50) {
      // Bounded cache: drop the oldest entry (insertion order).
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
  }

  const snapshot = tradesPayload as {
    venue: unknown;
    trades: { blockTime: number | null; priceSol: number | null; solAmount: number | null; kind: string }[];
    wallets: unknown;
    holders: unknown;
    topBuyers: unknown;
    topSellers: unknown;
    earlyBuyers: unknown;
    creatorActivity: unknown;
    coverageFrom: number | null;
    coverageTo: number | null;
    coverageNote: string;
    warnings: string[];
  };

  // Candles for the requested interval, aggregated uniformly from the cached
  // real-trade set (real executions only; unknown/unpriced trades excluded).
  const candles = aggregateCandles(snapshot.trades as never, candleSecondsFor(interval) ?? 300);

  // Activity windows (5m/1h/6h/24h) derived from the same decoded swaps —
  // each window carries its own swap count so sparse coverage is explicit.
  const activity = activityWindows(
    snapshot.trades as never,
    Math.floor(Date.now() / 1000),
  );

  return NextResponse.json(
    {
      mint,
      interval,
      venue: snapshot.venue,
      venueResolved: {
        kind: live.venue.kind,
        address: live.venue.address,
        dexId: live.venue.dexId,
        dexLabel: live.venue.dexLabel,
        quoteSymbol: live.venue.quoteSymbol,
        source: live.venue.source,
      },
      live: {
        available: live.available,
        identity: live.identity,
        metrics: live.metrics,
        notes: live.notes,
      },
      candles,
      activity,
      trades: snapshot.trades,
      wallets: snapshot.wallets,
      holders: snapshot.holders,
      topBuyers: snapshot.topBuyers,
      topSellers: snapshot.topSellers,
      earlyBuyers: snapshot.earlyBuyers,
      creatorActivity: snapshot.creatorActivity,
      coverageFrom: snapshot.coverageFrom,
      coverageTo: snapshot.coverageTo,
      coverageNote: snapshot.coverageNote,
      warnings: snapshot.warnings,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
