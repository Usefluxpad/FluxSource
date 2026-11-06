"use client";
/**
 * Compact top bar: global search (registry-backed, debounced), network
 * indicator, wallet status, quick Create action. No fabricated wallet state.
 */
import { currentNetworkCluster } from "@/lib/network-env";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useConnection } from "@solana/wallet-adapter-react";
import { FluxSymbol, FluxWordmark } from "@/components/brand/logo";
import { BrandIcon, Icon } from "@/components/ui/icons";
import { WalletButton } from "@/components/wallet/wallet-button";
import { RouteBadge } from "@/components/brand/route-badge";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { shortAddress } from "@/lib/format";

/** Official FluxPad links — GitHub org is the verified project home; no X account is published yet, so none is linked (never point brand links at a legacy brand's accounts). */
const SOCIAL_LINKS = [
  { href: "https://github.com/Usefluxpad", label: "Official FluxPad GitHub", brand: "github" as const, size: 15 },
];

function SocialLinks() {
  return (
    <div className="flex items-center gap-1" aria-label="FluxPad social links">
      {SOCIAL_LINKS.map((s) => (
        <a
          key={s.href}
          href={s.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={s.label}
          title={s.label}
          className="flex h-8 w-8 items-center justify-center rounded-md text-night-400 transition hover:bg-night-800 hover:text-ink active:bg-night-700"
        >
          <BrandIcon name={s.brand} size={s.size} />
        </a>
      ))}
    </div>
  );
}

interface SearchHit {
  id: string;
  name: string;
  symbol: string;
  route: string;
  status: string;
  mintAddress: string | null;
}

const NETWORK = currentNetworkCluster();

function NetworkIndicator() {
  const { connection } = useConnection();
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    connection
      .getSlot("confirmed")
      .then(() => live && setOk(true))
      .catch(() => live && setOk(false));
    return () => {
      live = false;
    };
  }, [connection]);
  return (
    <Link
      href="/status"
      title="Network status"
      className="hidden items-center gap-1.5 rounded-lg border border-night-700 bg-night-950 px-2.5 py-1.5 text-2xs text-night-400 transition hover:border-night-600 hover:text-ink sm:flex"
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          ok === null ? "bg-night-400 animate-pulse-soft" : ok ? "bg-mint-500" : "bg-down"
        }`}
      />
      {NETWORK}
    </Link>
  );
}
function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      const query = q.trim();
      if (query.length < 2) {
        setHits(null);
        setOpen(false);
        return;
      }
      setLoading(true);
      try {
        const res = await fetch(`/api/launches?q=${encodeURIComponent(query)}&limit=8`);
        const data = res.ok ? ((await res.json()) as { launches: SearchHit[] }) : { launches: [] };
        setHits(data.launches);
        setOpen(true);
      } catch {
        setHits([]);
        setOpen(true);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const go = (hit: SearchHit) => {
    setOpen(false);
    setQ("");
    router.push(`/tokens/${hit.mintAddress ?? hit.id}`);
  };

  return (
    <div ref={boxRef} className="relative w-full max-w-md flex-1">
      <div className="flex items-center gap-2 rounded-lg border border-night-700 bg-night-950 px-3 py-1.5 transition-colors duration-200 focus-within:border-mint-500/60 focus-within:bg-paper">
        <Icon name="search" size={15} className="shrink-0 text-night-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => hits && setOpen(true)}
          placeholder="Search tokens, mint addresses, creators…"
          aria-label="Search tokens, mint addresses, creators"
          className="w-full bg-transparent text-[13px] text-ink placeholder:text-night-500 focus:outline-none"
        />
        {loading && <span className="h-3 w-3 animate-spin rounded-full border border-night-600 border-t-mint-500" />}
      </div>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-night-700 bg-paper shadow-panel">
          {!hits || hits.length === 0 ? (
            <p className="px-3 py-3 text-xs text-night-400">
              No launches match “{q.trim()}”. Try a name, ticker, mint or creator address.
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {hits.map((h) => (
                <li key={h.id} className="row-sep">
                  <button
                    onClick={() => go(h)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-night-800"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">
                        {h.name} <span className="font-mono text-night-400">${h.symbol}</span>
                      </span>
                      <span className="block truncate font-mono text-2xs text-night-500">
                        {h.mintAddress ? shortAddress(h.mintAddress, 6) : "mint pending"}
                      </span>
                    </span>
                    <RouteBadge route={h.route} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function Topbar({ onMenu }: { onMenu: () => void }) {
  return (
    <header className="sticky top-0 z-30 border-b border-night-700 bg-paper/90 backdrop-blur">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <button
          onClick={onMenu}
          aria-label="Open navigation"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-night-400 hover:bg-night-800 hover:text-ink md:hidden"
        >
          <Icon name="menu" size={18} />
        </button>
        <Link href="/" aria-label="FluxPad home" className="flex shrink-0 items-center gap-2">
          <span className="sm:hidden">
            <FluxSymbol size={26} />
          </span>
          <span className="hidden sm:inline">
            <FluxWordmark height={30} />
          </span>
        </Link>
        <GlobalSearch />
        <div className="ml-auto flex items-center gap-2">
          <NetworkIndicator />
          <Link
            href="/create"
            className="hidden items-center gap-1.5 rounded-lg bg-mint-500 px-3 py-1.5 text-xs font-semibold text-snow shadow-glow-mint transition hover:bg-mint-400 sm:flex"
          >
            <Icon name="plus" size={13} />
            Create
          </Link>
          <SocialLinks />
          <ThemeToggle />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
