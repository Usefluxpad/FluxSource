"use client";

/**
 * Theme switcher UI — Sun (Light), Moon (Dark), Monitor (System).
 * ThemeToggle: compact segmented control for navigation surfaces.
 * ThemeOptions: labelled option cards for the Settings page.
 */
import { Icon } from "@/components/ui/icons";
import { useTheme, type ThemePreference } from "./theme-provider";

const OPTIONS: { value: ThemePreference; label: string; icon: string; hint: string }[] = [
  { value: "light", label: "Light", icon: "sun", hint: "Bright workspace" },
  { value: "dark", label: "Dark", icon: "moon", hint: "Deep navy" },
  { value: "system", label: "System", icon: "monitor", hint: "Match OS setting" },
];

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, setTheme, mounted } = useTheme();
  return (
    <div
      role="group"
      aria-label="Color theme"
      className={`inline-flex items-center gap-0.5 rounded-lg border border-night-700 bg-night-950 p-0.5 ${className}`}
    >
      {OPTIONS.map((o) => {
        const active = mounted && theme === o.value;
        return (
          <button
            key={o.value}
            onClick={() => setTheme(o.value)}
            aria-pressed={active}
            title={`${o.label} theme`}
            className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-200 ${
              active ? "bg-mint-500 text-snow" : "text-night-400 hover:text-ink"
            }`}
          >
            <Icon name={o.icon} size={14} />
            <span className="sr-only">{o.label} theme</span>
          </button>
        );
      })}
    </div>
  );
}

export function ThemeOptions() {
  const { theme, setTheme, mounted } = useTheme();
  return (
    <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label="Color theme">
      {OPTIONS.map((o) => {
        const active = mounted && theme === o.value;
        return (
          <button
            key={o.value}
            onClick={() => setTheme(o.value)}
            aria-pressed={active}
            className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all duration-200 ${
              active
                ? "border-mint-500 bg-sky-50 shadow-glow-mint"
                : "border-night-700 bg-paper hover:border-night-600"
            }`}
          >
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                active ? "bg-mint-500 text-snow" : "bg-night-800 text-night-400"
              }`}
            >
              <Icon name={o.icon} size={15} />
            </span>
            <span className="min-w-0">
              <span className={`block text-[13px] font-medium ${active ? "text-mint-700" : "text-ink"}`}>
                {o.label}
              </span>
              <span className="block text-2xs text-night-400">{o.hint}</span>
            </span>
            {active && <Icon name="check" size={14} className="ml-auto shrink-0 text-mint-600" />}
          </button>
        );
      })}
    </div>
  );
}
