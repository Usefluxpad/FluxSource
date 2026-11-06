import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDiscovery } from "@/lib/discovery/runtime";
import { applyScannerFilters, type ScannerFilters } from "@/lib/discovery/index";

export const dynamic = "force-dynamic";

/**
 * GET /api/discovery — merged, normalized token discovery across the Pump.fun
 * bonding curves + PumpSwap pools (on-chain), Raydium LaunchLab Mint API and
 * API v3 CPMM pools (documented REST), and verified FluxPad launch records.
 * All query parameters are validated and bounded; results are paginated.
 */
const querySchema = z.object({
  tab: z
    .enum([
      "all",
      "new-launches",
      "new-pools",
      "pumpfun",
      "pumpswap",
      "launchlab",
      "cpmm",
      "trending",
      "graduating",
      "graduated",
      "fluxpad",
    ])
    .default("all"),
  filter: z.enum(["all", "movers", "new", "market-cap", "oldest", "last-trade"]).default("all"),
  sort: z.enum(["newest", "oldest", "movers-up", "movers-down", "market-cap", "last-trade"]).default("newest"),
  q: z.string().max(64).default(""),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(5).max(50).default(25),
  launchRoute: z.enum(["all", "pump", "launchlab"]).default("all"),
  launchStatus: z.enum(["all", "pending", "graduated"]).default("all"),
  // Live-scanner filters (Phase 7) — all optional, all bounded.
  minMarketCapUsd: z.coerce.number().min(0).max(1e12).optional(),
  maxMarketCapUsd: z.coerce.number().min(0).max(1e12).optional(),
  minLiquidityQuote: z.coerce.number().min(0).max(1e12).optional(),
  minVolume24hUsd: z.coerce.number().min(0).max(1e12).optional(),
  maxAgeHours: z.coerce.number().min(0).max(24 * 365).optional(),
  minCurveProgress: z.coerce.number().min(0).max(100).optional(),
});

const numberOrNull = (v: number | undefined) => (typeof v === "number" ? v : null);

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    tab: url.searchParams.get("tab") ?? undefined,
    filter: url.searchParams.get("filter") ?? undefined,
    sort: url.searchParams.get("sort") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    launchRoute: url.searchParams.get("launchRoute") ?? undefined,
    launchStatus: url.searchParams.get("launchStatus") ?? undefined,
    minMarketCapUsd: url.searchParams.get("minMarketCapUsd") ?? undefined,
    maxMarketCapUsd: url.searchParams.get("maxMarketCapUsd") ?? undefined,
    minLiquidityQuote: url.searchParams.get("minLiquidityQuote") ?? undefined,
    minVolume24hUsd: url.searchParams.get("minVolume24hUsd") ?? undefined,
    maxAgeHours: url.searchParams.get("maxAgeHours") ?? undefined,
    minCurveProgress: url.searchParams.get("minCurveProgress") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
      { status: 400 },
    );
  }
  const { minMarketCapUsd, maxMarketCapUsd, minLiquidityQuote, minVolume24hUsd, maxAgeHours, minCurveProgress } =
    parsed.data;
  const scannerFilters: ScannerFilters = {
    minMarketCapUsd: numberOrNull(minMarketCapUsd),
    maxMarketCapUsd: numberOrNull(maxMarketCapUsd),
    minLiquidityQuote: numberOrNull(minLiquidityQuote),
    minVolume24hUsd: numberOrNull(minVolume24hUsd),
    maxAgeHours: numberOrNull(maxAgeHours),
    minCurveProgress: numberOrNull(minCurveProgress),
  };
  try {
    const result = await getDiscovery(parsed.data, scannerFilters);
    return NextResponse.json({ ...result, scannerFilters } as object);
  } catch (err) {
    console.error("[api/discovery] error", err);
    return NextResponse.json({ error: "discovery_failed" }, { status: 500 });
  }
}

