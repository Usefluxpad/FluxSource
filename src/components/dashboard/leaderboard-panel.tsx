"use client";
/**
 * Panel C — Creator leaderboard. Rankings computed from FluxPad's registry:
 * launches are real record counts; "graduated" counts only lifecycle states
 * verified on-chain (graduation detected / pool verified). No earnings,
 * volume, or profitability data exists — none is shown.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Panel, FilterPill, RefreshButton, PanelSkeleton, PanelEmpty, PanelError } from "./panel";
import { abbreviateWallet } from "@/lib/format";
import { Icon } from "@/components/ui/icons";

type Metric = "launches" | "active" | "graduated";

interface Row {
  creatorWallet: string;
  launches: number;
  graduated: number;
  lastActive: string | null;
}

const METRICS: { key: Metric; label: string }[] = [
  { key: "launches", label: "Most launches" },
  { key: "active", label: "Recently active" },
  { key: "graduated", label: "Graduated" },
];

const POLL_MS = 60_000;

export function LeaderboardPanel({ full = false }: { full?: boolean }) {
  const [metric, setMetric] = useState<Metric>("launches");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/leaderboard?metric=${metric}&limit=${full ? 25 : 10}`);
      if (res.status === 503) throw new Error("Launch registry unavailable (database not configured).");
      if (!res.ok) throw new Error(`Registry error ${res.status}`);
      const data = (await res.json()) as { leaderboard: Row[] };
      setRows(data.leaderboard);
      setUpdatedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [metric, full]);

  useEffect(() => {
    setRows(null);
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <Panel
      title={full ? "Creator leaderboard" : "Leaderboard"}
      icon="trophy"
      subtitle={full ? "from verified registry records" : undefined}
      className={full ? "" : "h-full"}
      bodyClassName={full ? "" : "lg:max-h-[420px] lg:overflow-y-auto"}
      actions={
        <>
          <div className="hidden items-center gap-0.5 rounded-md bg-night-800 p-0.5 sm:flex">
            {METRICS.map((m) => (
              <FilterPill key={m.key} active={metric === m.key} onClick={() => setMetric(m.key)}>
                {m.label}
              </FilterPill>
            ))}
          </div>
          <RefreshButton onClick={() => void load()} updatedAt={updatedAt} />
        </>
      }
    >
      {error ? (
        <PanelError message={error} onRetry={() => void load()} />
      ) : rows === null ? (
        <PanelSkeleton rows={full ? 10 : 5} />
      ) : rows.length === 0 ? (
        <PanelEmpty
          message="No creator data yet."
          hint="Rankings appear once creators record launches through FluxPad."
        />
      ) : (
        <ul>
          {rows.map((r, i) => (
            <li
              key={r.creatorWallet}
              className="row-sep flex items-center gap-3 px-3 py-2 transition-colors hover:bg-night-700/40"
            >
              <span
                className={`w-5 shrink-0 text-center font-mono text-2xs ${
                  i < 3 ? "text-mint-400" : "text-night-500"
                }`}
              >
                {i + 1}
              </span>
              <Icon name="user" size={14} className="shrink-0 text-night-500" />
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">
                {abbreviateWallet(r.creatorWallet)}
              </span>
              <span className="shrink-0 text-2xs text-night-400" title="Recorded launches">
                {r.launches} {r.launches === 1 ? "launch" : "launches"}
              </span>
              {r.graduated > 0 && (
                <span className="shrink-0 rounded bg-sky-100/70 px-1.5 py-0.5 text-2xs text-mint-300">
                  {r.graduated} graduated
                </span>
              )}
              <Link
                href={`/tokens?creator=${r.creatorWallet}`}
                className="shrink-0 text-2xs text-ice-300 hover:underline"
              >
                tokens
              </Link>
            </li>
          ))}
        </ul>
      )}
      {!full && rows && rows.length > 0 && (
        <Link
          href="/leaderboard"
          className="block border-t border-night-700/70 px-3 py-2 text-center text-2xs text-night-400 transition hover:bg-night-700/40 hover:text-mint-300"
        >
          View full leaderboard →
        </Link>
      )}
    </Panel>
  );
}
