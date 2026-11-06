import { PrismaClient } from "@prisma/client";
// Bare builtin imports (not "node:*"): Next dev bundling in this project fails
// on "node:" scheme imports inside the server module graph (UnhandledSchemeError),
// while the equivalent bare builtins resolve fine in both dev and production builds.
import { createHash } from "crypto";
import fs from "fs";
import path from "path";

/**
 * Lazily-created Prisma client. Returns null when DATABASE_URL is absent so
 * API routes can degrade with an explicit, honest error rather than crashing.
 * Launch persistence is required for the registry/dashboard features; the
 * core client-side launch flow continues to work without it.
 *
 * Production SQLite hardening (added after a live deployment failure):
 *
 * 1. `file:` DATABASE_URLs resolve RELATIVE TO `prisma/schema.prisma`, not
 *    the process cwd. A value copied from `.env.local`
 *    (`file:./prisma/dev.db`) therefore points at `<app>/prisma/prisma/dev.db`
 *    in production — a directory that does not exist — and SQLite fails with
 *    error 14 ("Unable to open the database file"), taking the whole registry
 *    down. `resolveSqliteUrl()` resolves the real location deterministically
 *    (preferring an existing database file, whichever convention created it,
 *    so no records are ever orphaned), creates the parent directory, and
 *    rewrites the runtime `DATABASE_URL` to that absolute file URL.
 * 2. A fresh production database has no tables. `ensureSqliteSchema()`
 *    applies the committed schema SQL (prisma/sqlite-bootstrap.sql, generated
 *    from the current models) exactly once, then records the applied
 *    migration in `_prisma_migrations` so `prisma migrate deploy` stays
 *    coherent. Existing tables and rows are never modified.
 */

const globalForPrisma = globalThis as unknown as {
  fluxpadPrisma?: PrismaClient;
  fluxpadSchemaBootstrap?: Promise<SqliteBootstrapResult | null>;
};

/** True when the configured DATABASE_URL targets a local SQLite file. */
export function isSqliteFileUrl(url: string | undefined): boolean {
  return typeof url === "string" && url.trim().startsWith("file:");
}

/**
 * Resolve a Prisma SQLite `file:` URL to an absolute file URL.
 *
 * Prisma resolves relative `file:` paths against the directory that contains
 * `schema.prisma`. Candidates are probed in this order and the first database
 * file that already exists wins (so records are never orphaned):
 *   1. schema-relative: <cwd>/prisma/<urlPath>
 *   2. cwd-relative:    <cwd>/<urlPath>
 * If neither exists, the schema-relative location is used (Prisma's own
 * convention) and its parent directory is created so SQLite can create the
 * file. Non-file URLs return null.
 */
export function resolveSqliteUrl(
  rawUrl: string | undefined,
  cwd: string = process.cwd(),
): { absolutePath: string; fileUrl: string; existed: boolean } | null {
  if (!isSqliteFileUrl(rawUrl)) return null;
  const raw = (rawUrl as string).trim().slice("file:".length);
  const isWinDrive = /^[A-Za-z]:[\\/]/.test(raw);
  if (path.isAbsolute(raw) || isWinDrive) {
    const abs = path.normalize(raw);
    return { absolutePath: abs, fileUrl: "file:" + abs.replace(/\\/g, "/"), existed: fs.existsSync(abs) };
  }
  const schemaRelative = path.resolve(cwd, "prisma", raw);
  const cwdRelative = path.resolve(cwd, raw);
  const existing = [schemaRelative, cwdRelative].find((p) => fs.existsSync(p));
  const chosen = existing ?? schemaRelative;
  const existed = fs.existsSync(chosen);
  if (!existed) {
    fs.mkdirSync(path.dirname(chosen), { recursive: true });
  }
  return { absolutePath: chosen, fileUrl: "file:" + chosen.replace(/\\/g, "/"), existed };
}

/**
 * Split a SQL script into individual statements. Whole-line `--` comments are
 * preserved inside chunks (SQLite accepts them); chunks that contain no SQL
 * beyond comments are dropped.
 */
export function splitSqlStatements(sql: string): string[] {
  return sql
    .replace(/\r\n/g, "\n")
    .split(/;\s*(?:\n|$)/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.replace(/--[^\n]*/g, "").trim().length > 0);
}

/** Table names created by a SQL script (CREATE TABLE "Name" / CREATE TABLE Name). */
export function tablesInSql(sql: string): string[] {
  return [...sql.matchAll(/CREATE TABLE ["` ]*(\w+)/g)].map((m) => m[1]);
}

/** Prisma error shape for missing tables/models (P2021/P2022) and raw SQLite open failures. */
export function isDatabaseBootError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "P2021" || code === "P2022") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return (
    /does not exist in the current database/i.test(msg) ||
    /Unable to open the database file/i.test(msg) ||
    /no such table/i.test(msg)
  );
}

const REQUIRED_BOOTSTRAP_FILE = path.join(process.cwd(), "prisma", "sqlite-bootstrap.sql");
const INIT_MIGRATION_NAME = "20261013005509_init";
const INIT_MIGRATION_SQL = path.join(process.cwd(), "prisma", "migrations", INIT_MIGRATION_NAME, "migration.sql");

export interface SqliteBootstrapResult {
  /** True when tables were missing and the schema SQL was applied. */
  bootstrapped: boolean;
  /** Tables that were missing before the bootstrap. */
  missing: string[];
  /** Path of the SQLite file the client uses. */
  databaseFile: string;
}

let warnedMissingDatabaseUrl = false;

export function getDb(): PrismaClient | null {
  if (!process.env.DATABASE_URL) {
    if (!warnedMissingDatabaseUrl) {
      warnedMissingDatabaseUrl = true;
      console.error(
        "[db] DATABASE_URL is not set — registry persistence is disabled and registry routes will return 503 until it is configured (see .env.example).",
      );
    }
    return null;
  }
  if (!globalForPrisma.fluxpadPrisma) {
    // SQLite file URLs are resolved to an absolute, existing-writable
    // location before the client is constructed (see resolveSqliteUrl) —
    // this removes the schema-relative path ambiguity that caused
    // "Unable to open the database file" in production.
    if (isSqliteFileUrl(process.env.DATABASE_URL)) {
      const resolved = resolveSqliteUrl(process.env.DATABASE_URL);
      if (resolved) {
        process.env.DATABASE_URL = resolved.fileUrl;
      }
    }
    globalForPrisma.fluxpadPrisma = new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
    if (isSqliteFileUrl(process.env.DATABASE_URL)) {
      // Self-heal a fresh production database: create missing tables exactly
      // once. Failures are logged and surfaced as honest 503s by the routes.
      void ensureSqliteSchema();
    }
  }
  return globalForPrisma.fluxpadPrisma;
}

async function runSqliteBootstrap(client: PrismaClient, databaseFile: string): Promise<SqliteBootstrapResult> {
  const existing = await client.$queryRawUnsafe<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  const have = new Set(existing.map((r) => r.name));

  const sql = fs.existsSync(REQUIRED_BOOTSTRAP_FILE)
    ? fs.readFileSync(REQUIRED_BOOTSTRAP_FILE, "utf8")
    : fs.existsSync(INIT_MIGRATION_SQL)
      ? fs.readFileSync(INIT_MIGRATION_SQL, "utf8")
      : "";
  const required = tablesInSql(sql);
  const missing = required.filter((t) => !have.has(t));
  if (required.length === 0 || missing.length === 0) {
    return { bootstrapped: false, missing: [], databaseFile };
  }

  for (const statement of splitSqlStatements(sql)) {
    try {
      await client.$executeRawUnsafe(statement);
    } catch (err) {
      // Already-existing objects are tolerated (partial bootstrap or a DB
      // created before this guard existed). Anything else is fatal.
      const msg = err instanceof Error ? err.message : String(err);
      if (/already exists/i.test(msg)) continue;
      throw err;
    }
  }

  // Keep Prisma's migration bookkeeping coherent: record the committed init
  // migration as applied so a future `prisma migrate deploy` is a no-op.
  let checksum = "";
  try {
    checksum = createHash("sha256").update(fs.readFileSync(INIT_MIGRATION_SQL)).digest("hex");
  } catch {
    checksum = createHash("sha256").update(sql).digest("hex");
  }
  await client.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "_prisma_migrations" ("id" TEXT NOT NULL PRIMARY KEY, "checksum" TEXT NOT NULL, "finished_at" DATETIME, "migration_name" TEXT NOT NULL, "logs" TEXT, "rolled_back_at" DATETIME, "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "applied_steps_count" INTEGER NOT NULL DEFAULT 0)',
  );
  const nowIso = new Date().toISOString();
  await client.$executeRawUnsafe(
    `INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
     SELECT ${JSON.stringify(crypto.randomUUID())}, ${JSON.stringify(checksum)}, ${JSON.stringify(nowIso)}, ${JSON.stringify(INIT_MIGRATION_NAME)}, 'bootstrapped by FluxPad runtime (schema was missing)', NULL, ${JSON.stringify(nowIso)}, 1
     WHERE NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE "migration_name" = ${JSON.stringify(INIT_MIGRATION_NAME)})`,
  );

  console.error(
    `[db] SQLite schema bootstrapped — created missing tables: ${missing.join(", ")} (database: ${databaseFile}). Existing records were preserved.`,
  );
  return { bootstrapped: true, missing, databaseFile };
}

/**
 * Ensure the SQLite database exists with the current schema. Single-flight
 * per process; only meaningful for `file:` URLs. Called from instrumentation
 * at server start so production traffic never hits a missing-table error.
 */
export async function ensureSqliteSchema(): Promise<SqliteBootstrapResult | null> {
  if (!isSqliteFileUrl(process.env.DATABASE_URL)) return null;
  if (!globalForPrisma.fluxpadSchemaBootstrap) {
    const bootstrap = (async () => {
      const client = getDb();
      if (!client) return null;
      const fileUrl = process.env.DATABASE_URL ?? "";
      return runSqliteBootstrap(client, fileUrl.replace(/^file:/, ""));
    })();
    globalForPrisma.fluxpadSchemaBootstrap = bootstrap;
    bootstrap.catch((err) => {
      console.error(
        "[db] SQLite schema bootstrap FAILED — registry routes will report the error until this is resolved:",
        err,
      );
    });
  }
  return globalForPrisma.fluxpadSchemaBootstrap ?? null;
}
