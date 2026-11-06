import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { clearDiscoveryCache, getDiscovery } from "@/lib/discovery/runtime";

/**
 * Discovery runtime regression tests (pumpfun.pool fix — provider health
 * honesty + last-good preservation). All five providers are mocked at the
 * module boundary; the real aggregation/cache/backoff logic runs.
 */

const providers = vi.hoisted(() => {
  return {
    pool: {
      ok: true,
      error: null as string | null,
      fetchedAt: null as number | null,
      tokens: [] as Record<string, unknown>[],
    },
    relayTokens: [] as Record<string, unknown>[],
  };
});

vi.mock("@/lib/discovery/pumpfun", () => ({
  scanPumpProgram: vi.fn(async () => ({
    feed: { source: "pumpfun.curve", tokens: [], ok: true, error: null, fetchedAt: Date.now(), stale: false },
  })),
  fetchPumpGlobals: vi.fn(async () => ({})),
  enrichPumpCurves: vi.fn(async (_c: unknown, tokens: unknown[]) => tokens),
}));
vi.mock("@/lib/discovery/pumpswap", () => ({
  fetchPumpswapPools: vi.fn(async (_c: unknown, opts: { now?: number }) => ({
    source: "pumpfun.pool",
    tokens: providers.pool.ok ? providers.pool.tokens : [],
    fetchedAt: providers.pool.fetchedAt ?? opts.now ?? Date.now(),
    ok: providers.pool.ok,
    error: providers.pool.error,
    stale: false,
  })),
}));
vi.mock("@/lib/discovery/launchlab", () => ({
  fetchLaunchLabMints: vi.fn(async () => ({
    source: "launchlab.curve",
    tokens: [],
    fetchedAt: Date.now(),
    ok: true,
    error: null,
    stale: false,
  })),
}));
vi.mock("@/lib/discovery/raydium", () => ({
  fetchRaydiumCpmmPools: vi.fn(async () => ({
    source: "raydium.cpmm",
    tokens: [],
    fetchedAt: Date.now(),
    ok: true,
    error: null,
    stale: false,
  })),
  fetchSolPriceUsd: vi.fn(async () => null),
}));
vi.mock("@/lib/discovery/fluxpad", () => ({
  fetchFluxpadLaunches: vi.fn(async () => ({
    source: "fluxpad",
    tokens: providers.relayTokens,
    fetchedAt: Date.now(),
    ok: true,
    error: null,
    stale: false,
  })),
}));
vi.mock("@/lib/connection", () => ({
  getConnection: () => ({}),
  resolveServerNetworkConfig: () => ({
    cluster: "mainnet-beta",
    rpcUrl: "stub",
    commitment: "confirmed",
    wsUrl: null,
    provider: "alchemy",
  }),
}));

import { fetchPumpswapPools } from "@/lib/discovery/pumpswap";

function token(mint: string, source: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    mint,
    name: "T " + mint,
    symbol: mint.slice(0, 4).toUpperCase(),
    imageUrl: null,
    source,
    status,
    createdAt: null,
    firstSeenAt: 1_700_000_000_000,
    fetchedAt: 0,
    stale: false,
    priceQuote: null,
    quoteSymbol: "SOL",
    liquidityQuote: null,
    change24h: null,
    volume24hUsd: null,
    marketCapUsd: null,
    valuation: null,
    curveProgress: null,
    poolAddress: null,
    signature: null,
    creatorWallet: null,
    fluxpadLaunchId: null,
    provenance: source,
    ...extra,
  };
}

const baseQuery = {
  tab: "all" as const,
  filter: "all" as const,
  sort: "newest" as const,
  q: "",
  page: 1,
  pageSize: 25,
  launchRoute: "all" as const,
  launchStatus: "all" as const,
};

const srcMeta = (
  r: { meta: { sources: { source: string; ok: boolean; error: string | null }[] } },
  source: string,
) => r.meta.sources.find((s) => s.source === source)!;

beforeEach(() => {
  vi.useFakeTimers();
  clearDiscoveryCache();
  providers.pool = { ok: true, error: null, fetchedAt: null, tokens: [] };
  providers.relayTokens = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("discovery runtime — provider health honesty + last-good preservation", () => {
  it("healthy → failure (warning + preserved pools) → recovery (warning gone) → failure again", async () => {
    const pool1 = token("mintPool1", "pumpfun.pool", "pool", { poolAddress: "pool1" });
    const pool2 = token("mintPool2", "pumpfun.pool", "pool", { poolAddress: "pool2" });
    providers.pool.tokens = [pool1, pool2];
    // A verified FluxPad record for the same mint as pool1 — attribution
    // must survive a pumpfun.pool outage.
    providers.relayTokens = [
      token("mintPool1", "fluxpad", "verified-launch", {
        fluxpadLaunchId: "launch-1",
        provenance: "fluxpad-registry(pump_pumpswap)",
        signature: "sig",
      }),
    ];

    // t0 — healthy: pools listed, provider ok, FluxPad attribution applied.
    const r1 = await getDiscovery(baseQuery);
    const m1 = srcMeta(r1, "pumpfun.pool");
    expect(m1.ok).toBe(true);
    expect(m1.error).toBeNull();
    // The aggregator dedupes by mint: the attributed mint merges into its
    // FluxPad identity (rank wins) — attribution must be present either way.
    const attributed = r1.tokens.find((t) => t.mint === "mintPool1");
    expect(attributed?.fluxpadLaunchId).toBe("launch-1");
    expect(r1.tokens.some((t) => t.mint === "mintPool2" && t.source === "pumpfun.pool")).toBe(true);
    const relayTab = await getDiscovery({ ...baseQuery, tab: "fluxpad" });
    expect(relayTab.tokens).toHaveLength(1);
    expect(relayTab.tokens[0].fluxpadLaunchId).toBe("launch-1");
    const callsAfterHealthy = vi.mocked(fetchPumpswapPools).mock.calls.length;

    // Past the feed TTL the provider genuinely fails: health goes red, the
    // last valid pools stay listed (never fabricated) and attribution
    // survives the outage.
    await vi.advanceTimersByTimeAsync(61_000); // expire the pumpfun.pool feed cache
    providers.pool = {
      ok: false,
      error: "429 Too Many Requests: compute units per second capacity",
      fetchedAt: null,
      tokens: [],
    };
    const r2 = await getDiscovery(baseQuery);
    const m2 = srcMeta(r2, "pumpfun.pool");
    expect(m2.ok).toBe(false);
    expect(m2.error).toContain("429");
    const pools2 = await getDiscovery({ ...baseQuery, tab: "new-pools" });
    expect(pools2.tokens.some((t) => t.mint === "mintPool2" && t.source === "pumpfun.pool")).toBe(true);
    const relayAfterFailure = await getDiscovery({ ...baseQuery, tab: "fluxpad" });
    expect(relayAfterFailure.tokens.some((t) => t.mint === "mintPool1" && t.fluxpadLaunchId === "launch-1")).toBe(true);
    const callsAfterFailure = vi.mocked(fetchPumpswapPools).mock.calls.length;
    expect(callsAfterFailure).toBeGreaterThan(callsAfterHealthy);

    // Backoff window: an immediate re-request is served from the bounded
    // failure cache — the struggling provider is not hammered again.
    const r3 = await getDiscovery(baseQuery);
    expect(srcMeta(r3, "pumpfun.pool").ok).toBe(false);
    expect(vi.mocked(fetchPumpswapPools).mock.calls.length).toBe(callsAfterFailure);
  });

  it("past the failure window the preserved pools are correctly labeled stale", async () => {
    const pool1 = token("mintPool1", "pumpfun.pool", "pool", { poolAddress: "pool1" });
    providers.pool.tokens = [pool1];
    await getDiscovery(baseQuery); // healthy fetch at t0 → last-good stored
    await vi.advanceTimersByTimeAsync(61_000); // expire the feed cache
    providers.pool = { ok: false, error: "429 compute units", fetchedAt: null, tokens: [] };
    const r = await getDiscovery(baseQuery); // failure on refresh
    expect(srcMeta(r, "pumpfun.pool").ok).toBe(false);
    // The preserved pools are now older than the freshness TTL → stale.
    const pools = await getDiscovery({ ...baseQuery, tab: "new-pools" });
    const stalePool = pools.tokens.find((t) => t.source === "pumpfun.pool");
    expect(stalePool).toBeDefined();
    expect(stalePool?.stale).toBe(true); // cached data correctly labeled
  });

  it("genuine recovery clears the warning; a genuine re-failure brings it back", async () => {
    const pool1 = token("mintPool1", "pumpfun.pool", "pool", { poolAddress: "pool1" });
    providers.pool.tokens = [pool1];
    await getDiscovery(baseQuery); // healthy
    await vi.advanceTimersByTimeAsync(61_000);
    providers.pool = { ok: false, error: "429 compute units", fetchedAt: null, tokens: [] };
    const rFail = await getDiscovery(baseQuery);
    expect(srcMeta(rFail, "pumpfun.pool").ok).toBe(false);
    // Provider recovers after the failure window: warning disappears.
    await vi.advanceTimersByTimeAsync(20_000);
    providers.pool = { ok: true, error: null, fetchedAt: null, tokens: [pool1] };
    const r = await getDiscovery(baseQuery);
    const m = srcMeta(r, "pumpfun.pool");
    expect(m.ok).toBe(true);
    expect(m.error).toBeNull();
    const fresh = r.tokens.find((t) => t.source === "pumpfun.pool");
    expect(fresh?.stale).toBe(false);
    // Genuine failure again: warning returns.
    await vi.advanceTimersByTimeAsync(70_000);
    providers.pool = { ok: false, error: "429 compute units", fetchedAt: null, tokens: [] };
    const r2 = await getDiscovery(baseQuery);
    expect(srcMeta(r2, "pumpfun.pool").ok).toBe(false);
  });

  it("no duplicate tokens across merged feeds and outages", async () => {
    const pool1 = token("mintPool1", "pumpfun.pool", "pool", { poolAddress: "pool1" });
    providers.pool.tokens = [pool1, pool1]; // provider itself returns a duplicate
    providers.relayTokens = [
      token("mintPool1", "fluxpad", "verified-launch", { fluxpadLaunchId: "launch-1" }),
    ];
    const r = await getDiscovery(baseQuery);
    const pool1Records = r.tokens.filter((t) => t.mint === "mintPool1");
    expect(pool1Records).toHaveLength(1); // deduped by mint
    expect(pool1Records[0].fluxpadLaunchId).toBe("launch-1");
    const relayOnly = await getDiscovery({ ...baseQuery, tab: "fluxpad" });
    expect(relayOnly.tokens).toHaveLength(1);
  });
});