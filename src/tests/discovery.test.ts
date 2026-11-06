import { describe, expect, it } from "vitest";
import {
  mergeFeeds,
  tabTokens,
  applyFilter,
  sortTokens,
  searchTokens,
  paginate,
  applySolPrice,
} from "@/lib/discovery/index";
import type { DiscoveredToken, SourceFeed } from "@/lib/discovery/types";

/**
 * Discovery aggregation unit tests (no network): dedupe across sources,
 * lifecycle classification (new launch vs new pool), honest-null filters,
 * sorting, search, pagination and SOL→USD valuation conversion.
 */

const NOW = 1_700_000_000_000;

function token(over: Partial<DiscoveredToken> & { mint: string }): DiscoveredToken {
  return {
    name: "Test Token",
    symbol: "TST",
    imageUrl: null,
    source: "pumpfun.curve",
    status: "curve",
    createdAt: Math.floor(NOW / 1000) - 60,
    firstSeenAt: NOW,
    fetchedAt: NOW,
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
    provenance: "test",
    ...over,
  };
}

function feed(source: SourceFeed["source"], tokens: DiscoveredToken[]): SourceFeed {
  return { source, tokens, fetchedAt: NOW, ok: true, error: null };
}

describe("mergeFeeds", () => {
  it("deduplicates by mint, keeping the most informative record", () => {
    const curve = token({ mint: "M1", source: "pumpfun.curve", status: "curve", name: "Unknown" });
    const pool = token({ mint: "M1", source: "pumpfun.pool", status: "pool", name: "Real Name", poolAddress: "POOL1" });
    const merged = mergeFeeds([feed("pumpfun.curve", [curve]), feed("pumpfun.pool", [pool])], NOW);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe("pumpfun.pool");
    expect(merged[0].status).toBe("pool");
    expect(merged[0].poolAddress).toBe("POOL1");
    // Earliest creation time and richer metadata are preserved.
    expect(merged[0].createdAt).toBe(curve.createdAt);
    expect(merged[0].name).toBe("Real Name");
  });

  it("applies FluxPad attribution without duplicating the token", () => {
    const curve = token({ mint: "M2" });
    const relay = token({ mint: "M2", source: "fluxpad", status: "verified-launch", fluxpadLaunchId: "L1" });
    const merged = mergeFeeds([feed("pumpfun.curve", [curve]), feed("fluxpad", [relay])], NOW);
    expect(merged).toHaveLength(1);
    expect(merged[0].fluxpadLaunchId).toBe("L1");
  });

  it("never attributes a token to FluxPad without a verified record", () => {
    const curve = token({ mint: "M3" });
    const merged = mergeFeeds([feed("pumpfun.curve", [curve])], NOW);
    expect(merged[0].fluxpadLaunchId).toBeNull();
  });
});

describe("tabTokens", () => {
  const curve = token({ mint: "A", status: "curve" });
  const pool = token({ mint: "B", status: "pool", source: "pumpfun.pool" });
  const cpmm = token({ mint: "C", status: "pool", source: "raydium.cpmm" });
  const lab = token({ mint: "D", source: "launchlab.curve" });
  const relay = token({ mint: "E", source: "fluxpad", status: "verified-launch", fluxpadLaunchId: "L9" });
  const all = [curve, pool, cpmm, lab, relay];

  it("classifies new launches vs new pools", () => {
    const launches = tabTokens(all, "new-launches").map((t) => t.mint);
    expect(launches).toContain("A");
    expect(launches).toContain("E");
    expect(launches).not.toContain("B");
    const pools = tabTokens(all, "new-pools").map((t) => t.mint);
    expect(pools).toEqual(["B", "C"]);
  });

  it("routes source tabs by record identity", () => {
    // Order follows merge order (first-seen feed), not a guaranteed sort.
    // Pump.fun tab = bonding-curve tokens only; PumpSwap tab = its pools
    // (separate tabs by design — see discovery types).
    expect(tabTokens(all, "pumpfun").map((t) => t.mint)).toEqual(["A"]);
    expect(tabTokens(all, "pumpswap").map((t) => t.mint)).toEqual(["B"]);
    expect(tabTokens(all, "cpmm").map((t) => t.mint)).toEqual(["C"]);
    expect(tabTokens(all, "launchlab").map((t) => t.mint)).toEqual(["D"]);
  });

  it("FluxPad tab requires a verified launch id", () => {
    expect(tabTokens(all, "fluxpad").map((t) => t.mint)).toEqual(["E"]);
  });
});

describe("applyFilter", () => {
  it("movers require a verified 24h change (no fabrication)", () => {
    const withChange = token({ mint: "A", change24h: 12.5 });
    const without = token({ mint: "B", change24h: null });
    const movers = applyFilter([withChange, without], "movers", NOW);
    expect(movers.map((t) => t.mint)).toEqual(["A"]);
  });

  it("new filter uses created time or first-seen", () => {
    const fresh = token({ mint: "A", createdAt: Math.floor(NOW / 1000) - 60 });
    const old = token({ mint: "B", createdAt: Math.floor(NOW / 1000) - 200_000 });
    expect(applyFilter([fresh, old], "new", NOW).map((t) => t.mint)).toEqual(["A"]);
    const unseen = token({ mint: "C", createdAt: null, firstSeenAt: NOW - 1000 });
    expect(applyFilter([unseen], "new", NOW)).toHaveLength(1);
  });
});

describe("sortTokens / searchTokens / paginate", () => {
  const a = token({ mint: "A", createdAt: 100 });
  const b = token({ mint: "B", createdAt: 300 });
  const c = token({ mint: "C", createdAt: null, firstSeenAt: 200 });

  it("sorts newest/oldest with first-seen fallback (ms)", () => {
    // createdAt is unix seconds; firstSeenAt is epoch ms — the newest sort
    // key normalizes both to ms, so firstSeenAt=200 sorts last.
    expect(sortTokens([a, b, c], "newest").map((t) => t.mint)).toEqual(["B", "A", "C"]);
    expect(sortTokens([a, b, c], "oldest").map((t) => t.mint)).toEqual(["C", "A", "B"]);
  });

  it("ranks missing market caps last", () => {
    const withMc = token({ mint: "M", marketCapUsd: 5 });
    expect(sortTokens([a, withMc], "market-cap")[0].mint).toBe("M");
  });

  it("searches name, symbol and mint case-insensitively", () => {
    const t = token({ mint: "MintXYZ", name: "Dog Coin", symbol: "DOG" });
    expect(searchTokens([t], "dog")).toHaveLength(1);
    expect(searchTokens([t], "xyz")).toHaveLength(1);
    expect(searchTokens([t], "nope")).toHaveLength(0);
  });

  it("paginates deterministically", () => {
    const four = [a, b, c, token({ mint: "D" })];
    expect(paginate(four, 2, 3).map((t) => t.mint)).toEqual(["D"]);
    expect(paginate(four, 9, 3)).toHaveLength(0);
  });
});

describe("applySolPrice", () => {
  it("converts SOL-denominated FDV to USD without touching verified USD figures", () => {
    const sol = token({ mint: "A" }) as DiscoveredToken & { marketCapSol?: number };
    sol.marketCapSol = 10;
    const usd = token({ mint: "B", marketCapUsd: 42, valuation: "market-cap" });
    const out = applySolPrice([sol, usd], 150);
    expect(out[0].marketCapUsd).toBe(1500);
    expect(out[0].valuation).toBe("fdv");
    expect(out[1].marketCapUsd).toBe(42);
    expect(out[1].valuation).toBe("market-cap");
  });

  it("leaves figures untouched without a verified SOL price", () => {
    const t = token({ mint: "A" });
    expect(applySolPrice([t], null)[0].marketCapUsd).toBeNull();
  });
});
