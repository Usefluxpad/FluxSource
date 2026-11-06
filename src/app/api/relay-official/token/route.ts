import { NextResponse } from "next/server";
import { getRelayOfficialConfig } from "@/lib/relay-official/config";
import { officialTokenView } from "@/lib/relay-official/token-display";
import { jsonHeaders, mutationRejected, publicApiGuard } from "@/lib/relay-official/api-guard";

/**
 * GET /api/relay-official/token — public, read-only official-token identity.
 *
 * Single source of truth for the public "Official $FLUX Token" section: the
 * same RELAY_OFFICIAL_MINT configuration the treasury dashboard uses. The
 * response is sanitized (no raw invalid values, no secrets) and carries an
 * honest status: "placeholder" (not announced yet), "invalid" (misconfigured),
 * or "configured" (valid address — still "NOT YET VERIFIED" on-chain).
 *
 * Read-only by construction: no transfers, buybacks, burns, or configuration
 * changes are possible here.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guard = publicApiGuard(req);
  if (guard) return guard;

  const config = getRelayOfficialConfig();
  return NextResponse.json(
    { ...officialTokenView(config) },
    { headers: jsonHeaders() },
  );
}

/** Explicit: this API never accepts mutating requests. */
export async function POST(req: Request) {
  return mutationRejected(req);
}
