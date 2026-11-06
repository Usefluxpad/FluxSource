import { PublicKey } from "@solana/web3.js";
import type { ClusterId } from "../constants";

/**
 * Explicit placeholder for FLUXPAD_OFFICIAL_MINT before the official token is
 * announced. Treated exactly like an unset value everywhere: never displayed
 * as a real address, never enables copying, and never listed as a
 * misconfiguration. Replace it in the environment with the real mint address
 * once the official token is launched and verified.
 */
export const OFFICIAL_TOKEN_MINT_PLACEHOLDER = "REPLACE_WITH_OFFICIAL_FLUX_MINT";


/**
 * Server-only configuration for the official $FLUX treasury dashboard.
 *
 * Contains PUBLIC addresses and non-secret policy values only. There are no
 * private keys, seed phrases, or signing credentials here — signing stays in
 * the wallet / signing-service components described in
 * docs/archive/RELAY_OFFICIAL_TOKEN_BUYBACK_IMPLEMENTATION_PLAN.md (historical
 * design record for the official-token treasury system).
 *
 * Until the owner finalizes the wallets, every value is an unset placeholder;
 * the dashboard renders honest "configuration needed" states for anything
 * missing rather than inventing data.
 */

export const OFFICIAL_TOKEN_ROLES = ["W1", "W2", "W3", "W4"] as const;
export type OfficialTokenRole = (typeof OFFICIAL_TOKEN_ROLES)[number];

export const OFFICIAL_TOKEN_ROLE_META: Record<
  OfficialTokenRole,
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

export interface OfficialTokenWalletConfig {
  role: OfficialTokenRole;
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

export interface OfficialTokenConfig {
  network: ClusterId;
  wallets: OfficialTokenWalletConfig[];
  /** Official $FLUX mint, or null until the new verified mint is provided. */
  mint: string | null;
  /** True when at least one treasury wallet is configured. */
  anyWalletConfigured: boolean;
  /**
   * Addresses present but not valid base58 public keys (misconfiguration —
   * distinct from pending configuration; surfaced on the dashboard).
   */
  invalid: { role: OfficialTokenRole | "MINT"; value: string }[];
  /** Master switch (FLUXPAD_OFFICIAL_ENABLED, default off). */
  enabled: boolean;
}

/**
 * Single-source env resolution: every official-token variable is read from its
 * FluxPad name ONLY. Empty strings count as unset (env files write VAR= for
 * "configured but empty"). No legacy-variable fallback exists.
 */

/** Load the current configuration. Pure over the provided env; no side effects. */
export function getOfficialTokenConfig(
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
    >
  >,
): OfficialTokenConfig {
  const sources: Record<OfficialTokenRole, string | undefined> = {
    W1: env.FLUXPAD_OFFICIAL_CREATOR_WALLET,
    W2: env.FLUXPAD_OFFICIAL_BUYBACK_TREASURY,
    W3: env.FLUXPAD_OFFICIAL_OPS_TREASURY,
    W4: env.FLUXPAD_OFFICIAL_DEV_WALLET,
  };
  const invalid: OfficialTokenConfig["invalid"] = [];
  const wallets = OFFICIAL_TOKEN_ROLES.map((role) => {
    const read = readAddress(sources[role]);
    if (read.invalid) invalid.push({ role, value: read.invalid });
    return {
      role,
      label: OFFICIAL_TOKEN_ROLE_META[role].label,
      description: OFFICIAL_TOKEN_ROLE_META[role].description,
      address: read.address,
    };
  });
  // The official $FLUX mint is read EXCLUSIVELY from FLUXPAD_OFFICIAL_MINT.
  // No legacy-variable fallback exists anywhere in the codebase — a new
  // official token must never silently inherit an old token's mint. The
  // dashboard stays in its "not configured yet" state until a verified $FLUX
  // mint is explicitly configured.
  const mintReadRaw = env.FLUXPAD_OFFICIAL_MINT?.trim() ?? "";
  // The explicit placeholder is an intentional "not announced yet" marker —
  // treated exactly like an unset value so the treasury dashboard and the
  // public token section stay consistent (never a misconfiguration).
  const mintRead =
    mintReadRaw && mintReadRaw !== OFFICIAL_TOKEN_MINT_PLACEHOLDER
      ? readAddress(mintReadRaw)
      : { address: null, invalid: null };
  if (mintRead.invalid) invalid.push({ role: "MINT", value: mintRead.invalid });
  const enabledRaw = env.FLUXPAD_OFFICIAL_ENABLED?.trim() ?? "";
  return {
    network: officialTokenNetworkFrom(env),
    wallets,
    mint: mintRead.address,
    anyWalletConfigured: wallets.some((w) => w.address !== null),
    invalid,
    enabled: enabledRaw === "true" || enabledRaw === "1",
  };
}

function officialTokenNetworkFrom(
  env: Partial<
    Pick<
      NodeJS.ProcessEnv,
      | "FLUXPAD_OFFICIAL_NETWORK"
      | "NEXT_PUBLIC_FLUXPAD_NETWORK"
    >
  >,
): ClusterId {
  // FluxPad variables only — no legacy fallbacks.
  const override = env.FLUXPAD_OFFICIAL_NETWORK?.trim() || "";
  if (override === "mainnet-beta") return "mainnet-beta";
  if (
    !override &&
    (env.NEXT_PUBLIC_FLUXPAD_NETWORK?.trim() || "") === "mainnet-beta"
  ) {
    return "mainnet-beta";
  }
  return "devnet";
}