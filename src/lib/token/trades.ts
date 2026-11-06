/**
 * Live token analytics — bounded, on-chain trade decoding for the token
 * detail terminal (Phases 4-6).
 *
 * Honesty rules:
 * - Only ACTUAL swap transactions are decoded (bounded getSignaturesForAddress
 *   + getParsedTransaction scan over the token's venue — bonding curve or
 *   pool). Candles are aggregated exclusively from those real trades; the
 *   response carries the exact coverage window, and history older than the
 *   scanned window is reported as unavailable (never fabricated).
 * - Buy/sell classification uses the program's own instruction logs when they
 *   name the side (Pump.fun / PumpSwap log "Instruction: Buy"/"Sell"), and
 *   otherwise derives the direction from on-chain balance deltas (venue SOL
 *   inflow ⇒ buy; venue token outflow ⇒ buy; user token delta as fallback).
 *   Transactions that cannot be classified stay "unknown" — never guessed.
 * - Wallet intelligence is derived from the same decoded trades; "creator"
 *   labeling only happens when the wallet matches a RelayPad launch record's
 *   creatorWallet (verified provenance). Top holders come from the documented
 *   getTokenLargestAccounts RPC — balances are on-chain facts, owner
 *   identities are NOT inferred.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { bondingCurvePda } from "@pump-fun/pump-sdk";
import { LAUNCHPAD_PROGRAM, DEVNET_PROGRAM_ID, getPdaLaunchpadPoolId } from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT } from "@solana/spl-token";
import { WSOL_MINT } from "@/lib/discovery/pump-constants";
import { getDb } from "@/lib/db";

export type VenueKind =
  | "pump-curve"
  | "pumpswap-pool"
  | "launchlab-curve"
  | "cpmm-pool"
  /** Any other supported AMM pool (Orca, Meteora, …) resolved by providers. */
  | "external-pool"
  | "unknown";

export interface TokenVenue {
  kind: VenueKind;
  /** Account whose signature history contains the venue's trades. */
  address: string | null;
}

export interface TokenTrade {
  signature: string;
  kind: "buy" | "sell" | "unknown";
  slot: number;
  blockTime: number | null;
  wallet: string | null;
  tokenAmount: number | null;
  solAmount: number | null;
  priceSol: number | null;
  creator: boolean;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buys: number;
  sells: number;
}

export interface WalletActivity {
  wallet: string;
  buys: number;
  sells: number;
  boughtToken: number;
  soldToken: number;
  firstAt: number | null;
  lastAt: number | null;
  creator: boolean;
}

export interface HolderRow {
  address: string;
  uiAmount: number | null;
  rank: number;
}

export interface TokenMarketSnapshot {
  mint: string;
  venue: TokenVenue;
  trades: TokenTrade[];
  candles: Candle[];
  wallets: WalletActivity[];
  holders: HolderRow[];
  topBuyers: WalletActivity[];
  topSellers: WalletActivity[];
  earlyBuyers: WalletActivity[];
  creatorActivity: { wallet: string; trades: number; boughtToken: number; soldToken: number } | null;
  coverageFrom: number | null;
  coverageTo: number | null;
  coverageNote: string;
  warnings: string[];
}

const CANDLE_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
  "4h": 14_400,
  "1d": 86_400,
};

export const CANDLE_INTERVALS = Object.keys(CANDLE_SECONDS);

const MAX_SIGNATURES = 40;
const MAX_TX_DECODED = 20;
const TX_BATCH = 4;

/** Resolve which venue trades this mint, using cheap existence checks. */
export async function resolveTokenVenue(connection: Connection, mint: string): Promise<TokenVenue> {
  const mintPk = new PublicKey(mint);
  // 1) RelayPad record: its route/poolAddress are verified provenance.
  try {
    const db = getDb();
    const record = db
      ? await db.launch.findFirst({
          where: { OR: [{ mintAddress: mint }, { id: mint }] },
          select: { route: true, poolAddress: true, status: true },
        })
      : null;
    if (record) {
      if (record.route === "PUMP_PUMPSWAP" && record.status !== "PREPARATION") {
        // Curve trades until graduation; the pool after it.
        if (record.status === "CONFIRMED" || record.status === "CURVE_TRADING") {
          return { kind: "pump-curve", address: bondingCurvePda(mintPk).toBase58() };
        }
        if (record.poolAddress) return { kind: "pumpswap-pool", address: record.poolAddress };
      }
      if (record.route === "LAUNCHLAB_CPMM") {
        if (record.status === "CONFIRMED" || record.status === "CURVE_TRADING") {
          // Same dual-cluster resolution the LaunchLab adapter uses.
          for (const programId of [LAUNCHPAD_PROGRAM, DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM]) {
            try {
              const poolId = getPdaLaunchpadPoolId(programId, mintPk, NATIVE_MINT).publicKey;
              const info = await connection.getAccountInfo(poolId, "confirmed");
              if (info) return { kind: "launchlab-curve", address: poolId.toBase58() };
            } catch {
              // try next program id
            }
          }
        }
        if (record.poolAddress) return { kind: "cpmm-pool", address: record.poolAddress };
      }
    }
  } catch {
    // DB unavailable — fall through to on-chain venue detection.
  }
  // 2) Pump.fun bonding curve (existence check is one cheap account read).
  try {
    const curve = bondingCurvePda(mintPk);
    const info = await connection.getAccountInfo(curve);
    if (info) return { kind: "pump-curve", address: curve.toBase58() };
  } catch {
    // RPC hiccup — continue.
  }
  // 3) LaunchLab bonding-curve pool PDA (both cluster program IDs, like the
  // LaunchLab adapter's resolveCurveAccount).
  for (const programId of [LAUNCHPAD_PROGRAM, DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM]) {
    try {
      const poolId = getPdaLaunchpadPoolId(programId, mintPk, NATIVE_MINT).publicKey;
      const info = await connection.getAccountInfo(poolId, "confirmed");
      if (info) return { kind: "launchlab-curve", address: poolId.toBase58() };
    } catch {
      // try next program id
    }
  }
  return { kind: "unknown", address: null };
}

interface ParsedLike {
  slot: number;
  blockTime: number | null;
  meta: {
    fee: number;
    logMessages: string[] | null;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances: {
      accountIndex: number;
      mint: string;
      owner?: string;
      uiTokenAmount: { amount: string; uiAmount: number | null; decimals: number };
    }[] | null;
    postTokenBalances: {
      accountIndex: number;
      mint: string;
      owner?: string;
      uiTokenAmount: { amount: string; uiAmount: number | null; decimals: number };
    }[] | null;
    err: unknown;
  } | null;
  transaction: { message: { accountKeys: { pubkey: string | { toBase58(): string }; signer: boolean }[] } };
}

/** Decode one parsed transaction into a classified trade (or null). */
export function classifyTrade(
  tx: ParsedLike,
  venueAddress: string,
  mint: string,
  tokenDecimals: number | null,
  creatorWallet: string | null,
): TokenTrade | null {
  const meta = tx.meta;
  if (!meta) return null;
  const keys = tx.transaction.message.accountKeys;
  // Normalize account keys to base58 strings: for versioned transactions
  // web3.js hands back PublicKey instances, not strings (live-verified).
  const keyStr = (k: { pubkey: string | { toBase58(): string } }): string =>
    typeof k.pubkey === "string" ? k.pubkey : k.pubkey.toBase58();
  const keyStrings = keys.map(keyStr);
  const signerFlags = keys.map((k) => k.signer);
  const venueIdx = keyStrings.indexOf(venueAddress);
  const signerWallets = new Set(keyStrings.filter((_, i) => signerFlags[i]));
  const wallet = keyStrings[signerFlags.indexOf(true)] ?? null;

  // Token deltas matched per account index (pre/post entries for the same
  // token account), with the owner resolved from whichever list carries it.
  // This survives owner-less entries and accounts created mid-transaction.
  const preByIndex = new Map<number, { amount: string; owner?: string; decimals?: number }>();
  const postByIndex = new Map<number, { amount: string; owner?: string; decimals?: number }>();
  for (const b of meta.preTokenBalances ?? []) {
    if (b.mint === mint)
      preByIndex.set(b.accountIndex, { amount: b.uiTokenAmount.amount, owner: b.owner, decimals: b.uiTokenAmount.decimals });
  }
  for (const b of meta.postTokenBalances ?? []) {
    if (b.mint === mint)
      postByIndex.set(b.accountIndex, { amount: b.uiTokenAmount.amount, owner: b.owner, decimals: b.uiTokenAmount.decimals });
  }
  const indices = new Set<number>([...preByIndex.keys(), ...postByIndex.keys()]);
  let userDelta = 0;
  let poolDelta = 0;
  let decimalsSeen: number | null = null;
  // The trader is the signer-owned account with the largest token movement —
  // v2 router trades may be sponsored (first signer = relayer, not trader).
  let traderWallet: string | null = null;
  let traderMagnitude = 0;
  for (const idx of indices) {
    const pre = preByIndex.get(idx);
    const post = postByIndex.get(idx);
    const delta = Number(post?.amount ?? 0) - Number(pre?.amount ?? 0);
    if (delta === 0) continue;
    const owner = pre?.owner ?? post?.owner;
    if (decimalsSeen == null) decimalsSeen = pre?.decimals ?? post?.decimals ?? null;
    if (owner != null && signerWallets.has(owner)) {
      userDelta += delta;
      if (Math.abs(delta) > traderMagnitude) {
        traderMagnitude = Math.abs(delta);
        traderWallet = owner;
      }
    } else {
      poolDelta += delta; // venue-side accounts (pool/curve vaults)
    }
  }
  const hasTokenActivity = userDelta !== 0 || poolDelta !== 0 || decimalsSeen != null;
  const walletFinal = traderWallet ?? wallet;

  // Venue SOL leg. v1 curve/pool trades move lamports directly on the venue
  // account; Pump.fun v2 routes SOL through WSOL token vaults owned by the
  // venue — so the leg is the sum of both channels (only one is non-zero).
  let venueSolDelta = 0;
  if (venueIdx >= 0 && meta.preBalances[venueIdx] != null) {
    venueSolDelta = (meta.postBalances[venueIdx] - meta.preBalances[venueIdx]) / 1e9;
  }
  const wsolPre = new Map<number, { amount: string; owner?: string }>();
  const wsolPost = new Map<number, { amount: string; owner?: string }>();
  for (const b of meta.preTokenBalances ?? []) {
    if (b.mint === WSOL_MINT) wsolPre.set(b.accountIndex, { amount: b.uiTokenAmount.amount, owner: b.owner });
  }
  for (const b of meta.postTokenBalances ?? []) {
    if (b.mint === WSOL_MINT) wsolPost.set(b.accountIndex, { amount: b.uiTokenAmount.amount, owner: b.owner });
  }
  for (const idx of new Set<number>([...wsolPre.keys(), ...wsolPost.keys()])) {
    const pre = wsolPre.get(idx);
    const post = wsolPost.get(idx);
    const delta = (Number(post?.amount ?? 0) - Number(pre?.amount ?? 0)) / 1e9; // WSOL = 9 decimals
    if (delta === 0) continue;
    const owner = pre?.owner ?? post?.owner;
    if (owner == null || !signerWallets.has(owner)) venueSolDelta += delta;
  }

  const logs = meta.logMessages ?? [];
  // Program-declared side: "Instruction: Buy"/"Sell" (v1 curve + PumpSwap)
  // and the v2 router variants "Instruction: PumpBuyV2"/"PumpSellV2".
  let kind: TokenTrade["kind"];
  if (logs.some((l) => /Instruction: \S*Buy/.test(l))) kind = "buy";
  else if (logs.some((l) => /Instruction: \S*Sell/.test(l))) kind = "sell";
  else if (venueSolDelta > 0 && poolDelta <= 0) kind = "buy";
  else if (venueSolDelta < 0 && poolDelta >= 0) kind = "sell";
  else if (userDelta > 0) kind = "buy";
  else if (userDelta < 0) kind = "sell";
  else kind = "unknown";

  const dec = tokenDecimals ?? decimalsSeen;
  const scale = dec != null ? 10 ** dec : null;
  const rawMoved = kind === "sell" ? poolDelta : userDelta !== 0 ? userDelta : poolDelta;
  const tokenAmount = scale != null && rawMoved !== 0 ? Math.abs(rawMoved) / scale : null;
  const solAmount = venueSolDelta !== 0 ? Math.abs(venueSolDelta) : null;
  const priceSol = tokenAmount != null && solAmount != null && tokenAmount > 0 ? solAmount / tokenAmount : null;

  // A trade must have a recognizable side to be reported as one; pure
  // unclassifiable transactions are dropped (never labeled buy/sell).
  if (kind === "unknown" && !hasTokenActivity) return null;

  return {
    signature: "",
    kind,
    slot: tx.slot,
    blockTime: tx.blockTime,
    wallet: walletFinal,
    tokenAmount,
    solAmount,
    priceSol,
    creator: creatorWallet != null && walletFinal === creatorWallet,
  };
}

/** Bounded live market fetch for one token: trades + wallets + candles.
 * `venueOverride` lets the caller supply a provider-resolved venue (DexScreener
 * / GeckoTerminal), so tokens outside the local registry and without a
 * derivable PDA still decode real on-chain swaps. */
export async function fetchTokenMarket(
  connection: Connection,
  mint: string,
  opts: { interval?: string; maxTx?: number; now?: number; venueOverride?: TokenVenue } = {},
): Promise<TokenMarketSnapshot> {
  const warnings: string[] = [];
  const venue = opts.venueOverride ?? (await resolveTokenVenue(connection, mint));
  const interval = CANDLE_SECONDS[opts.interval ?? "5m"] != null ? (opts.interval ?? "5m") : "5m";
  const empty: TokenMarketSnapshot = {
    mint,
    venue,
    trades: [],
    candles: [],
    wallets: [],
    holders: [],
    topBuyers: [],
    topSellers: [],
    earlyBuyers: [],
    creatorActivity: null,
    coverageFrom: null,
    coverageTo: null,
    coverageNote:
      venue.kind === "unknown" || venue.address == null
        ? "No tradable venue (bonding curve or pool) was identified for this mint — market activity is unavailable."
        : "No trades decoded in the scanned window. History is derived from real on-chain swaps only.",
    warnings,
  };
  if (venue.kind === "unknown" || venue.address == null) return empty;

  const venuePk = new PublicKey(venue.address);
  let signatures: { signature: string; slot: number; blockTime?: number | null; err: unknown }[] = [];
  try {
    signatures = await connection.getSignaturesForAddress(venuePk, { limit: MAX_SIGNATURES });
  } catch (err) {
    warnings.push(`Signature scan failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ...empty, warnings };
  }
  const tradeable = signatures.filter((s) => !s.err).slice(0, opts.maxTx ?? MAX_TX_DECODED);
  if (tradeable.length === 0) {
    return { ...empty, coverageNote: "No successful transactions found for this venue in the scanned window." };
  }

  // Token decimals (one documented call, cached by the RPC response).
  let tokenDecimals: number | null = null;
  try {
    const supply = await connection.getTokenSupply(new PublicKey(mint));
    tokenDecimals = supply.value.decimals;
  } catch {
    warnings.push("Token decimals unavailable — token amounts may be N/A.");
  }

  let creatorWallet: string | null = null;
  try {
    const db = getDb();
    const record = db
      ? await db.launch.findFirst({
          where: { OR: [{ mintAddress: mint }, { id: mint }] },
          select: { creatorWallet: true },
        })
      : null;
    creatorWallet = record?.creatorWallet ?? null;
  } catch {
    // DB unavailable — creator attribution simply stays unverified.
  }

  // Bounded parallel decode (batches of TX_BATCH, newest first).
  const trades: TokenTrade[] = [];
  for (let i = 0; i < tradeable.length; i += TX_BATCH) {
    const batch = tradeable.slice(i, i + TX_BATCH);
    const settled = await Promise.allSettled(
      batch.map((s) =>
        connection.getParsedTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        }),
      ),
    );
    settled.forEach((r, j) => {
      if (r.status !== "fulfilled" || !r.value) return;
      const sig = batch[j].signature;
      const tx = r.value as unknown as ParsedLike;
      const trade = classifyTrade(tx, venue.address!, mint, tokenDecimals, creatorWallet);
      if (trade) trades.push({ ...trade, signature: sig });
    });
  }
  trades.sort((a, b) => (b.blockTime ?? b.slot) - (a.blockTime ?? a.slot));

  // Candles — aggregated strictly from the decoded real trades.
  const bucketSec = CANDLE_SECONDS[interval];
  const candles = aggregateCandles(trades, bucketSec);

  // Wallet intelligence from the decoded trades.
  const byWallet = new Map<string, WalletActivity>();
  for (const t of trades) {
    if (!t.wallet) continue;
    const w = byWallet.get(t.wallet) ?? {
      wallet: t.wallet,
      buys: 0,
      sells: 0,
      boughtToken: 0,
      soldToken: 0,
      firstAt: t.blockTime,
      lastAt: t.blockTime,
      creator: t.creator,
    };
    if (t.kind === "buy") {
      w.buys += 1;
      w.boughtToken += t.tokenAmount ?? 0;
    } else if (t.kind === "sell") {
      w.sells += 1;
      w.soldToken += t.tokenAmount ?? 0;
    }
    if (t.blockTime != null) {
      w.firstAt = w.firstAt == null ? t.blockTime : Math.min(w.firstAt, t.blockTime);
      w.lastAt = w.lastAt == null ? t.blockTime : Math.max(w.lastAt, t.blockTime);
    }
    if (t.creator) w.creator = true;
    byWallet.set(t.wallet, w);
  }
  const wallets = [...byWallet.values()];
  const topBuyers = [...wallets].filter((w) => w.boughtToken > 0).sort((a, b) => b.boughtToken - a.boughtToken).slice(0, 5);
  const topSellers = [...wallets].filter((w) => w.soldToken > 0).sort((a, b) => b.soldToken - a.soldToken).slice(0, 5);
  const earlyBuyers = [...wallets]
    .filter((w) => w.buys > 0 && w.firstAt != null)
    .sort((a, b) => (a.firstAt ?? 0) - (b.firstAt ?? 0))
    .slice(0, 10);
  const creatorWallets = wallets.filter((w) => w.creator);
  const creatorActivity = creatorWallets.length
    ? {
        wallet: creatorWallets[0].wallet,
        trades: creatorWallets.reduce((a, w) => a + w.buys + w.sells, 0),
        boughtToken: creatorWallets.reduce((a, w) => a + w.boughtToken, 0),
        soldToken: creatorWallets.reduce((a, w) => a + w.soldToken, 0),
      }
    : null;

  // Top holders — documented RPC; ownership identities are not inferred.
  let holders: HolderRow[] = [];
  try {
    const largest = await connection.getTokenLargestAccounts(new PublicKey(mint));
    holders = largest.value
      .sort((a, b) => (b.uiAmount ?? 0) - (a.uiAmount ?? 0))
      .slice(0, 10)
      .map((h, i) => ({ address: h.address.toBase58(), uiAmount: h.uiAmount ?? null, rank: i + 1 }));
  } catch (err) {
    warnings.push(`Holder rankings unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const priced = trades.filter((t) => t.blockTime != null && t.priceSol != null);
  const coverageFrom = priced.length ? Math.min(...priced.map((t) => t.blockTime!)) : null;
  const coverageTo = priced.length ? Math.max(...priced.map((t) => t.blockTime!)) : null;
  const coverageNote =
    candles.length > 0
      ? `Candles aggregated from ${priced.length} real on-chain swaps decoded in this bounded scan (${interval} buckets). No older history is fabricated.`
      : "No priced swaps decoded in the scanned window — candles are unavailable until real trades exist.";

  return {
    mint,
    venue,
    trades,
    candles,
    wallets,
    holders,
    topBuyers,
    topSellers,
    earlyBuyers,
    creatorActivity,
    coverageFrom,
    coverageTo,
    coverageNote,
    warnings,
  };
}

/**
 * Activity windows derived strictly from decoded real trades. Every window
 * reports its own coverage (swap count + time span) — windows with no
 * decoded swaps report nulls, never interpolated figures.
 */
export interface ActivityWindow {
  /** Window length in seconds. */
  seconds: number;
  label: "5m" | "1h" | "6h" | "24h";
  /** SOL volume of classified swaps inside the window. */
  volumeSol: number;
  buys: number;
  sells: number;
  /** Price change % across the window (first vs last priced swap). */
  changePct: number | null;
  /** Decoded swaps inside the window (coverage honesty). */
  swaps: number;
  /** Window start (unix s) used for the computation. */
  from: number;
}

export function activityWindows(trades: TokenTrade[], nowSec: number): ActivityWindow[] {
  const specs: { label: ActivityWindow["label"]; seconds: number }[] = [
    { label: "5m", seconds: 300 },
    { label: "1h", seconds: 3_600 },
    { label: "6h", seconds: 21_600 },
    { label: "24h", seconds: 86_400 },
  ];
  return specs.map(({ label, seconds }) => {
    const from = nowSec - seconds;
    const inWindow = trades.filter(
      (t) => t.blockTime != null && t.blockTime >= from && t.kind !== "unknown" && t.solAmount != null,
    );
    const priced = inWindow.filter((t) => t.priceSol != null).sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
    const first = priced[0]?.priceSol ?? null;
    const last = priced[priced.length - 1]?.priceSol ?? null;
    return {
      seconds,
      label,
      volumeSol: inWindow.reduce((a, t) => a + (t.solAmount ?? 0), 0),
      buys: inWindow.filter((t) => t.kind === "buy").length,
      sells: inWindow.filter((t) => t.kind === "sell").length,
      changePct: first != null && last != null && first > 0 ? ((last - first) / first) * 100 : null,
      swaps: inWindow.length,
      from,
    };
  });
}

/** Interval name → bucket seconds (exported for the UI). */
export function candleSecondsFor(interval: string): number | null {
  return CANDLE_SECONDS[interval] ?? null;
}

/**
 * Aggregate real classified trades into OHLCV buckets. Trades without a
 * verified price or timestamp, and unclassified swaps, are excluded — the
 * output contains only what actually executed on-chain.
 */
export function aggregateCandles(trades: TokenTrade[], intervalSec: number): Candle[] {
  const byBucket = new Map<number, Candle>();
  for (const t of trades) {
    if (t.priceSol == null || t.blockTime == null || t.kind === "unknown") continue;
    const time = Math.floor(t.blockTime / intervalSec) * intervalSec;
    const c = byBucket.get(time) ?? {
      time,
      open: t.priceSol,
      high: t.priceSol,
      low: t.priceSol,
      close: t.priceSol,
      volume: 0,
      buys: 0,
      sells: 0,
    };
    c.high = Math.max(c.high, t.priceSol);
    c.low = Math.min(c.low, t.priceSol);
    c.close = t.priceSol;
    c.volume += t.solAmount ?? 0;
    if (t.kind === "buy") c.buys += 1;
    if (t.kind === "sell") c.sells += 1;
    byBucket.set(time, c);
  }
  return [...byBucket.values()].sort((a, b) => a.time - b.time);
}