"use client";
/**
 * Identity header for tokens discovered on-chain but not registered in
 * RelayPad's launch registry. Pulls the discovery snapshot (real provider
 * data) and falls back to the raw mint when the token is not discovered.
 */
import { currentNetworkCluster } from "@/lib/network-env";
import { useEffect, useState } from "react";
import Link from "next/link";
import { TokenImage } from "@/components/dashboard/token-row";
import { Badge, Card } from "@/components/ui/primitives";
import { SocialLinks } from "@/components/token/social-links";
import { explorerUrl, solscanUrl, type ClusterId } from "@/lib/constants";
import { shortAddress } from "@/lib/format";
import type { TokenSocials } from "@/lib/metadata";

// Build-time inlined network (no server round-trip in a client component).
const CLUSTER: ClusterId = currentNetworkCluster();

interface Discovered {
  mint: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  source: string;
  status: string;
  creatorWallet: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  "pumpfun.curve": "Pump.fun curve",
  "pumpfun.pool": "PumpSwap pool",
  "launchlab.curve": "LaunchLab curve",
  "raydium.cpmm": "Raydium CPMM",
};

export function DiscoveredTokenHeader({ mint, socials }: { mint: string; socials?: TokenSocials | null }) {
  const [found, setFound] = useState<Discovered | null>(null);
  const [provider, setProvider] = useState<{ name: string | null; symbol: string | null; imageUrl: string | null } | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/discovery?q=${encodeURIComponent(mint)}&pageSize=5`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { tokens: Discovered[] };
        const match = data.tokens.find((t) => t.mint === mint);
        if (live && match) {
          setFound(match);
          return;
        }
        // Not in the discovery snapshot — resolve identity from the live
        // market providers (DexScreener/GeckoTerminal) before giving up.
        const mres = await fetch(`/api/tokens/${encodeURIComponent(mint)}/market`, { cache: "no-store" });
        if (mres.ok) {
          const m = (await mres.json()) as {
            live?: { available?: boolean; identity?: { name: string | null; symbol: string | null; imageUrl: string | null } | null };
          };
          if (live && m.live?.available && m.live.identity) setProvider(m.live.identity);
        }
      } catch {
        // Header falls back to the raw mint display.
      } finally {
        if (live) setChecked(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [mint]);

  const name = found?.name ?? provider?.name ?? `Mint ${shortAddress(mint, 6)}`;
  const symbol = found?.symbol ?? provider?.symbol ?? "???";

  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-center gap-3">
        <TokenImage imageUrl={found?.imageUrl ?? provider?.imageUrl ?? null} symbol={symbol} size={48} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight text-ink">{name}</h1>
            <span className="font-mono text-sm text-night-400">${symbol}</span>
            {found && found.source in SOURCE_LABEL && (
              <Badge tone="ice">{SOURCE_LABEL[found.source] ?? found.source}</Badge>
            )}
            {found?.status === "curve" && <Badge tone="mint">bonding curve</Badge>}
            {found?.status === "pool" && <Badge tone="success">pool</Badge>}
          </div>
          {socials && <SocialLinks socials={socials} className="mb-1.5" />}
          <p className="mt-1 break-all font-mono text-2xs text-night-500">
            {shortAddress(mint, 8)}{" "}
            <a href={explorerUrl("mainnet-beta", "address", mint)} target="_blank" rel="noopener noreferrer" className="text-ice-300 hover:underline">
              Explorer
            </a>{" "}
            ·{" "}
            <a href={solscanUrl(CLUSTER, "account", mint)} target="_blank" rel="noopener noreferrer" className="text-ice-300 hover:underline">
              Solscan
            </a>
          </p>
          {checked && !found && !provider && (
            <p className="mt-1 text-2xs text-night-500">
              This token is not in the current discovery snapshot and no DEX venue was resolved — market analytics
              below stay unavailable until a pool or bonding curve exists.
            </p>
          )}
          {found?.creatorWallet && (
            <p className="mt-1 text-2xs text-night-500">
              Creator:{" "}
              <span className="font-mono">{shortAddress(found.creatorWallet, 6)}</span>
            </p>
          )}
        </div>
        <div className="ml-auto">
          <Link href="/create" className="rounded-lg border border-mint-600/50 bg-mint-600/10 px-3 py-1.5 text-2xs font-medium text-mint-300 transition hover:bg-mint-600/20">
            Launch your own →
          </Link>
        </div>
      </div>
    </Card>
  );
}