import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLiveMarketCacheForTests,
  providerCandles,
  resolveLiveMarket,
} from "@/lib/token/live-market";

/**
 * Live market provider layer (no network): venue mapping from DexScreener
 * dexIds, metric passthrough with honest nulls, GeckoTerminal fallback, OHLCV
 * normalization (newest-first → ascending, null buckets dropped), and cache
 * coalescing.
 */

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function pair(overrides: Record<string, unknown>) {
  return {
    chainId: "solana",
    dexId: "orca",
    pairAddress: "PoolAddr1",
    baseToken: { name: "Test Token", symbol: "TST" },
    quoteToken: { symbol: "SOL" },
    priceNative: "0.00123",
    priceUsd: "0.45",
    liquidity: { usd: 50_000 },
    ...overrides,
  };
}

beforeEach(() => {
  __resetLiveMarketCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveLiveMarket — venue resolution", () => {
  it("picks the highest-liquidity pair and maps dexId to the venue kind", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url) =>
        Promise.resolve(
          String(url).includes("dexscreener")
            ? jsonRes({
                pairs: [
                  pair({ pairAddress: "SmallPool", liquidity: { usd: 1_000 } }),
                  pair({ dexId: "pumpfun", pairAddress: "BigCurve", liquidity: { usd: 900_000 } }),
                ],
              })
            : jsonRes({ errors: [] }, 404),
        ) as never,
      ),
    );
    const m = await resolveLiveMarket("Mint11111111111111111111111111111111111");
    expect(m.available).toBe(true);
    expect(m.venue.kind).toBe("pump-curve");
    expect(m.venue.address).toBe("BigCurve");
    expect(m.venue.source).toBe("dexscreener");
    expect(m.identity?.symbol).toBe("TST");
  });

  it("maps pumpswap/raydium/orca dex ids to their venue kinds", async () => {
    const cases: [string, string][] = [
      ["pumpswap", "pumpswap-pool"],
      ["raydium", "cpmm-pool"],
      ["orca", "external-pool"],
      ["meteora", "external-pool"],
    ];
    for (const [dexId, kind] of cases) {
      __resetLiveMarketCacheForTests();
      vi.stubGlobal(
        "fetch",
        vi.fn((url) =>
          Promise.resolve(
            String(url).includes("dexscreener")
              ? jsonRes({ pairs: [pair({ dexId, pairAddress: "P1", liquidity: { usd: 10_000 } })] })
              : jsonRes({ errors: [] }, 404),
          ) as never,
        ),
      );
      const m = await resolveLiveMarket("Mint22222222222222222222222222222222222");
      expect(m.venue.kind).toBe(kind);
    }
  });

  it("reports honest unavailability when no provider knows the mint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url) =>
        Promise.resolve(
          String(url).includes("dexscreener")
            ? jsonRes({ schemaVersion: "1.0.0", pairs: null })
            : jsonRes({ errors: [{ status: "404" }] }, 404),
        ) as never,
      ),
    );
    const m = await resolveLiveMarket("Unknown111111111111111111111111111111111");
    expect(m.available).toBe(false);
    expect(m.venue.kind).toBe("unknown");
    expect(m.venue.address).toBeNull();
    expect(m.metrics).toBeNull();
    expect(m.notes.some((n) => n.includes("No DEX pair"))).toBe(true);
  });
});

describe("live market — GT fallback and metrics passthrough", () => {
  it("falls back to GeckoTerminal for the venue when DexScreener has no pair", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("dexscreener")) return Promise.resolve(jsonRes({ pairs: null }));
        if (u.includes("geckoterminal")) {
          return Promise.resolve(
            jsonRes({ data: [{ attributes: { address: "GtPool1", name: "Raydium LaunchLab TOKEN / USDC" } }] }),
          );
        }
        return Promise.resolve(jsonRes({ errors: [] }, 404));
      }) as never,
    );
    const m = await resolveLiveMarket("Mint33333333333333333333333333333333333");
    expect(m.available).toBe(true);
    expect(m.venue.source).toBe("geckoterminal");
    expect(m.venue.address).toBe("GtPool1");
    expect(m.venue.dexLabel).toBe("Raydium LaunchLab");
  });

  it("passes provider metrics through verbatim; missing fields stay null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url) =>
        Promise.resolve(
          String(url).includes("dexscreener")
            ? jsonRes({
                pairs: [
                  pair({
                    priceUsd: "0.45",
                    priceChange: { m5: 1.2, h1: -0.5 },
                    volume: { h24: 12_345 },
                    txns: { h24: { buys: 10, sells: 12 } },
                    fdv: 9_900_000,
                    marketCap: 8_800_000,
                    liquidity: { usd: 250_000 },
                  }),
                ],
              })
            : jsonRes({ errors: [] }, 404),
        ) as never,
      ),
    );
    const m = await resolveLiveMarket("Mint44444444444444444444444444444444444");
    expect(m.metrics?.priceUsd).toBe(0.45);
    expect(m.metrics?.changesPct.m5).toBe(1.2);
    expect(m.metrics?.changesPct.h1).toBe(-0.5);
    expect(m.metrics?.changesPct.h6).toBeNull();
    expect(m.metrics?.volumeUsd.h24).toBe(12_345);
    expect(m.metrics?.volumeUsd.m5).toBeNull();
    expect(m.metrics?.txns.h24).toEqual({ buys: 10, sells: 12 });
    expect(m.metrics?.txns.m5).toBeNull();
    expect(m.metrics?.liquidityUsd).toBe(250_000);
    expect(m.metrics?.fdvUsd).toBe(9_900_000);
    expect(m.metrics?.marketCapUsd).toBe(8_800_000);
  });
});

describe("providerCandles — GeckoTerminal OHLCV normalization", () => {
  it("sorts newest-first input ascending and drops null buckets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url) =>
        Promise.resolve(
          String(url).includes("geckoterminal")
            ? jsonRes({
                data: {
                  attributes: {
                    ohlcv_list: [
                      [1700_000_300, 1.5, 1.6, 1.4, 1.55, 100],
                      [1700_000_240, null, null, null, null, null],
                      [1700_000_240, 1.2, 1.3, 1.1, 1.25, 50],
                      [1700_000_180, 1.0, 1.2, 0.9, 1.2, 80],
                    ],
                  },
                },
              })
            : jsonRes({ errors: [] }, 404),
        ) as never,
      ),
    );
    const out = await providerCandles("PoolX", "1m");
    expect(out).not.toBeNull();
    const candles = out!.candles;
    expect(candles.map((c) => c.time)).toEqual([1700_000_180, 1700_000_240, 1700_000_300]);
    expect(candles[1].close).toBe(1.25);
    expect(candles.every((c) => c.open != null && c.high != null && c.low != null && c.close != null)).toBe(true);
  });

  it("returns null when the provider supplies no candles (honest unavailability)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url) =>
        Promise.resolve(
          String(url).includes("geckoterminal")
            ? jsonRes({ data: { attributes: { ohlcv_list: [] } } })
            : jsonRes({ errors: [] }, 404),
        ) as never,
      ),
    );
    const out = await providerCandles("PoolY", "5m");
    expect(out).toBeNull();
  });
});

describe("live market cache — coalescing", () => {
  it("coalesces concurrent identical requests into one provider call", async () => {
    let dexCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        if (String(url).includes("dexscreener")) {
          dexCalls += 1;
          return new Promise((resolve) =>
            setTimeout(() => resolve(jsonRes({ pairs: [pair({ pairAddress: "P", liquidity: { usd: 5 } })] })), 20),
          ) as never;
        }
        return Promise.resolve(jsonRes({ errors: [] }, 404)) as never;
      }),
    );
    const [a, b] = await Promise.all([
      resolveLiveMarket("Mint55555555555555555555555555555555555"),
      resolveLiveMarket("Mint55555555555555555555555555555555555"),
    ]);
    expect(a.available).toBe(true);
    expect(b.available).toBe(true);
    expect(dexCalls).toBe(1);
  });
});
