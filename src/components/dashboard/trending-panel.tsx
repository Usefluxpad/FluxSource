"use client";
/**
 * Panel A — Trending tokens. Ranked by most recent registry activity from
 * RelayPad's real records. Filters: All / Pump / LaunchLab / New / Graduating.
 * Verified curve progress is shown when on-chain snapshots exist; market
 * metrics that RelayPad cannot verify are never fabricated.
 */
import { useCallback, useEffect, useState } from "react";
import { Panel, FilterPill, RefreshButton, PanelSkeleton, PanelEmpty, PanelError } from "./panel";
import { TokenRow, type TokenRowData } from "./token-row";
import Link from "next/link";

type Filter = "all" | "pump" | "launchlab" | "new" | "graduating";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pump", label: "Pump" },
  { key: "launchlab", label: "LaunchLab" },
  { key: "new", label: "New" },
  { key: "graduating", label: "Graduating" },
];

const POLL_MS = 30_000;

export function TrendingPanel({ full = false }: { full?: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [tokens, setTokens] = useState<TokenRowData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: full ? "40" : "18", sort: "active" });
    if (filter === "pump") params.set("route", "PUMP_PUMPSWAP");
    if (filter === "launchlab") params.set("route", "LAUNCHLAB_CPMM");
    if (filter === "new") params.set("statusGroup", "new");
    if (filter === "graduating") params.set("statusGroup", "graduating");
    setError(null);
    try {
      const res = await fetch(`/api/launches?${params}`);
      if (res.status === 503) throw new Error("Launch registry unavailable (database not configured).");
      if (!res.ok) throw new Error(`Registry error ${res.status}`);
      const data = (await res.json()) as { launches: TokenRowData[] };
      setTokens(data.launches);
      setUpdatedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [filter, full]);

  useEffect(() => {
    setTokens(null);
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <Panel
      title={full ? "Trending launches" : "Trending"}
      icon="trending"
      subtitle={full ? "by recent registry activity" : undefined}
      className={full ? "" : "h-full"}
      bodyClassName={full ? "" : "lg:max-h-[420px] lg:overflow-y-auto"}
      actions={
        <>
          <div className="flex items-center gap-0.5 rounded-md bg-night-800 p-0.5">
            {FILTERS.map((f) => (
              <FilterPill key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label}
              </FilterPill>
            ))}
          </div>
          <RefreshButton onClick={() => void load()} updatedAt={updatedAt} />
        </>
      }
    >
      {error ? (
        <PanelError message={error} onRetry={() => void load()} />
      ) : tokens === null ? (
        <PanelSkeleton rows={full ? 10 : 6} />
      ) : tokens.length === 0 ? (
        <PanelEmpty
          message="No launches match this filter yet."
          hint="Launches recorded through FluxPad appear here with verified lifecycle data."
        />
      ) : (
        <ul>
          {tokens.map((t) => (
            <li key={t.id}>
              <TokenRow token={t} showCreator={full} />
            </li>
          ))}
        </ul>
      )}
      {!full && tokens && tokens.length > 0 && (
        <Link
          href="/trending"
          className="block border-t border-night-700/70 px-3 py-2 text-center text-2xs text-night-400 transition hover:bg-night-700/40 hover:text-mint-300"
        >
          View all trending →
        </Link>
      )}
    </Panel>
  );
}
