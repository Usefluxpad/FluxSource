import { NextResponse } from "next/server";
import { z } from "zod";
import { getOfficialTokenStore } from "@/lib/official-token/store";
import { jsonHeaders, mutationRejected, publicApiGuard } from "@/lib/official-token/api-guard";

/**
 * GET /api/official-token/activity — public, read-only activity feed.
 *
 * Validated + paginated. Filters: type, wallet role, sender/recipient
 * address, signature substring, date range. Only stored VERIFIED data is
 * returned; no transfers/buybacks/burns/config changes are possible here.
 */

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  type: z.enum(["all", "fee_collect", "transfer", "swap", "burn", "other"]).default("all"),
  wallet: z
    .enum(["W1", "W2", "W3", "W4"])
    .optional()
    .or(z.literal("").transform(() => undefined)),
  address: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
  q: z.string().max(100).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guard = publicApiGuard(req);
  if (guard) return guard;

  const url = new URL(req.url);
  const raw = Object.fromEntries(url.searchParams.entries());
  if (!raw.wallet) delete raw.wallet;
  if (!raw.address) delete raw.address;
  if (!raw.q) delete raw.q;
  if (!raw.from) delete raw.from;
  if (!raw.to) delete raw.to;
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_parameters", issues: parsed.error.flatten().fieldErrors },
      { status: 400, headers: jsonHeaders() },
    );
  }

  const store = getOfficialTokenStore();
  if (!store) {
    return NextResponse.json(
      { error: "database_not_configured" },
      { status: 503, headers: jsonHeaders() },
    );
  }

  const p = parsed.data;
  const filter = {
    type: p.type,
    walletRole: p.wallet,
    address: p.address,
    signatureQuery: p.q,
    from: p.from ? new Date(p.from) : undefined,
    to: p.to ? new Date(p.to) : undefined,
    page: p.page,
    pageSize: p.pageSize,
  } as const;

  try {
    const [rows, total] = await Promise.all([
      store.listActivities(filter),
      store.countActivities(filter),
    ]);
    return NextResponse.json(
      {
        page: p.page,
        pageSize: p.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / p.pageSize)),
        activities: rows,
        servedAt: new Date().toISOString(),
      },
      { headers: jsonHeaders() },
    );
  } catch (err) {
    console.error("[api/official-token/activity] db error", err);
    return NextResponse.json(
      { error: "database_error" },
      { status: 500, headers: jsonHeaders() },
    );
  }
}

/** Explicit: this API never accepts mutating requests. */
export async function POST(req: Request) {
  return mutationRejected(req);
}