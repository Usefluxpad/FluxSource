import { getDb } from "@/lib/db";
import type { ActivityRecord, ActivityStatus, ActivityType } from "./classify";

/**
 * Storage for verified official-$FLUX treasury activity.
 *
 * Two implementations of the same repository interface:
 * - PrismaOfficialTokenStore: the runtime store over the existing database
 *   (SQLite locally, PostgreSQL in production).
 * - MemoryOfficialTokenStore: an in-memory store for unit tests.
 *
 * The Prisma model enforces @@unique([signature, entryKey]); the upsert
 * path is idempotent so re-indexing after RPC or DB failures never
 * duplicates events.
 */

export interface ActivityFilter {
  type?: ActivityType | "all";
  /** Match any configured treasury wallet role (W1..W4) or a specific role. */
  walletRole?: string;
  /** Sender or recipient address filter (public address). */
  address?: string;
  /** Signature substring search. */
  signatureQuery?: string;
  from?: Date;
  to?: Date;
  status?: ActivityStatus;
  page: number;
  pageSize: number;
}

export interface ActivityRow {
  signature: string;
  entryKey: string;
  type: string;
  status: string;
  slot: number | null;
  blockTime: Date | null;
  walletRole: string | null;
  sender: string | null;
  recipient: string | null;
  inputAmount: string | null;
  inputAsset: string | null;
  inputDecimals: number | null;
  outputAmount: string | null;
  outputAsset: string | null;
  outputDecimals: number | null;
  burnMint: string | null;
  burnVerified: boolean;
  programId: string | null;
  network: string;
  detail: Record<string, unknown> | null;
  onChainVerified: boolean;
  verifiedAt: Date | null;
  createdAt: Date;
}

export interface TypeTotals {
  /** Sum of inputAmount (base units) for confirmed rows of the type. */
  totalInput: string;
  /** Sum of outputAmount (base units) for confirmed rows of the type. */
  totalOutput: string;
  count: number;
}

export interface TypeTotalsFilter {
  /** Sum only rows whose input/output asset equals this (mint or "SOL"). */
  asset?: string;
  /** Sum only rows that were re-verified against the node. */
  verifiedOnly?: boolean;
}

export interface OfficialTokenStore {
  upsertActivities(rows: ActivityRecord[]): Promise<{ written: number; duplicates: number }>;
  knownSignatures(signatures: string[]): Promise<Set<string>>;
  listActivities(filter: ActivityFilter): Promise<ActivityRow[]>;
  countActivities(filter: ActivityFilter): Promise<number>;
  /** Aggregates over CONFIRMED rows; filters prevent cross-asset mixing. */
  totalsByType(type: ActivityType, filter?: TypeTotalsFilter): Promise<TypeTotals>;
  getIndexState(key: string): Promise<IndexStateRow | null>;
  setIndexState(key: string, patch: IndexStatePatch): Promise<void>;
  markOnChainVerified(signatures: string[], verifiedAt: Date): Promise<number>;
  /** All stored signatures (bounded) for reconciliation checks. */
  allSignatures(limit: number): Promise<string[]>;
}

export interface IndexStateRow {
  key: string;
  lastRunAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  lastSignature: string | null;
  lastReconciledAt: Date | null;
}

export interface IndexStatePatch {
  lastRunAt?: Date;
  lastStatus?: "ok" | "error";
  lastError?: string | null;
  lastSignature?: string | null;
  lastReconciledAt?: Date;
}

/** Helpers shared by both implementations. */
function matchesFilter(row: ActivityRow, f: ActivityFilter): boolean {
  if (f.type && f.type !== "all" && row.type !== f.type) return false;
  if (f.walletRole && row.walletRole !== f.walletRole) return false;
  if (f.status && row.status !== f.status) return false;
  if (f.address) {
    const a = f.address;
    if (row.sender !== a && row.recipient !== a && row.walletRole !== a) return false;
  }
  if (f.signatureQuery && !row.signature.includes(f.signatureQuery)) return false;
  if (f.from && row.blockTime && row.blockTime < f.from) return false;
  if (f.to && row.blockTime && row.blockTime > f.to) return false;
  return true;
}

export class MemoryOfficialTokenStore implements OfficialTokenStore {
  readonly rows: ActivityRow[] = [];
  private readonly state = new Map<string, IndexStateRow>();
  private failNextUpsert: { times: number } | null = null;

  /** Test hook: make the next N upsert calls throw (DB outage simulation). */
  failNextUpserts(times: number): void {
    this.failNextUpsert = { times };
  }

  async upsertActivities(
    rows: ActivityRecord[],
  ): Promise<{ written: number; duplicates: number }> {
    if (this.failNextUpsert && this.failNextUpsert.times > 0) {
      this.failNextUpsert.times -= 1;
      throw new Error("simulated_database_failure");
    }
    let written = 0;
    let duplicates = 0;
    for (const row of rows) {
      const key = `${row.signature}:${row.entryKey}`;
      if (this.rows.some((r) => `${r.signature}:${r.entryKey}` === key)) {
        duplicates += 1;
        continue;
      }
      this.rows.push({ ...row, network: row.network ?? "", onChainVerified: false, verifiedAt: null, createdAt: new Date() } as ActivityRow);
      written += 1;
    }
    return { written, duplicates };
  }

  async knownSignatures(signatures: string[]): Promise<Set<string>> {
    const set = new Set(signatures);
    return new Set(this.rows.filter((r) => set.has(r.signature)).map((r) => r.signature));
  }

  async listActivities(filter: ActivityFilter): Promise<ActivityRow[]> {
    const matched = this.rows
      .filter((r) => matchesFilter(r, filter))
      .sort((a, b) => (b.blockTime?.getTime() ?? 0) - (a.blockTime?.getTime() ?? 0));
    const start = (filter.page - 1) * filter.pageSize;
    return matched.slice(start, start + filter.pageSize);
  }

  async countActivities(filter: ActivityFilter): Promise<number> {
    return this.rows.filter((r) => matchesFilter(r, filter)).length;
  }

  async totalsByType(
    type: ActivityType,
    filter?: TypeTotalsFilter,
  ): Promise<TypeTotals> {
    let totalInput = 0n;
    let totalOutput = 0n;
    let count = 0;
    for (const r of this.rows) {
      if (r.type !== type || r.status !== "confirmed") continue;
      if (filter?.verifiedOnly && !r.onChainVerified) continue;
      if (filter?.asset) {
        if (r.inputAsset !== filter.asset && r.outputAsset !== filter.asset) continue;
      }
      count += 1;
      if (r.inputAmount) totalInput += BigInt(r.inputAmount);
      if (r.outputAmount) totalOutput += BigInt(r.outputAmount);
    }
    return { totalInput: totalInput.toString(), totalOutput: totalOutput.toString(), count };
  }

  async getIndexState(key: string): Promise<IndexStateRow | null> {
    return this.state.get(key) ?? null;
  }

  async setIndexState(key: string, patch: IndexStatePatch): Promise<void> {
    const existing = this.state.get(key) ?? {
      key,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      lastSignature: null,
      lastReconciledAt: null,
    };
    this.state.set(key, { ...existing, ...patch });
  }

  async markOnChainVerified(signatures: string[], verifiedAt: Date): Promise<number> {
    const set = new Set(signatures);
    let count = 0;
    for (const r of this.rows) {
      if (set.has(r.signature) && !r.onChainVerified) {
        r.onChainVerified = true;
        r.verifiedAt = verifiedAt;
        count += 1;
      }
    }
    return count;
  }

  async allSignatures(limit: number): Promise<string[]> {
    return [...new Set(this.rows.map((r) => r.signature))].slice(0, limit);
  }
}

import { Prisma } from "@prisma/client";

/**
 * Prisma-backed store. Throws on infrastructure failures so callers can
 * reconcile before retrying (never silently drops a confirmed transaction).
 */
export class PrismaOfficialTokenStore implements OfficialTokenStore {
  private readonly db: NonNullable<ReturnType<typeof getDb>>;

  constructor(db: NonNullable<ReturnType<typeof getDb>>) {
    this.db = db;
  }

  async upsertActivities(
    rows: ActivityRecord[],
  ): Promise<{ written: number; duplicates: number }> {
    let duplicates = 0;
    for (const row of rows) {
      try {
        // Atomic INSERT: the (signature, entryKey) unique index makes
        // concurrent runs safe — the loser of a race receives P2002 and is
        // counted as a duplicate, never duplicated and never overwritten.
        await this.db.relayOfficialActivity.create({
          data: {
            signature: row.signature,
            entryKey: row.entryKey,
            type: row.type,
            status: row.status,
            slot: row.slot,
            blockTime: row.blockTime,
            walletRole: row.walletRole,
            sender: row.sender,
            recipient: row.recipient,
            inputAmount: row.inputAmount,
            inputAsset: row.inputAsset,
            inputDecimals: row.inputDecimals,
            outputAmount: row.outputAmount,
            outputAsset: row.outputAsset,
            outputDecimals: row.outputDecimals,
            burnMint: row.burnMint,
            burnVerified: row.burnVerified,
            programId: row.programId,
            network: row.network,
            detail: row.detail === null ? Prisma.DbNull : Prisma.JsonNull,
            onChainVerified: false,
          },
        });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002" // unique constraint violation → already stored
        ) {
          duplicates += 1;
          continue;
        }
        throw err; // real infrastructure failure → caller reconciles
      }
    }
    return { written: rows.length - duplicates, duplicates };
  }

  async knownSignatures(signatures: string[]): Promise<Set<string>> {
    if (signatures.length === 0) return new Set();
    const rows = await this.db.relayOfficialActivity.findMany({
      where: { signature: { in: signatures } },
      select: { signature: true },
      distinct: ["signature"],
    });
    return new Set(rows.map((r) => r.signature));
  }

  private whereFor(filter: ActivityFilter) {
    const where: Record<string, unknown> = {};
    if (filter.type && filter.type !== "all") where.type = filter.type;
    if (filter.walletRole) where.walletRole = filter.walletRole;
    if (filter.status) where.status = filter.status;
    if (filter.address) where.OR = [{ sender: filter.address }, { recipient: filter.address }];
    if (filter.signatureQuery) {
      // Case-insensitivity is provider-dependent (SQLite LIKE is
      // case-insensitive, PostgreSQL LIKE is not); ask Prisma for
      // insensitive matching only where it is supported.
      const isPostgres = (process.env.DATABASE_URL ?? "").startsWith("postgres");
      where.signature = isPostgres
        ? { contains: filter.signatureQuery, mode: "insensitive" }
        : { contains: filter.signatureQuery };
    }
    const blockTime: Record<string, Date> = {};
    if (filter.from) blockTime.gte = filter.from;
    if (filter.to) blockTime.lte = filter.to;
    if (Object.keys(blockTime).length > 0) where.blockTime = blockTime;
    return where;
  }

  async listActivities(filter: ActivityFilter): Promise<ActivityRow[]> {
    const rows = await this.db.relayOfficialActivity.findMany({
      where: this.whereFor(filter),
      orderBy: [{ blockTime: "desc" }, { createdAt: "desc" }],
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    });
    return rows.map(serializeRow);
  }

  async countActivities(filter: ActivityFilter): Promise<number> {
    return this.db.relayOfficialActivity.count({ where: this.whereFor(filter) });
  }

  async totalsByType(
    type: ActivityType,
    totalsFilter?: TypeTotalsFilter,
  ): Promise<TypeTotals> {
    // Amounts are stored as strings (u64-safe), so sum in JS with BigInt
    // over confirmed rows only. Filters prevent cross-asset mixing: an
    // aggregate over "SOL" never sums token units, and mint-scoped
    // aggregates never include other mints.
    const where: Record<string, unknown> = { type, status: "confirmed" };
    if (totalsFilter?.verifiedOnly) where.onChainVerified = true;
    if (totalsFilter?.asset) {
      where.OR = [{ inputAsset: totalsFilter.asset }, { outputAsset: totalsFilter.asset }];
    }
    const rows = await this.db.relayOfficialActivity.findMany({
      where,
      select: { inputAmount: true, outputAmount: true },
    });
    let totalInput = 0n;
    let totalOutput = 0n;
    for (const r of rows) {
      if (r.inputAmount) totalInput += BigInt(r.inputAmount);
      if (r.outputAmount) totalOutput += BigInt(r.outputAmount);
    }
    return {
      totalInput: totalInput.toString(),
      totalOutput: totalOutput.toString(),
      count: rows.length,
    };
  }

  async getIndexState(key: string): Promise<IndexStateRow | null> {
    const row = await this.db.relayOfficialIndexState.findUnique({ where: { key } });
    if (!row) return null;
    return {
      key: row.key,
      lastRunAt: row.lastRunAt,
      lastStatus: row.lastStatus,
      lastError: row.lastError,
      lastSignature: row.lastSignature,
      lastReconciledAt: row.lastReconciledAt,
    };
  }

  async setIndexState(key: string, patch: IndexStatePatch): Promise<void> {
    await this.db.relayOfficialIndexState.upsert({
      where: { key },
      create: {
        key,
        lastRunAt: patch.lastRunAt ?? null,
        lastStatus: patch.lastStatus ?? null,
        lastError: patch.lastError ?? null,
        lastSignature: patch.lastSignature ?? null,
        lastReconciledAt: patch.lastReconciledAt ?? null,
      },
      update: {
        ...(patch.lastRunAt !== undefined ? { lastRunAt: patch.lastRunAt } : {}),
        ...(patch.lastStatus !== undefined ? { lastStatus: patch.lastStatus } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        ...(patch.lastSignature !== undefined ? { lastSignature: patch.lastSignature } : {}),
        ...(patch.lastReconciledAt !== undefined
          ? { lastReconciledAt: patch.lastReconciledAt }
          : {}),
      },
    });
  }

  async markOnChainVerified(signatures: string[], verifiedAt: Date): Promise<number> {
    if (signatures.length === 0) return 0;
    const res = await this.db.relayOfficialActivity.updateMany({
      where: { signature: { in: signatures }, onChainVerified: false },
      data: { onChainVerified: true, verifiedAt },
    });
    return res.count;
  }

  async allSignatures(limit: number): Promise<string[]> {
    const rows = await this.db.relayOfficialActivity.findMany({
      select: { signature: true },
      distinct: ["signature"],
      take: limit,
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => r.signature);
  }
}

function serializeRow(row: {
  signature: string;
  entryKey: string;
  type: string;
  status: string;
  slot: number | null;
  blockTime: Date | null;
  walletRole: string | null;
  sender: string | null;
  recipient: string | null;
  inputAmount: string | null;
  inputAsset: string | null;
  inputDecimals: number | null;
  outputAmount: string | null;
  outputAsset: string | null;
  outputDecimals: number | null;
  burnMint: string | null;
  burnVerified: boolean;
  programId: string | null;
  network: string;
  detail: unknown;
  onChainVerified: boolean;
  verifiedAt: Date | null;
  createdAt: Date;
}): ActivityRow {
  return {
    ...row,
    detail: (row.detail ?? null) as Record<string, unknown> | null,
  };
}

/** Runtime store accessor (null when the database is not configured). */
export function getOfficialTokenStore(): OfficialTokenStore | null {
  const db = getDb();
  return db ? new PrismaOfficialTokenStore(db) : null;
}
