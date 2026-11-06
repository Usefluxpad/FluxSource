"use client";

/**
 * FluxPad theme system — Light / Dark / System.
 *
 * - Preference persists in localStorage ("fluxpad-theme"); default is Light.
 * - "system" follows prefers-color-scheme and live-updates on OS changes.
 * - The .dark class is applied to <html> pre-paint by the inline bootstrap in
 *   layout.tsx (no first-paint flash); this provider re-applies on change.
 * - No database or login involved — purely client-side preference.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "fluxpad-theme";

interface ThemeContextValue {
  /** Raw stored preference ("light" until the stored value is read). */
  theme: ThemePreference;
  /** Effective theme after resolving "system". */
  resolvedTheme: "light" | "dark";
  setTheme: (t: ThemePreference) => void;
  /** False during SSR and the very first client render (avoids mismatches). */
  mounted: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  resolvedTheme: "light",
  setTheme: () => {},
  mounted: false,
});

/** Applies the theme to <html> and returns the resolved mode. */
function applyTheme(theme: ThemePreference): "light" | "dark" {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  return dark ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>("light");
  const [resolved, setResolved] = useState<"light" | "dark">("light");
  const [mounted, setMounted] = useState(false);

  // Restore the stored preference after hydration (server default = light).
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Private mode / storage disabled — fall back to Light.
    }
    const t: ThemePreference =
      stored === "dark" || stored === "light" || stored === "system" ? stored : "light";
    setThemeState(t);
    setResolved(applyTheme(t));
    setMounted(true);
  }, []);

  // While in System mode, follow live OS theme changes.
  useEffect(() => {
    if (!mounted || theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(applyTheme("system"));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mounted, theme]);

  const setTheme = useCallback((t: ThemePreference) => {
    setThemeState(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // Storage unavailable — theme still applies for this session.
    }
    setResolved(applyTheme(t));
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme: resolved, setTheme, mounted }),
    [theme, resolved, setTheme, mounted],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}

/**
 * Reactive dark-mode flag for canvas rendering and other non-CSS surfaces.
 * Resolves System via the context (which listens to OS changes).
 */
export function useIsDarkMode(): boolean {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === "dark";
}
