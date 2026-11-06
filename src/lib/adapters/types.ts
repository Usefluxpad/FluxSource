import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { ClusterId } from "../constants";
import type { WalletSigner } from "../tx-engine";

export type LaunchRoute = "pump" | "launchlab";

/** Lifecycle states surfaced by the launch flow UI. */
export type LifecyclePhase =
  | "preparation"
  | "awaiting_signature"
  | "submitted"
  | "confirming"
  | "confirmed"
  | "curve_trading"
  | "graduation_detected"
  | "pool_verified"
  | "failed"
  | "unresolved";

export interface TokenLaunchInput {
  name: string;
  symbol: string;
  metadataUri: string;
  imageUrl: string;
  /** SOL amount for the optional creator initial buy, in lamports. 0 = skip. */
  initialBuyLamports: bigint;
  /** Slippage basis points for the optional initial buy. */
  slippageBps: number;
}

export interface PreparedTransaction {
  tx: Transaction | VersionedTransaction;
  /** Extra ephemeral signers (e.g. the vanity mint keypair) — never persisted. */
  extraSigners: { secretKey: Uint8Array; publicKey: string }[];
}

export interface PreparedLaunch {
  route: LaunchRoute;
  mintAddress: string;
  /** Fully-built, unsigned transactions. The mint signer may be pre-attached. */
  transactions: PreparedTransaction[];
  /** Rent + fees + optional buy, in lamports, best estimate only. */
  estimatedTotalLamports: bigint;
  breakdown: { label: string; lamports: bigint }[];
  protocolNotes: string[];
  /** Accounts the wallet user must sign (the mint keypair is handled by extraSigners). */
  requiresMintSigner: boolean;
  /**
   * Client-only: the ephemeral mint keypair, kept in browser memory so a
   * blockhash-expired transaction can be rebuilt and re-signed locally.
   * Never persisted and never sent to the server.
   */
  mintKeypair?: Keypair;
  /**
   * Safe rebuild-and-resign hook: rebuilds ALL transactions with a fresh
   * blockhash (fresh mint signature, size guards re-run). Must run BEFORE
   * wallet signing — a wallet-signed message is never mutated; the wallet
   * signs the rebuilt transaction fresh. Optional: adapters/flows without
   * rebuild support surface blockhash expiry as an actionable error instead.
   */
  rebuild?: (ctx: {
    connection: import("@solana/web3.js").Connection;
    signer: WalletSigner;
  }) => Promise<PreparedLaunch>;
}

export interface CurveState {
  /** True while the bonding curve still exists and trades on it are possible. */
  onCurve: boolean;
  /** Raw observed values — FluxPad never derives prices it cannot verify. */
  quoteReserves: bigint | null;
  virtualQuoteReserves: bigint | null;
  baseSold: bigint | null;
  complete: boolean | null;
  observedAt: number;
  raw: Record<string, unknown>;
}

export interface PoolVerification {
  /** Address derived and verified on-chain (account exists with correct owner). */
  poolAddress: string;
  programOwner: string;
  baseMint: string;
  quoteMint: string;
  verifiedAt: number;
}

export interface RouteAdapter {
  id: LaunchRoute;
  label: string;
  description: string;
  /** Program IDs actually in use for this cluster. */
  describePrograms(cluster: ClusterId): { name: string; address: string }[];
  /**
   * Load and validate the live protocol configuration for this cluster.
   * Throws a typed FluxpadError when the route is unusable (program missing,
   * config account not found, etc.).
   */
  loadConfig(connection: import("@solana/web3.js").Connection, cluster: ClusterId): Promise<RouteConfigInfo>;
  /** Build launch transactions. Runs fully client-side. */
  prepareLaunch(params: {
    connection: import("@solana/web3.js").Connection;
    cluster: ClusterId;
    config: RouteConfigInfo;
    signer: WalletSigner;
    mintKeypair: import("@solana/web3.js").Keypair;
    input: TokenLaunchInput;
  }): Promise<PreparedLaunch>;
  /** Read bonding-curve state from the chain. Never fabricates values. */
  readCurveState(
    connection: import("@solana/web3.js").Connection,
    mint: PublicKey,
  ): Promise<CurveState>;
  /**
   * Attempt to verify the graduation destination pool on-chain.
   * Returns null when the pool does not exist yet (not graduated).
   */
  verifyPool(
    connection: import("@solana/web3.js").Connection,
    mint: PublicKey,
  ): Promise<PoolVerification | null>;
}

export interface RouteConfigInfo {
  route: LaunchRoute;
  cluster: ClusterId;
  details: Record<string, unknown>;
  /** Whether this adapter supports an optional creator initial buy on this cluster. */
  supportsInitialBuy: boolean;
  /** Whether vanity mints are verified-compatible with this route's tx builder. */
  supportsVanityMint: boolean;
}
