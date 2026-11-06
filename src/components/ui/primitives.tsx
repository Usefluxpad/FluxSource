"use client";

import { ReactNode } from "react";

/* FluxPad "Electric Blue Launch Studio" design-system primitives.
   Light-first: white surfaces, pale tints, cobalt accents, ink typography. */

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-night-700 bg-paper p-5 shadow-panel transition-all duration-200 hover:border-night-600 ${className}`}
    >
      {children}
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  disabled,
  onClick,
  type = "button",
  className = "",
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  className?: string;
  "aria-label"?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-200 ease-out disabled:cursor-not-allowed disabled:opacity-50";
  const sizes = {
    sm: "px-3 py-1.5 text-sm",
    md: "px-4 py-2 text-sm",
    lg: "px-6 py-3 text-base",
  } as const;
  const variants = {
    primary:
      "bg-mint-500 text-snow shadow-glow-mint hover:bg-mint-400 active:bg-mint-600 disabled:bg-mint-500 disabled:shadow-none",
    secondary:
      "border border-night-700 bg-paper text-ink hover:border-mint-500/50 hover:bg-sky-50 hover:text-mint-700 disabled:hover:bg-paper disabled:hover:border-night-700 disabled:hover:text-ink",
    ghost:
      "text-night-400 hover:bg-night-800 hover:text-ink disabled:hover:bg-transparent disabled:hover:text-night-400",
    danger: "bg-down text-snow hover:bg-danger/50/90",
  } as const;
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}


export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "mint" | "ice" | "warn" | "danger" | "success";
}) {
  const tones = {
    neutral: "border-night-700 bg-night-800 text-night-400",
    mint: "border-mint-500/25 bg-sky-50 text-mint-700",
    ice: "border-sky-200 bg-sky-100/70 text-mint-600",
    warn: "border-warn/30 bg-warn/10 text-warn",
    danger: "border-danger/25 bg-danger/5 text-danger",
    success: "border-up/30 bg-up/10 text-up",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Input({
  label,
  hint,
  error,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      <input
        {...props}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded-lg border bg-paper px-3.5 py-2.5 text-sm text-ink placeholder:text-night-500 transition-colors duration-200 focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/15 ${
          error ? "border-danger/60" : "border-night-700"
        }`}
      />
      {hint && !error && <span className="mt-1 block text-xs text-night-400">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-danger">{error}</span>}
    </label>
  );
}

export function TextArea({
  label,
  hint,
  error,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  hint?: string;
  error?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      <textarea
        {...props}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded-lg border bg-paper px-3.5 py-2.5 text-sm text-ink placeholder:text-night-500 transition-colors duration-200 focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/15 ${
          error ? "border-danger/60" : "border-night-700"
        }`}
      />
      {hint && !error && <span className="mt-1 block text-xs text-night-400">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-danger">{error}</span>}
    </label>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-night-400" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-night-600 border-t-mint-500" />
      {label}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-night-600 bg-paper/60 px-6 py-14 text-center">
      {/* Branded empty state — the official standalone Flux symbol */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/flux-symbol.jpg"
        alt=""
        aria-hidden="true"
        className="mb-4 h-12 w-12 rounded-xl opacity-90"
        draggable={false}
      />
      <h3 className="font-display text-lg font-semibold text-ink">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-night-400">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorBanner({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-danger/30 bg-danger/5 p-4"
    >
      <p className="font-medium text-danger">{title}</p>
      <p className="mt-1 break-words text-sm text-danger/90">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 rounded-lg border border-danger/40 px-3 py-1.5 text-sm text-danger transition-colors duration-200 hover:bg-danger/50/10"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function CopyChip({ value, label }: { value: string; label: string }) {
  return (
    <button
      onClick={() => void navigator.clipboard?.writeText(value)}
      title={`Copy ${label}`}
      className="inline-flex max-w-full items-center gap-2 rounded-lg border border-night-700 bg-night-800 px-2.5 py-1 font-mono text-xs text-mint-700 transition-colors duration-200 hover:border-mint-500/60"
    >
      <span className="truncate">{value}</span>
      <span aria-hidden>⧉</span>
    </button>
  );
}
