import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, isDatabaseBootError } from "@/lib/db";
import { curveProgress } from "@/lib/format";

/**
 * POST /api/launches — persist a launch intent (idempotent via idempotencyKey).
 * GET  /api/launches?creator=...&limit= — list launches.
 *
 * The database stores RelayPad's observations only; on-chain state remains the
 * source of truth for graduation and pool verification.
 */

const createSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  creatorWallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  route: z.enum(["PUMP_PUMPSWAP", "LAUNCHLAB_CPMM"]),
  network: z.enum(["devnet", "mainnet-beta"]),
  name: z.string().min(1).max(64),
  symbol: z.string().min(1).max(10),
  description: z.string().max(1000).optional(),
  metadataUri: z.string().url().or(z.literal("")).optional(),
  imageUrl: z.string().url().or(z.literal("")).optional(),
});

export async function POST(req: Request) {
  const db = getDb();
  if (!db) {
    return NextResponse.json(
      {
        error: "database_not_configured",
        message:
          "FluxPad requires DATABASE_URL (PostgreSQL) to persist launch records. See .env.example.",
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const input = parsed.data;
  try {
    const launch = await db.launch.upsert({
      where: { idempotencyKey: input.idempotencyKey },
      create: {
        ...input,
        metadataUri: input.metadataUri || null,
        imageUrl: input.imageUrl || null,
        description: input.description || null,
        status: "PREPARATION",
        timeline: {
          create: {
            kind: "intent_recorded",
            dedupeKey: `${input.idempotencyKey}:intent`,
            detail: { route: input.route, network: input.network },
          },
        },
      },
      update: {
        // Idempotent: an existing record with the same key is left untouched,
        // preventing accidental duplicate launches.
      },
      include: { timeline: true },
    });
    return NextResponse.json({ launch }, { status: launch.createdAt === launch.updatedAt ? 201 : 200 });
  } catch (err) {
    console.error("[api/launches] db error", err);
    if (isDatabaseBootError(err)) {
      return NextResponse.json(
        { error: "database_not_initialized", message: "The registry database schema is not initialized yet. It is created automatically on server start; if this persists, run npx prisma migrate deploy." },
        { status: 503, headers: { "retry-after": "30" } },
      );
    }
    return NextResponse.json({ error: "database_error" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "database_not_configured" }, { status: 503 });
  }

  const url = new URL(req.url);
  const creator = url.searchParams.get("creator");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 48) || 48, 100);
  const route = url.searchParams.get("route");
  const sort = url.searchParams.get("sort") ?? "recent";
  // Status group filters used by the dashboard: new = pre-graduation,
  // graduating = graduation detected or pool verified.
  const statusGroup = url.searchParams.get("statusGroup");

  const where: Record<string, unknown> = {};
  if (creator) where.creatorWallet = creator;
  if (route === "PUMP_PUMPSWAP" || route === "LAUNCHLAB_CPMM") where.route = route;
  if (statusGroup === "new") {
    where.status = { in: ["PREPARATION", "SUBMITTED", "CONFIRMED", "CURVE_TRADING"] };
  } else if (statusGroup === "graduating") {
    where.status = { in: ["GRADUATION_DETECTED", "POOL_VERIFIED"] };
  }

  try {
    const orderBy = sort === "active" ? { updatedAt: "desc" as const } : { createdAt: "desc" as const };
    let rows = await db.launch.findMany({
      where: where as never,
      orderBy,
      take: 300,
      select: {
        id: true,
        name: true,
        symbol: true,
        description: true,
        route: true,
        status: true,
        mintAddress: true,
        imageUrl: true,
        network: true,
        creatorWallet: true,
        poolAddress: true,
        curveState: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Optional case-insensitive search across token identity, mint and creator
    // (Prisma SQLite `contains` is case-sensitive, so filter in JS over a
    // bounded result set).
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.symbol.toLowerCase().includes(q) ||
          (r.mintAddress ?? "").toLowerCase().includes(q) ||
          r.creatorWallet.toLowerCase().includes(q),
      );
    }

    const launches = rows.slice(0, limit).map((r) => ({
      ...r,
      curveState: undefined,
      curveProgress: curveProgress(r.curveState),
    }));
    return NextResponse.json({ launches });
  } catch (err) {
    console.error("[api/launches] db error", err);
    if (isDatabaseBootError(err)) {
      return NextResponse.json(
        { error: "database_not_initialized", message: "The registry database schema is not initialized yet. It is created automatically on server start; if this persists, run npx prisma migrate deploy." },
        { status: 503, headers: { "retry-after": "30" } },
      );
    }
    return NextResponse.json({ error: "database_error" }, { status: 500 });
  }
}
