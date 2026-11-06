/**
 * FluxPad launch-records adapter — the "FluxPad Launches" tab source.
 *
 * Only launches that originated through FluxPad AND whose launch
 * transaction + mint have been verified on-chain are included: the registry
 * only sets CONFIRMED (and later statuses) after `getAccountInfo(mint)` came
 * back non-null, so the query filters to status >= CONFIRMED and requires
 * both mintAddress and signature. FAILED / UNRESOLVED / PREPARATION /
 * SUBMITTED are excluded — a submitted-but-unconfirmed launch is never shown
 * as a verified listing.
 */
import { LaunchStatus } from "@prisma/client";
import { getDb } from "@/lib/db";
import { curveProgress as curveProgressFromState } from "@/lib/format";
import type { DiscoveredToken, SourceFeed } from "./types";

const VERIFIED_STATUSES: LaunchStatus[] = [
  LaunchStatus.CONFIRMED,
  LaunchStatus.CURVE_TRADING,
  LaunchStatus.GRADUATION_DETECTED,
  LaunchStatus.POOL_VERIFIED,
];

export async function fetchFluxpadLaunches(now = Date.now()): Promise<SourceFeed> {
  const db = getDb();
  if (!db) {
    return { source: "fluxpad", tokens: [], fetchedAt: now, ok: false, error: "database_not_configured" };
  }
  try {
    const rows = await db.launch.findMany({
      where: {
        status: { in: VERIFIED_STATUSES },
        mintAddress: { not: null },
        signature: { not: null },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        name: true,
        symbol: true,
        imageUrl: true,
        route: true,
        status: true,
        mintAddress: true,
        signature: true,
        poolAddress: true,
        creatorWallet: true,
        curveState: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    const tokens: DiscoveredToken[] = rows.map((r) => ({
      mint: r.mintAddress ?? r.id,
      name: r.name,
      symbol: r.symbol,
      imageUrl: r.imageUrl,
      source: "fluxpad",
      status: r.status === LaunchStatus.POOL_VERIFIED ? "pool" : "verified-launch",
      createdAt: Math.floor(r.createdAt.getTime() / 1000),
      firstSeenAt: r.createdAt.getTime(),
      fetchedAt: now,
      stale: false,
      priceQuote: null, // no verified price source for these yet — N/A, not fabricated
      quoteSymbol: "SOL",
      liquidityQuote: null,
      change24h: null,
      volume24hUsd: null,
      marketCapUsd: null,
      valuation: null,
      curveProgress: curveProgressFromState(r.curveState),
      poolAddress: r.poolAddress,
      signature: r.signature,
      creatorWallet: r.creatorWallet,
      fluxpadLaunchId: r.id,
      provenance: `fluxpad-registry(${r.route.toLowerCase()})`,
    }));
    return { source: "fluxpad", tokens, fetchedAt: now, ok: true, error: null };
  } catch (err) {
    return {
      source: "fluxpad",
      tokens: [],
      fetchedAt: now,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
