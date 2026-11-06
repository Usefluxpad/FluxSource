/**
 * Pump.fun bonding-curve discovery adapter — on-chain, documented path only.
 *
 * Data path (all documented in pump-fun/pump-public-docs):
 * 1. New/active program activity: bounded `getSignaturesForAddress` against
 *    the Pump program (deployed on both mainnet and devnet) with an
 *    incremental cursor; each unseen signature is fetched once with
 *    `getTransaction` and its `Program data:` (Anchor event) logs are decoded
 *    with the official @pump-fun/pump-sdk (`decodeCreateEventBc`).
 * 2. Curve state: `OnlinePumpSdk.fetchBondingCurve(mint)` decodes the
 *    documented BondingCurve account; progress and curve price are computed
 *    from its reserves against the live `Global` account values.
 * 3. Graduation: the curve's `complete` flag and `CompleteEvent` are the
 *    documented signals; PumpSwap-side verification happens in pumpswap.ts.
 *
 * No Pump.fun website/frontend API is used. Prices on a SOL-quoted curve are
 * the documented constant-product price (virtual quote / virtual token).
 * Volume/txn counts are NOT synthesized from a single snapshot — they stay
 * null here.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import type BN from "bn.js";
import { PumpSdk, OnlinePumpSdk, PUMP_PROGRAM_ID, type CreateEventBc } from "@pump-fun/pump-sdk";
import type { DiscoveredToken, SourceFeed } from "./types";
import { TOKEN_DECIMALS_PUMP, WSOL_MINT } from "./pump-constants";

const pumpSdk = new PumpSdk();

/** Anchor event payloads may arrive with a 0/8/16-byte prefix; try each. */
export function tryDecodeEvent<T>(decode: (buf: Buffer) => T, buf: Buffer): T | null {
  for (const cut of [0, 8, 16]) {
    const slice = cut === 0 ? buf : buf.subarray(cut);
    try {
      return decode(slice);
    } catch {
      // try next prefix length
    }
  }
  return null;
}

/** Extract all anchor event payloads ("Program data: <base64>") from a tx. */
export function extractProgramDataLogs(logMessages: string[] | null | undefined): Buffer[] {
  if (!logMessages) return [];
  return logMessages
    .filter((l) => l.startsWith("Program data: "))
    .map((l) => Buffer.from(l.slice("Program data: ".length), "base64"));
}

export function bnToNumber(bn: BN | undefined | null): number | null {
  if (!bn) return null;
  try {
    return Number(bn.toString());
  } catch {
    return null;
  }
}

/**
 * Curve price in the quote asset per token (pump token = 6 decimals, SOL =
 * 9 decimals): virtual quote reserves / virtual token reserves.
 */
export function curvePriceSol(
  virtualQuote: BN | undefined,
  virtualToken: BN | undefined,
): number | null {
  const q = bnToNumber(virtualQuote);
  const t = bnToNumber(virtualToken);
  if (q == null || t == null || t === 0) return null;
  return q / 1e9 / (t / 1e6);
}

/** Progress from documented curve state against the live Global snapshot. */
export function curveProgress(
  realTokenReserves: number | null,
  initialRealTokenReserves: number | null,
): number | null {
  if (realTokenReserves == null || initialRealTokenReserves == null) return null;
  if (initialRealTokenReserves <= 0) return null;
  const pct = (1 - realTokenReserves / initialRealTokenReserves) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, pct));
}

interface PumpGlobals {
  initialRealTokenReserves: number;
  tokenTotalSupply: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Detect RPC rate limiting (public endpoints return 429 / "Too Many Requests"). */
export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message}` : String(err ?? "");
  return /\b429\b|Too Many Requests|rate limit/i.test(msg);
}

/**
 * Fetch one transaction with bounded exponential backoff + jitter when the
 * RPC rate-limits. Never retries without delay; gives up after 3 attempts
 * and the caller simply skips that signature this round (honest omission —
 * the incremental cursor will not retry it as "fresh" again).
 */
export async function fetchTxWithBackoff(
  connection: Connection,
  signature: string,
  attempts = 3,
): Promise<{ logMessages: string[] | null } | null> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      // Exponential backoff with jitter: ~500ms, ~1000ms (+0-250ms jitter).
      const backoff = 500 * 2 ** (i - 1) + Math.floor(Math.random() * 250);
      await sleep(backoff);
    }
    try {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      return tx ? { logMessages: tx.meta?.logMessages ?? null } : null;
    } catch (err) {
      if (!isRateLimitError(err) || i === attempts - 1) return null;
      // rate-limited → back off and retry
    }
  }
  return null;
}


/** Global fields needed for honest progress math — read live, never hardcoded. */
export async function fetchPumpGlobals(connection: Connection): Promise<PumpGlobals | null> {
  try {
    const online = new OnlinePumpSdk(connection);
    const g = await online.fetchGlobal();
    const initial = bnToNumber(g.initialRealTokenReserves);
    const supply = bnToNumber(g.tokenTotalSupply);
    if (initial == null || supply == null) return null;
    return { initialRealTokenReserves: initial, tokenTotalSupply: supply };
  } catch {
    return null;
  }
}
export interface PumpScanResult {
  feed: SourceFeed;
  scannedMints: string[];
}

/**
 * Bounded incremental scan of Pump program activity. `cursor` maps a
 * signature to its first-seen timestamp and is capped to keep memory bounded.
 */
export async function scanPumpProgram(
  connection: Connection,
  cursor: Map<string, number>,
  opts: { limit?: number; now?: number } = {},
): Promise<PumpScanResult> {
  const now = opts.now ?? Date.now();
  const limit = Math.min(opts.limit ?? 20, 50);
  const tokens: DiscoveredToken[] = [];
  const scannedMints: string[] = [];
  try {
    const sigs = await connection.getSignaturesForAddress(PUMP_PROGRAM_ID, { limit }, "confirmed");
    const fresh = sigs.filter((s) => s.err === null && !cursor.has(s.signature));
    for (const s of sigs) cursor.set(s.signature, now);
    // Bounded cursor: keep the 250 most recent signatures only.
    if (cursor.size > 500) {
      const entries = [...cursor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 250);
      cursor.clear();
      for (const [k, v] of entries) cursor.set(k, v);
    }
    for (const s of fresh.slice(0, limit)) {
      // Paced sequential fetch — never concurrent, backs off on 429.
      const tx = await fetchTxWithBackoff(connection, s.signature);
      if (!tx?.logMessages) continue;
      const logMessages = tx.logMessages;
      for (const buf of extractProgramDataLogs(logMessages)) {
        const ev = tryDecodeEvent((b) => pumpSdk.decodeCreateEventBc(b), buf);
        if (ev && ev.mint) {
          tokens.push({
            mint: ev.mint.toBase58(),
            name: ev.name || "Unknown",
            symbol: ev.symbol || "???",
            imageUrl: null, // metadata URI is off-chain IPFS; icon stays a fallback, not fabricated
            source: "pumpfun.curve",
            status: "curve",
            createdAt: bnToNumber(ev.timestamp),
            firstSeenAt: now,
            fetchedAt: now,
            stale: false,
            priceQuote: curvePriceSol(ev.virtualSolReserves, ev.virtualTokenReserves),
            quoteSymbol: "SOL",
            liquidityQuote: null,
            change24h: null,
            volume24hUsd: null,
            marketCapUsd: null,
            valuation: null,
            curveProgress: null, // refined by enrichPumpCurves with live Global
            poolAddress: null,
            signature: null,
            creatorWallet: ev.creator?.toBase58() ?? null,
            fluxpadLaunchId: null,
            provenance: "pump-program(create-event)",
          });
          scannedMints.push(ev.mint.toBase58());
        }
      }
    }
    return {
      feed: { source: "pumpfun.curve", tokens, fetchedAt: now, ok: true, error: null },
      scannedMints,
    };
  } catch (err) {
    return {
      feed: {
        source: "pumpfun.curve",
        tokens: [],
        fetchedAt: now,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      scannedMints,
    };
  }
}

/**
 * Enrich discovered pump curve tokens with live curve state and honest
 * progress against the live Global account. `globals` may be null when the
 * Global account is unreachable — progress stays null (never fabricated).
 */
export async function enrichPumpCurves(
  connection: Connection,
  tokens: DiscoveredToken[],
  globals: { initialRealTokenReserves: number | null; tokenTotalSupply: number | null } | null,
): Promise<DiscoveredToken[]> {
  if (tokens.length === 0) return tokens;
  const online = new OnlinePumpSdk(connection);
  // Sequential with pacing — concurrent per-mint fetches overwhelm public
  // RPC endpoints (observed 429s). A rate limit stops the enrichment pass
  // early; tokens keep their create-event snapshot (honest, no fabrication).
  for (const t of tokens) {
    try {
      const curve = await online.fetchBondingCurve(new PublicKey(t.mint));
      const price = curvePriceSol(curve.virtualQuoteReserves, curve.virtualTokenReserves);
      if (price != null) t.priceQuote = price;
      const isSolQuoted =
        curve.quoteMint.equals(PublicKey.default) || curve.quoteMint.toBase58() === WSOL_MINT;
      if (isSolQuoted && globals) {
        t.curveProgress = curveProgress(
          bnToNumber(curve.realTokenReserves),
          globals.initialRealTokenReserves,
        );
        // Full-supply valuation at the curve price (FDV), SOL-denominated.
        const supplyRaw = bnToNumber(curve.tokenTotalSupply) ?? globals.tokenTotalSupply;
        if (price != null && supplyRaw != null) {
          t.valuation = "fdv";
          (t as DiscoveredToken & { marketCapSol?: number }).marketCapSol =
            (price * supplyRaw) / 1e6 / 1e9;
        }
      }
      if (curve.complete) t.status = "graduated";
    } catch (err) {
      if (isRateLimitError(err)) {
        // Back off and stop this enrichment round — remaining tokens stay
        // at their event-snapshot values (nulls stay null, never invented).
        await sleep(1000);
        break;
      }
      // Curve account unreadable (migrated away, hiccup): keep the snapshot.
    }
    await sleep(100); // gentle pacing between per-mint RPC reads
  }
  return tokens;
}
