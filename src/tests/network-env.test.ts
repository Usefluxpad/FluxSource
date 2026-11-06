import { describe, expect, it, afterEach, vi } from "vitest";
import { resolveClusterFromEnv, currentNetworkCluster, currentNetworkRaw } from "@/lib/network-env";

describe("resolveClusterFromEnv (phased triple-read)", () => {
  it("uses the FLUXPAD variable alone", () => {
    expect(resolveClusterFromEnv("mainnet-beta", undefined, undefined)).toBe("mainnet-beta");
    expect(resolveClusterFromEnv("devnet", undefined, undefined)).toBe("devnet");
  });

  it("falls back to the DotPad variable when FLUXPAD is unset", () => {
    expect(resolveClusterFromEnv(undefined, "mainnet-beta", undefined)).toBe("mainnet-beta");
    expect(resolveClusterFromEnv(undefined, "devnet", undefined)).toBe("devnet");
  });

  it("falls back to the legacy RelayPad variable when both newer names are unset", () => {
    expect(resolveClusterFromEnv(undefined, undefined, "mainnet-beta")).toBe("mainnet-beta");
    expect(resolveClusterFromEnv(undefined, undefined, "devnet")).toBe("devnet");
  });

  it("FLUXPAD wins when all three are set", () => {
    expect(resolveClusterFromEnv("devnet", "mainnet-beta", "mainnet-beta")).toBe("devnet");
    expect(resolveClusterFromEnv("mainnet-beta", "devnet", "devnet")).toBe("mainnet-beta");
  });

  it("DotPad wins over RelayPad when FLUXPAD is unset", () => {
    expect(resolveClusterFromEnv(undefined, "devnet", "mainnet-beta")).toBe("devnet");
    expect(resolveClusterFromEnv(undefined, "mainnet-beta", "devnet")).toBe("mainnet-beta");
  });

  it("defaults to devnet when no variable is set", () => {
    expect(resolveClusterFromEnv(undefined, undefined, undefined)).toBe("devnet");
  });

  it("treats empty new values as unset and falls back through the chain", () => {
    expect(resolveClusterFromEnv("", "mainnet-beta", "devnet")).toBe("mainnet-beta");
    expect(resolveClusterFromEnv("", "", "devnet")).toBe("devnet");
    expect(resolveClusterFromEnv("  ", "  ", "mainnet-beta")).toBe("mainnet-beta");
  });

  it("a set-but-unrecognized new value wins over fallbacks and resolves to devnet", () => {
    expect(resolveClusterFromEnv("garbage", "mainnet-beta", "mainnet-beta")).toBe("devnet");
  });

  it("tolerates surrounding whitespace", () => {
    expect(resolveClusterFromEnv(" mainnet-beta ", undefined, undefined)).toBe("mainnet-beta");
  });
});

describe("currentNetworkCluster / currentNetworkRaw (process.env triple-read)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the FLUXPAD variable", () => {
    vi.stubEnv("NEXT_PUBLIC_FLUXPAD_NETWORK", "mainnet-beta");
    vi.stubEnv("NEXT_PUBLIC_DOTPAD_NETWORK", "devnet");
    vi.stubEnv("NEXT_PUBLIC_RELAYPAD_NETWORK", "devnet");
    expect(currentNetworkCluster()).toBe("mainnet-beta");
    expect(currentNetworkRaw()).toBe("mainnet-beta");
  });

  it("falls back to the DotPad variable", () => {
    vi.stubEnv("NEXT_PUBLIC_FLUXPAD_NETWORK", "");
    vi.stubEnv("NEXT_PUBLIC_DOTPAD_NETWORK", "mainnet-beta");
    vi.stubEnv("NEXT_PUBLIC_RELAYPAD_NETWORK", "devnet");
    expect(currentNetworkCluster()).toBe("mainnet-beta");
    expect(currentNetworkRaw()).toBe("mainnet-beta");
  });

  it("falls back to the legacy RelayPad variable", () => {
    vi.stubEnv("NEXT_PUBLIC_FLUXPAD_NETWORK", undefined);
    vi.stubEnv("NEXT_PUBLIC_DOTPAD_NETWORK", undefined);
    vi.stubEnv("NEXT_PUBLIC_RELAYPAD_NETWORK", "mainnet-beta");
    expect(currentNetworkCluster()).toBe("mainnet-beta");
    expect(currentNetworkRaw()).toBe("mainnet-beta");
  });

  it("treats an empty new variable as unset", () => {
    vi.stubEnv("NEXT_PUBLIC_FLUXPAD_NETWORK", "");
    vi.stubEnv("NEXT_PUBLIC_DOTPAD_NETWORK", "");
    vi.stubEnv("NEXT_PUBLIC_RELAYPAD_NETWORK", "devnet");
    expect(currentNetworkCluster()).toBe("devnet");
    expect(currentNetworkRaw()).toBe("devnet");
  });

  it("returns undefined when no variable is set", () => {
    vi.stubEnv("NEXT_PUBLIC_FLUXPAD_NETWORK", undefined);
    vi.stubEnv("NEXT_PUBLIC_DOTPAD_NETWORK", undefined);
    vi.stubEnv("NEXT_PUBLIC_RELAYPAD_NETWORK", undefined);
    expect(currentNetworkRaw()).toBeUndefined();
    expect(currentNetworkCluster()).toBe("devnet");
  });
});
