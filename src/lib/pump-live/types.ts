/**
 * PumpPortal live data — shared types.
 *
 * Pipeline: PumpPortal WS → ws-manager → validation/dedupe → aggregation
 * engine → snapshot persistence → ranking engine → /api/trending[/stream].
 * Every record distinguishes "measured zero" from "unavailable" (null).
 */

/** Raw PumpPortal new-token event (fields parsed defensively). */
export interface PumpPortalNewTokenEvent {
  signature?: string;
  mint?: string;
  name?: string;
  symbol?: string;
  uri?: string;
  /** Creator wallet (PumpPortal `user` field). */
  user?: string;
  createdBy?: string;
  /** "create" events carry the dev initial buy (decimal token units). */
  initialBuy?: number;
  solAmount?: number;
  bondingCurveKey?: string;
  traderPublicKey?: string;
  timestamp?: number; // seconds
  [k: string]: unknown;
}

/** Raw PumpPortal trade event (bonding-curve and post-migration trades). */
export interface PumpPortalTradeEvent {
  signature?: string;
  mint?: string;
  solAmount?: number;
  tokenAmount?: number;
  user?: string; // trader wallet
  txType?: string; // "buy" | "sell"
  vSolInBondingCurve?: number;
  vTokensInBondingCurve?: number;
  marketCapSol?: number;
  timestamp?: number; // seconds
  pool?: string;
  [k: string]: unknown;
}

/** Raw PumpPortal migration event (bonding curve → PumpSwap). */
export interface PumpPortalMigrationEvent {
  signature?: string;
  mint?: string;
  poolId?: string;
  /** AMM/program the pool migrated to (e.g. "pump-amm"). */
  pool?: string;
  amm?: string;
  name?: string;
  symbol?: string;
  uri?: string;
  decimals?: number;
  marketCapSol?: number;
  timestamp?: number; // seconds
  [k: string]: unknown;
}

/** A validated, deduplicated trade kept in a mint's rolling window. */
export interface LiveTrade {
  /** Epoch ms (event timestamp or receipt time when the event lacked one). */
  t: number;
  /** Executed price in SOL per token (solAmount / tokenAmount). */
  priceSol: number;
  /** SOL side of the trade. */
  sol: number;
  side: "buy" | "sell";
  /** Trader wallet. */
  wallet: string;
  /** Transaction signature (dedupe key component). */
  sig: string;
}

/** Token identity tracked by the live engine. */
export interface LiveTokenIdentity {
  mint: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  metadataUri: string | null;
  creator: string | null;
  createdAt: number; // epoch ms
  creationSignature: string | null;
  migrated: boolean;
  migratedAt: number | null;
  poolAddress: string | null;
  amm: string | null;
  /** Verified SPL supply (decimal units) — null until RPC-verified. */
  supply: number | null;
  decimals: number | null;
  /** Pump.fun bonding-curve account (trade source while on curve). */
  bondingCurveKey: string | null;
}

export interface WindowMetrics {
  /** Volume in SOL within the window. */
  volSol: number;
  volUsd: number | null;
  buys: number;
  sells: number;
  buyers: number;
  sellers: number;
  /** (last-first)/first within the window; null when <2 prices or incomplete. */
  changePct: number | null;
  trades: number;
}

export interface LiveTokenMetrics {
  mint: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  createdAt: number;
  creator: string | null;
  migrated: boolean;
  migratedAt: number | null;
  poolAddress: string | null;
  /** Last executed trade price in SOL. */
  priceSol: number | null;
  priceUsd: number | null;
  /** price × verified supply — null when supply unverified. */
  marketCapUsd: number | null;
  marketCapSol: number | null;
  /** PumpPortal-reported curve market cap (SOL) — auxiliary, may be null. */
  eventMarketCapSol: number | null;
  vol5m: WindowMetrics;
  vol1h: WindowMetrics;
  vol4h: WindowMetrics;
  vol12h: WindowMetrics;
  vol24h: WindowMetrics;
  lastTradeAt: number | null;
  /** Trades in the last 5 minutes (HOT badge input). */
  trades5m: number;
  uniqueTraders5m: number;
  /** True when a metric window extends before our data start (honest partials). */
  historyPartial: boolean;
}

export interface RankedToken extends LiveTokenMetrics {
  /** Ranking score for the active tab (tab-dependent formula). */
  score: number;
}

export interface TrendingRow {
  mint: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  createdAt: number;
  ageMs: number;
  migrated: boolean;
  migratedAt: number | null;
  poolAddress: string | null;
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  volumeUsd: number | null;
  volumeSol: number | null;
  changePct: number | null;
  buys: number;
  sells: number;
  buyers: number;
  sellers: number;
  lastTradeAt: number | null;
  hot: boolean;
  score: number;
}

export interface TrendingStats {
  connected: boolean;
  reconnects: number;
  lastMessageAt: number | null;
  newTokenEvents: number;
  tradeEventsReceived: number;
  tradeEventsProcessed: number;
  duplicatesDropped: number;
  invalidEvents: number;
  migrationEvents: number;
  tokensTracked: number;
  tokensWithTrades: number;
  activeTradeSubscriptions: number;
  solUsd: number | null;
  solUsdSource: string | null;
  rpcCalls: number;
  processingLatencyMsAvg: number;
  /** Trades whose success was confirmed via independent Solana RPC. */
  verifiedTrades: number;
  /** Streamed trades that RPC verification proved invalid/failed. */
  verificationFailures: number;
  startedAt: number;
  dataFrom: number;
  /** True while the 24h window extends before our earliest stored data. */
  historyPartial: boolean;
  /** Est. SOL consumed by the data pipeline (data API + HTTP RPC = no SOL fees). */
  estSolConsumed: number;
  wsBytesReceived: number;
  lastError: string | null;
  /** Where trade flow comes from: funded-key WS stream or on-chain RPC polling. */
  tradeSource: "ws" | "rpc-poll" | null;
  /** False when PumpPortal rejected token-trade streaming (missing funded key). */
  tradeStreamingAvailable: boolean | null;
  tradeStreamingReason: string | null;
  /** Shared RPC gateway diagnostics (throttle/429/circuit/cache). Optional so
   * persisted snapshots and older consumers stay compatible. */
  rpc?: import("@/lib/rpc/rpc-gateway").RpcGatewayMetrics;
  /** Current effective trade-poll interval (base × adaptive stretch), ms. */
  pollIntervalMs?: number;
}

export type TrendingTab =
  | "trending"
  | "volume"
  | "gainers"
  | "losers"
  | "most-bought"
  | "newest"
  | "migrated";

export type TrendingTimeframe = "5m" | "1h" | "4h" | "12h" | "24h";
