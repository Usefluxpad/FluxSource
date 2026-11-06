/**
 * GET /api/trending — real Pump.fun trending rankings from the live engine.
 * Query: ?tab=trending|volume|gainers|losers|most-bought|newest|migrated
 *        &tf=5m|1h|4h|12h|24h&limit=50
 */
import { NextResponse } from "next/server";
import { getEngine } from "@/lib/pump-live/engine";
import type { TrendingTab, TrendingTimeframe } from "@/lib/pump-live/types";

export const dynamic = "force-dynamic";

const TABS: TrendingTab[] = ["trending", "volume", "gainers", "losers", "most-bought", "newest", "migrated"];
const TFS: TrendingTimeframe[] = ["5m", "1h", "4h", "12h", "24h"];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tabParam = url.searchParams.get("tab") as TrendingTab | null;
  const tfParam = url.searchParams.get("tf") as TrendingTimeframe | null;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const tab = tabParam && TABS.includes(tabParam) ? tabParam : "trending";
  const tf = tfParam && TFS.includes(tfParam) ? tfParam : "1h";
  try {
    const engine = getEngine();
    const snap = engine.getTrending(tab, tf, limit);
    return NextResponse.json(
      { type: "trending", tab, tf, ...snap },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: "trending_unavailable", message: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
