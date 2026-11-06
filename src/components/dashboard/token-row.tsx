"use client";
/** Compact token row used across trending / latest / explore lists. */
import Link from "next/link";
import { useEffect, useState } from "react";
import { RouteBadge, StatusBadge } from "@/components/brand/route-badge";
import { timeAgo, shortAddress, formatCompact } from "@/lib/format";
import { toBrowserImageUrl } from "@/lib/image-url";

export interface TokenRowData {
  id: string;
  name: string;
  symbol: string;
  route: string;
  status: string;
  mintAddress: string | null;
  imageUrl?: string | null;
  creatorWallet?: string;
  createdAt: string | Date;
  /** Verified 0–100 curve progress; null = unavailable (not fabricated). */
  curveProgress?: number | null;
}

/**
 * Token thumbnail with graceful degradation:
 * - the stored reference is normalized (`ipfs://` conversion, gateway
 *   rewrite for the deprecated `ipfs.io` host) before rendering;
 * - when the image genuinely cannot load, a symbol-initials avatar is
 *   rendered with identical dimensions (no layout shift, no retry loop);
 * - the failure stays visible in development diagnostics via console.warn.
 */
export function TokenImage({
  imageUrl,
  symbol,
  size = 32,
}: {
  imageUrl?: string | null;
  symbol: string;
  size?: number;
}) {
  const normalized = toBrowserImageUrl(imageUrl);
  const [failed, setFailed] = useState(false);
  // A new/changed URL resets the failure state so a fixed record renders its
  // image again without a remount.
  useEffect(() => {
    setFailed(false);
  }, [normalized]);

  const dims = { width: size, height: size };
  const frame =
    "shrink-0 rounded-md border border-night-600 object-cover overflow-hidden";

  if (normalized && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={normalized}
        alt=""
        width={size}
        height={size}
        onError={() => {
          // One-shot fallback: swap to the avatar; never re-attempt the same
          // broken URL (no retry loop).
          setFailed(true);
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              `[image] failed to load (${symbol}): ${normalized} — rendered fallback avatar`,
            );
          }
        }}
        className={frame}
        style={dims}
      />
    );
  }
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-md border border-night-600 bg-night-800 text-2xs font-bold text-night-400${normalized && failed ? " border-warn/60" : ""}`}
      style={dims}
      aria-hidden
      title={normalized && failed ? "Token image unavailable" : undefined}
    >
      {symbol.slice(0, 2).toUpperCase()}
    </span>
  );
}

export function CurveProgressBar({ progress }: { progress: number | null | undefined }) {
  if (progress == null) return null;
  return (
    <div
      className="h-1 w-full overflow-hidden rounded-full bg-night-700"
      title={`Verified bonding-curve progress: ${progress.toFixed(1)}%`}
    >
      <div
        className="h-full rounded-full bg-mint-500 transition-[width] duration-500"
        style={{ width: `${Math.min(100, Math.max(2, progress))}%` }}
      />
    </div>
  );
}

export function TokenRow({
  token,
  showCreator = false,
}: {
  token: TokenRowData;
  showCreator?: boolean;
}) {
  const href = `/tokens/${token.mintAddress ?? token.id}`;
  return (
    <Link
      href={href}
      className="row-sep group block px-3 py-2 transition-colors hover:bg-night-700/40"
    >
      <div className="flex items-center gap-3">
        <TokenImage imageUrl={token.imageUrl} symbol={token.symbol} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[13px] font-medium text-ink group-hover:text-mint-300">
              {token.name}
            </span>
            <span className="shrink-0 font-mono text-2xs text-night-400">${token.symbol}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-2xs text-night-500">
            <span className="truncate font-mono">
              {token.mintAddress ? shortAddress(token.mintAddress, 4) : "mint pending"}
            </span>
            {showCreator && token.creatorWallet && (
              <span className="hidden truncate font-mono sm:inline">
                by {shortAddress(token.creatorWallet, 4)}
              </span>
            )}
            <span className="shrink-0">{timeAgo(token.createdAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <RouteBadge route={token.route} />
          <StatusBadge status={token.status} />
        </div>
      </div>
      {token.curveProgress != null && (
        <div className="mt-1.5 flex items-center gap-2">
          <CurveProgressBar progress={token.curveProgress} />
          <span className="shrink-0 font-mono text-2xs text-mint-400">
            {formatCompact(token.curveProgress)}%
          </span>
        </div>
      )}
    </Link>
  );
}
