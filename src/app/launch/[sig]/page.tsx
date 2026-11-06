import { notFound } from "next/navigation";
import { CopyChip } from "@/components/ui/primitives";
import { getDb } from "@/lib/db";
import { RouteBadge, StatusBadge } from "@/components/brand/route-badge";
import { timeAgo } from "@/lib/format";

export const metadata = { title: "Launch status" };

interface LaunchRecord {
  id: string;
  name: string;
  symbol: string;
  route: string;
  status: string;
  mintAddress: string | null;
  signature: string | null;
  network: string;
  lastError: string | null;
  timeline: { kind: string; createdAt: string }[];
}

// Direct Prisma read (no HTTP self-fetch — see tokens/page.tsx).
async function fetchLaunch(signature: string): Promise<LaunchRecord | null> {
  try {
    const db = getDb();
    if (!db) return null;
    const launch = await db.launch.findFirst({
      where: { signature },
      include: { timeline: { orderBy: { createdAt: "asc" } } },
    });
    return launch as unknown as LaunchRecord | null;
  } catch {
    return null;
  }
}

export default async function LaunchStatusPage({
  params,
}: {
  params: Promise<{ sig: string }>;
}) {
  const { sig } = await params;
  const launch = await fetchLaunch(sig);

  if (!launch) {
    notFound();
  }

  return (
    <div className="animate-fade-up mx-auto max-w-2xl">
      <header className="mb-4">
        <h1 className="font-display text-lg font-semibold tracking-tight text-ink">Launch status</h1>
        <p className="mt-0.5 text-2xs text-night-500">
          Status is reconciled against on-chain accounts — the database never decides graduation on its own.
        </p>
      </header>
      <section className="space-y-3 rounded-lg border border-night-700/80 bg-night-850 p-4 shadow-panel">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-ink">
            {launch.name} <span className="font-mono text-night-500">${launch.symbol}</span>
          </span>
          <RouteBadge route={launch.route} />
          <StatusBadge status={launch.status} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-night-700/60 pb-2 text-[13px]">
          <span className="text-night-500">Transaction</span>
          <CopyChip value={launch.signature ?? sig} label="launch signature" />
        </div>
        {launch.mintAddress && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-night-700/60 pb-2 text-[13px]">
            <span className="text-night-500">Mint</span>
            <CopyChip value={launch.mintAddress} label="mint address" />
          </div>
        )}
        {launch.timeline.length > 0 && (
          <ol className="space-y-1.5 text-[13px]">
            {launch.timeline.map((t, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-night-400">
                <span>{t.kind.replace(/_/g, " ")}</span>
                <span className="text-2xs text-night-500">{timeAgo(t.createdAt)}</span>
              </li>
            ))}
          </ol>
        )}
        {launch.lastError && (
          <p className="rounded-lg border border-danger/40 bg-danger/50/10 p-3 text-xs text-danger">
            {launch.lastError}
          </p>
        )}
        {launch.mintAddress && (
          <a href={`/tokens/${launch.mintAddress}`} className="block text-sm text-mint-400 hover:underline">
            Open token page →
          </a>
        )}
      </section>
    </div>
  );
}
