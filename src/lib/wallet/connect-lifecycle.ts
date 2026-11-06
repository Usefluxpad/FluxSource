/**
 * Wallet connection lifecycle hardening.
 *
 * FluxPad is a Solana-only launchpad: the wallet stack is
 * @solana/wallet-adapter-(react|phantom|solflare). A wedged injected wallet
 * environment (browser wallet extensions inject providers into every page,
 * and several multi-chain extensions also expose `window.solana`) can make an
 * adapter's `connect()`/`autoConnect()` promise never settle. Inside
 * `@solana/wallet-adapter-react@0.15.39` the auto-connect effect sets
 * `connecting = true`, awaits the adapter call, and only clears the flag in a
 * `finally` — so a hung adapter left the UI stuck on "Connecting…" forever,
 * including after a page refresh.
 *
 * This module bounds every connection attempt: each adapter is wrapped so its
 * `connect()`/`autoConnect()` race a timeout and reject with a typed
 * `WalletConnectTimeoutError`. The provider's own `finally` then always runs,
 * the UI recovers, and a friendly error is surfaced. If the wallet eventually
 * responds after the timeout, the adapter's `connect` event still updates the
 * UI normally.
 */
import {
  WalletConnectionError,
  WalletDisconnectionError,
  WalletError,
  WalletNotReadyError,
  WalletTimeoutError,
  type Adapter,
} from "@solana/wallet-adapter-base";

/**
 * Upper bound for a single wallet connect/auto-connect attempt. It must be
 * longer than a human approving a wallet popup (which is why it is generous),
 * while still guaranteeing the UI recovers from a hung adapter instead of
 * spinning forever.
 */
export const WALLET_CONNECT_TIMEOUT_MS = 60_000;

/** Raised when an adapter's connect/auto-connect exceeded the timeout. */
export class WalletConnectTimeoutError extends WalletTimeoutError {
  constructor(timeoutMs: number) {
    super(
      `The wallet did not respond within ${Math.round(timeoutMs / 1000)}s. Check that your wallet extension is unlocked and up to date, then try again.`,
    );
    this.name = "WalletConnectTimeoutError";
  }
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WalletConnectTimeoutError(timeoutMs)), timeoutMs);
  });
  // Promise.race attaches handlers to both promises, so a late rejection of
  // the original can never become an unhandled rejection.
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Wrap a wallet adapter so its `connect()` and `autoConnect()` always settle
 * within `timeoutMs`. All other members (getters such as `publicKey`,
 * `connected` and `readyState`, and event methods such as `on`/`off`/`emit`)
 * pass through unchanged, so adapter events keep driving the UI.
 */
export interface WithConnectTimeoutOptions {
  /** Upper bound for one connect/auto-connect attempt. */
  timeoutMs?: number;
  /**
   * Called once per failed bounded attempt (timeout OR the adapter's own
   * rejection). wallet-adapter-react's auto-connect path drops adapter
   * errors, so this is the reliable surface for user-friendly messaging.
   */
  onConnectFailure?: (error: WalletError) => void;
}

export function withConnectTimeout(
  adapter: Adapter,
  options: WithConnectTimeoutOptions = {},
): Adapter {
  const timeoutMs = options.timeoutMs ?? WALLET_CONNECT_TIMEOUT_MS;
  const onConnectFailure = options.onConnectFailure;
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === "connect" || prop === "autoConnect") {
        const original = Reflect.get(target, prop, target) as unknown;
        if (typeof original !== "function") return original;
        const bound = (original as (...args: unknown[]) => Promise<unknown>).bind(target);
        return async (...args: unknown[]) => {
          try {
            return await raceWithTimeout(bound(...args), timeoutMs);
          } catch (err) {
            onConnectFailure?.(
              err instanceof WalletError ? err : new WalletConnectionError(String(err)),
            );
            throw err;
          }
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as Adapter;
}

/** Map a wallet error to a short, user-friendly message. */
export function describeWalletError(error: unknown): string {
  if (error instanceof WalletConnectTimeoutError || error instanceof WalletTimeoutError) {
    return "The wallet took too long to respond. Make sure your wallet extension is unlocked and up to date, then try again.";
  }
  if (error instanceof WalletNotReadyError) {
    return "The wallet is not ready. Open or install the wallet extension, then try again.";
  }
  if (error instanceof WalletDisconnectionError) {
    return "The wallet disconnected unexpectedly. Try connecting again.";
  }
  const message =
    error instanceof Error ? error.message : String(error);
  if (/window (was )?closed/i.test(message)) {
    return "The wallet window was closed before the connection was approved.";
  }
  if (/reject/i.test(message)) {
    return "The connection request was rejected in the wallet.";
  }
  return message ? `Wallet error: ${message}` : "An unknown wallet error occurred.";
}
