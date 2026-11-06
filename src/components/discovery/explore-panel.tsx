"use client";
/**
 * Explore Tokens panel — dense market discovery over /api/discovery.
 * Tabs (All / New Launches / New Pools / Pump.fun / LaunchLab / RelayPad
 * Launches), compact filters, search, sorting, pagination, honest N/A cells
 * and data-freshness indicators. No fabricated metrics.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icons";
import { TokenImage, CurveProgressBar } from "@/components/dashboard/token-row";
import { StatusBadge } from "@/components/brand/route-badge";
import { Panel, FilterPill, RefreshButton, PanelEmpty, PanelError, PanelSkeleton } from "@/components/dashboard/panel";
import { timeAgo, shortAddress, formatCompact } from "@/lib/format";
import type { DiscoveredToken, DiscoverySort, DiscoveryTab } from "@/lib/discovery/types";
import type { DiscoveryFilter } from "@/lib/discovery/index";

type TabKey = DiscoveryTab | "movers";

const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "movers", label: "Movers" },
  { key: "new-launches", label: "New Launches" },
  { key: "new-pools", label: "New Pools" },
  { key: "pumpfun", label: "Pump.fun" },
  { key: "pumpswap", label: "PumpSwap" },
  { key: "launchlab", label: "LaunchLab" },
  { key: "cpmm", label: "CPMM" },
  { key: "trending", label: "Trending" },
  { key: "graduating", label: "Graduating" },
  { key: "graduated", label: "Graduated" },
  { key: "relaypad", label: "FluxPad Launches" },
];

const FILTERS = [
  { key: "all", label: "All" },
  { key: "movers", label: "Movers" },
  { key: "new", label: "New" },
  { key: "market-cap", label: "Market Cap" },
  { key: "oldest", label: "Oldest" },
  { key: "last-trade", label: "Last Trade" },
] as const;

const SORT_FOR_FILTER: Record<string, string> = {
  all: "newest",
  movers: "movers-down",
  new: "newest",
  "market-cap": "market-cap",
  oldest: "oldest",
  "last-trade": "last-trade",
};

interface DiscoveryResponse {
  tokens: DiscoveredToken[];
  meta: {
    fetchedAt: number;
    degraded: boolean;
    sources: { source: string; ok: boolean; error: string | null; count: number; fetchedAt: number; stale: boolean }[];
  };
  page: number;
  pageSize: number;
  total: number;
}

function SourceBadge({ source, relaypadLaunchId }: { source: string; relaypadLaunchId: string | null }) {
  const meta: Record<string, { label: string; tone: "mint" | "ice" | "neutral" }> = {
    "pumpfun.curve": { label: "Pump curve", tone: "mint" },
    "pumpfun.pool": { label: "PumpSwap", tone: "mint" },
    "launchlab.curve": { label: "LaunchLab", tone: "ice" },
    "raydium.cpmm": { label: "Raydium CPMM", tone: "ice" },
    relaypad: { label: "FluxPad", tone: "mint" },
  };
  const m = meta[source] ?? { label: source, tone: "neutral" as const };
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={`rounded border px-1.5 py-0.5 text-2xs font-medium ${
          m.tone === "mint"
            ? "border-mint-500/25 bg-sky-50 text-mint-700"
            : m.tone === "ice"
              ? "border-sky-200 bg-sky-100/70 text-mint-600"
              : "border-night-700 bg-night-800 text-night-400"
        }`}
      >
        {m.label}
      </span>
      {relaypadLaunchId && (
        <span className="rounded border border-mint-500/30 bg-sky-50 px-1 py-0.5 text-2xs font-semibold text-mint-700" title="Launched via FluxPad">
          R
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Explore panel (part 2) — live component over /api/discovery
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25;
const POLL_MS = 30_000; // bounded polling, paused when the tab is hidden

/** Discovery status → reusable StatusBadge lifecycle key (no fake states). */
const STATUS_OF: Record<string, string> = {
  curve: "CURVE_TRADING",
  graduated: "GRADUATION_DETECTED",
  pool: "POOL_VERIFIED",
  "verified-launch": "CONFIRMED",
};

const SORT_OPTIONS: { key: DiscoverySort; label: string }[] = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "movers-up", label: "24h gainers" },
  { key: "movers-down", label: "24h losers" },
  { key: "market-cap", label: "Market cap" },
  { key: "last-trade", label: "Last trade" },
];

const EMPTY_HINTS: Record<TabKey, string> = {
  all: "Discovered tokens appear here as soon as any provider feed returns data.",
  movers: "Movers require a verified 24h price change from a provider — none available yet.",
  "new-launches": "New bonding-curve launches appear here shortly after on-chain detection.",
  "new-pools": "New PumpSwap / Raydium CPMM pools appear here once verified on-chain.",
  pumpfun: "Pump.fun tokens are discovered from on-chain create events on the Pump program.",
  pumpswap: "Graduated Pump.fun tokens trade in PumpSwap pools, detected on-chain.",
  launchlab: "LaunchLab tokens come from the documented Raydium LaunchLab Mint API.",
  cpmm: "Raydium CPMM pools come from the documented Raydium API v3.",
  trending: "Trending ranks tokens that have a verified 24h volume or change — tokens without metrics cannot trend.",
  graduating: "Graduating shows curve tokens at 80%+ bonding-curve progress.",
  graduated: "Graduated shows tokens that migrated to a destination pool.",
  relaypad: "",
};

function fmtPrice(n: number | null, sym: string): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "N/A";
  if (n === 0) return `0 ${sym}`;
  if (n >= 1000) return `${formatCompact(n)} ${sym}`;
  const decimals = Math.min(9, Math.max(2, Math.ceil(-Math.log10(n)) + 3));
  return `${n.toFixed(decimals)} ${sym}`;
}

function fmtChange(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function ageOf(t: DiscoveredToken): string {
  // Created timestamp when the provider supplies one; otherwise first-seen.
  return timeAgo(t.createdAt ? t.createdAt * 1000 : t.firstSeenAt);
}

function Metric({
  label,
  value,
  tone,
  stale,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
  stale?: boolean;
}) {
  const unavailable = value === "N/A";
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className="text-night-500">{label}</span>
      <span
        className={`font-mono ${
          tone === "up" ? "text-up" : tone === "down" ? "text-down" : unavailable ? "text-night-500" : "text-night-400"
        }`}
      >
        {value}
        {stale && (
          <span
            className="ml-1 rounded bg-night-700 px-1 text-2xs text-night-400"
            title="Served from a cache older than the provider freshness window"
          >
            stale
          </span>
        )}
      </span>
    </div>
  );
}

/** Dense discovery row built from the reusable token-row primitives. */
function DiscoveryRow({ token: t }: { token: DiscoveredToken }) {
  return (
    <li className="row-sep px-3 py-2.5">
      <div className="flex items-start gap-3">
        <TokenImage imageUrl={t.imageUrl} symbol={t.symbol} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <Link
              href={`/tokens/${t.mint}`}
              className="truncate text-[13px] font-medium text-ink transition hover:text-mint-300"
            >
              {t.name}
            </Link>
            <span className="shrink-0 font-mono text-2xs text-night-400">${t.symbol}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-night-500">
            <Link href={`/tokens/${t.mint}`} className="truncate font-mono transition hover:text-mint-300">
              {shortAddress(t.mint, 4)}
            </Link>
            <span className="shrink-0">{ageOf(t)}</span>
            <SourceBadge source={t.source} relaypadLaunchId={t.relaypadLaunchId} />
            <StatusBadge status={STATUS_OF[t.status] ?? t.status} />
            {t.poolAddress && (
              <span className="hidden font-mono sm:inline" title={`Verified pool address: ${t.poolAddress}`}>
                pool {shortAddress(t.poolAddress, 4)}
              </span>
            )}
            {t.signature && (
              <span className="hidden font-mono md:inline" title={`Verified launch signature: ${t.signature}`}>
                sig {shortAddress(t.signature, 4)}
              </span>
            )}
          </div>
        </div>
        <div className="hidden shrink-0 grid-cols-2 gap-x-4 gap-y-1 text-right text-2xs sm:grid md:grid-cols-3">
          <Metric label="Price" value={fmtPrice(t.priceQuote, t.quoteSymbol)} />
          <Metric
            label="24h"
            value={fmtChange(t.change24h)}
            tone={t.change24h == null ? undefined : t.change24h >= 0 ? "up" : "down"}
          />
          <Metric label="Vol 24h" value={t.volume24hUsd == null ? "N/A" : `$${formatCompact(t.volume24hUsd)}`} />
          <Metric
            label={t.valuation === "fdv" ? "FDV" : "MC"}
            value={t.marketCapUsd == null ? "N/A" : `$${formatCompact(t.marketCapUsd)}`}
          />
          <Metric
            label="Liquidity"
            value={t.liquidityQuote == null ? "N/A" : `${formatCompact(t.liquidityQuote)} ${t.quoteSymbol}`}
          />
          <Metric label="Updated" value={timeAgo(t.fetchedAt)} stale={t.stale} />
        </div>
      </div>
      {t.curveProgress != null && (
        <div className="mt-1.5 flex items-center gap-2">
          <CurveProgressBar progress={t.curveProgress} />
          <span className="shrink-0 font-mono text-2xs text-mint-400">{formatCompact(t.curveProgress)}%</span>
          <span className="text-2xs text-night-500">bonding curve</span>
        </div>
      )}
    </li>
  );
}

export function ExplorePanel({ initialSearch = "" }: { initialSearch?: string }) {
  const [tab, setTab] = useState<TabKey>("all");
  const [filter, setFilter] = useState<DiscoveryFilter>("all");
  const [sort, setSort] = useState<DiscoverySort>("newest");
  const [q, setQ] = useState(initialSearch);
  const [query, setQuery] = useState(initialSearch); // debounced search
  const [page, setPage] = useState(1);
  const [relayRoute, setRelayRoute] = useState<"all" | "pump" | "launchlab">("all");
  const [relayStatus, setRelayStatus] = useState<"all" | "pending" | "graduated">("all");
  // Live-scanner filters (Phase 7) — only real-provider-data filters.
  const [showScanner, setShowScanner] = useState(false);
  const [scanMinLiq, setScanMinLiq] = useState("");
  const [scanMinVol, setScanMinVol] = useState("");
  const [scanMinMcap, setScanMinMcap] = useState("");
  const [scanMaxMcap, setScanMaxMcap] = useState("");
  const [scanMaxAge, setScanMaxAge] = useState("");
  const [scanMinCurve, setScanMinCurve] = useState("");
  const [data, setData] = useState<DiscoveryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // The Movers tab is the "movers" filter applied over the merged feed.
  const isMovers = tab === "movers";
  const effectiveTab: DiscoveryTab = isMovers ? "all" : tab;
  const effectiveFilter: DiscoveryFilter = isMovers ? "movers" : filter;

  // Debounce search input (350ms) — search runs server-side over merged feeds.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 350);
    return () => clearTimeout(t);
  }, [q]);

  const scanQueryString = [
    scanMinLiq && `minLiquidityQuote=${encodeURIComponent(scanMinLiq)}`,
    scanMinVol && `minVolume24hUsd=${encodeURIComponent(scanMinVol)}`,
    scanMinMcap && `minMarketCapUsd=${encodeURIComponent(scanMinMcap)}`,
    scanMaxMcap && `maxMarketCapUsd=${encodeURIComponent(scanMaxMcap)}`,
    scanMaxAge && `maxAgeHours=${encodeURIComponent(scanMaxAge)}`,
    scanMinCurve && `minCurveProgress=${encodeURIComponent(scanMinCurve)}`,
  ]
    .filter(Boolean)
    .join("&");
  const scannerActive = scanQueryString.length > 0;

  // New view → back to page 1.
  useEffect(() => {
    setPage(1);
  }, [effectiveTab, effectiveFilter, query, relayRoute, relayStatus, scanQueryString]);

  // Filter choice implies a sensible sort; still overridable via the picker.
  useEffect(() => {
    setSort((SORT_FOR_FILTER[effectiveFilter] ?? "newest") as DiscoverySort);
  }, [effectiveFilter]);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    try {
      const params = new URLSearchParams({
        tab: effectiveTab,
        filter: effectiveFilter,
        sort,
        q: query,
        page: String(page),
        pageSize: String(PAGE_SIZE),
        relayRoute,
        relayStatus,
      });
      const res = await fetch(`/api/discovery?${params}${scannerActive ? `&${scanQueryString}` : ""}`, { signal: ctrl.signal });
      if (res.status === 400) throw new Error("Invalid discovery query.");
      if (!res.ok) throw new Error(`Discovery error ${res.status}`);
      const json = (await res.json()) as DiscoveryResponse;
      setData(json);
      setError(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!ctrl.signal.aborted) setBusy(false);
    }
  }, [effectiveTab, effectiveFilter, sort, query, page, relayRoute, relayStatus, scanQueryString, scannerActive]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  // Bounded polling: only while the page is visible.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const tokens = data?.tokens ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const failedSources = data?.meta.sources.filter((s) => !s.ok) ?? [];

  return (
    <Panel
      title="Live token discovery"
      icon="compass"
      subtitle={data ? `updated ${timeAgo(data.meta.fetchedAt)}` : undefined}
      className="h-full"
      actions={<RefreshButton onClick={() => void load()} updatedAt={data?.meta.fetchedAt ?? null} />}
    >
      {/* Source freshness strip — honest per-feed status */}
      {data && (
        <div className="flex flex-wrap items-center gap-1 border-b border-night-700/70 px-3 py-1.5 text-2xs">
          <span className="text-night-500">sources:</span>
          {data.meta.sources.map((s) => (
            <span
              key={s.source}
              title={`${s.source}${s.error ? ` — ${s.error}` : ""}${s.stale ? " — stale cache" : ""}`}
              className={`inline-flex items-center gap-1 rounded bg-night-800 px-1.5 py-0.5 ${
                s.ok ? "text-night-400" : "text-down"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  s.ok && !s.stale ? "bg-mint-500" : s.ok ? "bg-night-500" : "bg-down"
                }`}
              />
              {s.source}
            </span>
          ))}
        </div>
      )}

      {/* Degraded banner — providers down, cached data in use */}
      {failedSources.length > 0 && (
        <div className="flex items-center gap-2 border-b border-night-700/70 px-3 py-1.5 text-2xs text-down">
          <Icon name="alert" size={12} />
          <span className="truncate">
            Provider issue: {failedSources.map((s) => s.source).join(", ")}. Affected feeds serve their last cached
            data or nothing — never fabricated figures.
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2">
        <div className="flex flex-wrap items-center gap-0.5 rounded-lg bg-night-800/70 p-1">
          {TABS.map((tb) => (
            <FilterPill key={tb.key} active={tab === tb.key} onClick={() => setTab(tb.key)}>
              {tb.label}
            </FilterPill>
          ))}
        </div>
      </div>

      {/* Search + sort */}
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="relative flex-1">
          <Icon name="search" size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-night-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, ticker or mint address…"
            aria-label="Search discovery results"
            className="w-full rounded-md border border-night-700 bg-paper py-1.5 pl-8 pr-2 text-2xs text-ink placeholder:text-night-500 transition-colors focus:border-mint-500 focus:outline-none"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as DiscoverySort)}
          aria-label="Sort results"
          className="rounded-md border border-night-700 bg-paper px-2 py-1.5 text-2xs text-ink transition-colors focus:border-mint-500 focus:outline-none"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => setShowScanner((v) => !v)}
          aria-expanded={showScanner}
          className={`rounded-md border px-2 py-1.5 text-2xs font-medium transition ${
            scannerActive
              ? "border-mint-500/50 bg-sky-50 text-mint-700"
              : "border-night-700 bg-paper text-night-400 hover:text-ink"
          }`}
        >
          Scanner filters{scannerActive ? " ●" : ""}
        </button>
      </div>

      {/* Scanner filters — server-side over provider data; unknown values excluded */}
      {showScanner && (
        <div className="grid grid-cols-2 gap-2 border-b border-night-700/70 px-3 pb-2 sm:grid-cols-3 lg:grid-cols-6">
          {(
            [
              { label: "Min liquidity", value: scanMinLiq, set: setScanMinLiq, hint: "quote units" },
              { label: "Min 24h vol $", value: scanMinVol, set: setScanMinVol, hint: "USD" },
              { label: "Min mcap $", value: scanMinMcap, set: setScanMinMcap, hint: "USD" },
              { label: "Max mcap $", value: scanMaxMcap, set: setScanMaxMcap, hint: "USD" },
              { label: "Max age h", value: scanMaxAge, set: setScanMaxAge, hint: "hours" },
              { label: "Min curve %", value: scanMinCurve, set: setScanMinCurve, hint: "0-100" },
            ] as const
          ).map((f) => (
            <label key={f.label} className="flex flex-col gap-0.5">
              <span className="text-2xs text-night-500">{f.label}</span>
              <input
                value={f.value}
                onChange={(e) => f.set(e.target.value.replace(/[^0-9.]/g, ""))}
                inputMode="decimal"
                placeholder={f.hint}
                className="rounded-md border border-night-700 bg-paper px-2 py-1 font-mono text-2xs text-ink placeholder:text-night-500 transition-colors focus:border-mint-500 focus:outline-none"
              />
            </label>
          ))}
        </div>
      )}

      {/* Sub-filters */}
      <div className="flex flex-wrap items-center gap-2 px-3 pb-2">
        <div className="flex items-center gap-0.5 rounded-lg bg-night-800/70 p-1">
          {FILTERS.map((f) => (
            <FilterPill
              key={f.key}
              active={effectiveFilter === f.key}
              onClick={() => {
                if (!isMovers) setFilter(f.key);
              }}
            >
              {f.label}
            </FilterPill>
          ))}
        </div>
        {tab === "relaypad" && (
          <>
            <div className="flex items-center gap-0.5 rounded-lg bg-night-800/70 p-1">
              {([["all", "All routes"], ["pump", "Pump"], ["launchlab", "LaunchLab"]] as const).map(([k, l]) => (
                <FilterPill key={k} active={relayRoute === k} onClick={() => setRelayRoute(k)}>
                  {l}
                </FilterPill>
              ))}
            </div>
            <div className="flex items-center gap-0.5 rounded-lg bg-night-800/70 p-1">
              {([["all", "All lifecycle"], ["pending", "Pending"], ["graduated", "Graduated"]] as const).map(([k, l]) => (
                <FilterPill key={k} active={relayStatus === k} onClick={() => setRelayStatus(k)}>
                  {l}
                </FilterPill>
              ))}
            </div>
          </>
        )}
        <span className="ml-auto text-2xs text-night-500">{data ? `${data.total} tokens` : "…"}</span>
      </div>

      {error ? (
        <PanelError message={error} onRetry={() => void load()} />
      ) : data === null ? (
        <PanelSkeleton rows={8} />
      ) : tokens.length === 0 ? (
        tab === "relaypad" ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <p className="text-[13px] text-night-400">No verified FluxPad launches yet.</p>
            <p className="max-w-sm text-2xs text-night-500">
              Only tokens whose launch transaction and mint were verified through FluxPad appear here — tokens
              discovered on Pump.fun or LaunchLab are never attributed to FluxPad.
            </p>
            <Link
              href="/create"
              className="mt-1 rounded-md bg-mint-500 px-3 py-1.5 text-2xs font-semibold text-snow shadow-glow-mint transition hover:bg-mint-400"
            >
              Create Token →
            </Link>
          </div>
        ) : (
          <PanelEmpty message="No tokens match this view yet." hint={EMPTY_HINTS[tab]} />
        )
      ) : (
        <ul aria-busy={busy}>
          {tokens.map((t) => (
            <DiscoveryRow key={`${t.source}:${t.mint}`} token={t} />
          ))}
        </ul>
      )}

      {/* Pagination */}
      {data && data.total > 0 && (
        <div className="flex items-center justify-between border-t border-night-700/70 px-3 py-2 text-2xs text-night-500">
          <span>
            Page {data.page} of {totalPages} · {data.total} tokens
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={data.page <= 1}
              aria-label="Previous page"
              className="flex h-6 w-6 items-center justify-center rounded-md text-night-400 transition hover:bg-night-800 hover:text-ink disabled:opacity-30"
            >
              <Icon name="chevronLeft" size={13} />
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={data.page >= totalPages}
              aria-label="Next page"
              className="flex h-6 w-6 items-center justify-center rounded-md text-night-400 transition hover:bg-night-800 hover:text-ink disabled:opacity-30"
            >
              <Icon name="chevronRight" size={13} />
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
