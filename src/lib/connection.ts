import { Connection, Cluster, Commitment } from "@solana/web3.js";
import { ClusterId, clusterApiEndpoint } from "./constants";
import { rpcFetchMiddleware } from "./rpc/rpc-gateway";

export interface RelaypadNetworkConfig {
  cluster: ClusterId;
  rpcUrl: string;
  commitment: Commitment;
}

export interface RelaypadServerNetworkConfig extends RelaypadNetworkConfig {
  /** WebSocket endpoint for subscriptions; null when not configured. */
  wsUrl: string | null;
  /** True when the dedicated Alchemy endpoint is in use. */
  provider: "alchemy" | "custom" | "public";
}

/**
 * Server-side RPC resolution. Precedence: the dedicated Alchemy endpoint
 * (ALCHEMY_SOLANA_RPC_URL, or derived from ALCHEMY_API_KEY) → the generic
 * SOLANA_RPC_URL → the public cluster endpoint.
 *
 * Alchemy credentials are SERVER-SIDE ONLY: they must never be referenced
 * through NEXT_PUBLIC_* variables (those are inlined into client bundles).
 * Client wallet connections keep using NEXT_PUBLIC_SOLANA_RPC_URL or the
 * public endpoint.
 */
export function resolveServerNetworkConfig(
  envNetwork: string | undefined,
): RelaypadServerNetworkConfig {
  const cluster: ClusterId =
    envNetwork === "mainnet-beta" ? "mainnet-beta" : "devnet";

  const alchemyRpc = process.env.ALCHEMY_SOLANA_RPC_URL?.trim() || "";
  const alchemyKey = process.env.ALCHEMY_API_KEY?.trim() || "";
  const solRpc = process.env.SOLANA_RPC_URL?.trim() || "";

  let rpcUrl = solRpc;
  let provider: RelaypadServerNetworkConfig["provider"] = solRpc ? "custom" : "public";
  if (alchemyRpc) {
    rpcUrl = alchemyRpc;
    provider = "alchemy";
  } else if (alchemyKey) {
    // Standard Alchemy Solana URL shape: https://solana-<net>.g.alchemy.com/v2/<key>
    rpcUrl = `https://solana-${cluster === "mainnet-beta" ? "mainnet" : "devnet"}.g.alchemy.com/v2/${alchemyKey}`;
    provider = "alchemy";
  }
  if (!rpcUrl) rpcUrl = clusterApiEndpoint(cluster);

  // WebSocket endpoint for subscriptions (none in use today; configured for
  // future use). Only meaningful with the Alchemy provider.
  const alchemyWs = process.env.ALCHEMY_SOLANA_WS_URL?.trim() || "";
  const wsUrl =
    provider === "alchemy"
      ? alchemyWs ||
        (alchemyKey
          ? `wss://solana-${cluster === "mainnet-beta" ? "mainnet" : "devnet"}.g.alchemy.com/v2/${alchemyKey}`
          : null)
      : null;

  return { cluster, rpcUrl, commitment: "confirmed", wsUrl, provider };
}

export function resolveNetworkConfig(
  envNetwork: string | undefined,
  envRpc: string | undefined,
): RelaypadNetworkConfig {
  const cluster: ClusterId =
    envNetwork === "mainnet-beta" ? "mainnet-beta" : "devnet";
  return {
    cluster,
    rpcUrl: envRpc && envRpc.length > 0 ? envRpc : clusterApiEndpoint(cluster),
    commitment: "confirmed",
  };
}

/**
 * Browser RPC endpoint resolution.
 *
 * The browser never uses the Alchemy key (server-side only). Two supported
 * sources, in order:
 * 1. NEXT_PUBLIC_SOLANA_RPC_URL — when set to a relative path (e.g. "/api/rpc")
 *    it points at RelayPad's own server-side RPC proxy; the path is absolutized
 *    against the page origin. Never a secret.
 * 2. The public cluster endpoint (fallback).
 *
 * `origin` is injectable for tests; at runtime it is window.location.origin.
 */
export function resolveBrowserRpcEndpoint(
  envRpc: string | undefined,
  cluster: ClusterId,
  origin?: string,
): string {
  const raw = envRpc?.trim() || "";
  if (!raw) return clusterApiEndpoint(cluster);
  if (raw.startsWith("/")) {
    if (origin) return `${origin.replace(/\/$/, "")}${raw}`;
    if (typeof window !== "undefined") {
      return `${window.location.origin.replace(/\/$/, "")}${raw}`;
    }
    // SSR: relative paths cannot be resolved — fall back to the public
    // endpoint so server-side rendering never constructs an invalid URL.
    return clusterApiEndpoint(cluster);
  }
  return raw;
}

/** Browser-side network config (wallet connection + launch flow). */
export function resolveBrowserNetworkConfig(
  envNetwork: string | undefined,
  envRpc: string | undefined,
  origin?: string,
): RelaypadNetworkConfig {
  const cluster: ClusterId =
    envNetwork === "mainnet-beta" ? "mainnet-beta" : "devnet";
  return {
    cluster,
    rpcUrl: resolveBrowserRpcEndpoint(envRpc, cluster, origin),
    commitment: "confirmed",
  };
}

const connections = new Map<string, Connection>();

export function getConnection(cfg: RelaypadNetworkConfig): Connection {
  const key = `${cfg.cluster}:${cfg.rpcUrl}`;
  let conn = connections.get(key);
  if (!conn) {
    conn = new Connection(cfg.rpcUrl, {
      commitment: cfg.commitment,
      confirmTransactionInitialTimeout: 90_000,
      // Admission control for every HTTP JSON-RPC this Connection makes:
      // requests pass the shared gateway's token bucket and concurrency cap
      // before reaching the provider, and fail fast while the circuit breaker
      // is open (web3.js's own 429 retry loop handles transient limits).
      // WS subscriptions bypass fetch entirely.
      fetchMiddleware: rpcFetchMiddleware(),
    });
    connections.set(key, conn);
  }
  return conn;
}

export function getCluster(conn: Connection): Cluster {
  // @ts-expect-error cluster is present on Connection
  return conn._rpcEndpoint.includes("devnet") ? "devnet" : "mainnet-beta";
}

/** Error taxonomy used across the transaction engine and adapters. */
export type RelaypadErrorCode =
  | "WALLET_REJECTED"
  | "INSUFFICIENT_FUNDS"
  | "STALE_BLOCKHASH"
  | "BLOCKHASH_EXPIRED"
  | "RPC_ERROR"
  | "SIMULATION_FAILED"
  | "CONFIRMATION_TIMEOUT"
  | "TX_TOO_LARGE"
  | "UNRESOLVED"
  | "VALIDATION"
  | "PROTOCOL"
  | "UNKNOWN";

export class RelaypadError extends Error {
  readonly code: RelaypadErrorCode;
  readonly cause?: unknown;
  /** Set when the error refers to an already-submitted transaction. */
  readonly signature?: string;

  constructor(code: RelaypadErrorCode, message: string, cause?: unknown, signature?: string) {
    super(message);
    this.name = "RelaypadError";
    this.code = code;
    this.cause = cause;
    this.signature = signature;
  }
}

/**
 * True when an error is Solana's transaction-size overflow in any of its
 * observed shapes (verified against web3.js 1.98.2):
 * - `Transaction too large: N > 1232` — the wire-size assert in
 *   Transaction._serialize (message fits the packet buffer, signatures do not).
 * - `The value of "offset" is out of range. It must be >= 0 and <= 1231.`
 *   — legacy serializeMessage writes into a fixed 1,232-byte buffer.
 * - `encoding overruns Uint8Array` — MessageV0.serialize via BufferLayout.
 */
export function isTransactionTooLargeError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  return (
    lower.includes("transaction too large") ||
    lower.includes("encoding overruns") ||
    (lower.includes("out of range") &&
      (lower.includes("1231") || lower.includes("1232")))
  );
}

export function toRelaypadError(err: unknown): RelaypadError {
  if (err instanceof RelaypadError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (
    lower.includes("user rejected") ||
    lower.includes("rejected the request") ||
    lower.includes("declined") ||
    lower.includes("wallet request was denied")
  ) {
    return new RelaypadError("WALLET_REJECTED", "The wallet request was rejected.", err);
  }
  if (
    lower.includes("insufficient") ||
    lower.includes("0x1") ||
    lower.includes("custom program error") === false && lower.includes("lamport")
  ) {
    return new RelaypadError("INSUFFICIENT_FUNDS", raw, err);
  }
  // Transaction-level "BlockhashNotFound" (the camelCase form returned in
  // simulation results and send rejections): the transaction's referenced
  // blockhash is no longer valid. This is never a program-logic failure,
  // never proof the transaction landed, and — checked before submission —
  // always recoverable by rebuilding with a fresh blockhash.
  if (lower.includes("blockhashnotfound")) {
    return new RelaypadError(
      "BLOCKHASH_EXPIRED",
      "The transaction's blockhash expired before submission (the approval window closed). Nothing was submitted — rebuild with a fresh blockhash and approve again.",
      err,
    );
  }
  if (
    lower.includes("block height exceeded") ||
    lower.includes("blockhash") ||
    lower.includes("expired")
  ) {
    return new RelaypadError("STALE_BLOCKHASH", raw, err);
  }
  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("failed to fetch") ||
    lower.includes("network") ||
    lower.includes("-32005")
  ) {
    return new RelaypadError("RPC_ERROR", raw, err);
  }
  if (isTransactionTooLargeError(err)) {
    return new RelaypadError(
      "TX_TOO_LARGE",
      "The transaction exceeds Solana's 1,232-byte packet limit and cannot be signed or broadcast. Shorten the metadata URI (the default IPFS gateway produces the shortest URIs) or adjust the launch options — for example launch without the initial buy — then try again.",
      err,
    );
  }
  // web3.js confirmation-timeout (WS subscription never resolved — e.g. an
  // HTTP-only RPC path). A timeout never implies failure: surface it as
  // UNRESOLVED, never UNKNOWN.
  if (
    lower.includes("was not confirmed in") ||
    lower.includes("unknown if it succeeded")
  ) {
    return new RelaypadError("UNRESOLVED", raw, err);
  }

  return new RelaypadError("UNKNOWN", raw, err);
}
