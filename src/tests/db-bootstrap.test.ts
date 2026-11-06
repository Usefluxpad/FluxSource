/**
 * SQLite production bootstrap helpers — pure-function tests.
 *
 * These cover the fix for the live production failure where a relative
 * SQLite DATABASE_URL resolved to a non-existent directory ("Error code 14:
 * Unable to open the database file"), taking the registry provider and the
 * registry APIs down.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSqliteUrl, splitSqlStatements, tablesInSql, isDatabaseBootError } from "../lib/db";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fluxpad-dbtest-"));
  tmpDirs.push(dir);
  return dir;
}

describe("resolveSqliteUrl", () => {
  it("returns null for non-file URLs (e.g. PostgreSQL)", () => {
    expect(resolveSqliteUrl("postgresql://user:pass@host/db")).toBeNull();
    expect(resolveSqliteUrl(undefined)).toBeNull();
  });

  it("prefers an existing schema-relative database file (records never orphaned)", () => {
    const cwd = tmpRoot();
    const schemaRelative = path.join(cwd, "prisma", "prisma", "dev.db");
    fs.mkdirSync(path.dirname(schemaRelative), { recursive: true });
    fs.writeFileSync(schemaRelative, "sqlite");
    const r = resolveSqliteUrl("file:./prisma/dev.db", cwd);
    expect(r).not.toBeNull();
    expect(r!.existed).toBe(true);
    expect(r!.absolutePath.toLowerCase()).toBe(schemaRelative.toLowerCase());
    expect(r!.fileUrl.startsWith("file:")).toBe(true);
  });

  it("falls back to cwd-relative when a cwd-relative file exists", () => {
    const cwd = tmpRoot();
    const cwdRelative = path.join(cwd, "prisma", "dev.db");
    fs.mkdirSync(path.dirname(cwdRelative), { recursive: true });
    fs.writeFileSync(cwdRelative, "sqlite");
    const r = resolveSqliteUrl("file:./prisma/dev.db", cwd);
    expect(r!.existed).toBe(true);
    expect(r!.absolutePath.toLowerCase()).toBe(cwdRelative.toLowerCase());
  });

  it("defaults to the schema-relative location for a fresh database and creates its directory", () => {
    const cwd = tmpRoot();
    const r = resolveSqliteUrl("file:./prisma/dev.db", cwd);
    expect(r!.existed).toBe(false);
    const expected = path.join(cwd, "prisma", "prisma", "dev.db");
    expect(r!.absolutePath.toLowerCase()).toBe(expected.toLowerCase());
    // The parent directory was created so SQLite can create the file.
    expect(fs.existsSync(path.dirname(expected))).toBe(true);
    expect(r!.fileUrl.startsWith("file:")).toBe(true);
  });

  it("passes absolute file paths through unchanged", () => {
    const cwd = tmpRoot();
    const abs = path.join(tmpRoot(), "absolute", "prod.db");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "sqlite");
    const r = resolveSqliteUrl("file:" + abs.replace(/\\\\/g, "/"), cwd);
    expect(r!.existed).toBe(true);
    expect(r!.absolutePath.toLowerCase()).toBe(abs.toLowerCase());
  });
});

describe("splitSqlStatements", () => {
  it("splits on statement-terminating semicolons and drops comment-only chunks", () => {
    const sql = [
      "-- CreateTable",
      'CREATE TABLE "Launch" ("id" TEXT NOT NULL PRIMARY KEY);',
      "",
      "-- CreateIndex",
      'CREATE INDEX "Launch_status_idx" ON "Launch"("status");',
      "-- trailing comment with no SQL",
    ].join("\n");
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('CREATE TABLE "Launch"');
    expect(statements[1]).toContain('CREATE INDEX "Launch_status_idx"');
  });

  it("handles CRLF scripts", () => {
    const statements = splitSqlStatements('CREATE TABLE "A" (id TEXT);\r\nCREATE TABLE "B" (id TEXT);\r\n');
    expect(statements).toHaveLength(2);
  });
});

describe("tablesInSql", () => {
  it("extracts quoted and unquoted table names", () => {
    const tables = tablesInSql('CREATE TABLE "Launch" (id TEXT); CREATE TABLE UploadAudit (id TEXT);');
    expect(tables).toEqual(["Launch", "UploadAudit"]);
  });
});

describe("isDatabaseBootError", () => {
  it("detects the production failure signatures", () => {
    expect(isDatabaseBootError({ code: "P2021" })).toBe(true);
    expect(isDatabaseBootError({ code: "P2022" })).toBe(true);
    expect(isDatabaseBootError(new Error("Error querying the database: Error code 14: Unable to open the database file"))).toBe(true);
    expect(isDatabaseBootError(new Error("The table `main.Launch` does not exist in the current database."))).toBe(true);
    expect(isDatabaseBootError(new Error("Some other failure"))).toBe(false);
  });
});
