"use client";
/**
 * Panel D — Latest launches. The most recent records in FluxPad's registry,
 * with route filters and most-recent sorting. Only real records are shown.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Panel, FilterPill, RefreshButton, PanelSkeleton, PanelEmpty, PanelError } from "./panel";
import { TokenRow, type TokenRowData } from "./token-row";

type RouteFilter = "all" | "PUMP_PUMPSWAP" | "LAUNCHLAB_CPMM";

const FILTERS: { key: RouteFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "PUMP_PUMPSWAP", label: "Pump" },
  { key: "LAUNCHLAB_CPMM", label: "LaunchLab" },
];

const POLL_MS = 30_000;

export function LatestPanel({ full = false }: { full?: boolean }) {
  const [filter, setFilter] = useState<RouteFilter>("all");
  const [tokens, setTokens] = useState<TokenRowData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: full ? "40" : "18", sort: "recent" });
    if (filter !== "all") params.set("route", filter);
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
      title={full ? "Latest launches" : "Latest launches"}
      icon="rocket"
      subtitle={full ? "newest first" : undefined}
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
          message="No launches recorded yet."
          hint="Be the first: choose your launch path and create a token on devnet."
        />
      ) : (
        <ul>
          {tokens.map((t) => (
            <li key={t.id}>
              <TokenRow token={t} showCreator />
            </li>
          ))}
        </ul>
      )}
      {!full && tokens && tokens.length > 0 && (
        <Link
          href="/tokens"
          className="block border-t border-night-700/70 px-3 py-2 text-center text-2xs text-night-400 transition hover:bg-night-700/40 hover:text-mint-300"
        >
          Explore all launches →
        </Link>
      )}
    </Panel>
  );
}
