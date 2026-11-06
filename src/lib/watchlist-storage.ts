"use client";
/**
 * Watchlist storage key + one-time migration from the pre-rebrand
 * "relaypad:watchlist" key, so existing users keep their saved watchlists.
 */

/** Current storage key (FluxPad naming). */
export const watchlistStorageKey = "fluxpad:watchlist";

/** Pre-rebrand storage key — migrated once, then removed. */
const LEGACY_WATCHLIST_KEY = "relaypad:watchlist";

/** Copies the legacy watchlist into the FluxPad key (once) and clears it. */
export function migrateLegacyWatchlistKey(): void {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(watchlistStorageKey)) return;
    const legacy = window.localStorage.getItem(LEGACY_WATCHLIST_KEY);
    if (legacy === null) return;
    window.localStorage.setItem(watchlistStorageKey, legacy);
    window.localStorage.removeItem(LEGACY_WATCHLIST_KEY);
  } catch {
    // Storage unavailable (private mode, corrupted quota) — start empty.
  }
}
