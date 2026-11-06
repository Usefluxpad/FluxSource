import { NextResponse } from "next/server";
import { getOfficialTokenConfig } from "@/lib/official-token/config";
import { officialTokenView } from "@/lib/official-token/token-display";
import { jsonHeaders, mutationRejected, publicApiGuard } from "@/lib/official-token/api-guard";

/**
 * GET /api/official-token/token — public, read-only official-token identity.
 *
 * Single source of truth for the public "Official $FLUX Token" section: the
 * same FLUXPAD_OFFICIAL_MINT configuration the treasury dashboard uses. The
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

  const config = getOfficialTokenConfig();
  return NextResponse.json(
    { ...officialTokenView(config) },
    { headers: jsonHeaders() },
  );
}

/** Explicit: this API never accepts mutating requests. */
export async function POST(req: Request) {
  return mutationRejected(req);
}
