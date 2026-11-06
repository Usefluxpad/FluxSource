"use client";
/** Dashboard panel container: surface, header, filter pills, refresh. */
import { ReactNode } from "react";
import { Icon } from "@/components/ui/icons";

export function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md px-2 py-1 text-2xs font-medium transition-colors duration-200 ${
        active ? "bg-sky-100 text-mint-700" : "text-night-400 hover:bg-night-800 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

export function Panel({
  title,
  icon,
  actions,
  children,
  className = "",
  bodyClassName = "",
  subtitle,
}: {
  title: string;
  icon: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Extra classes for the scrollable body, e.g. independent scrolling. */
  bodyClassName?: string;
  subtitle?: string;
}) {
  return (
    <section
      className={`flex flex-col overflow-hidden rounded-lg border border-night-700/80 bg-night-850 shadow-panel ${className}`}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-night-700/70 px-3 py-2">
        <Icon name={icon} size={14} className="text-mint-400" />
        <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
        {subtitle && <span className="text-2xs text-night-500">{subtitle}</span>}
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      </header>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function RefreshButton({ onClick, updatedAt }: { onClick: () => void; updatedAt: number | null }) {
  return (
    <div className="flex items-center gap-1.5">
      {updatedAt && (
        <span className="hidden text-2xs text-night-500 sm:inline" title="Last refreshed">
          {new Date(updatedAt).toLocaleTimeString()}
        </span>
      )}
      <button
        onClick={onClick}
        aria-label="Refresh"
        className="flex h-6 w-6 items-center justify-center rounded-md text-night-400 transition hover:bg-night-700 hover:text-ink"
      >
        <Icon name="refresh" size={13} />
      </button>
    </div>
  );
}

export function PanelSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="row-sep flex items-center gap-3 px-3 py-2.5">
          <span className="h-8 w-8 animate-pulse rounded-md bg-night-700" />
          <span className="flex-1 space-y-1.5">
            <span className="block h-2.5 w-1/3 animate-pulse rounded bg-night-700" />
            <span className="block h-2 w-1/4 animate-pulse rounded bg-night-700/70" />
          </span>
          <span className="h-5 w-16 animate-pulse rounded bg-night-700/70" />
        </li>
      ))}
    </ul>
  );
}

export function PanelEmpty({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-4 py-10 text-center">
      <p className="text-[13px] text-night-400">{message}</p>
      {hint && <p className="max-w-xs text-2xs text-night-500">{hint}</p>}
    </div>
  );
}

export function PanelError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      <p className="text-[13px] text-down">{message}</p>
      <button
        onClick={onRetry}
        className="rounded-md border border-night-600 px-2.5 py-1 text-2xs text-night-400 hover:border-night-500 hover:text-ink"
      >
        Retry
      </button>
    </div>
  );
}
