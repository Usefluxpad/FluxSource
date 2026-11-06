/**
 * Live-market snapshot persistence.
 *
 * Deliberately file-based (data/live-market.json, atomic tmp+rename) instead
 * of touching the app's SQLite/Prisma store: the launch registry schema stays
 * 100% untouched (no migration, no reset risk), while high-frequency market
 * time-series gets its own cheap durable store. Limitations are surfaced
 * honestly by the engine (`historyPartial`) rather than hidden.
 */
import { mkdirSync, renameSync, writeFileSync, existsSync, readFileSync, statSync } from "fs";
import path from "path";
import type { LiveTokenIdentity, LiveTrade } from "./types";

export interface SnapshotData {
  version: 1;
  savedAt: number;
  solUsd: { usd: number; source: string } | null;
  tokens: LiveTokenIdentity[];
  trades: Record<string, LiveTrade[]>;
}

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "live-market.json");

export function saveSnapshot(snap: SnapshotData): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(snap), "utf8");
    renameSync(tmp, FILE);
  } catch {
    // Persistence best-effort; the engine keeps running from memory.
  }
}

/** Returns null when no valid snapshot exists (fresh start). */
export function loadSnapshot(): SnapshotData | null {
  try {
    if (!existsSync(FILE)) return null;
    const raw = readFileSync(FILE, "utf8");
    const snap = JSON.parse(raw) as SnapshotData;
    if (snap.version !== 1 || typeof snap.savedAt !== "number") return null;
    // Ignore snapshots older than 25h — windows they could feed are gone.
    if (Date.now() - snap.savedAt > 25 * 60 * 60_000) return null;
    return snap;
  } catch {
    return null;
  }
}

/** Snapshot age in ms (null when absent) — used by health reporting. */
export function snapshotAgeMs(): number | null {
  try {
    return Date.now() - statSync(FILE).mtimeMs;
  } catch {
    return null;
  }
}
