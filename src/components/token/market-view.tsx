"use client";
/**
 * Live token market view — polls /api/tokens/[mint]/market on a bounded
 * interval (no WebSocket: Solana discovery venues have no documented public
 * streaming endpoint, so bounded polling is the streaming fallback). Renders
 * the real-trade chart, live trade feed with large-buy/sell indicators,
 * wallet intelligence, and top holders. Every N/A is an honest "provider did
 * not supply this metric".
 */
import { currentNetworkCluster } from "@/lib/network-env";
import { useCallback, useEffect, useRef, useState } from "react";
import { PriceChart } from "./price-chart";
import { Badge, Card, CopyChip } from "@/components/ui/primitives";
import { explorerUrl, solscanUrl, type ClusterId } from "@/lib/constants";
import { shortAddress, timeAgo } from "@/lib/format";

// Build-time inlined network (no server round-trip in a client component).
const CLUSTER: ClusterId = currentNetworkCluster();

export interface MarketPayload {
  mint: string;
  interval: string;
  venue: { kind: string; address: string | null };
  venueResolved: {
    kind: string;
    address: string | null;
    dexId: string | null;
    dexLabel: string;
    quoteSymbol: string | null;
    source: string;
  };
  live: {
    available: boolean;
    identity: { name: string | null; symbol: string | null; imageUrl: string | null; pairCreatedAt: number | null } | null;
    metrics: {
      priceUsd: number | null;
      priceNative: number | null;
      changesPct: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
      volumeUsd: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
      txns: { m5: { buys: number; sells: number } | null; h1: { buys: number; sells: number } | null; h6: { buys: number; sells: number } | null; h24: { buys: number; sells: number } | null };
      liquidityUsd: number | null;
      fdvUsd: number | null;
      marketCapUsd: number | null;
    } | null;
    notes: string[];
  };
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number; buys: number; sells: number }[];
  activity: {
    label: string;
    volumeSol: number;
    buys: number;
    sells: number;
    changePct: number | null;
    swaps: number;
  }[];
  trades: {
    signature: string;
    kind: "buy" | "sell" | "unknown";
    slot: number;
    blockTime: number | null;
    wallet: string | null;
    tokenAmount: number | null;
    solAmount: number | null;
    priceSol: number | null;
    creator: boolean;
  }[];
  wallets: { wallet: string; buys: number; sells: number; boughtToken: number; soldToken: number; firstAt: number | null; lastAt: number | null; creator: boolean }[];
  holders: { address: string; uiAmount: number | null; rank: number }[];
  topBuyers: { wallet: string; buys: number; boughtToken: number }[];
  topSellers: { wallet: string; sells: number; soldToken: number }[];
  earlyBuyers: { wallet: string; buys: number; firstAt: number | null }[];
  creatorActivity: { wallet: string; trades: number; boughtToken: number; soldToken: number } | null;
  coverageFrom: number | null;
  coverageTo: number | null;
  coverageNote: string;
  warnings: string[];
}

const POLL_MS = 15_000;
/** Large-trade indicator threshold in SOL (visual only, from real data). */
const LARGE_TRADE_SOL = 5;

const VENUE_LABEL: Record<string, string> = {
  "pump-curve": "Pump.fun bonding curve",
  "pumpswap-pool": "PumpSwap pool",
  "launchlab-curve": "LaunchLab bonding curve",
  "cpmm-pool": "Raydium CPMM pool",
  "external-pool": "DEX liquidity pool",
  unknown: "No tradable venue identified",
};

/** Provider window labels → display order. */
const LIVE_WINDOWS = ["m5", "h1", "h6", "h24"] as const;
const WINDOW_LABELS: Record<string, string> = { m5: "5M", h1: "1H", h6: "6H", h24: "24H" };

function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "N/A";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  if (v > 0 && v < 0.01) return `$${v.toPrecision(3)}`;
  return `$${v.toFixed(v < 1 ? 6 : 2).replace(/\.?0+$/, "")}`;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "N/A";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function TokenMarketView({ mint }: { mint: string }) {
  const [interval, setIntervalState] = useState("5m");
  const [data, setData] = useState<MarketPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [chart, setChart] = useState<{
    candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
    unit: "SOL" | "USD";
    source: string;
    available: boolean;
    note: string;
  } | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setLoading(true);
      try {
        const res = await fetch(`/api/tokens/${encodeURIComponent(mint)}/market?interval=${interval}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData((await res.json()) as MarketPayload);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [mint, interval],
  );

  // Chart candles come from the dedicated candles endpoint: provider OHLCV for
  // tracked pools, on-chain aggregated candles for bonding curves. Tracked
  // separately from the market poll so timeframe switches feel instant.
  const loadChart = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setChartLoading(true);
      try {
        const res = await fetch(`/api/tokens/${encodeURIComponent(mint)}/candles?tf=${interval}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as {
          available: boolean;
          source: string;
          unit: string;
          candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
          note?: string;
        };
        setChart({
          candles: Array.isArray(j.candles) ? j.candles : [],
          unit: j.unit === "usd" ? "USD" : "SOL",
          source: String(j.source ?? ""),
          available: Boolean(j.available),
          note: String(j.note ?? ""),
        });
        setChartError(null);
      } catch (e) {
        setChartError(e instanceof Error ? e.message : String(e));
      } finally {
        setChartLoading(false);
      }
    },
    [mint, interval],
  );

  useEffect(() => {
    setData(null);
    void load();
    void loadChart();
    pollRef.current = setInterval(() => {
      if (document.visibilityState === "visible") {
        void load({ silent: true });
        void loadChart({ silent: true });
      }
    }, POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load, loadChart]);

  const lastPrice = data?.trades.find((t) => t.priceSol != null)?.priceSol ?? null;
  const lastTrade = data?.trades[0] ?? null;
  // Chart candles: provider OHLCV (USD) when available, else the on-chain
  // decode from the market payload (SOL). Both are real data.
  const chartCandles =
    chart && chart.candles.length > 0
      ? chart.candles.map((c) => ({ ...c, buys: 0, sells: 0 }))
      : (data?.candles ?? []);

  return (
    <div className="space-y-3">
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-2xs uppercase tracking-wider text-night-500">Venue</p>
            <p className="text-sm text-ink">
              {data?.venueResolved?.dexLabel ?? VENUE_LABEL[data?.venue.kind ?? "unknown"] ?? data?.venue.kind}
            </p>
            {(data?.venue.address || data?.venueResolved?.address) && (
              <p className="mt-1 font-mono text-2xs text-night-500">
                {shortAddress((data?.venue.address ?? data?.venueResolved?.address) as string, 6)}{" "}
                <a
                  href={explorerUrl("mainnet-beta", "address", (data?.venue.address ?? data?.venueResolved?.address) as string)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ice-300 hover:underline"
                >
                  Explorer
                </a>
              </p>
            )}
            {data?.venueResolved?.source && data.venueResolved.source !== "none" && (
              <p className="mt-1 text-2xs text-night-500">
                resolved via {data.venueResolved.source === "dexscreener" ? "DexScreener" : data.venueResolved.source === "geckoterminal" ? "GeckoTerminal" : "on-chain scan"}
                {data.venueResolved.quoteSymbol ? ` · quote ${data.venueResolved.quoteSymbol}` : ""}
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-2xs uppercase tracking-wider text-night-500">Last price</p>
            {data?.live?.metrics?.priceUsd != null ? (
              <>
                <p className="font-mono text-lg text-mint-300">{fmtUsd(data.live.metrics.priceUsd)}</p>
                {data.live.metrics.priceNative != null && (
                  <p className="font-mono text-2xs text-night-400">{data.live.metrics.priceNative.toPrecision(4)} SOL</p>
                )}
              </>
            ) : (
              <p className="font-mono text-lg text-mint-300">{lastPrice != null ? `${lastPrice.toPrecision(4)} SOL` : "N/A"}</p>
            )}
            {lastTrade?.blockTime != null && (
              <p className="text-2xs text-night-500">updated {timeAgo(new Date(lastTrade.blockTime * 1000))}</p>
            )}
          </div>
        </div>

        {/* Live provider metrics — every value is passed through verbatim; */}
        {/* missing provider metrics render as N/A, never fabricated. */}
        {data?.live?.metrics && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {LIVE_WINDOWS.map((w) => (
                <div key={w} className="rounded-lg border border-night-700/60 bg-night-800/40 p-2">
                  <p className="text-2xs text-night-500">{WINDOW_LABELS[w]} change</p>
                  <p className={`font-mono text-xs ${((data.live.metrics?.changesPct[w] ?? 0) as number) >= 0 ? "text-mint-300" : "text-danger"}`}>
                    {fmtPct(data.live.metrics?.changesPct[w])}
                  </p>
                  <p className="text-2xs text-night-500">vol {fmtUsd(data.live.metrics?.volumeUsd[w])}</p>
                  <p className="text-2xs text-night-500">
                    {data.live.metrics?.txns[w]
                      ? `${data.live.metrics.txns[w]!.buys} buys / ${data.live.metrics.txns[w]!.sells} sells`
                      : "N/A"}
                  </p>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2 text-2xs text-night-400">
              <span>Liquidity: <span className="font-mono text-ink">{fmtUsd(data.live.metrics.liquidityUsd)}</span></span>
              <span>Market cap: <span className="font-mono text-ink">{fmtUsd(data.live.metrics.marketCapUsd)}</span></span>
              <span>FDV: <span className="font-mono text-ink">{fmtUsd(data.live.metrics.fdvUsd)}</span></span>
            </div>
          </div>
        )}
        {data?.live?.available === false &&
          data.live.notes.map((n) => (
            <p key={n} className="rounded-lg border border-night-600/60 bg-night-800/40 p-2 text-2xs text-night-400">
              {n} Market metrics are unavailable for this mint.
            </p>
          ))}
        {error && <p className="rounded-lg border border-danger/40 bg-danger/50/10 p-2 text-xs text-danger">Market data unavailable: {error}</p>}
        {data?.warnings.map((w) => (
          <p key={w} className="rounded-lg border border-warn/40 bg-warn/100/10 p-2 text-2xs text-warn">
            {w}
          </p>
        ))}
      </Card>

      <Card>
        <PriceChart
          candles={chartCandles}
          trades={data?.trades ?? []}
          interval={interval}
          onIntervalChange={setIntervalState}
          coverageNote={
            chartError
              ? `Chart provider unreachable (${chartError}) — retrying.`
              : chart && chart.candles.length > 0
                ? `${chart.source === "geckoterminal" ? "Provider OHLCV (USD)" : "On-chain decoded swaps (SOL)"} · ${chart.note}`
                : (chart?.note ?? data?.coverageNote ?? "Loading market data…")
          }
          coverageFrom={chart && chart.source === "onchain-trades" && chart.candles.length > 0 ? chart.candles[0].time : (data?.coverageFrom ?? null)}
          coverageTo={chart && chart.source === "onchain-trades" && chart.candles.length > 0 ? chart.candles[chart.candles.length - 1].time : (data?.coverageTo ?? null)}
          loading={loading || chartLoading}
        />
      </Card>

      <Card>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">Activity (from decoded swaps)</p>
          <Badge tone="ice">real swaps only</Badge>
        </div>
        {data?.live?.metrics?.txns && data.live.available && (
          <p className="mb-2 rounded-lg border border-night-600/60 bg-night-800/40 p-2 text-2xs text-night-400">
            Provider-counted swaps (DexScreener):{" "}
            {LIVE_WINDOWS.map((w) =>
              data.live.metrics?.txns[w]
                ? `${WINDOW_LABELS[w]}: ${data.live.metrics.txns[w]!.buys}B/${data.live.metrics.txns[w]!.sells}S`
                : `${WINDOW_LABELS[w]}: N/A`,
            ).join(" · ")}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(data?.activity ?? []).map((a) => (
            <div key={a.label} className="rounded-lg border border-night-700 bg-night-800/60 p-2">
              <p className="text-2xs uppercase tracking-wider text-night-500">{a.label}</p>
              <p className="font-mono text-sm text-night-200">
                {a.swaps > 0 ? `${a.volumeSol.toFixed(3)} SOL` : "N/A"}
              </p>
              <p className="mt-0.5 font-mono text-2xs">
                <span className="text-mint-300">{a.buys} buys</span> / <span className="text-down">{a.sells} sells</span>
              </p>
              <p className={`font-mono text-2xs ${a.changePct == null ? "text-night-600" : a.changePct >= 0 ? "text-up" : "text-down"}`}>
                {a.changePct == null ? "N/A" : `${a.changePct > 0 ? "+" : ""}${a.changePct.toFixed(2)}%`}
              </p>
              <p className="mt-0.5 text-2xs text-night-600">{a.swaps} decoded swap{a.swaps === 1 ? "" : "s"} in window</p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-2xs text-night-500">
          Windows cover only the decoded swap scan (bounded, newest {data?.trades.length ?? 0} swaps) — sparse windows
          show N/A instead of interpolated volumes. Provider-supplied 24h figures appear on discovery lists.
        </p>
      </Card>

      <Card>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">Live trades</p>
          <Badge tone="ice">decoded from on-chain swaps</Badge>
        </div>
        {!data || data.trades.length === 0 ? (
          <p className="py-4 text-center text-xs text-night-400">
            No classified trades in the scanned window. Only real on-chain swaps are shown — none are fabricated.
          </p>
        ) : (
          <ul className="max-h-96 overflow-y-auto">
            {data.trades.map((t) => {
              const large = (t.solAmount ?? 0) >= LARGE_TRADE_SOL;
              return (
                <li key={t.signature} className="row-sep flex flex-wrap items-center gap-2 px-1 py-2 text-xs">
                  <Badge tone={t.kind === "buy" ? "mint" : t.kind === "sell" ? "danger" : "neutral"}>
                    {t.kind === "unknown" ? "unknown" : t.kind}
                  </Badge>
                  <span className="w-20 shrink-0 text-right font-mono text-night-400">
                    {t.tokenAmount != null ? t.tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "N/A"}
                  </span>
                  <span className="w-20 shrink-0 text-right font-mono text-mint-300">
                    {t.solAmount != null ? t.solAmount.toFixed(4) : "N/A"}
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-night-400">
                    {t.priceSol != null ? t.priceSol.toPrecision(4) : "N/A"}
                  </span>
                  {large && <Badge tone="warn">large</Badge>}
                  {t.creator && <Badge tone="ice">creator</Badge>}
                  <span className="min-w-0 flex-1 truncate text-right text-night-500">
                    {t.wallet ? (
                      <a href={solscanUrl(CLUSTER, "account", t.wallet)} target="_blank" rel="noopener noreferrer" className="hover:text-ice-300">
                        {shortAddress(t.wallet, 4)}
                      </a>
                    ) : (
                      "unknown wallet"
                    )}
                  </span>
                  <a
                    href={explorerUrl("mainnet-beta", "tx", t.signature)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-2xs text-ice-300 hover:underline"
                  >
                    tx
                  </a>
                  <span className="w-16 shrink-0 text-right text-2xs text-night-500">
                    {t.blockTime != null ? timeAgo(new Date(t.blockTime * 1000)) : "—"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-2 text-2xs text-night-500">
          Columns: side · token amount · SOL amount · price (SOL) · wallet · tx · time. USD values appear only when a
          verified SOL/USD price is available; otherwise they stay N/A.
        </p>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <p className="mb-2 text-sm font-semibold text-ink">Top buyers</p>
          {data && data.topBuyers.length > 0 ? (
            <ul className="space-y-1 text-xs">
              {data.topBuyers.map((w) => (
                <li key={w.wallet} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-night-400">{shortAddress(w.wallet, 4)}</span>
                  <span className="text-night-500">
                    {w.buys} buys · {w.boughtToken.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-night-400">No buyer data in the scanned window.</p>
          )}
          <p className="mb-2 mt-4 text-sm font-semibold text-ink">Top sellers</p>
          {data && data.topSellers.length > 0 ? (
            <ul className="space-y-1 text-xs">
              {data.topSellers.map((w) => (
                <li key={w.wallet} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-night-400">{shortAddress(w.wallet, 4)}</span>
                  <span className="text-night-500">
                    {w.sells} sells · {w.soldToken.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-night-400">No seller data in the scanned window.</p>
          )}
          <p className="mb-2 mt-4 text-sm font-semibold text-ink">Early buyers (this window)</p>
          {data && data.earlyBuyers.length > 0 ? (
            <ul className="space-y-1 text-xs">
              {data.earlyBuyers.slice(0, 5).map((w) => (
                <li key={w.wallet} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-night-400">{shortAddress(w.wallet, 4)}</span>
                  <span className="text-night-500">{w.firstAt != null ? timeAgo(new Date(w.firstAt * 1000)) : "—"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-night-400">No early-buy data in the scanned window.</p>
          )}
          {data?.creatorActivity && (
            <p className="mt-4 rounded-lg border border-ice-600/40 bg-ice-600/10 p-2 text-2xs text-ice-300">
              Creator wallet activity (verified via FluxPad launch record): {data.creatorActivity.trades} trades ·{" "}
              {data.creatorActivity.boughtToken.toLocaleString(undefined, { maximumFractionDigits: 0 })} bought ·{" "}
              {data.creatorActivity.soldToken.toLocaleString(undefined, { maximumFractionDigits: 0 })} sold
            </p>
          )}
          <p className="mt-3 text-2xs text-night-500">
            Derived from the bounded on-chain trade scan. Wallets are shown by address; ownership is not inferred.
          </p>
        </Card>
        <Card>
          <p className="mb-2 text-sm font-semibold text-ink">Top holders (on-chain ranking)</p>
          {data && data.holders.length > 0 ? (
            <ul className="space-y-1 text-xs">
              {data.holders.map((h) => (
                <li key={h.address} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-night-400">
                    #{h.rank} {shortAddress(h.address, 4)}
                  </span>
                  <span className="font-mono text-night-500">
                    {h.uiAmount != null ? h.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "N/A"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-night-400">Holder rankings unavailable.</p>
          )}
          <p className="mt-3 text-2xs text-night-500">
            Balances from the documented getTokenLargestAccounts RPC. Holder owner identities are not inferred — an
            address may be a vault or an associated token account.
          </p>
          {data?.venue.address && (
            <div className="mt-3">
              <CopyChip value={data.venue.address} label="Copy venue address" />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}