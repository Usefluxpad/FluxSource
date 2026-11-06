/**
 * GET /api/trending/stats — pipeline health + PumpPortal usage monitoring.
 * No secret values are exposed; counts and states only.
 */
import { NextResponse } from "next/server";
import { getEngine } from "@/lib/pump-live/engine";
import { snapshotAgeMs } from "@/lib/pump-live/persist";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const engine = getEngine();
    const stats = engine.getStats();
    return NextResponse.json(
      { ...stats, snapshotAgeMs: snapshotAgeMs() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: "stats_unavailable", message: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
