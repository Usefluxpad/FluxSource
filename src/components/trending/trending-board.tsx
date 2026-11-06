"use client";

/**
 * Live Pump.fun Trending board — real-time data from FluxPad's backend engine
 * (/api/trending + SSE /api/trending/stream). The backend owns the single
 * PumpPortal connection; the browser only subscribes to FluxPad's stream.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { TokenImage } from "@/components/dashboard/token-row";
import { Badge } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/icons";
import { timeAgo } from "@/lib/format";
import type { TrendingRow, TrendingStats, TrendingTab, TrendingTimeframe } from "@/lib/pump-live/types";

const TABS: { key: TrendingTab; label: string }[] = [
  { key: "trending", label: "Trending Now" },
  { key: "volume", label: "Highest Volume" },
  { key: "gainers", label: "Biggest Gainers" },
  { key: "losers", label: "Biggest Losers" },
  { key: "most-bought", label: "Most Bought" },
  { key: "newest", label: "Newest Tokens" },
  { key: "migrated", label: "Recently Migrated" },
];

const TIMEFRAMES: { key: TrendingTimeframe; label: string }[] = [
  { key: "1h", label: "1H" },
  { key: "4h", label: "4H" },
  { key: "12h", label: "12H" },
  { key: "24h", label: "24H" },
];

interface StreamPayload {
  type: "trending";
  rows: TrendingRow[];
  meta: {
    solUsd: number | null;
    solUsdSource: string | null;
    generatedAt: number;
    historyPartial: boolean;
    stale: boolean;
  };
}

function formatCompactUsd(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "N/A";
  if (n >= 1000) return `$${formatCompactUsd(n)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toPrecision(3)}`;
  return "$0";
}

function fmtChange(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "N/A";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

type ConnState = "live" | "reconnecting" | "offline";

export function TrendingBoard() {
  const [tab, setTab] = useState<TrendingTab>("trending");
  const [tf, setTf] = useState<TrendingTimeframe>("1h");
  const [rows, setRows] = useState<TrendingRow[]>([]);
  const [meta, setMeta] = useState<StreamPayload["meta"] | null>(null);
  const [stats, setStats] = useState<TrendingStats | null>(null);
  const [conn, setConn] = useState<ConnState>("reconnecting");
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const apply = useCallback((p: StreamPayload) => {
    setRows(p.rows);
    setMeta(p.meta);
    setLastUpdate(Date.now());
    setConn("live");
  }, []);

  // Initial + on-demand REST fetch (first paint and tab switches).
  useEffect(() => {
    let live = true;
    fetch(`/api/trending?tab=${tab}&tf=${tf}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: StreamPayload | null) => {
        if (live && j && Array.isArray(j.rows)) apply(j);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [tab, tf, apply]);

  // SSE subscription — the browser's only real-time channel.
  useEffect(() => {
    setConn("reconnecting");
    const es = new EventSource(`/api/trending/stream?tab=${tab}&tf=${tf}`);
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const p = JSON.parse(ev.data) as StreamPayload;
        if (p && Array.isArray(p.rows)) apply(p);
      } catch {
        // malformed frame — the next tick arrives shortly
      }
    };
    es.onopen = () => setConn("live");
    es.onerror = () => {
      // EventSource auto-reconnects; reflect the state honestly.
      setConn((c) => (c === "live" ? "reconnecting" : c));
    };
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [tab, tf, apply]);

  // Poll pipeline stats occasionally for the health footer.
  useEffect(() => {
    const load = () =>
      fetch("/api/trending/stats", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => j && setStats(j))
        .catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  const stale = meta?.stale ?? false;
  return (
    <div className="rounded-xl border border-night-700 bg-paper shadow-panel">
      {/* Header: tabs + time filters + connection indicator */}
      <div className="flex flex-wrap items-center gap-2 border-b border-night-700 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-0.5 rounded-lg bg-night-800/70 p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              aria-pressed={tab === t.key}
              className={`rounded-md px-2 py-1 text-2xs font-medium transition-colors duration-200 ${
                tab === t.key ? "bg-sky-100 text-mint-700" : "text-night-400 hover:bg-night-800 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg bg-night-800/70 p-1">
            {TIMEFRAMES.map((t) => (
              <button
                key={t.key}
                onClick={() => setTf(t.key)}
                aria-pressed={tf === t.key}
                disabled={tab === "newest" || tab === "migrated"}
                className={`rounded-md px-2 py-1 text-2xs font-semibold transition-colors duration-200 disabled:opacity-40 ${
                  tf === t.key ? "bg-sky-100 text-mint-700" : "text-night-400 hover:bg-night-800 hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-night-700 bg-night-950 px-2.5 py-1 text-2xs font-medium text-night-400"
            title={stale ? "Data stream stalled — reconnecting" : "Receiving live Pump.fun events"}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                conn === "live" && !stale ? "bg-up animate-pulse-soft" : conn === "live" ? "bg-warn" : "bg-down animate-pulse-soft"
              }`}
            />
            {stale ? "Stalled" : conn === "live" ? "Live" : conn === "reconnecting" ? "Connecting…" : "Offline"}
          </span>
        </div>
      </div>

      {/* Honest data-coverage notice */}
      {meta?.historyPartial && (
        <p className="border-b border-night-700 bg-night-800/60 px-3 py-1.5 text-2xs text-night-400">
          Rolling windows are still filling — rankings cover only the period since this pipeline
          started collecting live trades (24h history completes as data accumulates).
        </p>
      )}
      {stale && (
        <p className="border-b border-night-700 bg-warn/10 px-3 py-1.5 text-2xs text-warn">
          Live stream stalled — showing the last verified snapshot while the backend reconnects.
        </p>
      )}

      {/* Column header */}
      <div className="hidden items-center gap-3 border-b border-night-700 px-3 py-1.5 text-2xs font-medium uppercase tracking-wider text-night-500 sm:flex">
        <span className="w-8 shrink-0">#</span>
        <span className="flex min-w-0 flex-1 items-center gap-2">Token</span>
        <span className="w-24 shrink-0 text-right">Price</span>
        <span className="hidden w-24 shrink-0 text-right md:block">Market Cap</span>
        <span className="w-24 shrink-0 text-right">Volume</span>
        <span className="w-16 shrink-0 text-right">Change</span>
        <span className="hidden w-20 shrink-0 text-right lg:block">Buys / Sells</span>
        <span className="w-16 shrink-0 text-right">Age</span>
      </div>

      {/* Rows — every value is real engine output; nulls render as N/A */}
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/flux-symbol.jpg" alt="" aria-hidden className="mb-1 h-12 w-12 rounded-xl opacity-90" draggable={false} />
          <p className="text-[13px] text-night-400">
            {conn === "live" ? "No tokens match this ranking yet." : "Connecting to the live Pump.fun stream…"}
          </p>
          <p className="max-w-sm text-2xs text-night-500">
            Rankings are built from real trades as they happen — nothing is simulated or backfilled.
          </p>
        </div>
      ) : (
        <ul aria-busy={conn !== "live"}>
          {rows.map((r, i) => (
            <li key={r.mint} className="row-sep">
              <Link
                href={`/tokens/${r.mint}`}
                className="group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-night-800"
              >
                <span className="w-8 shrink-0 text-2xs font-semibold text-night-500">{i + 1}</span>
                <TokenImage imageUrl={r.imageUrl} symbol={r.symbol} size={34} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-ink group-hover:text-mint-300">{r.name}</span>
                    {r.hot && (
                      <span className="shrink-0 rounded bg-danger/10 px-1 py-0.5 text-2xs font-bold text-danger">HOT</span>
                    )}
                    {r.migrated ? <Badge tone="ice">PumpSwap</Badge> : <Badge tone="mint">Curve</Badge>}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-2xs text-night-500">
                    <span className="font-mono">${r.symbol}</span>
                    <span className="hidden sm:inline">· {timeAgo(new Date(r.createdAt))}</span>
                    {r.poolAddress && (
                      <span className="hidden font-mono md:inline">· pool {r.poolAddress.slice(0, 6)}…</span>
                    )}
                  </span>
                </span>
                <span className="w-24 shrink-0 text-right font-mono text-xs text-ink">{fmtUsd(r.priceUsd)}</span>
                <span className="hidden w-24 shrink-0 text-right font-mono text-xs text-night-400 md:block">
                  {fmtUsd(r.marketCapUsd)}
                </span>
                <span className="w-24 shrink-0 text-right font-mono text-xs text-ink">{fmtUsd(r.volumeUsd)}</span>
                <span
                  className={`w-16 shrink-0 text-right font-mono text-xs ${
                    r.changePct === null ? "text-night-500" : r.changePct >= 0 ? "text-up" : "text-down"
                  }`}
                >
                  {fmtChange(r.changePct)}
                </span>
                <span className="hidden w-20 shrink-0 text-right font-mono text-2xs text-night-400 lg:block">
                  <span className="text-up">{r.buys}</span> / <span className="text-down">{r.sells}</span>
                </span>
                <span className="w-16 shrink-0 text-right text-2xs text-night-500">
                  {r.lastTradeAt ? timeAgo(new Date(r.lastTradeAt)) : "—"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* Footer: live pipeline stats (real numbers from the engine) */}
      {stats?.tradeStreamingAvailable === false && (
        <p className="border-b border-night-700 bg-night-800/60 px-3 py-1.5 text-2xs text-night-400">
          Per-token trade streaming requires a funded PumpPortal API key — trades are sourced
          directly from the Solana chain via on-chain RPC for active tokens.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-night-700 px-3 py-2 text-2xs text-night-500">
        <span className="inline-flex items-center gap-1">
          <Icon name="zap" size={11} className="text-mint-500" />
          {stats ? `${stats.tradeEventsProcessed.toLocaleString()} live trades processed` : "loading pipeline stats…"}
        </span>
        <span>{stats ? `${stats.newTokenEvents.toLocaleString()} new tokens seen` : ""}</span>
        <span>{stats ? `${stats.tokensTracked.toLocaleString()} tracked` : ""}</span>
        <span>{stats ? `trades via ${stats.tradeSource === "ws" ? "PumpPortal stream" : "on-chain RPC"}` : ""}</span>
        <span>{meta?.solUsd != null ? `SOL $${meta.solUsd.toFixed(2)} (${meta.solUsdSource})` : "SOL price N/A"}</span>
        <span className="ml-auto">{lastUpdate ? `updated ${timeAgo(new Date(lastUpdate))}` : ""}</span>
      </div>
    </div>
  );
}
