"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { EmptyState, Spinner } from "@/components/ui/primitives";
import { RouteBadge, StatusBadge } from "@/components/brand/route-badge";
import { TokenImage, CurveProgressBar, type TokenRowData } from "@/components/dashboard/token-row";
import { timeAgo } from "@/lib/format";

interface MyLaunch extends TokenRowData {
  signature: string | null;
  updatedAt: string;
}

export default function DashboardPage() {
  const { publicKey, connected } = useWallet();
  const [launches, setLaunches] = useState<MyLaunch[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/launches?creator=${publicKey.toBase58()}&limit=50&sort=recent`);
      if (res.status === 503) {
        setError(
          "Launch registry unavailable: the database is not configured on this deployment.",
        );
        setLaunches(null);
        return;
      }
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const data = (await res.json()) as { launches: MyLaunch[] };
      setLaunches(data.launches);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  if (!connected || !publicKey) {
    return (
      <div className="animate-fade-up">
        <h1 className="mb-1 font-display text-lg font-semibold tracking-tight text-ink">My Tokens</h1>
        <p className="mb-6 text-2xs text-night-500">
          Launched with your connected wallet — FluxPad attributes by creator address, never by custody.
        </p>
        <EmptyState
          title="Connect your wallet"
          description="Your launches appear here once a wallet is connected. FluxPad attributes launches by creator address — never by custody."
        />
      </div>
    );
  }

  const total = launches?.length ?? 0;
  const trading = launches?.filter((l) => l.status === "CURVE_TRADING").length ?? 0;
  const graduated =
    launches?.filter((l) => l.status === "GRADUATION_DETECTED" || l.status === "POOL_VERIFIED").length ?? 0;

  return (
    <div className="animate-fade-up">
      <header className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div>
          <h1 className="font-display text-lg font-semibold tracking-tight text-ink">My Tokens</h1>
          <p className="mt-0.5 font-mono text-2xs text-night-500">{publicKey.toBase58()}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/create"
            className="flex items-center gap-1.5 rounded-lg bg-mint-500 px-3 py-1.5 text-xs font-semibold text-snow shadow-glow-mint transition hover:bg-mint-400"
          >
            + New launch
          </Link>
          <button
            onClick={() => void load()}
            aria-label="Refresh"
            className="rounded-lg border border-night-600 px-3 py-1.5 text-xs text-night-400 hover:border-night-500 hover:text-ink"
          >
            Refresh
          </button>
        </div>
      </header>

      {/* Real counts from the connected creator's registry records only */}
      <div className="mb-4 grid grid-cols-3 gap-3 sm:max-w-md">
        {[
          { label: "Launches", value: total },
          { label: "On curve", value: trading },
          { label: "Graduated", value: graduated },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-night-700/80 bg-night-850 px-3 py-2.5 shadow-panel">
            <p className="font-mono text-lg font-semibold text-ink">{s.value}</p>
            <p className="text-2xs text-night-500">{s.label}</p>
          </div>
        ))}
      </div>

      {loading && <Spinner label="Loading launches…" />}
      {error && (
        <div role="alert" className="rounded-xl border border-danger/40 bg-danger/50/10 p-4 text-sm text-danger">
          {error}
        </div>
      )}

      {!loading && !error && launches && launches.length === 0 && (
        <EmptyState
          title="No launches yet"
          description="Launches initiated with this wallet will be listed here with their lifecycle state."
          action={
            <Link href="/create" className="text-sm text-mint-400 hover:underline">
              Start a new launch →
            </Link>
          }
        />
      )}

      <div className="overflow-hidden rounded-lg border border-night-700/80 bg-night-850 shadow-panel">
        {launches?.map((l) => (
          <Link
            key={l.id}
            href={l.mintAddress ? `/tokens/${l.mintAddress}` : `/launch/${l.signature ?? l.id}`}
            className="row-sep block px-3 py-2.5 transition hover:bg-night-700/40"
          >
            <div className="flex items-center gap-3">
              <TokenImage imageUrl={l.imageUrl} symbol={l.symbol} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="truncate text-[13px] font-medium text-ink">{l.name}</span>
                  <span className="shrink-0 font-mono text-2xs text-night-400">${l.symbol}</span>
                </div>
                <div className="mt-0.5 text-2xs text-night-500">
                  {new Date(l.createdAt).toLocaleString()} · {timeAgo(l.createdAt)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <RouteBadge route={l.route} />
                <StatusBadge status={l.status} />
              </div>
            </div>
            {l.curveProgress != null && (
              <div className="mt-1.5">
                <CurveProgressBar progress={l.curveProgress} />
              </div>
            )}
          </Link>
        ))}
      </div>

      {launches && launches.length > 0 && (
        <p className="mt-3 text-2xs text-night-500">
          Tip: star any token on its detail page to follow it in your{" "}
          <Link href="/watchlist" className="text-ice-300 hover:underline">
            watchlist
          </Link>
          .
        </p>
      )}
    </div>
  );
}
