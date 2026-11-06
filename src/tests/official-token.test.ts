import { describe, expect, it, vi, afterEach } from "vitest";
import {
  getOfficialTokenConfig,
  OFFICIAL_TOKEN_MINT_PLACEHOLDER,
} from "@/lib/official-token/config";
import {
  officialTokenView,
  networkLabelFor,
  OFFICIAL_MINT_UNCONFIGURED_TEXT,
  type OfficialTokenView,
} from "@/lib/official-token/token-display";
import { copyText, type CopyResult } from "@/components/official/copy-text";

/* ---------------------------------------------------------------- fixtures */

const W1 = "52Y2w7NXvFk4zUsVGXaq3ai8xBVNV8FX7aME2Vpz2tH";
const FLUX_MINT = "F1uxMintAddressAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/* ---------------------------------------- config: single-source resolution */

describe("getOfficialTokenConfig — single-source FluxPad variables", () => {
  it("reads the FLUXPAD_OFFICIAL_ENABLED switch alone", () => {
    expect(getOfficialTokenConfig({ FLUXPAD_OFFICIAL_ENABLED: "true" }).enabled).toBe(true);
    expect(getOfficialTokenConfig({ FLUXPAD_OFFICIAL_ENABLED: "false" }).enabled).toBe(false);
  });

  it("disables when no switch variable is set", () => {
    expect(getOfficialTokenConfig({}).enabled).toBe(false);
  });

  it("ignores the legacy RelayPad/DotPad switch names entirely", () => {
    // Legacy names must NOT enable the feature (no fallback, no dual-read).
    const legacy = getOfficialTokenConfig({
      DOTPAD_OFFICIAL_ENABLED: "true",
      RELAY_OFFICIAL_ENABLED: "true",
    } as never);
    expect(legacy.enabled).toBe(false);
  });

  it("reads the FLUXPAD_OFFICIAL_NETWORK override alone", () => {
    expect(getOfficialTokenConfig({ FLUXPAD_OFFICIAL_NETWORK: "mainnet-beta" }).network).toBe("mainnet-beta");
  });

  it("ignores the legacy RelayPad/DotPad network override names", () => {
    const legacy = getOfficialTokenConfig({
      DOTPAD_OFFICIAL_NETWORK: "mainnet-beta",
      RELAY_OFFICIAL_NETWORK: "mainnet-beta",
      NEXT_PUBLIC_DOTPAD_NETWORK: "mainnet-beta",
      NEXT_PUBLIC_RELAYPAD_NETWORK: "mainnet-beta",
    } as never);
    expect(legacy.network).toBe("devnet");
  });

  it("reads wallets from the FLUXPAD_* names alone", () => {
    const config = getOfficialTokenConfig({ FLUXPAD_OFFICIAL_CREATOR_WALLET: W1 });
    expect(config.wallets.find((w) => w.role === "W1")?.address).toBe(W1);
  });

  it("ignores the legacy RelayPad/DotPad wallet names", () => {
    const legacy = getOfficialTokenConfig({
      DOTPAD_OFFICIAL_CREATOR_WALLET: W1,
      RELAY_OFFICIAL_CREATOR_WALLET: W1,
    } as never);
    expect(legacy.wallets.find((w) => w.role === "W1")?.address).toBeNull();
    expect(legacy.anyWalletConfigured).toBe(false);
  });

  it("treats empty strings as unset for the FluxPad variables", () => {
    const config = getOfficialTokenConfig({
      FLUXPAD_OFFICIAL_CREATOR_WALLET: "",
      FLUXPAD_OFFICIAL_ENABLED: "",
    });
    expect(config.wallets.find((w) => w.role === "W1")?.address).toBeNull();
    expect(config.enabled).toBe(false);
  });

  it("reads the official $FLUX mint exclusively from FLUXPAD_OFFICIAL_MINT", () => {
    // Legacy mint names must never be reused as the $FLUX mint.
    const legacy = getOfficialTokenConfig({
      DOTPAD_OFFICIAL_MINT: FLUX_MINT,
      RELAY_OFFICIAL_MINT: FLUX_MINT,
    } as never);
    expect(legacy.mint).toBeNull();
    expect(legacy.invalid.some((i) => i.role === "MINT")).toBe(false);
  });
});


function viewFromConfig(
  env: Record<string, string | undefined>,
): OfficialTokenView {
  return officialTokenView(getOfficialTokenConfig(env));
}

/* ------------------------------------------------- config: placeholder aware */

describe("getOfficialTokenConfig — mint placeholder handling", () => {
  it("treats the exact placeholder value exactly like an unset mint", () => {
    const config = getOfficialTokenConfig({
      FLUXPAD_OFFICIAL_MINT: OFFICIAL_TOKEN_MINT_PLACEHOLDER,
    });
    expect(config.mint).toBeNull();
    expect(config.invalid.some((i) => i.role === "MINT")).toBe(false);
  });

  it("treats a missing mint as unconfigured (no invalid entry)", () => {
    const config = getOfficialTokenConfig({});
    expect(config.mint).toBeNull();
    expect(config.invalid.some((i) => i.role === "MINT")).toBe(false);
  });

  it("still flags a genuinely invalid mint value as a misconfiguration", () => {
    const config = getOfficialTokenConfig({
      FLUXPAD_OFFICIAL_MINT: "not-a-valid-base58-address!!!",
    });
    expect(config.mint).toBeNull();
    expect(config.invalid).toEqual([
      { role: "MINT", value: "not-a-valid-base58-address!!!" },
    ]);
  });

  it("accepts a valid configured mint", () => {
    const config = getOfficialTokenConfig({ FLUXPAD_OFFICIAL_MINT: FLUX_MINT });
    expect(config.mint).toBe(FLUX_MINT);
    expect(config.invalid.some((i) => i.role === "MINT")).toBe(false);
  });
});

/* --------------------------------------------- official token view model */

describe("officialTokenView — placeholder state", () => {
  it("renders the not-configured CA text with the required badge, message and disabled copy (unset)", () => {
    const view = viewFromConfig({ FLUXPAD_OFFICIAL_NETWORK: "mainnet-beta" });
    expect(view.status).toBe("placeholder");
    expect(view.displayValue).toBe(OFFICIAL_MINT_UNCONFIGURED_TEXT);
    // The legacy placeholder string is never rendered as the contract address.
    expect(view.displayValue).not.toContain("REPLACE_WITH_OFFICIAL_FLUX_MINT");
    expect(view.badgeLabel).toBe("CA NOT OFFICIAL YET");
    expect(view.message).toBe(
      "The official $FLUX token has not been announced yet.",
    );
    expect(view.copyable).toBe(false);
    expect(view.mint).toBeNull();
    expect(view.explorerHref).toBeNull();
    expect(view.networkLabel).toBe("Solana Mainnet");
  });

  it("renders the identical honest state when the placeholder is explicitly configured", () => {
    const explicit = viewFromConfig({
      FLUXPAD_OFFICIAL_MINT: OFFICIAL_TOKEN_MINT_PLACEHOLDER,
      FLUXPAD_OFFICIAL_NETWORK: "mainnet-beta",
    });
    const unset = viewFromConfig({ FLUXPAD_OFFICIAL_NETWORK: "mainnet-beta" });
    expect(explicit).toEqual(unset);
  });

  it("never renders a token explorer link for the placeholder", () => {
    const view = viewFromConfig({ FLUXPAD_OFFICIAL_NETWORK: "mainnet-beta" });
    expect(view.explorerHref).toBeNull();
    expect(JSON.stringify(view)).not.toContain("explorer.solana.com");
  });
});
describe("officialTokenView — invalid configuration state", () => {
  it("disables copy and shows a clear error without exposing the raw value", () => {
    const view = viewFromConfig({
      FLUXPAD_OFFICIAL_MINT: "%%definitely-not-valid%%",
      FLUXPAD_OFFICIAL_NETWORK: "mainnet-beta",
    });
    expect(view.status).toBe("invalid");
    expect(view.badgeLabel).toBe("INVALID CONFIGURATION");
    expect(view.copyable).toBe(false);
    expect(view.message).toContain("FLUXPAD_OFFICIAL_MINT");
    expect(view.message).toContain("not a valid Solana address");
    // The raw invalid value must never be rendered publicly.
    expect(JSON.stringify(view)).not.toContain("definitely-not-valid");
    expect(view.explorerHref).toBeNull();
  });
});

describe("officialTokenView — configured (valid) state", () => {
  it("displays the complete address and enables copying", () => {
    const view = viewFromConfig({
      FLUXPAD_OFFICIAL_MINT: FLUX_MINT,
      FLUXPAD_OFFICIAL_NETWORK: "mainnet-beta",
    });
    expect(view.status).toBe("configured");
    expect(view.displayValue).toBe(FLUX_MINT);
    expect(view.mint).toBe(FLUX_MINT);
    expect(view.copyable).toBe(true);
    // Honest badge: a syntactically valid address is NOT proof of official status.
    expect(view.badgeLabel).toBe("NOT YET VERIFIED");
    expect(view.message).toContain("explicitly verified");
  });

  it("links the network-aware explorer only for a configured mint", () => {
    const mainnet = viewFromConfig({
      FLUXPAD_OFFICIAL_MINT: FLUX_MINT,
      FLUXPAD_OFFICIAL_NETWORK: "mainnet-beta",
    });
    expect(mainnet.explorerHref).toBe(
      `https://explorer.solana.com/address/${FLUX_MINT}`,
    );
    const devnet = viewFromConfig({
      FLUXPAD_OFFICIAL_MINT: FLUX_MINT,
      FLUXPAD_OFFICIAL_NETWORK: "devnet",
    });
    expect(devnet.explorerHref).toBe(
      `https://explorer.solana.com/address/${FLUX_MINT}?cluster=devnet`,
    );
  });
});

describe("networkLabelFor", () => {
  it("maps clusters to human labels", () => {
    expect(networkLabelFor("mainnet-beta")).toBe("Solana Mainnet");
    expect(networkLabelFor("devnet")).toBe("Solana Devnet");
  });
});

/* ------------------------------------------------------ copy functionality */

describe("copyText — clipboard with fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the async Clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const result: CopyResult = await copyText(FLUX_MINT);
    expect(result).toBe("copied");
    expect(writeText).toHaveBeenCalledWith(FLUX_MINT);
  });

  it("falls back to execCommand when the Clipboard API is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const execCommand = vi.fn().mockReturnValue(true);
    const textarea: Record<string, unknown> = {
      style: {},
      setAttribute: vi.fn(),
      select: vi.fn(),
    };
    vi.stubGlobal("document", {
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand,
    });
    const result = await copyText(FLUX_MINT);
    expect(result).toBe("copied-fallback");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.value).toBe(FLUX_MINT);
  });

  it("reports a failure when both paths fail so the UI can show a helpful error", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    vi.stubGlobal("document", {
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      createElement: vi.fn().mockReturnValue({
        style: {},
        setAttribute: vi.fn(),
        select: vi.fn(),
      }),
      execCommand: vi.fn().mockReturnValue(false),
    });
    const result = await copyText(FLUX_MINT);
    expect(result).toBe("failed");
  });

  it("never copies a truncated display text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyText(W1);
    expect(writeText).toHaveBeenCalledWith(W1); // full address, no truncation
  });
});

