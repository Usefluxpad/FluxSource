"use client";

import { Card, CopyChip } from "@/components/ui/primitives";
import type { PreparedLaunch } from "@/lib/adapters/types";
import type { LaunchFormState } from "@/hooks/use-launch-flow";
import type { FluxpadNetworkConfig } from "@/lib/connection";
import { LAMPORTS_PER_SOL } from "@/lib/constants";

function sol(lamports: bigint): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(5);
}

export function ReviewPanel({
  prepared,
  form,
  network,
  vanityPublicKey,
}: {
  prepared: PreparedLaunch;
  form: LaunchFormState;
  network: FluxpadNetworkConfig;
  vanityPublicKey: string | null;
}) {
  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-ink">Review before signing</h3>
        <p className="mt-1 text-sm text-night-500">
          Everything below comes from the built transaction and the live protocol
          configuration — nothing is invented.
        </p>
      </div>

      <dl className="grid gap-3 text-sm">
        <Row label="Route">
          {prepared.route === "pump" ? "Pump.fun → PumpSwap" : "LaunchLab → CPMM"}
        </Row>
        <Row label="Network">{network.cluster}</Row>
        <Row label="Mint address">
          <div className="flex items-center gap-2">
            <CopyChip value={prepared.mintAddress} label="mint address" />
            {vanityPublicKey && <span className="text-xs text-mint-300">vanity</span>}
          </div>
        </Row>
        <Row label="Transactions to sign">{prepared.transactions.length}</Row>
        <Row label="Initial buy">
          {form.initialBuySol && Number(form.initialBuySol) > 0
            ? `${form.initialBuySol} SOL`
            : "none"}
        </Row>
        {prepared.breakdown.map((b) => (
          <Row key={b.label} label={b.label}>
            {sol(b.lamports)} SOL
          </Row>
        ))}
        <Row label="Estimated total">
          <span className="font-medium text-mint-300">
            {sol(prepared.estimatedTotalLamports)} SOL
          </span>
        </Row>
        <Row label="Mint signer required">
          {prepared.requiresMintSigner ? "yes (signed locally)" : "no"}
        </Row>
      </dl>

      {prepared.protocolNotes.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-night-700 bg-night-850 p-3 text-xs text-night-500">
          {prepared.protocolNotes.map((n, i) => (
            <li key={i}>• {n}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-night-500">
        Only the transactions shown above are submitted, and only after you
        approve them in your wallet. FluxPad holds no keys and cannot move
        funds without your signature.
      </p>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-night-800 pb-2">
      <dt className="text-night-500">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}
