import { describe, expect, it, afterEach, vi } from "vitest";
import { resolveClusterFromEnv, currentNetworkCluster, currentNetworkRaw } from "@/lib/network-env";

describe("resolveClusterFromEnv (single-source FluxPad variable)", () => {
  it("uses the FLUXPAD variable alone", () => {
    expect(resolveClusterFromEnv("mainnet-beta")).toBe("mainnet-beta");
    expect(resolveClusterFromEnv("devnet")).toBe("devnet");
  });

  it("defaults to devnet when no variable is set", () => {
    expect(resolveClusterFromEnv(undefined)).toBe("devnet");
  });

  it("treats an empty or whitespace value as unset", () => {
    expect(resolveClusterFromEnv("")).toBe("devnet");
    expect(resolveClusterFromEnv("   ")).toBe("devnet");
  });

  it("a set-but-unrecognized value resolves to devnet (safe default)", () => {
    expect(resolveClusterFromEnv("garbage")).toBe("devnet");
  });

  it("tolerates surrounding whitespace", () => {
    expect(resolveClusterFromEnv(" mainnet-beta ")).toBe("mainnet-beta");
  });
});

describe("currentNetworkCluster / currentNetworkRaw (FluxPad variable only)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads NEXT_PUBLIC_FLUXPAD_NETWORK", () => {
    vi.stubEnv("NEXT_PUBLIC_FLUXPAD_NETWORK", "mainnet-beta");
    expect(currentNetworkCluster()).toBe("mainnet-beta");
    expect(currentNetworkRaw()).toBe("mainnet-beta");
  });

  it("ignores the legacy DotPad/RelayPad variable names entirely", () => {
    vi.stubEnv("NEXT_PUBLIC_DOTPAD_NETWORK", "mainnet-beta");
    vi.stubEnv("NEXT_PUBLIC_RELAYPAD_NETWORK", "mainnet-beta");
    expect(currentNetworkCluster()).toBe("devnet");
    expect(currentNetworkRaw()).toBeUndefined();
  });

  it("treats an empty FluxPad variable as unset (legacy names still ignored)", () => {
    vi.stubEnv("NEXT_PUBLIC_FLUXPAD_NETWORK", "");
    vi.stubEnv("NEXT_PUBLIC_DOTPAD_NETWORK", "mainnet-beta");
    vi.stubEnv("NEXT_PUBLIC_RELAYPAD_NETWORK", "devnet");
    expect(currentNetworkCluster()).toBe("devnet");
    expect(currentNetworkRaw()).toBeUndefined();
  });

  it("returns undefined when no variable is set", () => {
    vi.stubEnv("NEXT_PUBLIC_FLUXPAD_NETWORK", undefined);
    expect(currentNetworkRaw()).toBeUndefined();
    expect(currentNetworkCluster()).toBe("devnet");
  });
});
