import { notFound } from "next/navigation";
import Link from "next/link";
import { Badge, CopyChip } from "@/components/ui/primitives";
import { explorerUrl, solscanUrl, type ClusterId } from "@/lib/constants";
import { getDb } from "@/lib/db";
import { RouteBadge, StatusBadge, LIFECYCLE_STEPS, lifecycleIndex } from "@/components/brand/route-badge";
import { WatchButton } from "@/components/watch/watch-button";
import { TokenImage } from "@/components/dashboard/token-row";
import { TokenMarketView } from "@/components/token/market-view";
import { DiscoveredTokenHeader } from "@/components/token/discovered-header";
import { curveProgress, timeAgo, shortAddress } from "@/lib/format";
import { fetchSocialsFromUri, fetchTokenSocials, type TokenSocials } from "@/lib/token/onchain-metadata";
import { SocialLinks } from "@/components/token/social-links";

export const metadata = { title: "Token" };
// Live registry + creator listings; render per request.
export const dynamic = "force-dynamic";

interface LaunchRecord {
  id: string;
  name: string;
  symbol: string;
  description: string | null;
  route: "PUMP_PUMPSWAP" | "LAUNCHLAB_CPMM";
  status: string;
  mintAddress: string | null;
  signature: string | null;
  metadataUri: string | null;
  imageUrl: string | null;
  poolAddress: string | null;
  poolVerifiedAt: string | null;
  network: string;
  creatorWallet: string;
  createdAt: string;
  updatedAt: string;
  curveState: Record<string, unknown> | null;
  timeline: { kind: string; createdAt: string; detail: unknown }[];
}

// Direct Prisma read (no HTTP self-fetch — see tokens/page.tsx).
async function fetchLaunch(mintOrId: string): Promise<LaunchRecord | null> {
  try {
    const db = getDb();
    if (!db) return null;
    const launch = await db.launch.findFirst({
      where: { OR: [{ id: mintOrId }, { mintAddress: mintOrId }] },
      include: { timeline: { orderBy: { createdAt: "asc" } } },
    });
    return launch as unknown as LaunchRecord | null;
  } catch {
    return null;
  }
}

async function fetchCreatorOthers(creatorWallet: string, excludeId: string) {
  try {
    const db = getDb();
    if (!db) return [];
    const rows = await db.launch.findMany({
      where: { creatorWallet, NOT: { id: excludeId } },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        name: true,
        symbol: true,
        route: true,
        status: true,
        mintAddress: true,
        imageUrl: true,
        createdAt: true,
      },
    });
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  } catch {
    return [];
  }
}

export default async function TokenDetailPage({
  params,
}: {
  params: Promise<{ mint: string }>;
}) {
  const { mint } = await params;
  const launch = await fetchLaunch(mint);

  // Social links come from the token's own off-chain metadata JSON — the
  // registry record's metadataUri for FluxPad launches, or the mint's
  // on-chain Metaplex metadata for scanned external tokens. Unavailable
  // links stay null (never fabricated).
  let socials: TokenSocials = { website: null, twitter: null, telegram: null };
  if (launch?.metadataUri) {
    socials = await fetchSocialsFromUri(launch.metadataUri);
  } else if (!launch) {
    socials = await fetchTokenSocials(mint);
  }

  // Discovered (or unknown) mints: live market analytics without a registry
  // record. The chart/trades/wallet sections derive from real on-chain swaps.
  if (!launch) {
    return (
      <div className="animate-fade-up mx-auto max-w-5xl">
        <DiscoveredTokenHeader mint={mint} socials={socials} />
        <div className="mb-4">
          <TokenMarketView mint={mint} />
        </div>
      </div>
    );
  }

  const cluster = (launch.network === "mainnet-beta"
    ? "mainnet-beta"
    : "devnet") as ClusterId;
  const others = launch.creatorWallet
    ? await fetchCreatorOthers(launch.creatorWallet, launch.id)
    : [];
  const progress = curveProgress(launch.curveState);
  const stepIdx = lifecycleIndex(launch.status);

  return (
    <div className="animate-fade-up">
      {/* Identity header */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <TokenImage imageUrl={launch.imageUrl} symbol={launch.symbol} size={48} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-lg font-semibold tracking-tight text-ink">{launch.name}</h1>
            <span className="font-mono text-sm text-night-400">${launch.symbol}</span>
            <RouteBadge route={launch.route} />
            <StatusBadge status={launch.status} />
            <Badge tone="neutral">{launch.network}</Badge>
          </div>
          <SocialLinks socials={socials} className="mt-1.5" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {launch.mintAddress && <WatchButton mint={launch.mintAddress} />}
          {launch.mintAddress && <CopyChip value={launch.mintAddress} label="mint address" />}
        </div>
      </div>

      {/* Lifecycle progress strip */}
      <div className="mb-4 rounded-lg border border-night-700/80 bg-night-850 px-4 py-3 shadow-panel">
        <div className="flex items-center">
          {LIFECYCLE_STEPS.map((s, i) => {
            const done = stepIdx > i;
            const current = stepIdx === i;
            const failed = stepIdx === -1;
            return (
              <div key={s.key} className="flex min-w-0 flex-1 items-center last:flex-none">
                <div className="flex min-w-0 flex-col items-center">
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full border text-2xs ${
                      current
                        ? "border-mint-500 bg-mint-500 text-snow"
                        : done
                          ? "border-mint-600/60 bg-night-800 text-mint-400"
                          : failed
                            ? "border-night-600 bg-night-850 text-night-500"
                            : "border-night-600 bg-night-850 text-night-500"
                    }`}
                  >
                    {done ? "✓" : i + 1}
                  </span>
                  <span className={`mt-1 hidden truncate text-2xs sm:block ${current ? "text-mint-300" : "text-night-500"}`}>
                    {s.label}
                  </span>
                </div>
                {i < LIFECYCLE_STEPS.length - 1 && (
                  <div className={`mx-1 mb-0 h-px flex-1 sm:mb-4 ${done ? "bg-mint-600/60" : "bg-night-600"}`} />
                )}
              </div>
            );
          })}
        </div>
        {stepIdx === -1 && (
          <p className="mt-2 text-center text-2xs text-down">
            This launch is {launch.status.toLowerCase()} — see the timeline below for details.
          </p>
        )}
      </div>

      {/* Live market analytics — real on-chain swaps only (no fabricated data) */}
      <div className="mb-4">
        <TokenMarketView mint={launch.mintAddress ?? mint} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {/* Launch record */}
        <section className="rounded-lg border border-night-700/80 bg-night-850 p-4 shadow-panel lg:col-span-2">
          <h2 className="text-[13px] font-semibold text-ink">Launch record</h2>
          <dl className="mt-3 grid gap-2.5 text-[13px]">
            <Row label="Mint">
              {launch.mintAddress ? (
                <CopyChip value={launch.mintAddress} label="mint address" />
              ) : (
                <span className="text-night-500">Not confirmed yet</span>
              )}
            </Row>
            <Row label="Creator">
              <Link
                href={`/tokens?creator=${launch.creatorWallet}`}
                className="text-ice-300 hover:underline"
                title="View this creator's other launches"
              >
                <span className="font-mono">{shortAddress(launch.creatorWallet, 6)}</span>
              </Link>
            </Row>
            <Row label="Launch transaction">
              {launch.signature ? (
                <CopyChip value={launch.signature} label="launch signature" />
              ) : (
                <span className="text-night-500">Not submitted yet</span>
              )}
            </Row>
            <Row label="Created">
              {new Date(launch.createdAt).toLocaleString()}
              <span className="ml-1 text-night-500">({timeAgo(launch.createdAt)})</span>
            </Row>
            {launch.metadataUri && (
              <Row label="Metadata URI">
                <a
                  href={launch.metadataUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-ice-300 hover:underline"
                >
                  {launch.metadataUri}
                </a>
              </Row>
            )}
          </dl>

          {/* Graduation destination — verified data only */}
          <div className="mt-4 rounded-lg border border-night-700 bg-night-800/60 p-3">
            <p className="text-2xs font-semibold uppercase tracking-wider text-night-500">
              Graduation destination
            </p>
            {launch.poolAddress ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <CopyChip value={launch.poolAddress} label="pool address" />
                <Badge tone="success">
                  verified {launch.poolVerifiedAt ? new Date(launch.poolVerifiedAt).toLocaleString() : ""}
                </Badge>
              </div>
            ) : (
              <p className="mt-2 text-xs text-night-500">
                {launch.route === "PUMP_PUMPSWAP"
                  ? "PumpSwap pool appears here once pump.fun's protocol completes migration and FluxPad verifies it on-chain."
                  : "Raydium CPMM pool address appears here once the LaunchLab migration completes and the pool is verified on-chain."}
              </p>
            )}
          </div>

          {/* Curve state — verified snapshot only */}
          <div className="mt-3 rounded-lg border border-night-700 bg-night-800/60 p-3">
            <p className="text-2xs font-semibold uppercase tracking-wider text-night-500">
              Bonding-curve state
            </p>
            {progress != null ? (
              <div className="mt-2 flex items-center gap-3">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-night-700">
                  <div
                    className="h-full rounded-full bg-mint-500"
                    style={{ width: `${Math.min(100, Math.max(2, progress))}%` }}
                  />
                </div>
                <span className="font-mono text-2xs text-mint-400">{progress.toFixed(1)}%</span>
              </div>
            ) : launch.curveState ? (
              <p className="mt-2 break-all font-mono text-2xs text-night-400">
                {JSON.stringify(launch.curveState).slice(0, 220)}
                {JSON.stringify(launch.curveState).length > 220 ? "…" : ""}
              </p>
            ) : (
              <p className="mt-2 text-xs text-night-500">
                No verified curve snapshot recorded yet.
              </p>
            )}
          </div>

          {launch.description && (
            <p className="mt-4 border-t border-night-700/60 pt-3 text-[13px] text-night-500">
              {launch.description}
            </p>
          )}

          {launch.mintAddress && (
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <a
                href={explorerUrl(cluster, "address", launch.mintAddress)}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-night-600 px-3 py-1.5 text-night-500 hover:text-ink"
              >
                Explorer ↗
              </a>
              <a
                href={solscanUrl(cluster, "account", launch.mintAddress)}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-night-600 px-3 py-1.5 text-night-500 hover:text-ink"
              >
                Solscan ↗
              </a>
            </div>
          )}
        </section>

        {/* Timeline */}
        <section className="rounded-lg border border-night-700/80 bg-night-850 p-4 shadow-panel">
          <h2 className="text-[13px] font-semibold text-ink">Launch events</h2>
          <ol className="mt-3 space-y-3">
            {launch.timeline.length === 0 && (
              <li className="text-[13px] text-night-500">No recorded events yet.</li>
            )}
            {launch.timeline.map((t, i) => (
              <li key={i} className="flex gap-2.5 text-[13px]">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-mint-500" />
                <div className="min-w-0">
                  <p className="text-ink">{t.kind.replace(/_/g, " ")}</p>
                  <p className="text-2xs text-night-500">
                    {new Date(t.createdAt).toLocaleString()} ({timeAgo(t.createdAt)})
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {/* Creator's other launches */}
      {others.length > 0 && (
        <section className="mt-4">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-[13px] font-semibold text-ink">
              More from {shortAddress(launch.creatorWallet, 4)}
            </h2>
            <Link
              href={`/tokens?creator=${launch.creatorWallet}`}
              className="text-2xs text-ice-300 hover:underline"
            >
              view all →
            </Link>
          </div>
          <div className="overflow-hidden rounded-lg border border-night-700/80 bg-night-850 shadow-panel">
            {others.map((o) => (
              <Link
                key={o.id}
                href={`/tokens/${o.mintAddress ?? o.id}`}
                className="row-sep flex items-center gap-3 px-3 py-2 transition hover:bg-night-700/40"
              >
                <TokenImage imageUrl={o.imageUrl} symbol={o.symbol} size={28} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  {o.name} <span className="font-mono text-2xs text-night-400">${o.symbol}</span>
                </span>
                <RouteBadge route={o.route} />
                <StatusBadge status={o.status} />
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-night-700/60 pb-2">
      <dt className="text-night-500">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}
