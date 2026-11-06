/**
 * Live token analytics tests — Phases 2/5/7 core logic.
 *
 * Buy/sell classification, real-trade candle aggregation, discovery tab
 * filters and scanner filters are pure functions tested with synthetic
 * on-chain-shaped transactions. No network, no fabrication.
 */
import { describe, it, expect } from "vitest";
import { classifyTrade, aggregateCandles, candleSecondsFor, activityWindows, type TokenTrade } from "../lib/token/trades";
import { tabTokens, applyScannerFilters } from "../lib/discovery/index";
import type { DiscoveredToken } from "../lib/discovery/types";

const MINT = "TokenMint1111111111111111111111111111111111111";
const VENUE = "VenUe11111111111111111111111111111111111111";
const USER = "User111111111111111111111111111111111111111";
const OTHER = "Othr111111111111111111111111111111111111111";

function tb(overrides: Partial<{ accountIndex: number; mint: string; owner: string; amount: string; decimals: number }>) {
  return {
    accountIndex: overrides.accountIndex ?? 2,
    mint: overrides.mint ?? MINT,
    owner: overrides.owner,
    programId: "",
    uiTokenAmount: {
      amount: overrides.amount ?? "0",
      uiAmount: Number(overrides.amount ?? "0") / 10 ** (overrides.decimals ?? 6),
      decimals: overrides.decimals ?? 6,
    },
  };
}

function tx(opts: {
  logs?: string[];
  preBalances?: number[];
  postBalances?: number[];
  preToken?: { owner: string; amount: string }[];
  postToken?: { owner: string; amount: string }[];
}) {
  const mk = (list?: { owner: string; amount: string }[]) =>
    (list ?? []).map((e, i) => tb({ accountIndex: 2 + i, owner: e.owner, amount: e.amount }));
  return {
    slot: 100,
    blockTime: 1_700_000_000,
    meta: {
      fee: 5000,
      logMessages: opts.logs ?? [],
      preBalances: opts.preBalances ?? [1_000_000_000, 0],
      postBalances: opts.postBalances ?? [400_000_000, 600_000_000],
      preTokenBalances: mk(opts.preToken),
      postTokenBalances: mk(opts.postToken),
      err: null,
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: USER, signer: true },
          { pubkey: VENUE, signer: false },
        ],
      },
    },
  };
}

describe("classifyTrade — buy/sell classification", () => {
  it("classifies a pump buy from the program's own Buy log and computes legs", () => {
    const t = classifyTrade(
      tx({
        logs: ["Program log: Instruction: Buy"],
        preBalances: [1_000_000_000, 0],
        postBalances: [400_000_000, 600_000_000],
        preToken: [{ owner: VENUE, amount: "1000000" }],
        postToken: [{ owner: VENUE, amount: "500000" }],
      }),
      VENUE,
      MINT,
      6,
      null,
    );
    expect(t).not.toBeNull();
    expect(t!.kind).toBe("buy");
    expect(t!.tokenAmount).toBeCloseTo(0.5, 9);
    expect(t!.solAmount).toBeCloseTo(0.6, 9);
    expect(t!.priceSol).toBeCloseTo(1.2, 9);
    expect(t!.wallet).toBe(USER);
  });

  it("classifies a pump sell from the Sell log with the correct legs", () => {
    const t = classifyTrade(
      tx({
        logs: ["Program log: Instruction: Sell"],
        preBalances: [1_000_000_000, 600_000_000],
        postBalances: [1_200_000_000, 400_000_000],
        preToken: [{ owner: VENUE, amount: "1000000" }],
        postToken: [{ owner: VENUE, amount: "1300000" }],
      }),
      VENUE,
      MINT,
      6,
      null,
    );
    expect(t!.kind).toBe("sell");
    expect(t!.solAmount).toBeCloseTo(0.2, 9);
    expect(t!.priceSol).toBeCloseTo(0.2 / 0.3, 9);
  });

  it("classifies direction from balance deltas when logs do not name the side", () => {
    const buy = classifyTrade(
      tx({
        logs: ["Program log: swap_base_in"],
        preBalances: [1_000_000_000, 500_000_000],
        postBalances: [700_000_000, 800_000_000],
        preToken: [{ owner: VENUE, amount: "2000000" }],
        postToken: [{ owner: VENUE, amount: "1500000" }],
      }),
      VENUE,
      MINT,
      6,
      null,
    );
    expect(buy!.kind).toBe("buy");

    const sell = classifyTrade(
      tx({
        logs: ["Program log: swap_base_in"],
        preBalances: [1_000_000_000, 500_000_000],
        postBalances: [1_300_000_000, 200_000_000],
        preToken: [{ owner: VENUE, amount: "1000000" }],
        postToken: [{ owner: VENUE, amount: "1500000" }],
      }),
      VENUE,
      MINT,
      6,
      null,
    );
    expect(sell!.kind).toBe("sell");
  });

  it("falls back to the user-side token delta when the venue account is absent", () => {
    const t = classifyTrade(
      tx({
        logs: [],
        preBalances: [1_000_000_000, 0],
        postBalances: [1_000_000_000, 0],
        preToken: [{ owner: USER, amount: "1000000" }],
        postToken: [{ owner: USER, amount: "2000000" }],
      }),
      VENUE,
      MINT,
      6,
      null,
    );
    expect(t!.kind).toBe("buy");
    expect(t!.tokenAmount).toBeCloseTo(1, 9);
    expect(t!.solAmount).toBeNull();
    expect(t!.priceSol).toBeNull();
  });

  it("drops fully unclassifiable transactions instead of guessing a side", () => {
    // No side-naming logs, no venue SOL change, no token movement — the
    // decoder returns null (the transaction is not reported at all) rather
    // than inventing a buy/sell label.
    const t = classifyTrade(
      tx({
        logs: ["Program log: vague"],
        preBalances: [1_000_000_000, 500_000_000],
        postBalances: [1_000_000_000, 500_000_000],
        preToken: [{ owner: VENUE, amount: "1000000" }],
        postToken: [{ owner: VENUE, amount: "1000000" }],
      }),
      VENUE,
      MINT,
      6,
      null,
    );
    expect(t).toBeNull();
  });

  it("classifies Pump.fun v2 router buys (PumpBuyV2) via WSOL venue vaults", () => {
    // v2 evidence (live-verified): the curve account is absent from the tx
    // (venueIdx=-1); SOL moves through the venue's WSOL token vault, and the
    // buyer's ATA is created mid-transaction.
    const t = classifyTrade(
      tx({
        logs: [
          "Program log: CreateIdempotent",
          "Program log: Instruction: InitializeAccount3",
          "Program log: Instruction: PumpBuyV2",
        ],
        preBalances: [1_000_000_000, 0],
        postBalances: [400_000_000, 0],
        preToken: [{ owner: VENUE, amount: "931571674453754" }],
        postToken: [
          { owner: VENUE, amount: "927426674453754" }, // vault shipped 4.145B raw
          { owner: USER, amount: "4145000000" }, // buyer ATA created with tokens
        ],
      }),
      VENUE,
      MINT,
      6,
      null,
    );
    expect(t).not.toBeNull();
    expect(t!.kind).toBe("buy");
    expect(t!.tokenAmount).toBeCloseTo(4145, 6); // 4.145B raw / 1e6 decimals
    // SOL leg flows through the venue WSOL vault (covered by the next test).
  });

  it("computes the v2 SOL leg from the venue-side WSOL vault delta", () => {
    // Wrap the fixture in a WSOL-bearing transaction: venue WSOL vault +4145000 lamports.
    const t = classifyTrade(
      {
        ...tx({
          logs: ["Program log: Instruction: PumpBuyV2"],
          preToken: [{ owner: VENUE, amount: "1000000" }],
          postToken: [
            { owner: VENUE, amount: "500000" },
            { owner: USER, amount: "500000" },
          ],
        }),
        meta: {
          fee: 5000,
          logMessages: ["Program log: Instruction: PumpBuyV2"],
          preBalances: [1_000_000_000, 0],
          postBalances: [400_000_000, 0],
          preTokenBalances: [
            { accountIndex: 2, mint: MINT, owner: VENUE, uiTokenAmount: { amount: "1000000", uiAmount: 1, decimals: 6 } },
            { accountIndex: 3, mint: "So11111111111111111111111111111111111111112", owner: VENUE, uiTokenAmount: { amount: "5000000", uiAmount: 0.005, decimals: 9 } },
          ],
          postTokenBalances: [
            { accountIndex: 2, mint: MINT, owner: VENUE, uiTokenAmount: { amount: "500000", uiAmount: 0.5, decimals: 6 } },
            { accountIndex: 3, mint: "So11111111111111111111111111111111111111112", owner: VENUE, uiTokenAmount: { amount: "9145000", uiAmount: 0.009145, decimals: 9 } },
            { accountIndex: 4, mint: MINT, owner: USER, uiTokenAmount: { amount: "500000", uiAmount: 0.5, decimals: 6 } },
          ],
          err: null,
        },
      },
      VENUE,
      MINT,
      6,
      null,
    );
    expect(t!.kind).toBe("buy");
    expect(t!.solAmount).toBeCloseTo(0.004145, 9); // venue WSOL vault +4145000 lamports
    expect(t!.tokenAmount).toBeCloseTo(0.5, 9); // user received 0.5 tokens (user-side delta)
    expect(t!.priceSol).toBeCloseTo(0.004145 / 0.5, 9);
  });

  it("attributes creator only when the wallet matches the FluxPad record", () => {
    const withCreator = classifyTrade(
      tx({
        logs: ["Program log: Instruction: Buy"],
        preToken: [{ owner: VENUE, amount: "1000000" }],
        postToken: [{ owner: VENUE, amount: "500000" }],
      }),
      VENUE,
      MINT,
      6,
      USER,
    );
    expect(withCreator!.creator).toBe(true);

    const notCreator = classifyTrade(
      tx({
        logs: ["Program log: Instruction: Buy"],
        preToken: [{ owner: VENUE, amount: "1000000" }],
        postToken: [{ owner: VENUE, amount: "500000" }],
      }),
      VENUE,
      MINT,
      6,
      OTHER,
    );
    expect(notCreator!.creator).toBe(false);
  });
});

function trade(p: Partial<TokenTrade>): TokenTrade {
  // Explicit nulls stay null (they mean "unknown/unpriced") — same rule as
  // the discovery fixture above.
  const pick = <T,>(v: T | undefined, fallback: T): T => (v !== undefined ? v : fallback);
  return {
    signature: pick(p.signature, "sig"),
    kind: pick(p.kind, "buy"),
    slot: pick(p.slot, 1),
    blockTime: pick(p.blockTime, 1_700_000_000),
    wallet: pick(p.wallet, USER),
    tokenAmount: pick(p.tokenAmount, 100),
    solAmount: pick(p.solAmount, 1),
    priceSol: pick(p.priceSol, 0.01),
    creator: pick(p.creator, false),
  };
}

describe("aggregateCandles — real-trade OHLCV", () => {
  // Bucket edge: 1_700_000_400 is divisible by 60, making the floor math
  // explicit in the expectations below.
  const E = 1_700_000_400;

  it("buckets trades and computes OHLCV strictly from executed swaps", () => {
    const trades = [
      trade({ blockTime: E + 5, priceSol: 0.01, solAmount: 1, kind: "buy" }),
      trade({ blockTime: E + 30, priceSol: 0.012, solAmount: 2, kind: "buy" }),
      trade({ blockTime: E + 45, priceSol: 0.009, solAmount: 0.5, kind: "sell" }),
      trade({ blockTime: E + 65, priceSol: 0.011, solAmount: 3, kind: "buy" }),
      trade({ blockTime: E + 130, priceSol: 0.013, solAmount: 1.5, kind: "buy" }),
    ];
    const candles = aggregateCandles(trades, 60);
    expect(candles).toHaveLength(3);
    const [c0, c1, c2] = candles;
    expect(c0.time).toBe(E);
    expect(c0.open).toBe(0.01);
    expect(c0.high).toBe(0.012);
    expect(c0.low).toBe(0.009);
    expect(c0.close).toBe(0.009);
    expect(c0.volume).toBeCloseTo(3.5, 9);
    expect(c0.buys).toBe(2);
    expect(c0.sells).toBe(1);
    expect(c1.time).toBe(E + 60);
    expect(c1.open).toBe(0.011);
    expect(c1.close).toBe(0.011);
    expect(c1.volume).toBeCloseTo(3, 9);
    expect(c1.buys).toBe(1);
    expect(c2.time).toBe(E + 120);
    expect(c2.open).toBe(0.013);
  });

  it("excludes unclassified and unpriced trades from candles", () => {
    const trades = [
      trade({ blockTime: E + 5, priceSol: 0.01, kind: "buy" }),
      trade({ blockTime: E + 20, priceSol: null, kind: "buy" }),
      trade({ blockTime: E + 30, priceSol: 0.02, kind: "unknown" }),
    ];
    const candles = aggregateCandles(trades, 60);
    expect(candles).toHaveLength(1);
    expect(candles[0].buys).toBe(1);
    expect(candles[0].sells).toBe(0);
    expect(candles[0].volume).toBeCloseTo(1, 9);
  });

  it("maps every advertised interval to a bucket size", () => {
    for (const i of ["1m", "5m", "15m", "1h", "4h", "1d"]) {
      expect(candleSecondsFor(i)).toBeGreaterThan(0);
    }
    expect(candleSecondsFor("2m")).toBeNull();
  });
});

describe("activityWindows — honest per-window coverage", () => {
  it("aggregates volumes/buys/sells per window and reports swap counts", () => {
    const now = 1_800_000_000;
    const trades = [
      trade({ blockTime: now - 60, priceSol: 0.01, solAmount: 2, kind: "buy" }),
      trade({ blockTime: now - 120, priceSol: 0.009, solAmount: 1, kind: "sell" }),
      trade({ blockTime: now - 3_600, priceSol: 0.008, solAmount: 5, kind: "buy" }),
      trade({ blockTime: now - 90_000, priceSol: 0.007, solAmount: 9, kind: "buy" }), // >24h old
      trade({ blockTime: now - 30, priceSol: null, solAmount: 1, kind: "buy" }), // unpriced still counts volume
    ];
    const windows = activityWindows(trades, now);
    expect(windows.map((w) => w.label)).toEqual(["5m", "1h", "6h", "24h"]);
    const w5 = windows[0];
    expect(w5.volumeSol).toBeCloseTo(4, 9); // 2 + 1 + 1 (unpriced but real)
    expect(w5.buys).toBe(2);
    expect(w5.sells).toBe(1);
    expect(w5.swaps).toBe(3);
    expect(w5.changePct).not.toBeNull();
    const w1h = windows[1];
    expect(w1h.volumeSol).toBeCloseTo(9, 9); // + the 3,600s trade
    expect(w1h.swaps).toBe(4);
    const w24 = windows[3];
    expect(w24.swaps).toBe(4); // the >24h trade is outside every window
    expect(w24.volumeSol).toBeCloseTo(9, 9);
  });

  it("reports empty windows instead of interpolating", () => {
    const now = 1_800_000_000;
    const windows = activityWindows([trade({ blockTime: now - 500_000 })], now);
    expect(windows.every((w) => w.swaps === 0 && w.volumeSol === 0 && w.changePct === null)).toBe(true);
  });
});

function token(p: Partial<DiscoveredToken> = {}): DiscoveredToken {
  const now = Date.now();
  // Explicit nulls must stay null (they mean "provider did not supply");
  // only undefined falls back to the default fixture value.
  const pick = <T,>(v: T | undefined, fallback: T): T => (v !== undefined ? v : fallback);
  return {
    mint: pick(p.mint, `mint${Math.random()}`),
    name: pick(p.name, "Token"),
    symbol: pick(p.symbol, "TKN"),
    imageUrl: null,
    source: pick(p.source, "pumpfun.curve"),
    status: pick(p.status, "curve"),
    createdAt: pick(p.createdAt, Math.floor(now / 1000) - 3600),
    firstSeenAt: pick(p.firstSeenAt, now - 3_600_000),
    fetchedAt: pick(p.fetchedAt, now),
    stale: pick(p.stale, false),
    priceQuote: pick(p.priceQuote, 0.001),
    quoteSymbol: pick(p.quoteSymbol, "SOL"),
    liquidityQuote: pick(p.liquidityQuote, 10),
    change24h: pick(p.change24h, 1),
    volume24hUsd: pick(p.volume24hUsd, 5_000),
    marketCapUsd: pick(p.marketCapUsd, 100_000),
    valuation: pick(p.valuation, "fdv"),
    curveProgress: pick(p.curveProgress, 50),
    poolAddress: pick(p.poolAddress, null),
    signature: pick(p.signature, null),
    creatorWallet: pick(p.creatorWallet, null),
    relaypadLaunchId: pick(p.relaypadLaunchId, null),
    provenance: pick(p.provenance, "test"),
  };
}

describe("discovery tabs (Phase 2 filters)", () => {
  it("pumpswap / cpmm tabs select only their source", () => {
    const all = [
      token({ source: "pumpfun.curve" }),
      token({ source: "pumpfun.pool", status: "pool" }),
      token({ source: "launchlab.curve" }),
      token({ source: "raydium.cpmm", status: "pool" }),
    ];
    expect(tabTokens(all, "pumpswap").map((t) => t.source)).toEqual(["pumpfun.pool"]);
    expect(tabTokens(all, "cpmm").map((t) => t.source)).toEqual(["raydium.cpmm"]);
    expect(tabTokens(all, "pumpfun").map((t) => t.source)).toEqual(["pumpfun.curve"]);
    expect(tabTokens(all, "launchlab").map((t) => t.source)).toEqual(["launchlab.curve"]);
  });

  it("graduating selects curve tokens at 80%+ progress; graduated selects pools", () => {
    const all = [
      token({ curveProgress: 50 }),
      token({ curveProgress: 85 }),
      token({ status: "pool", source: "pumpfun.pool", curveProgress: null }),
    ];
    const graduating = tabTokens(all, "graduating");
    expect(graduating).toHaveLength(1);
    expect(graduating[0].curveProgress).toBe(85);
    const graduated = tabTokens(all, "graduated");
    expect(graduated).toHaveLength(1);
    expect(graduated[0].status).toBe("pool");
  });

  it("trending only ranks tokens with a provider-supplied 24h metric", () => {
    const all = [
      token({ volume24hUsd: 1_000, change24h: 5 }),
      token({ volume24hUsd: 9_000, change24h: -2 }),
      token({ volume24hUsd: null, change24h: null }),
    ];
    const trending = tabTokens(all, "trending");
    expect(trending).toHaveLength(2);
    expect(trending[0].volume24hUsd).toBe(9_000);
  });
});

describe("scanner filters (Phase 7)", () => {
  it("filters on market cap, liquidity, volume, age and curve progress", () => {
    const all = [
      token({ marketCapUsd: 50_000, liquidityQuote: 5, volume24hUsd: 100, curveProgress: 10, createdAt: Math.floor(Date.now() / 1000) - 7200 }),
      token({ marketCapUsd: 500_000, liquidityQuote: 50, volume24hUsd: 20_000, curveProgress: 90, createdAt: Math.floor(Date.now() / 1000) - 600 }),
      token({ marketCapUsd: null, liquidityQuote: 999, volume24hUsd: 99_999, curveProgress: 90 }),
    ];
    const out = applyScannerFilters(all, {
      minMarketCapUsd: 100_000,
      maxMarketCapUsd: 1_000_000,
      minLiquidityQuote: 10,
      minVolume24hUsd: 1_000,
      maxAgeHours: 1,
      minCurveProgress: 50,
    });
    // Token 2 passes everything; token 3 is excluded because its market cap
    // is unknown (unknown metrics never satisfy a filter).
    expect(out).toHaveLength(1);
    expect(out[0].marketCapUsd).toBe(500_000);
  });

  it("applies nothing when no filter is set", () => {
    const all = [token(), token()];
    expect(applyScannerFilters(all, {})).toHaveLength(2);
  });
});