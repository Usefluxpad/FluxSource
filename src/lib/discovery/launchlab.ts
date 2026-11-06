/**
 * Raydium LaunchLab discovery adapter — official documented REST path.
 *
 * Uses the LaunchLab Mint API (docs: raydium-docs-v1, api-reference/
 * launch-mint-v1): `GET /get/list?sort=new|marketCap|lastTrade|hotToken` for
 * discovery and `GET /get/search?text=` for search. Devnet host
 * `launch-mint-v1-devnet.raydium.io` exists alongside mainnet.
 *
 * The API is edge-cached 5–60s (documented); records are labeled with
 * fetchedAt and provenance "raydium-launch-mint-api(<cluster>)" and may be
 * flagged stale by the aggregator. The response schema is not typed in the
 * OpenAPI spec, so fields are normalized defensively: only fields actually
 * present in the response are surfaced, everything else stays null.
 */
import { fetchJson } from "./http";
import type { DiscoveredToken, SourceFeed } from "./types";

export function launchMintHost(cluster: string): string {
  return cluster === "mainnet-beta"
    ? "https://launch-mint-v1.raydium.io"
    : "https://launch-mint-v1-devnet.raydium.io";
}

type Obj = Record<string, unknown>;

/** Tolerant field access for an untyped provider response. */
function pick(obj: Obj | null | undefined, ...keys: string[]): unknown {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Normalize one LaunchLab mint record (defensive; nulls stay null). */
export function normalizeLaunchLabMint(raw: Obj, now: number, cluster: string): DiscoveredToken | null {
  const mint = str(pick(raw, "mint", "address", "mintAddress"));
  if (!mint) return null;
  const status = str(pick(raw, "status", "state")) ?? "unknown";
  // LaunchLab statuses (documented lifecycle): unlaunched/locked (curve),
  // migrate/launch (graduated). Map conservatively.
  const graduated = /migrat|launch/i.test(status);
  return {
    mint,
    name: str(pick(raw, "name", "tokenName")) ?? "Unknown",
    symbol: str(pick(raw, "symbol", "ticker")) ?? "???",
    imageUrl: str(pick(raw, "icon", "logoURI", "image", "logoUrl", "uri")),
    source: "launchlab.curve",
    status: graduated ? "graduated" : "curve",
    createdAt: num(pick(raw, "createAt", "createTime", "createdAt", "timestamp")),
    firstSeenAt: now,
    fetchedAt: now,
    stale: false,
    priceQuote: num(pick(raw, "price", "priceQuote")),
    quoteSymbol: str(pick(raw, "quoteSymbol")) ?? "SOL",
    liquidityQuote: num(pick(raw, "liquidity", "liquidityQuote")),
    change24h: num(pick(raw, "priceChange24h", "change24h", "priceChange1d")),
    volume24hUsd: num(pick(raw, "volume24h", "volumeUsd24h")),
    marketCapUsd: num(pick(raw, "marketCap", "mcUsd")),
    valuation: num(pick(raw, "marketCap", "mcUsd")) != null ? "market-cap" : null,
    curveProgress: num(pick(raw, "progress", "curveProgress", "launchProgress")),
    poolAddress: str(pick(raw, "poolAddress", "poolId", "cpmmPool")),
    signature: null,
    creatorWallet: str(pick(raw, "creator", "creatorAddress", "owner")),
    fluxpadLaunchId: null,
    provenance: `raydium-launch-mint-api(${cluster})`,
  };
}

/** Accepts arrays or common envelope shapes and yields item objects. */
export function extractItems(payload: unknown): Obj[] {
  if (Array.isArray(payload)) return payload as Obj[];
  if (payload && typeof payload === "object") {
    const p = payload as Obj;
    for (const key of ["data", "list", "mints", "items", "result"]) {
      const v = p[key];
      if (Array.isArray(v)) return v as Obj[];
      if (v && typeof v === "object") {
        const inner = v as Obj;
        for (const k2 of ["list", "mints", "data", "items"]) {
          if (Array.isArray(inner[k2])) return inner[k2] as Obj[];
        }
      }
    }
  }
  return [];
}

export async function fetchLaunchLabMints(
  cluster: string,
  opts: { sort?: "new" | "marketCap" | "lastTrade" | "hotToken"; limit?: number; now?: number } = {},
): Promise<SourceFeed> {
  const now = opts.now ?? Date.now();
  const sort = opts.sort ?? "new";
  const host = launchMintHost(cluster);
  try {
    const payload = await fetchJson<unknown>(`${host}/get/list?sort=${encodeURIComponent(sort)}`);
    const items = extractItems(payload).slice(0, Math.min(opts.limit ?? 60, 100));
    const tokens = items
      .map((it) => normalizeLaunchLabMint(it, now, cluster))
      .filter((t): t is DiscoveredToken => t !== null);
    return { source: "launchlab.curve", tokens, fetchedAt: now, ok: true, error: null };
  } catch (err) {
    return {
      source: "launchlab.curve",
      tokens: [],
      fetchedAt: now,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Search via the documented /get/search endpoint (used by the Explore page). */
export async function searchLaunchLabMints(cluster: string, text: string, now = Date.now()): Promise<DiscoveredToken[]> {
  const host = launchMintHost(cluster);
  const payload = await fetchJson<unknown>(
    `${host}/get/search?text=${encodeURIComponent(text)}`,
    { retries: 1 },
  );
  return extractItems(payload)
    .map((it) => normalizeLaunchLabMint(it, now, cluster))
    .filter((t): t is DiscoveredToken => t !== null)
    .slice(0, 30);
}
