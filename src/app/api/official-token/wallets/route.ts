import { NextResponse } from "next/server";
import { resolveServerNetworkConfig, getConnection } from "@/lib/connection";
import { getOfficialTokenConfig } from "@/lib/official-token/config";
import { buildTreasurySummary } from "@/lib/official-token/summary";
import { adaptConnection } from "@/lib/official-token/rpc-adapter";
import { jsonHeaders, mutationRejected, publicApiGuard } from "@/lib/official-token/api-guard";
import { logSafeDetail } from "@/lib/official-token/sanitize";

/**
 * GET /api/official-token/wallets — public wallet directory.
 *
 * Lists the configured treasury wallets (role, public address, live SOL and
 * $FLUX balances, explorer link). Unconfigured roles render as explicit
 * "awaiting configuration" placeholders. Public data only.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guard = publicApiGuard(req);
  if (guard) return guard;

  const config = getOfficialTokenConfig();
  try {
    const networkCfg = resolveServerNetworkConfig(config.network);
    const connection = adaptConnection(getConnection(networkCfg));
    const summary = await buildTreasurySummary({ balanceConnection: connection, store: null, config });
    return NextResponse.json(
      {
        network: summary.network,
        mint: config.mint,
        wallets: summary.wallets.map((w) => ({
          role: w.role,
          address: w.address,
          configured: w.configured,
          solLamports: w.lamports,
          relayBalance: w.relayBalance,
          relayDecimals: w.relayDecimals,
          balanceError: w.balanceError,
        })),
        servedAt: new Date().toISOString(),
      },
      { headers: jsonHeaders() },
    );
  } catch (err) {
    console.error("[api/official-token/wallets] error:", logSafeDetail(err));
    return NextResponse.json(
      { error: "wallets_unavailable" },
      { status: 503, headers: jsonHeaders() },
    );
  }
}

/** Explicit: this API never accepts mutating requests. */
export async function POST(req: Request) {
  return mutationRejected(req);
}