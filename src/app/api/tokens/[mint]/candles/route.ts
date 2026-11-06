import { currentNetworkRaw } from "@/lib/network-env";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveServerNetworkConfig, getConnection } from "@/lib/connection";
import { fetchTokenMarket, aggregateCandles, candleSecondsFor } from "@/lib/token/trades";
import { providerCandles, resolveLiveMarket } from "@/lib/token/live-market";

export const dynamic = "force-dynamic";

/**
 * GET /api/tokens/[mint]/candles?tf=1m|5m|15m|1h|4h|1d
 *
 * Real OHLCV for the token's CURRENT venue:
 * 1. GeckoTerminal pool candles (provider OHLCV, USD) when a pool is tracked.
 * 2. On-chain fallback: candles aggregated from the bounded real-swap decode
 *    (SOL-priced) with an explicit coverage window — history outside the
 *    scanned window is reported as unavailable, never filled in.
 *
 * No venue → honest `available: false`; no synthetic candles are ever built.
 */

const querySchema = z.object({
  tf: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).default("5m"),
  maxTx: z.coerce.number().int().min(5).max(20).default(20),
});

export async function GET(req: NextRequest, ctx: { params: Promise<{ mint: string }> }) {
  const { mint } = await ctx.params;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return NextResponse.json({ error: "invalid_mint" }, { status: 400 });
  }
  const parsed = querySchema.safeParse({
    tf: new URL(req.url).searchParams.get("tf") ?? undefined,
    maxTx: new URL(req.url).searchParams.get("maxTx") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  }
  const tf = parsed.data.tf;
  const intervalSec = candleSecondsFor(tf);
  if (intervalSec == null) {
    return NextResponse.json({ error: "invalid_interval" }, { status: 400 });
  }

  const live = await resolveLiveMarket(mint);

  // 1) Provider OHLCV for the resolved pool (pumpswap/raydium/orca/… pools).
  if (live.venue.address != null && live.venue.kind !== "pump-curve") {
    const provider = await providerCandles(live.venue.address, tf);
    if (provider) {
      return NextResponse.json(
        {
          mint,
          tf,
          available: true,
          source: "geckoterminal",
          unit: "usd",
          poolAddress: live.venue.address,
          candles: provider.candles,
          note: "Provider OHLCV candles for the current pool (USD).",
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
  }

  // 2) On-chain fallback: aggregate the bounded real-swap decode. Applies to
  // pump bonding curves (not tracked as GT pools) and any venue whose provider
  // OHLCV is unavailable.
  const cfg = resolveServerNetworkConfig(currentNetworkRaw());
  const connection = getConnection(cfg);
  const snapshot = await fetchTokenMarket(connection, mint, {
    interval: tf,
    maxTx: parsed.data.maxTx,
    venueOverride:
      live.venue.address != null ? { kind: live.venue.kind, address: live.venue.address } : undefined,
  });
  const candles = aggregateCandles(snapshot.trades as never, intervalSec);
  return NextResponse.json(
    {
      mint,
      tf,
      available: candles.length > 0,
      source: snapshot.venue.kind === "unknown" ? "none" : "onchain-trades",
      unit: "sol",
      poolAddress: snapshot.venue.address,
      candles,
      coverageFrom: snapshot.coverageFrom,
      coverageTo: snapshot.coverageTo,
      note:
        snapshot.venue.kind === "unknown" || snapshot.venue.address == null
          ? "No tradable venue was identified for this mint — chart data is unavailable."
          : candles.length > 0
            ? "Candles aggregated from real decoded on-chain swaps; older history is outside the scanned window."
            : "No priced swaps decoded in the scanned window yet.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}