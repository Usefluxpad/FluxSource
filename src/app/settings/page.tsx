"use client";

import { currentNetworkCluster } from "@/lib/network-env";
import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Badge, Card } from "@/components/ui/primitives";
import { ThemeOptions } from "@/components/theme/theme-toggle";

export default function SettingsPage() {
  const { connection } = useConnection();
  const { publicKey, wallet } = useWallet();
  const [rpcOk, setRpcOk] = useState<boolean | null>(null);
  const [slot, setSlot] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    connection
      .getSlot("confirmed")
      .then((s) => {
        if (live) {
          setRpcOk(true);
          setSlot(s);
        }
      })
      .catch(() => {
        if (live) setRpcOk(false);
      });
    return () => {
      live = false;
    };
  }, [connection]);

  const network = currentNetworkCluster();

  return (
    <div className="animate-fade-up mx-auto max-w-3xl">
      <header className="mb-4">
        <h1 className="font-display text-lg font-semibold tracking-tight text-ink">Settings</h1>
        <p className="mt-0.5 text-2xs text-night-500">Wallet and network configuration for this browser session.</p>
      </header>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <h2 className="text-[13px] font-semibold text-ink">Appearance</h2>
          <p className="mt-1 text-2xs text-night-500">
            Choose how FluxPad looks. System follows your operating system preference.
          </p>
          <div className="mt-4">
            <ThemeOptions />
          </div>
        </Card>
        <Card>
          <h2 className="text-[13px] font-semibold text-ink">Wallet</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <Row label="Provider">
              {wallet ? wallet.adapter.name : <span className="text-night-500">Not connected</span>}
            </Row>
            <Row label="Address">
              {publicKey ? (
                <span className="break-all font-mono text-xs text-mint-300">
                  {publicKey.toBase58()}
                </span>
              ) : (
                <span className="text-night-500">—</span>
              )}
            </Row>
          </dl>
          <p className="mt-4 text-xs text-night-500">
            FluxPad never requests seed phrases or private keys. Transactions
            are signed in your wallet; the optional vanity mint keypair lives
            only in this browser tab&apos;s memory and disappears on refresh.
          </p>
        </Card>
        <Card>
          <h2 className="text-[13px] font-semibold text-ink">Network</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <Row label="Cluster">
              <Badge tone={network === "mainnet-beta" ? "danger" : "ice"}>{network}</Badge>
            </Row>
            <Row label="RPC">
              <span className="break-all font-mono text-xs text-night-500">
                {connection.rpcEndpoint}
              </span>
            </Row>
            <Row label="RPC status">
              {rpcOk === null ? (
                <span className="text-night-500">checking…</span>
              ) : rpcOk ? (
                <Badge tone="success">reachable · slot {slot}</Badge>
              ) : (
                <Badge tone="danger">unreachable</Badge>
              )}
            </Row>
          </dl>
          <p className="mt-4 text-xs text-night-500">
            Mainnet is disabled by default; test on devnet first. Never conduct
            unapproved real-money transactions while testing.
          </p>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-night-800 pb-2">
      <dt className="text-night-500">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}
