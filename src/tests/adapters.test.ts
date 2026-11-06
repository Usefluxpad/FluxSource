import { describe, expect, it } from "vitest";
import { PumpAdapter } from "@/lib/adapters/pump";
import { LaunchLabAdapter, LAUNCHPAD_STATUS } from "@/lib/adapters/launchlab";
import { getAdapter } from "@/lib/adapters";
import type { LaunchRoute } from "@/lib/adapters/types";

/**
 * Adapter unit tests without network access: verify construction, program
 * descriptions, and route registry behaviour. Transaction construction is
 * covered by integration tests against a supported network (see
 * docs/VERIFICATION.md) — FluxPad does not claim transaction construction
 * works from these stubs alone.
 */
describe("route registry", () => {
  it("resolves both adapters lazily", async () => {
    const pump = await getAdapter("pump");
    const lab = await getAdapter("launchlab");
    expect(pump.id).toBe("pump");
    expect(lab.id).toBe("launchlab");
  });

  it("rejects unknown routes", async () => {
    await expect(getAdapter("nope" as unknown as LaunchRoute)).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});

describe("PumpAdapter", () => {
  const adapter = new PumpAdapter();
  it("describes documented programs", () => {
    const programs = adapter.describePrograms("mainnet-beta");
    expect(programs.some((p) => p.address === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")).toBe(true);
    expect(programs.some((p) => p.address === "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA")).toBe(true);
  });
});

describe("LaunchLabAdapter", () => {
  const adapter = new LaunchLabAdapter();
  it("exposes documented status values", () => {
    expect(LAUNCHPAD_STATUS.INIT).toBe(0);
    expect(LAUNCHPAD_STATUS.MIGRATE).toBeGreaterThan(LAUNCHPAD_STATUS.SELL);
  });
  it("describes the LaunchLab program per cluster", () => {
    expect(adapter.describePrograms("mainnet-beta")[0].address).toBe(
      "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
    );
    expect(adapter.describePrograms("devnet")[0].address).toBe(
      "DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6",
    );
  });
});
