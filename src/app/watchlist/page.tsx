"use client";
/**
 * Watchlist — client-side (localStorage) collection of mint addresses the
 * user starred on token pages. Rendered against real registry records only.
 */
import { useCallback, useEffect, useState } from "react";
import { TokenRow, type TokenRowData } from "@/components/dashboard/token-row";
import { Panel, PanelSkeleton, PanelEmpty } from "@/components/dashboard/panel";
import { watchlistStorageKey, migrateLegacyWatchlistKey } from "@/lib/watchlist-storage";

const KEY = watchlistStorageKey;

function readWatchlist(): string[] {
  try {
    migrateLegacyWatchlistKey();
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export default function WatchlistPage() {
  const [mints, setMints] = useState<string[] | null>(null);
  const [tokens, setTokens] = useState<TokenRowData[] | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const list = readWatchlist();
    setMints(list);
    if (list.length === 0) {
      setTokens([]);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/launches?limit=300");
      const data = res.ok ? ((await res.json()) as { launches: TokenRowData[] }) : { launches: [] };
      const wanted = new Set(list);
      setTokens(data.launches.filter((t) => t.mintAddress && wanted.has(t.mintAddress)));
    } catch {
      setTokens([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = (mint: string) => {
    const next = readWatchlist().filter((m) => m !== mint);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
    void load();
  };

  return (
    <div className="animate-fade-up">
      <header className="mb-4">
        <h1 className="font-display text-lg font-semibold tracking-tight text-ink">Watchlist</h1>
        <p className="mt-0.5 text-2xs text-night-500">
          Tokens you starred on their detail pages. Stored in this browser only — never on a server.
        </p>
      </header>
      <Panel title={`Watched tokens${mints ? ` (${mints.length})` : ""}`} icon="star">
        {loading || tokens === null ? (
          <PanelSkeleton rows={4} />
        ) : tokens.length === 0 ? (
          <PanelEmpty
            message={mints && mints.length > 0 ? "None of your watched launches are in the registry yet." : "Your watchlist is empty."}
            hint="Star a token on its detail page to follow it here. Registry records appear once launches are confirmed."
          />
        ) : (
          <ul>
            {tokens.map((t) => (
              <li key={t.id} className="relative">
                <TokenRow token={t} showCreator />
                {t.mintAddress && (
                  <button
                    onClick={() => remove(t.mintAddress as string)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-2xs text-night-500 transition hover:text-down"
                    aria-label={`Remove ${t.name} from watchlist`}
                  >
                    remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
