"use client";
/**
 * Standalone vanity mint generator. Uses the existing vanity engine
 * (Web Worker, cancellable, bounded). Generated keypairs live in this tab's
 * memory only — never sent to a server, never persisted.
 */
import { useState } from "react";
import Link from "next/link";
import { Panel } from "@/components/dashboard/panel";
import { Button, CopyChip, Input } from "@/components/ui/primitives";
import { useVanityMint } from "@/hooks/use-vanity-mint";
import { isValidVanityPattern, type VanityPattern } from "@/lib/vanity/vanity-core";
import { confirmKeypairExport, exportKeypairJson } from "@/lib/vanity/export-keypair";
import { Icon } from "@/components/ui/icons";

/** Attempts per second — real measured rate, "…" until enough data exists. */
function attemptsPerSec(attempts: number, elapsedMs: number): string {
  if (elapsedMs < 500 || attempts === 0) return "…";
  const rate = attempts / (elapsedMs / 1000);
  return rate >= 1000 ? `${(rate / 1000).toFixed(1)}k` : Math.round(rate).toString();
}

const KIND_OPTIONS: { kind: VanityPattern["kind"]; label: string }[] = [
  { kind: "prefix", label: "Prefix" },
  { kind: "suffix", label: "Suffix" },
  { kind: "contains", label: "Contains" },
];

export default function VanityPage() {
  const vanity = useVanityMint();
  const [pattern, setPattern] = useState("FLUX");
  const [kind, setKind] = useState<VanityPattern["kind"]>("suffix");
  const [caseInsensitive, setCaseInsensitive] = useState(false);

  const valid = isValidVanityPattern(pattern);
  const search = () => vanity.start({ kind, value: pattern, caseInsensitive });
  const running = vanity.state === "running";
  const paused = vanity.state === "paused";

  return (
    <div className="animate-fade-up mx-auto max-w-2xl">
      <header className="mb-4">
        <h1 className="font-display text-xl font-semibold tracking-tight text-ink">Vanity Mint Generator</h1>
        <p className="mt-0.5 text-2xs text-night-500">
          Generate a mint address with your chosen prefix, suffix, or substring. Compatible with
          both the Pump and LaunchLab launch flows.
        </p>
      </header>

      <Panel title="Generate a vanity mint" icon="wand">
        <div className="space-y-4 p-4">
          {/* Pattern kind */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xs text-night-500">Match:</span>
            {KIND_OPTIONS.map((o) => (
              <button
                key={o.kind}
                type="button"
                aria-pressed={kind === o.kind}
                onClick={() => setKind(o.kind)}
                className={`rounded-md px-2 py-1 text-2xs font-medium transition-colors ${
                  kind === o.kind
                    ? "bg-night-600 text-ink"
                    : "text-night-400 hover:bg-night-700/60 hover:text-ink"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>

          <Input
            label={`${kind.charAt(0).toUpperCase()}${kind.slice(1)} (Base58)`}
            value={pattern}
            onChange={(e) => setPattern(caseInsensitive ? e.target.value : e.target.value.toUpperCase())}
            placeholder="FLUX"
            maxLength={8}
            hint="1–8 characters, Base58 only (no 0, O, I, l). Each extra character multiplies expected work by ~33."
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
              real case; matches are always verified against the actual key). Finds matches faster
              than the case-sensitive estimate.
            </span>
          </label>

          {vanity.difficulty && (
            <p className="text-2xs text-night-500">
              Honest estimate: ~{vanity.difficulty.expectedAttempts.toLocaleString()} attempts
              (≈{vanity.difficulty.secondsEstimate.toLocaleString()} {vanity.difficulty.label} at ~50k
              attempts/sec on one core). Longer patterns are exponentially harder and some may
              practically never finish.
            </p>
          )}

          {/* Live progress + controls */}
          {(running || paused) && (
            <div className="space-y-2 rounded-lg border border-night-700 bg-night-800/60 p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-night-400">
                <span className="flex items-center gap-2">
                  {running && (
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-night-600 border-t-mint-400" />
                  )}
                  <span className="font-mono">{vanity.attempts.toLocaleString()}</span> attempts
                </span>
                <span className="font-mono">{(vanity.elapsedMs / 1000).toFixed(1)}s</span>
                <span>
                  rate <span className="font-mono">{attemptsPerSec(vanity.attempts, vanity.elapsedMs)}/s</span>
                </span>
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

          {/* Result */}
          {vanity.state === "found" && vanity.publicKey && vanity.keypair && (
            <div className="rounded-lg border border-mint-600/40 bg-sky-50 p-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-mint-300">
                <Icon name="check" size={13} />
                Vanity mint generated — verified against the generated keypair ·{" "}
                {vanity.attempts.toLocaleString()} attempts · {(vanity.elapsedMs / 1000).toFixed(1)}s
              </p>
              <CopyChip value={vanity.publicKey} label="vanity mint address" />
              <p className="mt-2 text-2xs text-night-500">
                This keypair exists only in this browser tab&apos;s memory. Use it now via the create
                flow — refreshing this page loses it.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    if (confirmKeypairExport(vanity.publicKey!)) exportKeypairJson(vanity.keypair!);
                  }}
                >
                  Export keypair file
                </Button>
                <Button variant="ghost" size="sm" onClick={vanity.discard}>
                  Discard key
                </Button>
              </div>
              <p className="mt-2 rounded border border-down/40 bg-down/10 p-2 text-2xs text-down">
                ⚠ The export file contains the SECRET KEY that fully controls this mint. It is
                created only when you click and confirm — never sent to any server, never logged,
                never stored by FluxPad. Keep it offline if you keep it at all.
              </p>
            </div>
          )}
          {vanity.state === "exhausted" && (
            <p className="text-xs text-warn">
              Search budget exhausted without a match. Try a shorter pattern or search again.
            </p>
          )}
          {vanity.state === "cancelled" && <p className="text-xs text-night-500">Search cancelled.</p>}
          {vanity.error && <p className="text-xs text-down">{vanity.error}</p>}

          {/* Start */}
          {vanity.state !== "running" && vanity.state !== "found" && (
            <Button variant="primary" size="sm" disabled={!valid} onClick={search}>
              {paused ? "Resume search" : "Generate"}
            </Button>
          )}

          <p className="rounded-lg border border-warn/30 bg-warn/100/10 p-2.5 text-2xs text-warn">
            <strong>Security:</strong> the generated secret key is created and kept only in this
            browser tab&apos;s memory. FluxPad never receives, stores, or logs it. Export is manual
            and explicit — download only if you understand the risk, and keep the file offline.
          </p>

          <div className="rounded-lg border border-night-700 bg-night-800/60 p-3 text-2xs text-night-500">
            <p className="mb-1 font-medium text-night-400">How to use it in a launch</p>
            The create flow&apos;s “Set Up Your Launch” step includes the same generator. A vanity
            keypair generated here can be verified there — FluxPad always checks that the final
            on-chain mint matches the vanity address before review.
            <Link href="/create" className="ml-1 text-mint-400 hover:underline">
              Open the create flow →
            </Link>
          </div>
        </div>
      </Panel>
    </div>
  );
}
