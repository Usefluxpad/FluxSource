"use client";

/**
 * Official $FLUX Token card.
 *
 * Public, read-only display of the official token identity (name, symbol,
 * network, contract address). Fetches the sanitized view from the guarded
 * /api/relay-official/token endpoint so the homepage and the treasury
 * dashboard always render the SAME configured value (single source of truth).
 *
 * Honesty guarantees:
 * - Unconfigured/placeholder configuration renders the honest "not
 *   configured" CA text with a "CA NOT OFFICIAL YET" badge and a DISABLED
 *   copy button — no placeholder string is ever presented as an address
 *   and nothing is linked to an explorer.
 * - A valid configured mint enables copying but keeps a "NOT YET VERIFIED"
 *   badge until the mint has been explicitly verified on-chain.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/icons";
import { FluxSymbol } from "@/components/brand/logo";
import { copyText, type CopyResult } from "@/components/official/copy-text";
import type { OfficialTokenView } from "@/lib/relay-official/token-display";

type LoadState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; view: OfficialTokenView };

const STATUS_TONES = {
  placeholder: "warn",
  invalid: "danger",
  configured: "warn",
} as const;

export function OfficialTokenCard({
  initialView,
}: {
  /** Server-computed view (same config source). When present, no initial fetch. */
  initialView?: OfficialTokenView;
}) {
  const [state, setState] = useState<LoadState>(
    initialView ? { phase: "ready", view: initialView } : { phase: "loading" },
  );
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    // Silent mode: the server-rendered view stays on screen while the card
    // revalidates — a configuration change reaches the page without a
    // rebuild and without a loading flash.
    if (!opts.silent) setState({ phase: "loading" });
    try {
      const res = await fetch("/api/relay-official/token", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const view = (await res.json()) as OfficialTokenView;
      setState({ phase: "ready", view });
    } catch {
      // Silent revalidation keeps the server-rendered honest view on failure;
      // a hard failure without SSR content surfaces the error state.
      if (!opts.silent) setState({ phase: "error" });
    }
  }, []);

  useEffect(() => {
    // The server-rendered view paints instantly; the card still revalidates
    // against the API on mount so the CA always reflects the CURRENT
    // FLUXPAD_OFFICIAL_MINT configuration (env changes must reach the page
    // without a rebuild or redeploy).
    void load({ silent: Boolean(initialView) });
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, [initialView, load]);

  const onCopy = useCallback(async (view: OfficialTokenView) => {
    if (!view.copyable) return;
    const result: CopyResult = await copyText(view.mint ?? view.displayValue);
    if (result === "copied" || result === "copied-fallback") {
      setCopyState("copied");
    } else {
      setCopyState("failed");
    }
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(
      () => setCopyState("idle"),
      result === "failed" ? 4000 : 2000,
    );
  }, []);

  if (state.phase === "loading") {
    return (
      <Card className="animate-pulse-soft">
        <div className="h-4 w-40 rounded bg-night-800" />
        <div className="mt-4 h-10 w-full max-w-xl rounded-lg bg-night-800/70" />
        <div className="mt-3 h-3 w-72 rounded bg-night-800/50" />
      </Card>
    );
  }

  if (state.phase === "error") {
    return (
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-night-400">
            Official token information is temporarily unavailable.
          </p>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <Icon name="refresh" size={14} />
            Retry
          </Button>
        </div>
      </Card>
    );
  }

  /* ------------------------------- render ------------------------------- */
  return renderCard(state.view, copyState, onCopy);
}

function renderCard(
  view: OfficialTokenView,
  copyState: "idle" | "copied" | "failed",
  onCopy: (view: OfficialTokenView) => Promise<void>,
) {
  const statusTone: "warn" | "danger" =
    view.status === "invalid" ? "danger" : "warn";
  const showCopied = copyState === "copied";
  const showCopyError = copyState === "failed";

  return (
    <Card className="overflow-hidden">
      {/* Header: identity + honest status badge */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl">
            <FluxSymbol size={36} className="object-contain" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight text-ink">
              Official $FLUX Token
              <span className="ml-2 text-2xs font-normal uppercase tracking-wider text-night-500">
                FluxPad
              </span>
            </h2>
            <p className="text-2xs text-night-500">
              FluxPad&apos;s official token — {view.networkLabel}
            </p>
          </div>
        </div>
        <Badge tone={statusTone}>{view.badgeLabel}</Badge>
      </div>

      {/* Contract address row */}
      <div className="mt-4">
        <p className="text-2xs font-medium uppercase tracking-wider text-night-500">
          Contract Address (CA)
        </p>
        <div
          className={`mt-1.5 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2.5 ${
            view.status === "configured"
              ? "border-mint-700/40 bg-night-850"
              : "border-night-600 bg-night-850"
          }`}
        >
          {view.status === "configured" && view.explorerHref ? (
            <a
              href={view.explorerHref}
              target="_blank"
              rel="noopener noreferrer"
              title="View the official $FLUX token on Solana Explorer"
              className={`min-w-0 flex-1 break-all font-mono text-xs underline decoration-night-600 underline-offset-2 hover:decoration-ice-400 sm:text-sm text-mint-300`}
            >
              {view.displayValue}
            </a>
          ) : (
            <code
              className={`min-w-0 flex-1 break-all font-mono text-xs sm:text-sm ${
                view.status === "configured" ? "text-mint-300" : "text-night-400"
              }`}
            >
              {view.displayValue}
            </code>
          )}
          {view.status === "configured" && view.explorerHref && (
            <a
              href={view.explorerHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-1 text-2xs text-ice-300 hover:text-ice-200"
              title="View on Solana Explorer"
            >
              Explorer
              <Icon name="external" size={12} />
            </a>
          )}
          <span
            className="inline-flex shrink-0"
            title={
              view.copyable
                ? "Copy address"
                : "Copying is disabled — the official $FLUX token has not been announced yet"
            }
          >
            <Button
              variant={view.status === "configured" ? "primary" : "secondary"}
              size="sm"
              disabled={!view.copyable}
              onClick={() => void onCopy(view)}
              aria-label={
                view.copyable
                  ? "Copy official token address"
                  : "Copying is disabled until the official $FLUX token is announced"
              }
              className="shrink-0"
            >
              {showCopied ? (
                <>
                  <Icon name="check" size={13} />
                  Copied!
                </>
              ) : (
                <>
                  <Icon name="copy" size={13} />
                  Copy Address
                </>
              )}
            </Button>
          </span>
        </div>
      </div>

      {/* Honest state messaging */}
      <p
        className={`mt-2.5 text-xs ${
          view.status === "invalid"
            ? "text-danger"
            : view.status === "placeholder"
              ? "text-warn"
              : "text-night-500"
        }`}
      >
        {view.message}
      </p>
      {showCopyError && (
        <p role="alert" className="mt-1 text-xs text-danger">
          Copy failed — please select the address text and copy it manually.
        </p>
      )}
    </Card>
  );
}

