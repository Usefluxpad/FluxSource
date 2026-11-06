"use client";
/** Network status — live RPC reachability and the programs FluxPad uses. */
import { currentNetworkCluster } from "@/lib/network-env";
import { useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { Panel } from "@/components/dashboard/panel";
import { Badge } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/icons";
import { copyText } from "@/components/official/copy-text";

const PROGRAMS = [
  { name: "Pump.fun bonding curve", type: "Launch · Bonding Curve", address: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" },
  { name: "PumpSwap AMM", type: "AMM · Bonding Curve", address: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA" },
  { name: "Raydium LaunchLab (devnet)", type: "Launch · LaunchLab", address: "DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6" },
  { name: "Raydium LaunchLab (mainnet)", type: "Launch · LaunchLab", address: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj" },
  { name: "Raydium CPMM", type: "AMM · LaunchLab", address: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C" },
];

export default function StatusPage() {
  const { connection } = useConnection();
  const [rpcOk, setRpcOk] = useState<boolean | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    const started = performance.now();
    connection
      .getSlot("confirmed")
      .then((s) => {
        if (!live) return;
        setRpcOk(true);
        setSlot(s);
        setLatencyMs(Math.round(performance.now() - started));
      })
      .catch(() => live && setRpcOk(false));
    return () => {
      live = false;
    };
  }, [connection]);

  const network =
    currentNetworkCluster();

  return (
    <div className="animate-fade-up mx-auto w-full min-w-0 max-w-5xl">
      <header className="mb-4">
        <h1 className="font-display text-lg font-semibold tracking-tight text-ink">Network Status</h1>
        <p className="mt-0.5 text-2xs text-night-500">Live RPC health and the programs FluxPad integrates with.</p>
      </header>

      {/* Two-column on desktop (RPC 1 : Programs 1.2); stacked below lg */}
      <div className="mb-3 grid min-w-0 grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Panel title="RPC connection" icon="signal" className="min-w-0">
          <div className="space-y-2.5 p-3 text-[13px]">
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-night-500">Cluster</span>
              <Badge tone={network === "mainnet-beta" ? "danger" : "ice"}>{network}</Badge>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-night-500">Reachability</span>
              {rpcOk === null ? (
                <span className="text-night-500">checking…</span>
              ) : rpcOk ? (
                <Badge tone="success">reachable</Badge>
              ) : (
                <Badge tone="danger">unreachable</Badge>
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-night-500">Slot</span>
              <span className="min-w-0 truncate text-right font-mono text-xs text-ink">
                {slot?.toLocaleString() ?? "—"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-night-500">Latency</span>
              <span className="min-w-0 truncate text-right font-mono text-xs text-ink">
                {latencyMs != null ? `${latencyMs} ms` : "—"}
              </span>
            </div>
            <div className="flex min-w-0 flex-col gap-1 border-t border-night-700/60 pt-2.5">
              <span className="shrink-0 text-night-500">Endpoint</span>
              <span className="block max-w-full break-all font-mono text-2xs leading-relaxed text-night-400">
                {connection.rpcEndpoint}
              </span>
            </div>
          </div>
        </Panel>

        <Panel title="Integrated programs" icon="layers" className="min-w-0">
          <ul className="min-w-0 p-1">
            {PROGRAMS.map((p) => (
              <ProgramRow key={p.address} name={p.name} type={p.type} address={p.address} />
            ))}
          </ul>
        </Panel>
      </div>

      <p className="text-2xs text-night-500">
        FluxPad derives every program interaction from these addresses at request time and fails
        honestly when a program or configuration is unavailable on the selected cluster.
      </p>
    </div>
  );
}

/**
 * One integrated-program entry: identity on the first line, the full address
 * underneath with an aligned copy button. The address truncates with an
 * ellipsis on wider screens and wraps on narrow ones — the copy action always
 * uses the complete address, never the truncated text.
 */
function ProgramRow({ name, type, address }: { name: string; type: string; address: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const onCopy = async () => {
    const result = await copyText(address); // full address, never the truncated text
    setCopyState(result === "failed" ? "failed" : "copied");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyState("idle"), result === "failed" ? 4000 : 2000);
  };

  return (
    <li className="row-sep min-w-0 px-2 py-2.5">
      {/* First line: program name + type */}
      <div className="flex min-w-0 items-center gap-2">
        <Icon name="check" size={13} className="shrink-0 text-mint-500" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink" title={name}>
          {name}
        </span>
        <span className="shrink-0 text-2xs uppercase tracking-wider text-night-500">{type}</span>
      </div>
      {/* Second line: address + aligned copy button (no absolute positioning) */}
      <div className="mt-1.5 flex min-w-0 max-w-full items-center gap-2 pl-[21px]">
        <code
          className="min-w-0 flex-1 overflow-hidden break-all text-2xs text-night-400 sm:truncate sm:text-xs"
          title={address}
        >
          {address}
        </code>
        <button
          onClick={() => void onCopy()}
          disabled={copyState === "copied"}
          aria-label={`Copy ${name} program address`}
          className={`inline-flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-2xs transition ${
            copyState === "copied"
              ? "border-mint-600/60 bg-mint-600/10 text-mint-300"
              : "border-night-600 bg-night-850 text-night-400 hover:border-mint-600 hover:text-mint-300"
          }`}
        >
          {copyState === "copied" ? (
            <>
              <Icon name="check" size={11} />
              Copied!
            </>
          ) : (
            <>
              <Icon name="copy" size={11} />
              Copy
            </>
          )}
        </button>
      </div>
      {copyState === "failed" && (
        <p role="alert" className="mt-1 pl-[21px] text-2xs text-danger">
          Copy failed — please select the address text and copy it manually.
        </p>
      )}
    </li>
  );
}
