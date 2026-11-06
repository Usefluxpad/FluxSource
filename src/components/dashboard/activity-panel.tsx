"use client";
/**
 * Panel B — Live Launches & Activity. Streams real lifecycle events from
 * FluxPad's registry (LaunchEvent records) with polling and reconnect-safe
 * refresh. No simulated users, trades, or events.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Panel, RefreshButton, PanelSkeleton, PanelEmpty, PanelError } from "./panel";
import { RouteBadge } from "@/components/brand/route-badge";
import { Icon } from "@/components/ui/icons";
import { timeAgo, shortAddress } from "@/lib/format";

interface ActivityEvent {
  id: string;
  kind: string;
  createdAt: string;
  launch: {
    id: string;
    name: string;
    symbol: string;
    route: string;
    status: string;
    mintAddress: string | null;
    imageUrl: string | null;
  };
}

const KIND_META: Record<string, { label: string; icon: string; color: string }> = {
  intent_recorded: { label: "Launch prepared", icon: "clock", color: "text-night-400" },
  submitted: { label: "Submitted", icon: "zap", color: "text-ice-300" },
  confirmed: { label: "Confirmed", icon: "check", color: "text-mint-400" },
  curve_trading: { label: "Curve trading", icon: "trending", color: "text-mint-400" },
  graduation_detected: { label: "Graduation detected", icon: "zap", color: "text-ice-300" },
  pool_verified: { label: "Pool verified", icon: "check", color: "text-up" },
  failed: { label: "Failed", icon: "alert", color: "text-down" },
  unresolved: { label: "Unresolved", icon: "alert", color: "text-warn" },
};

const POLL_MS = 20_000;

export function ActivityPanel({ full = false }: { full?: boolean }) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/activity?limit=${full ? 60 : 16}`);
      if (res.status === 503) throw new Error("Launch registry unavailable (database not configured).");
      if (!res.ok) throw new Error(`Registry error ${res.status}`);
      const data = (await res.json()) as { events: ActivityEvent[] };
      setEvents(data.events);
      setUpdatedAt(Date.now());
      setOffline(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setOffline(true);
    }
  }, [full]);

  useEffect(() => {
    setEvents(null);
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onOnline = () => void load();
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(t);
      window.removeEventListener("online", onOnline);
    };
  }, [load]);

  return (
    <Panel
      title={full ? "Live launches & activity" : "Live activity"}
      icon="activity"
      subtitle={full ? "real lifecycle events" : undefined}
      className={full ? "" : "h-full"}
      bodyClassName={full ? "" : "lg:max-h-[420px] lg:overflow-y-auto"}
      actions={
        <>
          {offline && <span className="text-2xs text-warn">reconnecting…</span>}
          <RefreshButton onClick={() => void load()} updatedAt={updatedAt} />
        </>
      }
    >
      {error ? (
        <PanelError message={error} onRetry={() => void load()} />
      ) : events === null ? (
        <PanelSkeleton rows={full ? 10 : 5} />
      ) : events.length === 0 ? (
        <PanelEmpty
          message="No launch activity recorded yet."
          hint="Events appear when creators prepare, submit, and confirm launches through FluxPad."
        />
      ) : (
        <ul>
          {events.map((ev) => {
            const meta = KIND_META[ev.kind] ?? { label: ev.kind, icon: "info", color: "text-night-400" };
            return (
              <li key={ev.id} className="row-sep px-3 py-2 transition-colors hover:bg-night-700/40">
                <Link href={`/tokens/${ev.launch.mintAddress ?? ev.launch.id}`} className="block">
                  <div className="flex items-center gap-2.5">
                    <Icon name={meta.icon} size={14} className={`shrink-0 ${meta.color}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="truncate text-[13px] text-ink">
                          {meta.label}
                          {": "}
                          <span className="text-mint-300">{ev.launch.name}</span>
                        </span>
                        <span className="shrink-0 font-mono text-2xs text-night-500">
                          ${ev.launch.symbol}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-2xs text-night-500">
                        <span>{timeAgo(ev.createdAt)}</span>
                        {ev.launch.mintAddress && (
                          <span className="hidden font-mono sm:inline">
                            {shortAddress(ev.launch.mintAddress, 4)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0">
                      <RouteBadge route={ev.launch.route} />
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {!full && events && events.length > 0 && (
        <Link
          href="/live"
          className="block border-t border-night-700/70 px-3 py-2 text-center text-2xs text-night-400 transition hover:bg-night-700/40 hover:text-mint-300"
        >
          View all activity →
        </Link>
      )}
    </Panel>
  );
}
