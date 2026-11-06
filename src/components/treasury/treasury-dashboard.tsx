"use client";

/**
 * Treasury & On-Chain Activity dashboard (read-only).
 *
 * Consumes the public /api/official-token/* endpoints. Every metric shown is
 * either verified stored activity or a live on-chain balance; anything
 * unconfigured or unavailable renders as an explicit placeholder state.
 * The dashboard cannot initiate any transaction — the API is read-only.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, CopyChip, Spinner } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/icons";
import {
  FilterPill,
  Panel,
  PanelEmpty,
  PanelError,
  PanelSkeleton,
} from "@/components/dashboard/panel";
import { explorerUrl, type ClusterId } from "@/lib/constants";

/* ---- Shared API shapes (mirrors the server responses; no server imports) ---- */

interface WalletEntry {
  role: string;
  address: string | null;
  configured: boolean;
  lamports: number | null;
  relayBalance: string | null;
  relayDecimals: number | null;
  balanceError: string | null;
}

interface SummaryResponse {
  network: ClusterId;
  configured: boolean;
  wallets: WalletEntry[];
  totals: {
    feesCollected: string | null;
    transfers: string | null;
    fluxPurchased: string | null;
    fluxBurned: string | null;
  };
  activityCounts: Record<string, number | undefined>;
  lastReconciledAt: string | null;
  errors: string[];
  invalid?: { role: string }[];
}

interface ActivityRow {
  signature: string;
  entryKey: string;
  type: string;
  status: string;
  blockTime: string | null;
  walletRole: string | null;
  sender: string | null;
  recipient: string | null;
  inputAmount: string | null;
  inputAsset: string | null;
  inputDecimals: number | null;
  outputAmount: string | null;
  outputAsset: string | null;
  outputDecimals: number | null;
  burnVerified: boolean;
}

interface ActivityResponse {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  activities: ActivityRow[];
  servedAt: string;
}

const TYPE_TABS = [
  { key: "all", label: "All Activity" },
  { key: "fee_collect", label: "Creator Fees" },
  { key: "transfer", label: "Treasury Transfers" },
  { key: "swap", label: "Buybacks" },
  { key: "burn", label: "Burns" },
] as const;

const TYPE_LABELS: Record<string, string> = {
  fee_collect: "Creator fee",
  transfer: "Transfer",
  swap: "Buyback",
  burn: "Burn",
  other: "Other",
};

function formatToken(raw: string | null, decimals: number | null): string {
  if (raw == null) return "—";
  try {
    const value = BigInt(raw);
    const d = decimals ?? 0;
    if (d === 0) return value.toString();
    const neg = value < 0n;
    const abs = (neg ? -value : value).toString().padStart(d + 1, "0");
    const whole = abs.slice(0, abs.length - d) || "0";
    const frac = abs.slice(abs.length - d).replace(/0+$/, "");
    const num = `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
    return num.length > 16 ? `${num.slice(0, 14)}…` : num;
  } catch {
    return raw;
  }
}

function assetLabel(asset: string | null): string {
  if (!asset) return "—";
  if (asset === "SOL") return "SOL";
  return `${asset.slice(0, 4)}…${asset.slice(-4)}`;
}

function shortAddr(addr: string | null): string {
  return addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : "—";
}

function MetricCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: string;
}) {
  return (
    <div className="rounded-lg border border-night-700/80 bg-night-850 p-3">
      <div className="flex items-center gap-1.5 text-2xs text-night-500">
        <Icon name={icon} size={12} className="text-mint-400" />
        {label}
      </div>
      <div className="mt-1 font-mono text-sm text-ink" title={value === "—" ? undefined : value}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-2xs text-night-500">{sub}</div>}
    </div>
  );
}

export default function TreasuryDashboard() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [typeFilter, setTypeFilter] = useState<(typeof TYPE_TABS)[number]["key"]>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // Debounce the signature-search input so one API request fires per
  // pause in typing, not per keystroke (L7).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 400);
    return () => clearTimeout(t);
  }, [query]);

  const loadSummary = useCallback(async () => {
    try {
      const res = await fetch("/api/official-token/summary", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSummary((await res.json()) as SummaryResponse);
      setSummaryError(null);
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : "unavailable");
    }
  }, []);

  const loadActivity = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (typeFilter !== "all") params.set("type", typeFilter);
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    if (fromDate) params.set("from", new Date(`${fromDate}T00:00:00Z`).toISOString());
    if (toDate) params.set("to", new Date(`${toDate}T23:59:59Z`).toISOString());
    try {
      const res = await fetch(`/api/official-token/activity?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setActivity((await res.json()) as ActivityResponse);
      setActivityError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      setActivityError(err instanceof Error ? err.message : "unavailable");
    }
  }, [page, typeFilter, debouncedQuery, fromDate, toDate]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([loadSummary(), loadActivity()])
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [loadSummary, loadActivity]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadSummary();
      await loadActivity();
    } finally {
      setRefreshing(false);
    }
  }, [loadSummary, loadActivity]);

  const network = summary?.network ?? "devnet";
  const configured = summary?.configured ?? false;

  const metricDefs = useMemo(() => {
    const t = summary?.totals;
    return [
      {
        label: "Creator fees collected",
        value: formatToken(t?.feesCollected ?? null, 9),
        sub: "verified fee collections (SOL)",
        icon: "activity",
      },
      {
        label: "Treasury transfers",
        value: formatToken(t?.transfers ?? null, 9),
        sub: "verified transfers (SOL)",
        icon: "wallet",
      },
      {
        label: "$FLUX purchased",
        value: t?.fluxPurchased != null ? formatToken(t.fluxPurchased, null) : "—",
        sub: "verified swap output",
        icon: "trending",
      },
      {
        label: "$FLUX burned",
        value: t?.fluxBurned != null ? formatToken(t.fluxBurned, null) : "—",
        sub: "verified SPL burns",
        icon: "zap",
      },
    ];
  }, [summary]);

  return (
    <div className="space-y-3">
      {!loading && !configured && (
        <div className="rounded-lg border border-warn/40 bg-warn/100/10 p-3 text-2xs text-warn/90">
          <div className="flex items-center gap-1.5 font-medium text-warn">
            <Icon name="info" size={13} />
            Treasury configuration pending
          </div>
          <p className="mt-1">
            The official $FLUX token has not been launched yet and no treasury wallet
            addresses are configured. All metrics below display explicit unavailable
            states until real, verified addresses exist — no data is invented.
          </p>
        </div>
      )}
      {summary?.invalid && summary.invalid.length > 0 && (
        <div className="rounded-lg border border-danger/40 bg-danger/50/10 p-3 text-2xs text-danger">
          <div className="flex items-center gap-1.5 font-medium">
            <Icon name="alert" size={13} />
            Invalid configuration detected
          </div>
          <p className="mt-1">
            {summary.invalid
              .map((i) => `${i.role} is set but not a valid public address`)
              .join("; ")}
            . These entries are treated as unconfigured — check the server
            environment.
          </p>
        </div>
      )}
      {summaryError && (
        <div className="rounded-lg border border-danger/40 bg-danger/50/10 p-3 text-2xs text-danger">
          <Icon name="alert" size={13} className="mr-1 inline" />
          Overview unavailable: {summaryError}
        </div>
      )}

      {/* Section 1 — Treasury overview */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-ink">Treasury overview</h2>
          <div className="flex items-center gap-2 text-2xs text-night-500">
            <Badge tone={network === "mainnet-beta" ? "ice" : "warn"}>{network}</Badge>
            {summary?.lastReconciledAt && (
              <span title="Last successful reconciliation">
                <Icon name="check" size={11} className="mr-1 inline text-mint-500" />
                reconciled {new Date(summary.lastReconciledAt).toLocaleString()}
              </span>
            )}
            <button
              onClick={() => void refresh()}
              aria-label="Refresh"
              className="flex h-6 w-6 items-center justify-center rounded-md text-night-400 transition hover:bg-night-700 hover:text-ink"
            >
              {refreshing ? <Spinner /> : <Icon name="refresh" size={13} />}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {metricDefs.map((m) => (
            <MetricCard key={m.label} {...m} />
          ))}
        </div>
        {summary && summary.errors.length > 0 && (
          <p className="mt-1.5 text-2xs text-warn/80">
            {summary.errors.length} data source(s) unavailable — shown as “—” above.
          </p>
        )}
      </section>

      {/* Section 2 — Public wallet directory */}
      <Panel
        title="Public wallet directory"
        icon="wallet"
        subtitle="Configured public addresses — roles per the implementation plan"
      >
        {loading ? (
          <PanelSkeleton rows={4} />
        ) : !summary ? (
          <PanelError message="Wallet directory unavailable." onRetry={() => void refresh()} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-2xs">
              <thead className="text-night-500">
                <tr className="border-b border-night-700/70">
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 font-medium">Public address</th>
                  <th className="px-3 py-2 text-right font-medium">SOL</th>
                  <th className="px-3 py-2 text-right font-medium">$FLUX</th>
                  <th className="px-3 py-2 font-medium">Explorer</th>
                </tr>
              </thead>
              <tbody>
                {summary.wallets.map((w) => (
                  <tr key={w.role} className="row-sep">
                    <td className="px-3 py-2">
                      <Badge tone={w.role === "W1" ? "mint" : w.role === "W2" ? "ice" : "neutral"}>
                        {w.role}
                      </Badge>
                      <div className="mt-0.5 text-night-500">{roleLabel(w.role)}</div>
                    </td>
                    <td className="px-3 py-2">
                      {w.address ? (
                        <CopyChip value={w.address} label={`${w.role} address`} />
                      ) : (
                        <span className="text-night-500">awaiting configuration</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-night-400">
                      {w.lamports != null ? formatToken(String(w.lamports), 9) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-night-400">
                      {w.relayBalance != null ? formatToken(w.relayBalance, w.relayDecimals) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {w.address ? (
                        <a
                          href={explorerUrl(network, "address", w.address)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-mint-300 hover:text-mint-200"
                        >
                          view <Icon name="external" size={11} />
                        </a>
                      ) : (
                        <span className="text-night-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Section 3 — Transaction activity */}
      <Panel
        title="On-chain activity"
        icon="activity"
        subtitle="verified transactions only"
        actions={
          updatedAt ? (
            <span className="text-2xs text-night-500" title="Last updated">
              <Icon name="clock" size={11} className="mr-1 inline" />
              {new Date(updatedAt).toLocaleTimeString()}
            </span>
          ) : null
        }
      >
        <div className="flex flex-wrap items-center gap-1.5 border-b border-night-700/70 px-3 py-2">
          {TYPE_TABS.map((t) => (
            <FilterPill
              key={t.key}
              active={typeFilter === t.key}
              onClick={() => {
                setTypeFilter(t.key);
                setPage(1);
              }}
            >
              {t.label}
            </FilterPill>
          ))}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              placeholder="Search signature…"
              aria-label="Search by transaction signature"
              className="w-44 rounded-md border border-night-600 bg-night-850 px-2 py-1 text-2xs text-ink placeholder:text-night-500 focus:border-mint-500 focus:outline-none"
            />
            <input
              type="date"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                setPage(1);
              }}
              aria-label="From date"
              className="rounded-md border border-night-600 bg-night-850 px-2 py-1 text-2xs text-night-400"
            />
            <input
              type="date"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
                setPage(1);
              }}
              aria-label="To date"
              className="rounded-md border border-night-600 bg-night-850 px-2 py-1 text-2xs text-night-400"
            />
          </div>
        </div>

        {activityError ? (
          <PanelError message={`Activity unavailable: ${activityError}`} onRetry={() => void refresh()} />
        ) : loading ? (
          <PanelSkeleton rows={6} />
        ) : !activity || activity.activities.length === 0 ? (
          <PanelEmpty
            message="No verified activity yet."
            hint="Transactions appear here only after being verified on-chain against configured treasury wallets."
          />
        ) : (
          <ActivityTable activity={activity} network={network} onPage={setPage} />
        )}
      </Panel>

      <p className="text-2xs text-night-500">
        Read-only dashboard. Every metric is derived from verified on-chain transactions or live
        RPC balance reads; unconfigured wallets and tokens display placeholder states until the
        official $FLUX launch. No transfers can be initiated from this page.
      </p>
    </div>
  );
}

function roleLabel(role: string): string {
  switch (role) {
    case "W1":
      return "Creator-fee receiver";
    case "W2":
      return "Buyback treasury";
    case "W3":
      return "Operations & reserve";
    case "W4":
      return "Development";
    default:
      return role;
  }
}

function ActivityTable({
  activity,
  network,
  onPage,
}: {
  activity: ActivityResponse;
  network: ClusterId;
  onPage: (page: number) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-left text-2xs">
        <thead className="text-night-500">
          <tr className="border-b border-night-700/70">
            <th className="px-3 py-2 font-medium">Signature</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">From</th>
            <th className="px-3 py-2 font-medium">To</th>
            <th className="px-3 py-2 text-right font-medium">In</th>
            <th className="px-3 py-2 text-right font-medium">Out</th>
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {activity.activities.map((a) => (
            <tr key={`${a.signature}:${a.entryKey}`} className="row-sep">
              <td className="max-w-[180px] px-3 py-2">
                <a
                  href={explorerUrl(network, "tx", a.signature)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-mint-300 hover:text-mint-200"
                  title={a.signature}
                >
                  {a.signature.slice(0, 8)}…{a.signature.slice(-6)}
                  <Icon name="external" size={10} />
                </a>
              </td>
              <td className="px-3 py-2">
                <Badge
                  tone={
                    a.type === "burn"
                      ? "danger"
                      : a.type === "swap"
                        ? "ice"
                        : a.type === "fee_collect"
                          ? "mint"
                          : "neutral"
                  }
                >
                  {TYPE_LABELS[a.type] ?? a.type}
                </Badge>
              </td>
              <td className="px-3 py-2 font-mono text-night-400">{shortAddr(a.sender)}</td>
              <td className="px-3 py-2 font-mono text-night-400">{shortAddr(a.recipient)}</td>
              <td className="px-3 py-2 text-right font-mono text-night-400">
                {formatToken(a.inputAmount, a.inputDecimals)}{" "}
                <span className="text-night-500">{assetLabel(a.inputAsset)}</span>
              </td>
              <td className="px-3 py-2 text-right font-mono text-night-400">
                {a.outputAmount != null
                  ? `${formatToken(a.outputAmount, a.outputDecimals)} ${assetLabel(a.outputAsset)}`
                  : "—"}
              </td>
              <td className="px-3 py-2 text-night-400">
                {a.blockTime ? new Date(a.blockTime).toLocaleString() : "—"}
              </td>
              <td className="px-3 py-2">
                <Badge tone={a.status === "confirmed" ? "success" : "danger"}>{a.status}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between border-t border-night-700/70 px-3 py-2 text-2xs text-night-500">
        <span>
          Page {activity.page} of {activity.totalPages} · {activity.total} verified entries
        </span>
        <div className="flex items-center gap-1">
          <button
            disabled={activity.page <= 1}
            onClick={() => onPage(Math.max(1, activity.page - 1))}
            aria-label="Previous page"
            className="rounded-md border border-night-600 px-2 py-1 text-night-400 hover:border-night-500 hover:text-ink disabled:opacity-40"
          >
            <Icon name="chevronLeft" size={11} />
          </button>
          <button
            disabled={activity.page >= activity.totalPages}
            onClick={() => onPage(activity.page + 1)}
            aria-label="Next page"
            className="rounded-md border border-night-600 px-2 py-1 text-night-400 hover:border-night-500 hover:text-ink disabled:opacity-40"
          >
            <Icon name="chevronRight" size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}