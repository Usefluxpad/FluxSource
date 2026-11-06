import { Connection, PublicKey } from "@solana/web3.js";
import { PUMP_AMM_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { WSOL_MINT } from "./pump-constants";
import type { DiscoveredToken, SourceFeed } from "./types";

// We read baseMint(0..32), quoteMint(32..64), baseVault(96..128),
// quoteVault(128..160) — 160 bytes covers everything we decode.
const POOL_SLICE = { offset: 43, length: 160 };
const OFF = { quoteMint: 32, lpMint: 64, baseVault: 96, quoteVault: 128, lpSupply: 160, coinCreator: 168 };

/** How long the decoded pool-address list is reused before rescanning. The
 * GPA scan is the most expensive call (it walks every pool on the program),
 * so it only needs to run when NEW pools might exist — not on every refresh. */
const POOL_LIST_TTL_MS = 10 * 60_000;
/** Max accounts per getMultipleAccountsInfo call (provider-safe bound). */
const MULTI_BATCH = 100;

// ---------------------------------------------------------------------------
// RPC-volume optimization state (module-level; process lifetime).
// ---------------------------------------------------------------------------

interface PoolSlice {
  address: string;
  decode: NonNullable<ReturnType<typeof decodePoolSlice>>;
}
let poolListCache: { slices: PoolSlice[]; fetchedAt: number } | null = null;
/** Mint decimals are immutable — cached for the process lifetime. */
const mintDecimalsCache = new Map<string, number>();
/** Measured RPC usage of the last fetchPumpswapPools run. */
let lastRunStats = { gpaCalls: 0, multiCalls: 0, accountsRead: 0, poolListFromCache: false, pools: 0 };

export function lastPumpswapRpcStats() {
  return { ...lastRunStats };
}

function readPubkey(buf: Buffer, off: number): string | null {
  if (buf.length < off + 32) return null;
  try {
    return new PublicKey(buf.subarray(off, off + 32)).toBase58();
  } catch {
    return null;
  }
}

export function decodePoolSlice(buf: Buffer): {
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
} | null {
  const baseMint = readPubkey(buf, 0);
  const quoteMint = readPubkey(buf, OFF.quoteMint);
  const baseVault = readPubkey(buf, OFF.baseVault);
  const quoteVault = readPubkey(buf, OFF.quoteVault);
  if (!baseMint || !quoteMint || !baseVault || !quoteVault) return null;
  return { baseMint, quoteMint, baseVault, quoteVault };
}
/** SPL token account amount (u64 LE @64) and mint decimals (u8 @44). */
export function decodeTokenAccountAmount(buf: Buffer): number | null {
  if (buf.length < 72) return null;
  return Number(buf.readBigUInt64LE(64));
}

export function decodeMintDecimals(buf: Buffer): number | null {
  if (buf.length < 45) return null;
  return buf[44];
}

/** Spot price from pool reserves (decimal-adjusted), or null when unknown. */
export function poolPrice(
  baseAmount: number | null,
  quoteAmount: number | null,
  baseDecimals: number | null,
  quoteDecimals: number | null,
): number | null {
  if (baseAmount == null || quoteAmount == null || baseDecimals == null || quoteDecimals == null) return null;
  if (baseAmount <= 0) return null;
  return quoteAmount / 10 ** quoteDecimals / (baseAmount / 10 ** baseDecimals);
}

/** Test hook: clear the module-level caches. */
export function resetPumpswapCaches(): void {
  poolListCache = null;
  mintDecimalsCache.clear();
  lastRunStats = { gpaCalls: 0, multiCalls: 0, accountsRead: 0, poolListFromCache: false, pools: 0 };
}

/** Bounded await: rejects with a labeled timeout error instead of hanging. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * RPC failure shapes a fallback transport can plausibly recover from
 * (throughput limits, provider 5xx, transport faults). Permanent protocol
 * errors (e.g. invalid account shape) are never retried elsewhere.
 */
function isRecoverableRpcError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return /\b429\b|too many requests|compute units|server error|\b5\d\d\b|timed? ?out|aborted|econnreset|etimedout|fetch failed|network/i.test(
    raw.replace(/[_-]/g, " "),
  );
}

interface PoolAccount {
  pubkey: PublicKey;
  account: { data: Buffer };
}

/**
 * Pool-list acquisition with a bounded fallback tier.
 *
 * The getProgramAccounts scan over the PumpSwap AMM program is by far the
 * most expensive discovery call (measured 2026-10: ~9.6k live pools), and
 * throughput-limited providers reject it outright with 429 even when every
 * other RPC succeeds. Tiering:
 *   1. the configured provider connection (short timeout, single attempt —
 *      a rejection is instant and consumes no further budget), then
 *   2. the documented public cluster endpoint (generous timeout, one
 *      bounded retry for transient transport faults).
 * Identical account shape and decode either way — the data is not
 * differentiated by transport.
 */
async function fetchPoolAccounts(
  connection: Connection,
  fallbackConnection: Connection | null,
): Promise<PoolAccount[]> {
  const gpaConfig = {
    commitment: "confirmed" as const,
    encoding: "base64" as const,
    filters: [{ dataSize: 261 }], // documented Pool size
    dataSlice: POOL_SLICE,
  };
  try {
    return (await withTimeout(
      connection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, gpaConfig),
      20_000,
      "getProgramAccounts",
    )) as unknown as PoolAccount[];
  } catch (err) {
    if (!fallbackConnection || !isRecoverableRpcError(err)) throw err;
  }
  try {
    return (await withTimeout(
      fallbackConnection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, gpaConfig),
      45_000,
      "getProgramAccounts (public)",
    )) as unknown as PoolAccount[];
  } catch (err) {
    if (!isRecoverableRpcError(err)) throw err;
    // One bounded retry for a transient transport fault on the public tier.
    await new Promise((r) => setTimeout(r, 1_500));
    return (await withTimeout(
      fallbackConnection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, gpaConfig),
      45_000,
      "getProgramAccounts (public retry)",
    )) as unknown as PoolAccount[];
  }
}

export async function fetchPumpswapPools(
  connection: Connection,
  opts: { maxPools?: number; now?: number; fallbackConnection?: Connection | null } = {},
): Promise<SourceFeed> {
  const now = opts.now ?? Date.now();
  const maxPools = Math.min(opts.maxPools ?? 60, 120);
  lastRunStats = { gpaCalls: 0, multiCalls: 0, accountsRead: 0, poolListFromCache: false, pools: 0 };
  try {
    // 1) Pool list — reused for 10 minutes; the expensive getProgramAccounts
    //    scan only runs when the cached list is stale.
    let slices: PoolSlice[];
    if (poolListCache && now - poolListCache.fetchedAt < POOL_LIST_TTL_MS) {
      slices = poolListCache.slices;
      lastRunStats.poolListFromCache = true;
    } else {
      const accounts = await fetchPoolAccounts(connection, opts.fallbackConnection ?? null);
      lastRunStats.gpaCalls = 1;
      slices = accounts
        .slice(0, maxPools)
        .map((a) => ({ address: a.pubkey.toBase58(), decode: decodePoolSlice(a.account.data as Buffer) }))
        .filter((s): s is PoolSlice => s.decode !== null);
      poolListCache = { slices, fetchedAt: now };
    }
    lastRunStats.pools = slices.length;

    // 2) Vault balances every refresh (they change); mint decimals only on
    //    first sight (immutable) — this halves the keys per pool after warm-up.
    const vaultKeys: string[] = [];
    const mintKeysNeedingFetch: string[] = [];
    for (const s of slices) {
      vaultKeys.push(s.decode.baseVault, s.decode.quoteVault);
      if (!mintDecimalsCache.has(s.decode.baseMint)) mintKeysNeedingFetch.push(s.decode.baseMint);
      if (!mintDecimalsCache.has(s.decode.quoteMint)) mintKeysNeedingFetch.push(s.decode.quoteMint);
    }

    const vaultAmounts = new Map<string, number | null>();
    const batchKeys = (keys: string[]): string[][] => {
      const out: string[][] = [];
      for (let i = 0; i < keys.length; i += MULTI_BATCH) out.push(keys.slice(i, i + MULTI_BATCH));
      return out;
    };
    for (const chunk of batchKeys(vaultKeys)) {
      const infos = await withTimeout(
        connection.getMultipleAccountsInfo(chunk.map((k) => new PublicKey(k))),
        15_000,
        "getMultipleAccountsInfo (vaults)",
      );
      lastRunStats.multiCalls++;
      lastRunStats.accountsRead += infos.length;
      chunk.forEach((key, idx) => {
        const info = infos[idx];
        vaultAmounts.set(key, info?.data ? decodeTokenAccountAmount(info.data as Buffer) : null);
      });
    }
    for (const chunk of batchKeys(mintKeysNeedingFetch)) {
      const infos = await withTimeout(
        connection.getMultipleAccountsInfo(chunk.map((k) => new PublicKey(k))),
        15_000,
        "getMultipleAccountsInfo (mints)",
      );
      lastRunStats.multiCalls++;
      lastRunStats.accountsRead += infos.length;
      chunk.forEach((key, idx) => {
        const info = infos[idx];
        const dec = info?.data ? decodeMintDecimals(info.data as Buffer) : null;
        if (dec != null) mintDecimalsCache.set(key, dec);
      });
    }

    const tokens: DiscoveredToken[] = slices.map((s) => {
      // Layout (verified against live PumpSwap accounts, 2026-10):
      //   baseMint @ slice+0, quoteMint @ slice+32, baseVault @ slice+96
      //   (holds baseMint's balance), quoteVault @ slice+128 (holds
      //   quoteMint's balance). Pump.fun pools store WSOL on either side
      //   depending on how the pair was created, so the discovered token is
      //   the NON-WSOL side when one side is WSOL; pump-coin-quoted pools
      //   resolve to their base side. This is what keeps pool records
      //   distinct per token (the previous code reported the base side,
      //   collapsing every SOL-quoted pool into one WSOL record).
      const isWsolBase = s.decode.baseMint === WSOL_MINT;
      const tokenMint = isWsolBase ? s.decode.quoteMint : s.decode.baseMint;
      const tokenVault = isWsolBase ? s.decode.quoteVault : s.decode.baseVault;
      const quoteVault = isWsolBase ? s.decode.baseVault : s.decode.quoteVault;
      const quoteMint = isWsolBase ? s.decode.baseMint : s.decode.quoteMint;
      const tokenDec = mintDecimalsCache.get(tokenMint) ?? null;
      const quoteDec = mintDecimalsCache.get(quoteMint) ?? null;
      const tokenAmount = vaultAmounts.get(tokenVault) ?? null;
      const quoteAmount = vaultAmounts.get(quoteVault) ?? null;
      const isWsol = quoteMint === WSOL_MINT;
      return {
        mint: tokenMint,
        name: "Unknown",
        symbol: "???",
        imageUrl: null,
        source: "pumpfun.pool",
        status: "pool",
        createdAt: null, // Pool accounts carry no timestamp — UI shows "first seen"
        firstSeenAt: now,
        fetchedAt: now,
        stale: false,
        priceQuote: poolPrice(tokenAmount, quoteAmount, tokenDec, quoteDec),
        quoteSymbol: isWsol ? "SOL" : "quote",
        liquidityQuote: quoteDec != null && quoteAmount != null ? quoteAmount / 10 ** quoteDec : null,
        change24h: null,
        volume24hUsd: null,
        marketCapUsd: null,
        valuation: null,
        curveProgress: null,
        poolAddress: s.address,
        signature: null,
        creatorWallet: null, // creator not included in the bounded slice
        fluxpadLaunchId: null,
        provenance: "pumpswap-pool(gpa)",
      };
    });
    return { source: "pumpfun.pool", tokens, fetchedAt: now, ok: true, error: null };
  } catch (err) {
    return {
      source: "pumpfun.pool",
      tokens: [],
      fetchedAt: now,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
