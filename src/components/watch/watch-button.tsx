"use client";
/** Watchlist toggle — client-side only (localStorage), no server writes. */
import { useEffect, useState } from "react";


const KEY = "relaypad:watchlist";

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function WatchButton({ mint }: { mint: string }) {
  const [watched, setWatched] = useState(false);
  useEffect(() => {
    setWatched(read().includes(mint));
  }, [mint]);

  const toggle = () => {
    const list = read();
    const next = watched ? list.filter((m) => m !== mint) : [...list, mint];
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      return;
    }
    setWatched(!watched);
  };

  return (
    <button
      onClick={toggle}
      aria-pressed={watched}
      aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
      title={watched ? "Remove from watchlist" : "Add to watchlist"}
      className={`flex h-8 w-8 items-center justify-center rounded-lg border transition ${
        watched
          ? "border-mint-600/60 bg-sky-50 text-mint-400"
          : "border-night-600 bg-night-850 text-night-400 hover:text-ink"
      }`}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill={watched ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9L12 3.5Z" />
      </svg>
      <span className="sr-only">{watched ? "Remove from watchlist" : "Add to watchlist"}</span>
    </button>
  );
}
