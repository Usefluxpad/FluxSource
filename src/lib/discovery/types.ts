/**
 * Shared discovery model — every provider adapter (Pump.fun, PumpSwap,
 * LaunchLab, Raydium CPMM, FluxPad registry) normalizes into this shape.
 *
 * Honesty rules enforced here:
 * - Numeric metrics are `null` when no defensible source exists. Callers
 *   render N/A — never a fabricated figure.
 * - Every record carries `source`, `fetchedAt` (epoch ms) and `stale`.
 * - `priceQuote`/`liquidityQuote` are denominated in the pool/curve quote
 *   asset (typically SOL) — `quoteSymbol` states which.
 * - `marketCapUsd`/`fdvUsd` are only populated when supply and price come
 *   from verified sources; curve "market cap" is full-supply valuation
 *   (i.e. FDV) and `valuation` says so explicitly.
 */

export type DiscoverySource =
  | "pumpfun.curve" // Pump.fun bonding-curve token (pre-graduation)
  | "pumpfun.pool" // graduated PumpSwap pool
  | "launchlab.curve" // LaunchLab bonding-curve token
  | "raydium.cpmm" // graduated Raydium CPMM pool
  | "fluxpad"; // verified FluxPad-originated launch

export type DiscoveryStatus = "curve" | "graduated" | "pool" | "verified-launch";

export interface DiscoveredToken {
  mint: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  source: DiscoverySource;
  status: DiscoveryStatus;
  /** Unix seconds when the token was created; null when unknown. */
  createdAt: number | null;
  /** Epoch ms when our cache first observed this token (for sources with no on-chain timestamp). */
  firstSeenAt: number;
  /** Epoch ms when this record's data was fetched from its provider. */
  fetchedAt: number;
  /** True when served from a cache older than the source's freshness TTL. */
  stale: boolean;
  /** Spot/curve price in the quote asset, decimal-adjusted. */
  priceQuote: number | null;
  quoteSymbol: string;
  /** Pool/curve liquidity (quote side) in the quote asset. */
  liquidityQuote: number | null;
  /** Verified change over the last day, only when the provider supplies it. */
  change24h: number | null;
  /** Trading volume over the last day (USD), only when the provider supplies it. */
  volume24hUsd: number | null;
  /** Market cap or FDV in USD — see `valuation`. */
  marketCapUsd: number | null;
  valuation: "market-cap" | "fdv" | null;
  /** Verified bonding-curve progress 0..100; null when not computable. */
  curveProgress: number | null;
  /** Verified destination pool address (post-graduation). */
  poolAddress: string | null;
  /** Launch transaction signature (FluxPad records). */
  signature: string | null;
  creatorWallet: string | null;
  /** Set when this mint also has a verified FluxPad launch record. */
  fluxpadLaunchId: string | null;
  /** Provider label for provenance, e.g. "raydium-mint-api(devnet)". */
  provenance: string;
}

export interface SourceFeed {
  source: DiscoverySource;
  tokens: DiscoveredToken[];
  fetchedAt: number;
  /** Provider reachability for this refresh. */
  ok: boolean;
  error: string | null;
}

export type DiscoveryTab =
  | "all"
  | "new-launches"
  | "new-pools"
  | "pumpfun"
  | "pumpswap"
  | "launchlab"
  | "cpmm"
  | "trending"
  | "graduating"
  | "graduated"
  | "fluxpad";

export type DiscoverySort =
  | "newest"
  | "oldest"
  | "movers-up"
  | "movers-down"
  | "market-cap"
  | "last-trade";
