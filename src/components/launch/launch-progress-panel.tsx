"use client";

import { Badge, Card, CopyChip } from "@/components/ui/primitives";
import type { LaunchProgress } from "@/hooks/use-launch-flow";
import type { RelaypadNetworkConfig } from "@/lib/connection";
import { explorerUrl } from "@/lib/constants";
import type { ClusterId } from "@/lib/constants";

const TONE: Record<string, "mint" | "ice" | "warn" | "danger" | "success" | "neutral"> = {
  preparation: "neutral",
  awaiting_signature: "ice",
  submitted: "ice",
  confirming: "ice",
  confirmed: "success",
  curve_trading: "mint",
  graduation_detected: "ice",
  pool_verified: "success",
  failed: "danger",
  unresolved: "warn",
};

export function LaunchProgressPanel({
  progress,
  network,
}: {
  progress: LaunchProgress;
  network: RelaypadNetworkConfig;
}) {
  const cluster: ClusterId = network.cluster;
  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink">{progress.message}</p>
        <Badge tone={TONE[progress.phase] ?? "neutral"}>{progress.phase}</Badge>
      </div>

      {progress.signature && (
        <div className="space-y-1">
          <p className="text-xs text-night-500">
            Signature:{" "}
            <a
              href={explorerUrl(cluster, "tx", progress.signature)}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-ice-300 hover:underline"
            >
              {progress.signature}
            </a>
          </p>
          <CopyChip value={progress.signature} label="Copy signature" />
        </div>
      )}
      {progress.mintAddress && (
        <p className="break-all text-xs text-night-500">
          Mint: <span className="font-mono text-mint-300">{progress.mintAddress}</span>
        </p>
      )}
      {progress.phase === "unresolved" && (
        <p className="rounded-lg border border-warn/40 bg-warn/100/10 p-3 text-xs text-warn">
          FluxPad could not verify this transaction&apos;s final status yet — it may still
          land. Do NOT launch again until the signature above has been checked on the
          Solana Explorer: submitting the same launch twice spends SOL twice.
        </p>
      )}
      {progress.phase === "failed" && (
        <p className="rounded-lg border border-danger/40 bg-danger/50/10 p-3 text-xs text-danger">
          The transaction failed on-chain. The reason above comes from the blockchain — a
          retry is a new, separate transaction.
        </p>
      )}
      {progress.error && (
        <p className="rounded-lg border border-danger/40 bg-danger/50/10 p-3 text-xs text-danger">
          {progress.error}
        </p>
      )}
      <p className="text-xs text-night-500">
        FluxPad reports on-chain reality only. If the transaction failed, check
        the signature on the explorer before retrying — a retry after a landed
        failure is a new, separate transaction.
      </p>
    </Card>
  );
}
