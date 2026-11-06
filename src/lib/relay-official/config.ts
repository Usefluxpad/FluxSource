import { PublicKey } from "@solana/web3.js";
import type { ClusterId } from "../constants";

/**
 * Explicit placeholder for RELAY_OFFICIAL_MINT before the official token is
 * announced. Treated exactly like an unset value everywhere: never displayed
 * as a real address, never enables copying, and never listed as a
 * misconfiguration. Replace it in the environment with the real mint address
 * once the official token is launched and verified.
 */
export const RELAY_OFFICIAL_MINT_PLACEHOLDER = "REPLACE_WITH_OFFICIAL_RELAY_MINT";


/**
 * Server-only configuration for the official $FLUX treasury dashboard.
 *
 * Contains PUBLIC addresses and non-secret policy values only. There are no
 * private keys, seed phrases, or signing credentials here — signing stays in
 * the wallet / signing-service components described in
 * docs/RELAY_OFFICIAL_TOKEN_BUYBACK_IMPLEMENTATION_PLAN.md.
 *
 * Until the owner finalizes the wallets, every value is an unset placeholder;
 * the dashboard renders honest "configuration needed" states for anything
 * missing rather than inventing data.
 */

export const RELAY_OFFICIAL_ROLES = ["W1", "W2", "W3", "W4"] as const;
export type RelayOfficialRole = (typeof RELAY_OFFICIAL_ROLES)[number];

export const RELAY_OFFICIAL_ROLE_META: Record<
  RelayOfficialRole,
  { label: string; description: string }
> = {
  W1: {
    label: "Creator-fee receiver",
    description:
      "Official $FLUX creator-fee recipient (recorded at token launch). Receives verified creator-fee collections.",
  },
  W2: {
    label: "Buyback treasury",
    description:
      "Dedicated buyback treasury. Holds only the approved buyback allocation; executes verified buybacks and burns.",
  },
  W3: {
    label: "Operations & reserve",
    description:
      "Operations and reserve treasury. Holds the ops, reserve, and growth allocations.",
  },
  W4: {
    label: "Development wallet",
    description:
      "Separate development wallet. Not connected to the creator-fee allocation system; listed for transparency only.",
  },
};

export interface RelayOfficialWalletConfig {
  role: RelayOfficialRole;
  label: string;
  description: string;
  /** Public address, or null while the placeholder is unfinalized. */
  address: string | null;
}

function readAddress(
  envValue: string | undefined,
): { address: string | null; invalid: string | null } {
  const raw = envValue?.trim() ?? "";
  if (!raw) return { address: null, invalid: null };
  try {
    // Validation only — public keys, never secrets.
    new PublicKey(raw);
    return { address: raw, invalid: null };
  } catch {
    return { address: null, invalid: raw };
  }
}

export interface RelayOfficialConfig {
  network: ClusterId;
  wallets: RelayOfficialWalletConfig[];
  /** Official $FLUX mint, or null until the new verified mint is provided. */
  mint: string | null;
  /** True when at least one treasury wallet is configured. */
  anyWalletConfigured: boolean;
  /**
   * Addresses present but not valid base58 public keys (misconfiguration —
   * distinct from pending configuration; surfaced on the dashboard).
   */
  invalid: { role: RelayOfficialRole | "MINT"; value: string }[];
  /** Master switch (RELAY_OFFICIAL_ENABLED, default off). */
  enabled: boolean;
}

/**
 * Phased dual-read: resolve a value from the newest FluxPad variable first
 * and fall back through the DotPad and legacy RelayPad variables. Empty
 * strings count as unset (env files write VAR= for "configured but empty").
 */
function envChain(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** Load the current configuration. Pure over the provided env; no side effects. */
export function getRelayOfficialConfig(
  env: Partial<
    Pick<
      NodeJS.ProcessEnv,
      | "FLUXPAD_OFFICIAL_CREATOR_WALLET"
      | "FLUXPAD_OFFICIAL_BUYBACK_TREASURY"
      | "FLUXPAD_OFFICIAL_OPS_TREASURY"
      | "FLUXPAD_OFFICIAL_DEV_WALLET"
      | "FLUXPAD_OFFICIAL_MINT"
      | "FLUXPAD_OFFICIAL_NETWORK"
      | "FLUXPAD_OFFICIAL_ENABLED"
      | "NEXT_PUBLIC_FLUXPAD_NETWORK"
      | "DOTPAD_OFFICIAL_CREATOR_WALLET"
      | "DOTPAD_OFFICIAL_BUYBACK_TREASURY"
      | "DOTPAD_OFFICIAL_OPS_TREASURY"
      | "DOTPAD_OFFICIAL_DEV_WALLET"
      | "DOTPAD_OFFICIAL_MINT"
      | "DOTPAD_OFFICIAL_NETWORK"
      | "DOTPAD_OFFICIAL_ENABLED"
      | "NEXT_PUBLIC_DOTPAD_NETWORK"
      | "RELAY_OFFICIAL_CREATOR_WALLET"
      | "RELAY_OFFICIAL_BUYBACK_TREASURY"
      | "RELAY_OFFICIAL_OPS_TREASURY"
      | "RELAY_OFFICIAL_DEV_WALLET"
      | "RELAY_OFFICIAL_MINT"
      | "RELAY_OFFICIAL_NETWORK"
      | "RELAY_OFFICIAL_ENABLED"
      | "NEXT_PUBLIC_RELAYPAD_NETWORK"
    >
  > = process.env as Partial<
    Pick<
      NodeJS.ProcessEnv,
      | "FLUXPAD_OFFICIAL_CREATOR_WALLET"
      | "FLUXPAD_OFFICIAL_BUYBACK_TREASURY"
      | "FLUXPAD_OFFICIAL_OPS_TREASURY"
      | "FLUXPAD_OFFICIAL_DEV_WALLET"
      | "FLUXPAD_OFFICIAL_MINT"
      | "FLUXPAD_OFFICIAL_NETWORK"
      | "FLUXPAD_OFFICIAL_ENABLED"
      | "NEXT_PUBLIC_FLUXPAD_NETWORK"
      | "DOTPAD_OFFICIAL_CREATOR_WALLET"
      | "DOTPAD_OFFICIAL_BUYBACK_TREASURY"
      | "DOTPAD_OFFICIAL_OPS_TREASURY"
      | "DOTPAD_OFFICIAL_DEV_WALLET"
      | "DOTPAD_OFFICIAL_MINT"
      | "DOTPAD_OFFICIAL_NETWORK"
      | "DOTPAD_OFFICIAL_ENABLED"
      | "NEXT_PUBLIC_DOTPAD_NETWORK"
      | "RELAY_OFFICIAL_CREATOR_WALLET"
      | "RELAY_OFFICIAL_BUYBACK_TREASURY"
      | "RELAY_OFFICIAL_OPS_TREASURY"
      | "RELAY_OFFICIAL_DEV_WALLET"
      | "RELAY_OFFICIAL_MINT"
      | "RELAY_OFFICIAL_NETWORK"
      | "RELAY_OFFICIAL_ENABLED"
      | "NEXT_PUBLIC_RELAYPAD_NETWORK"
    >
  >,
): RelayOfficialConfig {
  const sources: Record<RelayOfficialRole, string | undefined> = {
    W1: envChain(env.FLUXPAD_OFFICIAL_CREATOR_WALLET, env.DOTPAD_OFFICIAL_CREATOR_WALLET, env.RELAY_OFFICIAL_CREATOR_WALLET),
    W2: envChain(env.FLUXPAD_OFFICIAL_BUYBACK_TREASURY, env.DOTPAD_OFFICIAL_BUYBACK_TREASURY, env.RELAY_OFFICIAL_BUYBACK_TREASURY),
    W3: envChain(env.FLUXPAD_OFFICIAL_OPS_TREASURY, env.DOTPAD_OFFICIAL_OPS_TREASURY, env.RELAY_OFFICIAL_OPS_TREASURY),
    W4: envChain(env.FLUXPAD_OFFICIAL_DEV_WALLET, env.DOTPAD_OFFICIAL_DEV_WALLET, env.RELAY_OFFICIAL_DEV_WALLET),
  };
  const invalid: RelayOfficialConfig["invalid"] = [];
  const wallets = RELAY_OFFICIAL_ROLES.map((role) => {
    const read = readAddress(sources[role]);
    if (read.invalid) invalid.push({ role, value: read.invalid });
    return {
      role,
      label: RELAY_OFFICIAL_ROLE_META[role].label,
      description: RELAY_OFFICIAL_ROLE_META[role].description,
      address: read.address,
    };
  });
  // FluxPad rebrand: the official $FLUX mint comes ONLY from the new
  // FLUXPAD_OFFICIAL_MINT variable. The DotPad-era DOTPAD_OFFICIAL_MINT and
  // legacy RELAY_OFFICIAL_MINT values are intentionally NOT reused as the
  // $FLUX mint — a new official token must never silently inherit an old
  // token's mint. The dashboard stays in its "not configured yet" state until
  // a verified $FLUX mint is explicitly configured.
  const mintReadRaw = env.FLUXPAD_OFFICIAL_MINT?.trim() ?? "";
  // The explicit placeholder is an intentional "not announced yet" marker —
  // treated exactly like an unset value so the treasury dashboard and the
  // public token section stay consistent (never a misconfiguration).
  const mintRead =
    mintReadRaw && mintReadRaw !== RELAY_OFFICIAL_MINT_PLACEHOLDER
      ? readAddress(mintReadRaw)
      : { address: null, invalid: null };
  if (mintRead.invalid) invalid.push({ role: "MINT", value: mintRead.invalid });
  const enabledRaw = envChain(env.FLUXPAD_OFFICIAL_ENABLED, env.DOTPAD_OFFICIAL_ENABLED, env.RELAY_OFFICIAL_ENABLED);
  return {
    network: relayOfficialNetworkFrom(env),
    wallets,
    mint: mintRead.address,
    anyWalletConfigured: wallets.some((w) => w.address !== null),
    invalid,
    enabled: enabledRaw === "true" || enabledRaw === "1",
  };
}

function relayOfficialNetworkFrom(
  env: Partial<
    Pick<
      NodeJS.ProcessEnv,
      | "FLUXPAD_OFFICIAL_NETWORK"
      | "NEXT_PUBLIC_FLUXPAD_NETWORK"
      | "DOTPAD_OFFICIAL_NETWORK"
      | "RELAY_OFFICIAL_NETWORK"
      | "NEXT_PUBLIC_DOTPAD_NETWORK"
      | "NEXT_PUBLIC_RELAYPAD_NETWORK"
    >
  >,
): ClusterId {
  // Phased dual-read: FluxPad names first, then DotPad, then legacy RelayPad.
  const override = envChain(env.FLUXPAD_OFFICIAL_NETWORK, env.DOTPAD_OFFICIAL_NETWORK, env.RELAY_OFFICIAL_NETWORK);
  if (override === "mainnet-beta") return "mainnet-beta";
  if (
    !override &&
    envChain(env.NEXT_PUBLIC_FLUXPAD_NETWORK, env.NEXT_PUBLIC_DOTPAD_NETWORK, env.NEXT_PUBLIC_RELAYPAD_NETWORK) ===
      "mainnet-beta"
  ) {
    return "mainnet-beta";
  }
  return "devnet";
}