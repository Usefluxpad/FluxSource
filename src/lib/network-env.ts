/**
 * Solana network selection — the FluxPad variable is the single source.
 *
 * `NEXT_PUBLIC_FLUXPAD_NETWORK` is the only network variable consulted by the
 * application. Legacy RelayPad/DotPad variable names are no longer read
 * anywhere; deployments must set the FluxPad name.
 *
 * Works identically in client and server bundles: `NEXT_PUBLIC_*` values are
 * inlined at build time wherever these literals appear, and the server reads
 * the real environment at runtime.
 *
 * Migration note: changing `NEXT_PUBLIC_FLUXPAD_NETWORK` requires a
 * production REBUILD — client bundles only pick up `NEXT_PUBLIC_*` values
 * at build time, not at runtime.
 */
import type { ClusterId } from "./constants";

/** Pure resolver: anything unrecognized → devnet. */
export function resolveClusterFromEnv(
  fluxpadNetwork: string | undefined,
): ClusterId {
  const raw = fluxpadNetwork?.trim() || "";
  return raw === "mainnet-beta" ? "mainnet-beta" : "devnet";
}

/** The effective raw network value. */
export function currentNetworkRaw(): string | undefined {
  return process.env.NEXT_PUBLIC_FLUXPAD_NETWORK?.trim() || undefined;
}

/** The active cluster for the running app. */
export function currentNetworkCluster(): ClusterId {
  return resolveClusterFromEnv(process.env.NEXT_PUBLIC_FLUXPAD_NETWORK);
}
