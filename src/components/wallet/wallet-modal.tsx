"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

interface WalletModalCtx {
  open: boolean;
  setOpen: (v: boolean) => void;
  /** Last wallet-connection error (user-friendly), or null. */
  error: string | null;
  /** Clear the error before starting a new connection attempt. */
  clearError: () => void;
}

const Ctx = createContext<WalletModalCtx>({
  open: false,
  setOpen: () => {},
  error: null,
  clearError: () => {},
});

export function useWalletModalState() {
  return useContext(Ctx);
}

export function WalletModalProvider({
  children,
  error = null,
  clearError = () => {},
}: {
  children: React.ReactNode;
  error?: string | null;
  clearError?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen, error, clearError }), [open, error, clearError]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Lightweight wallet picker modal (custom UI instead of wallet-adapter-react-ui). */
export function WalletModal() {
  const { open, setOpen, error, clearError } = useWalletModalState();
  const { wallets, select, wallet, connecting } = useWallet();

  if (!open) return null;
  const installed = wallets.filter(
    (w) => w.readyState === "Installed" || w.readyState === "Loadable",
  );
  const others = wallets.filter((w) => !installed.includes(w));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Connect a wallet"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-night-700 bg-night-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">Connect a wallet</h2>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-night-500 hover:bg-night-800 hover:text-ink"
          >
            ✕
          </button>
        </div>
        {wallet && (
          <p className="mb-3 text-sm text-night-500">
            Currently selected: <span className="text-mint-300">{wallet.adapter.name}</span>
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="mb-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
          >
            {error}
          </p>
        )}
        <ul className="space-y-2">
          {[...installed, ...others].map((w) => (
            <li key={w.adapter.name}>
              <button
                disabled={connecting}
                onClick={() => {
                  if (connecting) return; // a connection attempt is already in flight
                  clearError();
                  select(w.adapter.name);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between rounded-xl border border-night-700 bg-night-850 px-4 py-3 text-sm text-ink transition hover:border-mint-600 hover:bg-night-800"
              >
                <span className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={w.adapter.icon} alt="" width={24} height={24} />
                  {w.adapter.name}
                </span>
                <span className="text-xs text-night-500">
                  {w.readyState === "Installed"
                    ? "Detected"
                    : w.readyState === "Loadable"
                      ? "Loadable"
                      : "Not installed"}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-night-500">
          FluxPad never asks for seed phrases or private keys. You approve every
          transaction in your own wallet.
        </p>
      </div>
    </div>
  );
}
