"use client";
/**
 * Client-side launch orchestration — the shared flow: validate → persist
 * intent → prepare (route adapter) → review → sign in wallet → submit &
 * confirm → verify mint on-chain → report lifecycle events.
 *
 * Security: the mint keypair (standard or vanity) never leaves the browser.
 * The server only ever receives public launch metadata.
 */
import { useCallback, useRef, useState } from "react";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { getAdapter } from "@/lib/adapters";
import type {
  LaunchRoute,
  LifecyclePhase,
  PreparedLaunch,
  TokenLaunchInput,
} from "@/lib/adapters/types";
import { FluxpadError, type FluxpadNetworkConfig } from "@/lib/connection";
import { submitAndConfirm, makeBlockhashAwareBuildTx, type WalletSigner } from "@/lib/tx-engine";
import { buildOffchainMetadata, tokenMetadataSchema } from "@/lib/metadata";

export interface LaunchFormState {
  name: string;
  symbol: string;
  description: string;
  website: string;
  twitter: string;
  telegram: string;
  route: LaunchRoute;
  initialBuySol: string;
  slippageBps: number;
  useVanity: boolean;
  vanityPattern: string;
}

export interface LaunchProgress {
  phase: LifecyclePhase;
  message: string;
  signature?: string | null;
  mintAddress?: string | null;
  error?: string | null;
  errorCode?: string | null;
}

function phaseMessage(p: LifecyclePhase): string {
  const m: Record<LifecyclePhase, string> = {
    preparation: "Preparing…",
    awaiting_signature: "Waiting for wallet signature…",
    submitted: "Submitted — waiting for confirmation…",
    confirming: "Confirming on-chain…",
    confirmed: "Launch confirmed on-chain.",
    curve_trading: "Live on the bonding curve.",
    graduation_detected: "Graduation threshold reached.",
    pool_verified: "Destination pool verified.",
    failed: "Launch failed.",
    unresolved: "Unresolved — verify the signature manually before retrying.",
  };
  return m[p];
}

function makeIdempotencyKey(wallet: string, form: LaunchFormState): string {
  return `${wallet}:${form.route}:${form.name}:${form.symbol}:${Date.now()}`;
}

export interface UseLaunchFlowResult {
  progress: LaunchProgress | null;
  prepared: PreparedLaunch | null;
  busy: boolean;
  validate(form: LaunchFormState): { ok: true } | { ok: false; errors: string[] };
  prepare(params: {
    form: LaunchFormState;
    artwork: File | null;
    wallet: { publicKey: PublicKey; signTransaction: WalletSigner["signTransaction"] };
    connection: Connection;
    network: FluxpadNetworkConfig;
    vanityKeypair: Keypair | null;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
  execute(params: {
    prepared: PreparedLaunch;
    wallet: { publicKey: PublicKey; signTransaction: WalletSigner["signTransaction"] };
    connection: Connection;
    network: FluxpadNetworkConfig;
  }): Promise<
    { ok: true; signature: string; mintAddress: string } | { ok: false; error: string; code?: string }
  >;
  reset(): void;
}

export function useLaunchFlow(): UseLaunchFlowResult {
  const [progress, setProgress] = useState<LaunchProgress | null>(null);
  const [prepared, setPrepared] = useState<PreparedLaunch | null>(null);
  const [busy, setBusy] = useState(false);
  const idempotencyRef = useRef<string | null>(null);
  // Registry record id, captured from the intent POST response so lifecycle
  // events can address the record directly (the record's mintAddress is
  // null until the first event binds it, so mint-based lookup would 404).
  const launchIdRef = useRef<string | null>(null);

  const validate = useCallback((form: LaunchFormState) => {
    const parsed = tokenMetadataSchema.safeParse(form);
    const errors: string[] = parsed.success
      ? []
      : parsed.error.issues.map((i) => i.message);
    const buy = Number(form.initialBuySol || "0");
    if (Number.isNaN(buy) || buy < 0) errors.push("Initial buy must be a non-negative amount");
    if (buy > 0 && buy < 0.001) errors.push("Initial buy below 0.001 SOL is not practical");
    return errors.length ? { ok: false as const, errors } : { ok: true as const };
  }, []);

  const prepare = useCallback<UseLaunchFlowResult["prepare"]>(
    async ({ form, artwork, wallet, connection, network, vanityKeypair }) => {
      setBusy(true);
      try {
        // 1) Metadata upload (credentials stay server-side).
        let imageUrl = "";
        let metadataUri = "";
        if (artwork) {
          setProgress({ phase: "preparation", message: "Uploading artwork & metadata…" });
          const meta = buildOffchainMetadata(
            {
              name: form.name,
              symbol: form.symbol,
              description: form.description,
              website: form.website || undefined,
              twitter: form.twitter || undefined,
              telegram: form.telegram || undefined,
            },
            "",
          );
          const fd = new FormData();
          fd.append("file", artwork);
          fd.append("metadata", JSON.stringify(meta));
          const res = await fetch("/api/upload", { method: "POST", body: fd });
          if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as { message?: string };
            return {
              ok: false,
              error:
                j.message ??
                `Upload failed (HTTP ${res.status}). Configure PINATA_JWT on the server to enable artwork uploads.`,
            };
          }
          const j = (await res.json()) as { imageUrl: string; metadataUri: string | null };
          imageUrl = j.imageUrl;
          metadataUri = j.metadataUri ?? j.imageUrl;
        }
        if (!metadataUri) {
          return { ok: false, error: "A metadata URI is required: upload artwork first." };
        }

        // 2) Route adapter + live protocol configuration.
        setProgress({ phase: "preparation", message: "Loading protocol configuration…" });
        const adapter = await getAdapter(form.route);
        const config = await adapter.loadConfig(connection, network.cluster);

        // 3) Mint keypair: vanity (already generated in memory) or fresh.
        const mintKeypair = vanityKeypair ?? Keypair.generate();

        // 4) Persist launch intent (idempotent; no key material sent). The
        // response's launch id is captured so lifecycle events can address
        // the record directly (mint-based lookup cannot work yet — the
        // record's mintAddress is null until an event binds it).
        const idempotencyKey = makeIdempotencyKey(wallet.publicKey.toBase58(), form);
        idempotencyRef.current = idempotencyKey;
        const intentRes = await fetch("/api/launches", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idempotencyKey,
            creatorWallet: wallet.publicKey.toBase58(),
            route: form.route === "pump" ? "PUMP_PUMPSWAP" : "LAUNCHLAB_CPMM",
            network: network.cluster,
            name: form.name,
            symbol: form.symbol,
            description: form.description || undefined,
            metadataUri,
            imageUrl,
          }),
        }).catch(() => null); // registry is best-effort; the chain is the ledger
        if (intentRes?.ok) {
          const intent = (await intentRes.json().catch(() => null)) as {
            launch?: { id?: string };
          } | null;
          if (intent?.launch?.id) launchIdRef.current = intent.launch.id;
        }

        // 5) Build route-specific transactions (fully client-side).
        setProgress({ phase: "preparation", message: "Building transactions…" });
        const input: TokenLaunchInput = {
          name: form.name,
          symbol: form.symbol,
          metadataUri,
          imageUrl,
          initialBuyLamports: BigInt(Math.round(Number(form.initialBuySol || "0") * 1e9)),
          slippageBps: form.slippageBps,
        };
        const launch = await adapter.prepareLaunch({
          connection,
          cluster: network.cluster,
          config,
          signer: { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction },
          mintKeypair,
          input,
        });

        // 6) A claimed vanity mint must match exactly before review.
        if (vanityKeypair && launch.mintAddress !== vanityKeypair.publicKey.toBase58()) {
          return { ok: false, error: "Vanity mint mismatch — aborting for safety." };
        }

        // 6b) Client-only rebuild context: the ephemeral mint keypair plus a
        // rebuild closure (fresh blockhash, fresh mint signature, size guards
        // re-run). Both stay in browser memory — never persisted, never sent
        // to the server. This is what makes the safe rebuild-and-resign flow
        // possible when the blockhash expires during review or approval.
        const makeRebuild = (): NonNullable<PreparedLaunch["rebuild"]> =>
          async ({ connection: rebuildConnection, signer: rebuildSigner }) => {
            const fresh = await adapter.prepareLaunch({
              connection: rebuildConnection,
              cluster: network.cluster,
              config,
              signer: {
                publicKey: rebuildSigner.publicKey,
                signTransaction: rebuildSigner.signTransaction,
              },
              mintKeypair,
              input,
            });
            return { ...fresh, mintKeypair, rebuild: makeRebuild() };
          };
        setPrepared({ ...launch, mintKeypair, rebuild: makeRebuild() });
        setProgress({
          phase: "preparation",
          message: "Ready for review.",
          mintAddress: launch.mintAddress,
        });
        return { ok: true };
      } catch (err) {
        const e = toRelay(err);
        setProgress({ phase: "failed", message: e.message, error: e.message, errorCode: e.code });
        return { ok: false, error: e.message };
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const execute = useCallback<UseLaunchFlowResult["execute"]>(
    async ({ prepared, wallet, connection, network }) => {
      if (!prepared) return { ok: false, error: "Nothing prepared to execute." };
      setBusy(true);
      const signer: WalletSigner = {
        publicKey: wallet.publicKey,
        signTransaction: wallet.signTransaction,
      };
      let signature: string | null = null;
      // Working copy of the launch: replaced wholesale when a blockhash
      // rebuild produces fresh transactions. React state is never mutated.
      let working = prepared;
      try {
        for (let i = 0; i < working.transactions.length; i++) {
          setProgress({
            phase: "awaiting_signature",
            message:
              working.transactions.length > 1
                ? `Signing transaction ${i + 1} of ${working.transactions.length}…`
                : "Waiting for wallet signature…",
            mintAddress: working.mintAddress,
          });
          // Blockhash-aware buildTx (LaunchLab CPMM fix): before the wallet is
          // asked to sign — and on every retry — probe the prebuilt tx's
          // blockhash; when it has expired since review, rebuild with a fresh
          // blockhash + fresh mint signature first. A wallet-signed message is
          // never mutated: the rebuilt transaction is signed from scratch and
          // the wallet gates every submission.
          const buildTx = makeBlockhashAwareBuildTx({
            connection,
            getTx: () => {
              const step = working.transactions[i];
              if (!step) throw new FluxpadError("PROTOCOL", `Launch step ${i + 1} disappeared.`);
              return step.tx;
            },
            rebuild: working.rebuild
              ? async () => {
                  const rebuildFn = working.rebuild;
                  if (!rebuildFn) {
                    throw new FluxpadError("PROTOCOL", "Rebuild capability disappeared.");
                  }
                  working = { ...working, ...(await rebuildFn({ connection, signer })) };
                  const freshStep = working.transactions[i];
                  if (!freshStep) {
                    throw new FluxpadError(
                      "PROTOCOL",
                      `Rebuilt launch is missing transaction ${i + 1}.`,
                    );
                  }
                  return freshStep.tx;
                }
              : undefined,
            onRebuildStart: () => {
              setProgress({
                phase: "preparation",
                message:
                  "The blockhash expired since review — rebuilding the transaction with a fresh blockhash before your wallet signs…",
                mintAddress: working.mintAddress,
              });
            },
            onRebuildDone: () => {
              setProgress({
                phase: "awaiting_signature",
                message: "Fresh blockhash secured — waiting for wallet signature…",
                mintAddress: working.mintAddress,
              });
            },
          });
          const result = await submitAndConfirm(connection, buildTx, signer, {
            onAttempt: (attempt, sig) => {
              setProgress({
                phase: sig ? "confirming" : attempt > 1 ? "preparation" : "submitted",
                message: sig
                  ? "Confirming on-chain…"
                  : attempt > 1
                    ? "Blockhash expired during approval — rebuilt with a fresh blockhash; approving again (nothing was submitted)…"
                    : phaseMessage("awaiting_signature"),
                signature: sig ?? null,
                mintAddress: working.mintAddress,
              });
            },
          });
          signature = result.signature;
        }

        // Verify the mint on-chain before ever claiming success.
        const mintInfo = await connection.getAccountInfo(
          new PublicKey(prepared.mintAddress),
          "confirmed",
        ).catch(() => null);
        setProgress({
          phase: mintInfo ? "curve_trading" : "unresolved",
          message: mintInfo
            ? "Mint verified on-chain."
            : "Mint account not visible yet — it may still be indexing.",
          signature,
          mintAddress: prepared.mintAddress,
        });

        if (signature) {
          await recordEvents(
            prepared.mintAddress,
            {
              kind: "confirmed",
              signature,
              mintAddress: prepared.mintAddress,
              detail: { network: network.cluster },
            },
            launchIdRef.current,
          );
        }

        return { ok: true, signature: signature ?? "", mintAddress: prepared.mintAddress };
      } catch (err) {
        const e = toRelay(err);
        setProgress({
          phase: e.code === "UNRESOLVED" ? "unresolved" : "failed",
          message: e.message,
          error: e.message,
          errorCode: e.code,
          signature: e.signature ?? signature,
        });
        // Registry status consistency (best-effort): failures and unresolved
        // outcomes are recorded too — the server re-validates every claim
        // against the chain before changing any status (a timeout whose
        // transaction actually landed resolves to CONFIRMED server-side,
        // never to FAILED).
        if (prepared) {
          await recordEvents(
            prepared.mintAddress,
            {
              kind: e.code === "UNRESOLVED" ? "unresolved" : "failed",
              signature: (e.signature ?? signature) || undefined,
              mintAddress: prepared.mintAddress,
              detail: { network: network.cluster, code: e.code },
              error: e.message.slice(0, 2000),
            },
            launchIdRef.current,
          );
        }
        return { ok: false, error: e.message, code: e.code };
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const reset = useCallback(() => {
    setProgress(null);
    setPrepared(null);
    idempotencyRef.current = null;
    launchIdRef.current = null;
  }, []);

  return { progress, prepared, busy, validate, prepare, execute, reset };
}

function toRelay(err: unknown): FluxpadError {
  if (err instanceof FluxpadError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new FluxpadError("UNKNOWN", message, err);
}

async function recordEvents(
  mintOrId: string,
  payload: {
    kind: string;
    signature?: string | null;
    mintAddress?: string | null;
    detail?: Record<string, unknown>;
    error?: string;
  },
  launchId?: string | null,
) {
  try {
    // Prefer the captured registry record id: the record's mintAddress is
    // null until the first event binds it, so a mint-based lookup 404s.
    const target = encodeURIComponent(launchId || mintOrId);
    await fetch(`/api/launches/${target}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Registry is best-effort; the chain remains the source of truth.
  }
}

