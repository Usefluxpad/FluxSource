"use client";

import { useState } from "react";
import { Button, Card, CopyChip, Input, Spinner } from "@/components/ui/primitives";
import type { VanityHandle } from "@/hooks/use-vanity-mint";
import { isValidVanityPattern, type VanityPattern } from "@/lib/vanity/vanity-core";
import { confirmKeypairExport, exportKeypairJson } from "@/lib/vanity/export-keypair";

/**
 * Vanity mint panel ("Generate Custom CA") in the token-creation flow. The
 * generated keypair lives only in browser memory; a refresh loses it. Skipping
 * vanity generation is always available — normal creation is unaffected.
 */
export function VanityPanel({
  enabled,
  pattern,
  onToggle,
  onPattern,
  vanity,
}: {
  enabled: boolean;
  pattern: string;
  onToggle: (v: boolean) => void;
  onPattern: (p: string) => void;
  vanity: VanityHandle;
}) {
  const [kind, setKind] = useState<VanityPattern["kind"]>("prefix");
  const [caseInsensitive, setCaseInsensitive] = useState(false);

  const valid = isValidVanityPattern(pattern);
  const running = vanity.state === "running";
  const paused = vanity.state === "paused";
  const rate =
    vanity.elapsedMs >= 500 && vanity.attempts > 0
      ? vanity.attempts / (vanity.elapsedMs / 1000)
      : null;
  const search = () => vanity.start({ kind, value: pattern, caseInsensitive });
  const exportKey = () => {
    if (vanity.keypair && vanity.publicKey && confirmKeypairExport(vanity.publicKey)) {
      exportKeypairJson(vanity.keypair);
    }
  };

  return (
    <Card className="space-y-4">
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="h-4 w-4 accent-mint-400"
        />
        <span className="text-sm font-medium text-ink">
          Generate a vanity mint address
        </span>
      </label>

      {enabled && (
        <>
          {/* Pattern kind */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xs text-night-500">Match:</span>
            {([["prefix", "Prefix"], ["suffix", "Suffix"], ["contains", "Contains"]] as const).map(
              ([k, label]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                  className={`rounded-md px-2 py-1 text-2xs font-medium transition-colors ${
                    kind === k
                      ? "bg-night-600 text-ink"
                      : "text-night-400 hover:bg-night-700/60 hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ),
            )}
          </div>

          <Input
            label={`${kind.charAt(0).toUpperCase()}${kind.slice(1)} (Base58)`}
            value={pattern}
            onChange={(e) => onPattern(caseInsensitive ? e.target.value : e.target.value.toUpperCase())}
            placeholder="FLUX"
            maxLength={8}
            hint="Base58 only (no 0, O, I, l). Each extra character multiplies the expected work by ~33."
            error={pattern.length > 0 && !valid ? "Invalid pattern: use 1–8 Base58 characters." : undefined}
          />

          {/* Case sensitivity — technically applicable: Base58 addresses contain both cases */}
          <label className="flex items-start gap-2 text-2xs text-night-500">
            <input
              type="checkbox"
              checked={caseInsensitive}
              onChange={(e) => setCaseInsensitive(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-mint-400"
            />
            <span>
              Case-insensitive matching (matches either letter case — the generated address keeps its
              real case; matches are always verified against the actual key)
            </span>
          </label>

          {vanity.difficulty && (
            <p className="text-xs text-night-500">
              Honest estimate: ~{vanity.difficulty.expectedAttempts.toLocaleString()} attempts
              (≈{vanity.difficulty.secondsEstimate.toLocaleString()} {vanity.difficulty.label} at
              ~50k attempts/sec on one core). Longer patterns can take far longer — that is the
              nature of brute force.
            </p>
          )}
          {(running || paused) && (
            <div className="space-y-2 rounded-lg border border-night-700 bg-night-800/60 p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-night-400">
                <Spinner label={`${vanity.attempts.toLocaleString()} attempts`} />
                <span className="font-mono">{(vanity.elapsedMs / 1000).toFixed(1)}s</span>
                {rate != null && (
                  <span>
                    rate <span className="font-mono">{Math.round(rate).toLocaleString()}/s</span>
                  </span>
                )}
                <span className="text-night-600">no completion time promised</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {running ? (
                  <Button variant="secondary" size="sm" onClick={vanity.pause}>
                    Pause
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" onClick={vanity.resume}>
                    Resume
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={vanity.cancel}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {vanity.state === "found" && vanity.publicKey && vanity.keypair && (
            <div className="rounded-lg border border-mint-600/40 bg-sky-50 p-3">
              <p className="text-xs font-medium text-mint-300">
                Custom mint ready — verified against the keypair ·{" "}
                {vanity.attempts.toLocaleString()} attempts
              </p>
              <div className="mt-2">
                <CopyChip value={vanity.publicKey} label="custom mint address" />
              </div>
              <p className="mt-2 text-2xs text-night-500">
                This mint address will be used for your launch. The secret key exists only in this
                browser tab — it is never stored or transmitted. If you leave this page without
                launching, the key is gone; export it first if you want to keep it.
              </p>
              <Button variant="secondary" size="sm" className="mt-2" onClick={exportKey}>
                Export keypair file
              </Button>
              <p className="mt-2 rounded border border-down/40 bg-down/10 p-2 text-2xs text-down">
                ⚠ The export file contains the SECRET KEY that fully controls this mint. It is
                created only when you click and confirm — never sent to any server, never logged,
                never stored by FluxPad. Keep it offline if you keep it at all.
              </p>
            </div>
          )}
          {vanity.state === "exhausted" && (
            <p className="text-sm text-warn">
              Search budget exhausted without a match. Try a shorter pattern or search again.
            </p>
          )}
          {vanity.state === "cancelled" && (
            <p className="text-sm text-night-500">Search cancelled.</p>
          )}
          {vanity.error && <p className="text-sm text-danger">{vanity.error}</p>}
          {!running && vanity.state !== "found" && (
            <Button onClick={search} disabled={!valid} size="sm" variant="secondary">
              {paused ? "Resume search" : "Generate Custom CA"}
            </Button>
          )}
          <p className="text-xs text-night-500">
            The mint keypair stays in this browser tab&apos;s memory only — never sent to any
            server, never stored. Refreshing the page loses it, and a launch built around it
            must be completed in the same session.
          </p>
        </>
      )}

      {!enabled && (
        <p className="text-xs text-night-500">
          Skipping is recommended for first launches: FluxPad will use a standard
          randomly-generated mint address.
        </p>
      )}
    </Card>
  );
}
