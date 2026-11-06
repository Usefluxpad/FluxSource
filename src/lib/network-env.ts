/**
 * Solana network selection — FluxPad variable first, then the DotPad and
 * RelayPad legacy variables as fallbacks (phased naming migration).
 *
 * Priority: `NEXT_PUBLIC_FLUXPAD_NETWORK` → `NEXT_PUBLIC_DOTPAD_NETWORK`
 * → `NEXT_PUBLIC_RELAYPAD_NETWORK`. Legacy variables remain so existing
 * deployments keep working unchanged; they are removed only after every
 * deployment has been migrated.
 *
 * Works identically in client and server bundles: `NEXT_PUBLIC_*` values are
 * inlined at build time wherever these literals appear, and the server reads
 * the real environment at runtime.
 *
 * Migration note: migrating hosting to `NEXT_PUBLIC_FLUXPAD_NETWORK` requires
 * a production REBUILD — client bundles only pick up `NEXT_PUBLIC_*` values
 * at build time, not at runtime.
 */
import type { ClusterId } from "./constants";

/** Pure resolver: newest first, legacy fallbacks, anything unrecognized → devnet. */
export function resolveClusterFromEnv(
  fluxpadNetwork: string | undefined,
  dotpadNetwork: string | undefined,
  legacyNetwork: string | undefined,
): ClusterId {
  const a = fluxpadNetwork?.trim();
  const b = dotpadNetwork?.trim();
  const c = legacyNetwork?.trim();
  const raw = a || b || c || "";
  return raw === "mainnet-beta" ? "mainnet-beta" : "devnet";
}

/** The effective raw network value (newest name first, legacy fallbacks). */
export function currentNetworkRaw(): string | undefined {
  const a = process.env.NEXT_PUBLIC_FLUXPAD_NETWORK?.trim();
  if (a) return a;
  const b = process.env.NEXT_PUBLIC_DOTPAD_NETWORK?.trim();
  if (b) return b;
  return process.env.NEXT_PUBLIC_RELAYPAD_NETWORK?.trim() || undefined;
}

/** The active cluster for the running app (newest name first, legacy fallbacks). */
export function currentNetworkCluster(): ClusterId {
  return resolveClusterFromEnv(
    process.env.NEXT_PUBLIC_FLUXPAD_NETWORK,
    process.env.NEXT_PUBLIC_DOTPAD_NETWORK,
    process.env.NEXT_PUBLIC_RELAYPAD_NETWORK,
  );
}
