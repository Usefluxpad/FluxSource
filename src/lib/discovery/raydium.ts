/**
 * Raydium CPMM pool adapter — official documented REST path (API v3).
 *
 * `GET /pools/info/list?poolType=…&sortField=…&sortType=…&page=…&size=…` on
 * api-v3[-devnet].raydium.io; SOL→USD via the documented
 * `GET /mint/price?mints=…`. Responses are edge-cached 5–60s (documented) and
 * records carry fetchedAt + provenance. Fields are normalized defensively;
 * missing metrics stay null (never fabricated).
 */
import { fetchJson } from "./http";
import { WSOL_MINT } from "./pump-constants";
import type { DiscoveredToken, SourceFeed } from "./types";

export function apiV3Host(cluster: string): string {
  return cluster === "mainnet-beta" ? "https://api-v3.raydium.io" : "https://api-v3-devnet.raydium.io";
}

type Obj = Record<string, unknown>;

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

/** SOL→USD via the documented /mint/price endpoint (Raydium API v3). */
export async function fetchSolPriceUsd(cluster: string): Promise<number | null> {
  try {
    const payload = await fetchJson<Obj>(`${apiV3Host(cluster)}/mint/price?mints=${WSOL_MINT}`);
    const data = (pick(payload, "data") ?? {}) as Obj;
    return num(data[WSOL_MINT]);
  } catch {
    return null; // USD stays N/A when the documented price source is down
  }
}

/** Normalize one API v3 PoolInfoItem defensively. */
export function normalizeCpmmPool(raw: Obj, now: number, cluster: string, solPriceUsd: number | null): DiscoveredToken | null {
  const id = str(pick(raw, "id", "poolId"));
  const mint1 = (pick(raw, "mint1", "mintA") ?? {}) as Obj;
  const mint2 = (pick(raw, "mint2", "mintB") ?? {}) as Obj;
  const base = str(pick(mint1, "address"));
  if (!id || !base) return null;
  const quote = str(pick(mint2, "address")) ?? "";
  const isWsol = quote === WSOL_MINT;
  const day = (pick(raw, "day") ?? {}) as Obj;
  const price = num(pick(raw, "price"));
  const priceQuote = isWsol ? price : null; // only SOL-paired pools get a SOL price here
  const liquidityQuote = isWsol ? num(pick(raw, "tvl")) : null; // tvl is USD; only meaningful as SOL when solPrice known
  const solLiquidity = isWsol && solPriceUsd && solPriceUsd > 0 ? (num(pick(raw, "tvl")) ?? 0) / solPriceUsd : null;
  return {
    mint: base,
    name: str(pick(mint1, "name")) ?? "Unknown",
    symbol: str(pick(mint1, "symbol")) ?? "???",
    imageUrl: str(pick(mint1, "logoURI", "logo")),
    source: "raydium.cpmm",
    status: "pool",
    createdAt: num(pick(raw, "openTime", "createTime", "createdAt")),
    firstSeenAt: now,
    fetchedAt: now,
    stale: false,
    priceQuote,
    quoteSymbol: isWsol ? "SOL" : "quote",
    liquidityQuote: solLiquidity ?? liquidityQuote,
    change24h: num(pick(day, "priceChange", "change24h")),
    volume24hUsd: num(pick(day, "volume", "volumeQuote", "volumeUsd")),
    marketCapUsd: null, // pool item carries no verified supply — not fabricated
    valuation: null,
    curveProgress: null,
    poolAddress: id,
    signature: null,
    creatorWallet: null,
    fluxpadLaunchId: null,
    provenance: `raydium-api-v3(${cluster})`,
  };
}

export async function fetchRaydiumCpmmPools(
  cluster: string,
  opts: { page?: number; size?: number; sortField?: string; now?: number } = {},
): Promise<SourceFeed> {
  const now = opts.now ?? Date.now();
  const page = Math.max(1, opts.page ?? 1);
  const size = Math.min(Math.max(1, opts.size ?? 60), 100);
  const solPriceUsd = await fetchSolPriceUsd(cluster);
  try {
    const payload = await fetchJson<Obj>(
      // Documented API v3 parameters (api-reference/api-v3/overview.mdx):
      // poolType enum has no "cpmm" — constant-product pools are "standard";
      // the sort parameter is "poolSortField" and page size is "pageSize".
      `${apiV3Host(cluster)}/pools/info/list?poolType=standard&poolSortField=liquidity&sortType=desc&page=${page}&pageSize=${size}`,
    );
    const data = (pick(payload, "data") ?? {}) as Obj;
    const rows = Array.isArray(data.data) ? (data.data as Obj[]) : [];
    const tokens = rows
      .map((r) => normalizeCpmmPool(r, now, cluster, solPriceUsd))
      .filter((t): t is DiscoveredToken => t !== null);
    return { source: "raydium.cpmm", tokens, fetchedAt: now, ok: true, error: null };
  } catch (err) {
    return {
      source: "raydium.cpmm",
      tokens: [],
      fetchedAt: now,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
