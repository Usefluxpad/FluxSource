"use client";

import { currentNetworkRaw } from "@/lib/network-env";
import { useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Input,
  Spinner,
  TextArea,
} from "@/components/ui/primitives";
import { RouteSelector } from "@/components/launch/route-selector";
import { VanityPanel } from "@/components/launch/vanity-panel";
import { ReviewPanel } from "@/components/launch/review-panel";
import { LaunchProgressPanel } from "@/components/launch/launch-progress-panel";
import { useVanityMint } from "@/hooks/use-vanity-mint";
import { useLaunchFlow, type LaunchFormState } from "@/hooks/use-launch-flow";
import { resolveBrowserNetworkConfig } from "@/lib/connection";
import { Icon } from "@/components/ui/icons";

const EMPTY_FORM: LaunchFormState = {
  name: "",
  symbol: "FLUX",
  description: "",
  website: "",
  twitter: "",
  telegram: "",
  route: "pump",
  initialBuySol: "0",
  slippageBps: 100,
  useVanity: false,
  vanityPattern: "",
};

/** Five-step guided flow: details → launch method → set up → review → sign. */
const STEP_LABELS = ["Token Details", "Launch Method", "Set Up", "Review & Sign", "Launch"] as const;
type Step = 0 | 1 | 2 | 3 | 4;

function Stepper({ step }: { step: Step }) {
  return (
    <ol aria-label="Launch steps" className="mb-6 flex flex-wrap items-center gap-y-2">
      {STEP_LABELS.map((label, i) => {
        const state = i === step ? "current" : i < step ? "done" : "todo";
        return (
          <li key={label} className="flex items-center">
            <span
              aria-current={state === "current" ? "step" : undefined}
              className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium ${
                state === "current"
                  ? "bg-sky-100 text-mint-700"
                  : state === "done"
                    ? "text-night-400"
                    : "text-night-500"
              }`}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full border text-2xs ${
                  state === "current"
                    ? "border-mint-500 bg-mint-500 text-snow"
                    : state === "done"
                      ? "border-mint-500/50 bg-sky-50 text-mint-600"
                      : "border-night-600 bg-paper text-night-500"
                }`}
              >
                {state === "done" ? <Icon name="check" size={11} /> : i + 1}
              </span>
              {label}
            </span>
            {i < STEP_LABELS.length - 1 && <span className="mx-1 h-px w-4 bg-night-600" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

export default function CreateTokenPage() {
  const { connection } = useConnection();
  const { publicKey, connected, signTransaction } = useWallet();
  const [step, setStep] = useState<Step>(0);
  const [form, setForm] = useState<LaunchFormState>(EMPTY_FORM);
  const [artwork, setArtwork] = useState<File | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const vanity = useVanityMint();
  const flow = useLaunchFlow();

  const network = useMemo(
    () =>
      resolveBrowserNetworkConfig(
        currentNetworkRaw(),
        process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
      ),
    [],
  );

  const set = <K extends keyof LaunchFormState>(key: K, value: LaunchFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  if (!connected || !publicKey || !signTransaction) {
    return (
      <div className="animate-fade-up mx-auto max-w-xl">
        <Stepper step={0} />
        <Card>
          <h1 className="font-display text-lg font-semibold tracking-tight text-ink">Create Your Token</h1>
          <p className="mt-2 text-sm text-night-500">
            Connect a Solana wallet to start. FluxPad never requests seed
            phrases or private keys — you approve every transaction yourself.
          </p>
        </Card>
      </div>
    );
  }

  const goDetails = () => {
    const result = flow.validate(form);
    if (!result.ok) {
      setValidationErrors(result.errors);
      return;
    }
    setValidationErrors([]);
    setStep(1);
  };

  // Configure → Review: build the real transaction via the route adapter.
  const goReview = async () => {
    setValidationErrors([]);
    const result = await flow.prepare({
      form,
      artwork,
      wallet: { publicKey, signTransaction },
      connection,
      network,
      vanityKeypair: form.useVanity ? vanity.keypair : null,
    });
    if (result.ok) setStep(3);
  };

  const launch = async () => {
    if (!flow.prepared) return;
    const result = await flow.execute({
      prepared: flow.prepared,
      wallet: { publicKey, signTransaction },
      connection,
      network,
    });
    if (result.ok) setStep(4);
  };

  const terminal =
    flow.progress?.phase === "failed" ||
    flow.progress?.phase === "unresolved" ||
    flow.progress?.phase === "curve_trading" ||
    flow.progress?.phase === "graduation_detected" ||
    flow.progress?.phase === "pool_verified";

  return (
    <div className="animate-fade-up mx-auto max-w-2xl">
      <header className="mb-4">
        <h1 className="font-display text-lg font-semibold tracking-tight text-ink">Create Your Token</h1>
        <p className="mt-0.5 text-2xs text-night-500">
          One guided flow, two launch paths. Protocol-specific settings appear once you choose.
        </p>
      </header>

      <Stepper step={step} />

      {validationErrors.length > 0 && (
        <div className="mb-4">
          <ErrorBanner title="Check the form" message={validationErrors.join(" · ")} />
        </div>
      )}
      {flow.progress?.error && step !== 4 && (
        <div className="mb-4">
          <ErrorBanner
            title={`Error (${flow.progress.errorCode ?? "unknown"})`}
            message={flow.progress.error}
          />
        </div>
      )}

      {step === 0 && (
        <Card className="space-y-5">
          <Input
            label="Token name"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Flux Test Token"
            maxLength={64}
          />
          <Input
            label="Symbol"
            value={form.symbol}
            onChange={(e) => set("symbol", e.target.value.toUpperCase())}
            placeholder="FLUX"
            maxLength={10}
            hint="Max 10 characters, alphanumeric."
          />
          <TextArea
            label="Description (optional)"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            rows={3}
            maxLength={1000}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label="Website (optional)"
              value={form.website}
              onChange={(e) => set("website", e.target.value)}
              placeholder="https://…"
            />
            <Input
              label="X / Twitter (optional)"
              value={form.twitter}
              onChange={(e) => set("twitter", e.target.value)}
              placeholder="@handle or URL"
            />
            <Input
              label="Telegram (optional)"
              value={form.telegram}
              onChange={(e) => set("telegram", e.target.value)}
              placeholder="@channel or URL"
            />
          </div>
          <div>
            <span className="mb-1.5 block text-sm font-medium text-ink">Artwork</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(e) => setArtwork(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-night-500 file:mr-4 file:rounded-lg file:border-0 file:bg-night-700 file:px-4 file:py-2 file:text-sm file:text-ink hover:file:bg-night-600"
            />
            <p className="mt-1 text-xs text-night-500">
              PNG/JPEG/WebP/GIF up to 10 MB. Uploaded server-side to IPFS; a
              metadata URI is required before the launch transaction is built.
            </p>
          </div>
          <div className="flex justify-end">
            <Button onClick={goDetails}>Continue →</Button>
          </div>
        </Card>
      )}

      {step === 1 && (
        <div className="space-y-5">
          <RouteSelector
            value={form.route}
            onChange={(r) => set("route", r)}
            connection={connection}
            cluster={network.cluster}
          />
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(0)}>
              ← Back
            </Button>
            <Button onClick={() => setStep(2)}>Continue →</Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-5">
          <Card>
            <h3 className="mb-3 text-sm font-semibold text-ink">Optional initial buy</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Initial buy (SOL)"
                value={form.initialBuySol}
                onChange={(e) => set("initialBuySol", e.target.value)}
                placeholder="0"
                inputMode="decimal"
                hint="0 skips the initial buy. Shown in the review step before signing."
              />
              <Input
                label="Slippage (basis points)"
                value={String(form.slippageBps)}
                onChange={(e) => set("slippageBps", Number(e.target.value) || 0)}
                inputMode="numeric"
                hint="100 bps = 1%."
              />
            </div>
          </Card>
          <VanityPanel
            enabled={form.useVanity}
            pattern={form.vanityPattern}
            onToggle={(v) => {
              set("useVanity", v);
              if (!v) vanity.discard();
            }}
            onPattern={(p) => set("vanityPattern", p)}
            vanity={vanity}
          />
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(1)}>
              ← Back
            </Button>
            <Button onClick={() => void goReview()} disabled={flow.busy}>
              {flow.busy ? <Spinner label="Preparing…" /> : "Build transaction →"}
            </Button>
          </div>
        </div>
      )}

      {step === 3 && flow.prepared && (
        <div className="space-y-5">
          <ReviewPanel
            prepared={flow.prepared}
            form={form}
            network={network}
            vanityPublicKey={form.useVanity ? vanity.publicKey : null}
          />
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(2)} disabled={flow.busy}>
              ← Back
            </Button>
            <Button onClick={() => void launch()} disabled={flow.busy}>
              {flow.busy ? <Spinner /> : "Sign & launch"}
            </Button>
          </div>
        </div>
      )}

      {(step === 4 || (flow.busy && step === 3)) && flow.progress && (
        <div className="space-y-4">
          <LaunchProgressPanel progress={flow.progress} network={network} />
          {terminal && (
            <div className="flex gap-3">
              <Button
                variant="ghost"
                onClick={() => {
                  flow.reset();
                  vanity.discard();
                  setStep(0);
                }}
              >
                Start another launch
              </Button>
              {flow.progress.mintAddress && (
                <a
                  href={`/tokens/${flow.progress.mintAddress}`}
                  className="rounded-lg bg-mint-500 px-4 py-2 text-sm font-medium text-snow shadow-glow-mint hover:bg-mint-400"
                >
                  View token →
                </a>
              )}
            </div>
          )}
        </div>
      )}

      <p className="mt-6 text-xs text-night-500">
        Estimated fees are shown before signing; your wallet performs the final
        approval. A launch is never displayed as successful just because it was
        submitted. <Badge tone="ice">{network.cluster}</Badge>
      </p>
    </div>
  );
}
