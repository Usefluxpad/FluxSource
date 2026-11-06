"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModalState } from "./wallet-modal";

/** Compact wallet button. Modal-based connect (no external CSS dependency). */
export function WalletButton() {
  const { publicKey, wallet, disconnect, connecting } = useWallet();
  const { setOpen, error, clearError } = useWalletModalState();

  if (connecting) {
    return (
      <button
        disabled
        className="rounded-lg bg-night-800 px-3 py-1.5 text-sm text-night-500"
      >
        Connecting…
      </button>
    );
  }

  if (!publicKey) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <button
          onClick={() => {
            clearError();
            setOpen(true);
          }}
          className="rounded-lg bg-mint-500 px-3.5 py-1.5 text-sm font-medium text-snow shadow-glow-mint transition hover:bg-mint-400"
        >
          Connect Wallet
        </button>
        {error && (
          <span
            role="alert"
            title={error}
            className="max-w-[220px] truncate text-2xs text-danger"
          >
            {error}
          </span>
        )}
      </div>
    );
  }

  const label = wallet?.adapter.name ?? "Wallet";
  void label;
  const short = `${publicKey.toBase58().slice(0, 4)}…${publicKey.toBase58().slice(-4)}`;

  return (
    <div className="flex items-center gap-1">
      <span
        className="rounded-lg border border-night-700 bg-night-800 px-3 py-1.5 font-mono text-xs text-mint-700"
        title={publicKey.toBase58()}
      >
        {short}
      </span>
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg px-2 py-1.5 text-xs text-night-500 hover:text-ink"
      >
        Switch
      </button>
      <button
        onClick={() => void disconnect()}
        className="rounded-lg px-2 py-1.5 text-xs text-night-500 hover:text-danger"
      >
        Exit
      </button>
    </div>
  );
}
