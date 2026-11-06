/*
 * Solana-only Solflare wallet adapter.
 *
 * This is a faithful port of the official Solflare adapter package with ONE
 * deliberate removal: its constructor eagerly ran the Solflare-inside-EVM-
 * extension (Snap) bridge from the transitive Solflare snap SDK. That
 * detection posts a snap-enumeration query at the injected scripts of a
 * certain EVM browser extension on every page load, which forces that
 * extension inpage script to establish its background connection; when the
 * extension service worker is unavailable, the extension surfaces a
 * failed-to-connect error as an uncaught page error (rendered by the Next.js
 * dev overlay).
 *
 * FluxPad is Solana-only and never offered an EVM path, so this port drops
 * the entire bridge while keeping the Solflare Solana behavior identical to
 * the official adapter: ready-state polling, the iOS universal-link
 * redirect, the dynamic Solflare SDK load, connect/disconnect error
 * wrapping, and connect/disconnect/accountChanged events. The Solflare SDK
 * itself contains no EVM code (verified), so nothing in this module ever
 * touches an EVM provider.
 */

import {
  BaseMessageSignerWalletAdapter,
  WalletConfigError,
  WalletConnectionError,
  WalletDisconnectedError,
  WalletDisconnectionError,
  WalletError,
  WalletLoadError,
  WalletNotConnectedError,
  WalletNotReadyError,
  WalletPublicKeyError,
  WalletReadyState,
  WalletSendTransactionError,
  WalletSignMessageError,
  WalletSignTransactionError,
  isIosAndRedirectable,
  isVersionedTransaction,
  scopePollingDetectionStrategy,
  type SendTransactionOptions,
  type WalletAdapterNetwork,
  type WalletName,
} from "@solana/wallet-adapter-base";
import { PublicKey, type Connection, type Transaction, type VersionedTransaction } from "@solana/web3.js";

declare global {
  interface Window {
    /** Injected Solflare extension provider (Solana). */
    solflare?: { isSolflare?: boolean };
    /** Solflare mobile web-view global. */
    SolflareApp?: unknown;
  }
}

export const SolflareWalletName = "Solflare" as WalletName<"Solflare">;

/** Best-effort message extraction from unknown thrown values (catch vars
 * are `unknown` under strict settings). */
function errMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return undefined;
}

export interface SolflareWalletAdapterConfig {
  network?: WalletAdapterNetwork;
}

/**
 * Structural view of the `@solflare-wallet/sdk` wallet instance used here.
 * The real SDK ships richer types; only the members the adapter exercises
 * are declared, keeping this module independent of the SDK's type surface.
 */
interface SolflareSdkWallet {
  connected: boolean;
  publicKey: { toBytes(): Uint8Array } | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(event: "disconnect", handler: () => void): unknown;
  off(event: "disconnect", handler: () => void): unknown;
  on(event: "accountChanged", handler: (publicKey: { toBytes(): Uint8Array }) => void): unknown;
  off(event: "accountChanged", handler: (publicKey: { toBytes(): Uint8Array }) => void): unknown;
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]>;
  signMessage(message: Uint8Array, encoding?: "utf8"): Promise<Uint8Array>;
  signAndSendTransaction(
    transaction: Transaction | VersionedTransaction,
    options?: SendTransactionOptions,
  ): Promise<string>;
}

export class SolflareWalletAdapter extends BaseMessageSignerWalletAdapter {
  readonly name: WalletName<"Solflare"> = SolflareWalletName;
  readonly url = "https://solflare.com";
  readonly icon = SOLFLARE_ICON_DATA_URI;
  readonly supportedTransactionVersions: ReadonlySet<"legacy" | 0> = new Set(["legacy", 0]);

  private _readyState: WalletReadyState =
    typeof window === "undefined" || typeof document === "undefined"
      ? WalletReadyState.Unsupported
      : WalletReadyState.Loadable;
  private _connecting = false;
  private _publicKey: PublicKey | null = null;
  private _wallet: SolflareSdkWallet | null = null;
  private readonly _config: SolflareWalletAdapterConfig;
  private readonly _disconnected = () => {
    const wallet = this._wallet;
    if (wallet) {
      wallet.off("disconnect", this._disconnected);
      this._wallet = null;
      this._publicKey = null;
      this.emit("error", new WalletDisconnectedError());
      this.emit("disconnect");
    }
  };
  private readonly _accountChanged = (newPublicKey: { toBytes(): Uint8Array }) => {
    if (!newPublicKey) return;
    const publicKey = this._publicKey;
    if (!publicKey) return;
    const next = new PublicKey(newPublicKey.toBytes());
    if (publicKey.equals(next)) return;
    this._publicKey = next;
    this.emit("connect", next);
  };

  constructor(config: SolflareWalletAdapterConfig = {}) {
    super();
    this._config = config;
    if (this._readyState !== WalletReadyState.Unsupported) {
      // Browser only: poll for the injected Solflare provider. The official
      // adapter ALSO fired its MetaMask-Snap detection here — deliberately
      // omitted, see the module header.
      scopePollingDetectionStrategy(() => {
        if (window.solflare?.isSolflare || window.SolflareApp) {
          this._readyState = WalletReadyState.Installed;
          this.emit("readyStateChange", this._readyState);
          return true;
        }
        return false;
      });
    }
  }

  get publicKey(): PublicKey | null {
    return this._publicKey;
  }

  get connecting(): boolean {
    return this._connecting;
  }

  get connected(): boolean {
    return !!this._wallet?.connected;
  }

  get readyState(): WalletReadyState {
    return this._readyState;
  }

  async autoConnect(): Promise<void> {
    // Skip autoconnect in the Loadable state on iOS: the universal-link
    // redirect needs a user gesture.
    if (!(this.readyState === WalletReadyState.Loadable && isIosAndRedirectable())) {
      await this.connect();
    }
  }

  async connect(): Promise<void> {
    try {
      if (this.connected || this.connecting) return;
      if (this._readyState !== WalletReadyState.Loadable && this._readyState !== WalletReadyState.Installed) {
        throw new WalletNotReadyError();
      }
      // Redirect to the Solflare /browse universal link — this opens the
      // current URL in the Solflare in-wallet browser.
      if (this.readyState === WalletReadyState.Loadable && isIosAndRedirectable()) {
        const url = encodeURIComponent(window.location.href);
        const ref = encodeURIComponent(window.location.origin);
        window.location.href = `https://solflare.com/ul/v1/browse/${url}?ref=${ref}`;
        return;
      }
      let SolflareClass: new (config: { network?: WalletAdapterNetwork }) => SolflareSdkWallet;
      try {
        SolflareClass = ((await import("@solflare-wallet/sdk")) as unknown as { default: typeof SolflareClass }).default;
      } catch (error) {
        throw new WalletLoadError(errMessage(error), error);
      }
      let wallet: SolflareSdkWallet;
      try {
        wallet = new SolflareClass({ network: this._config.network });
      } catch (error) {
        throw new WalletConfigError(errMessage(error), error);
      }
      this._connecting = true;
      if (!wallet.connected) {
        try {
          await wallet.connect();
        } catch (error) {
          throw new WalletConnectionError(errMessage(error), error);
        }
      }
      if (!wallet.publicKey) throw new WalletConnectionError();
      let publicKey: PublicKey;
      try {
        publicKey = new PublicKey(wallet.publicKey.toBytes());
      } catch (error) {
        throw new WalletPublicKeyError(errMessage(error), error);
      }
      wallet.on("disconnect", this._disconnected);
      wallet.on("accountChanged", this._accountChanged);
      this._wallet = wallet;
      this._publicKey = publicKey;
      this.emit("connect", publicKey);
    } catch (error) {
      this.emit("error", error as WalletError);
      throw error;
    } finally {
      this._connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    const wallet = this._wallet;
    if (wallet) {
      wallet.off("disconnect", this._disconnected);
      wallet.off("accountChanged", this._accountChanged);
      this._wallet = null;
      this._publicKey = null;
      try {
        await wallet.disconnect();
      } catch (error) {
        this.emit("error", new WalletDisconnectionError(errMessage(error), error));
      }
    }
    this.emit("disconnect");
  }

  async sendTransaction(
    transaction: Transaction | VersionedTransaction,
    connection: Connection,
    options: SendTransactionOptions = {},
  ): Promise<string> {
    try {
      const wallet = this._wallet;
      if (!wallet) throw new WalletNotConnectedError();
      try {
        const { signers, ...sendOptions } = options;
        if (isVersionedTransaction(transaction)) {
          signers?.length && transaction.sign(signers);
        } else {
          transaction = (await this.prepareTransaction(transaction, connection, sendOptions)) as typeof transaction;
          signers?.length && transaction.partialSign(...signers);
        }
        sendOptions.preflightCommitment = sendOptions.preflightCommitment || connection.commitment;
        return await wallet.signAndSendTransaction(transaction, sendOptions);
      } catch (error) {
        if (error instanceof WalletError) throw error;
        throw new WalletSendTransactionError(errMessage(error), error);
      }
    } catch (error) {
      this.emit("error", error as WalletError);
      throw error;
    }
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    try {
      const wallet = this._wallet;
      if (!wallet) throw new WalletNotConnectedError();
      try {
        return (await wallet.signTransaction(transaction)) || transaction;
      } catch (error) {
        throw new WalletSignTransactionError(errMessage(error), error);
      }
    } catch (error) {
      this.emit("error", error as WalletError);
      throw error;
    }
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]> {
    try {
      const wallet = this._wallet;
      if (!wallet) throw new WalletNotConnectedError();
      try {
        return (await wallet.signAllTransactions(transactions)) || transactions;
      } catch (error) {
        throw new WalletSignTransactionError(errMessage(error), error);
      }
    } catch (error) {
      this.emit("error", error as WalletError);
      throw error;
    }
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    try {
      const wallet = this._wallet;
      if (!wallet) throw new WalletNotConnectedError();
      try {
        return await wallet.signMessage(message, "utf8");
      } catch (error) {
        throw new WalletSignMessageError(errMessage(error), error);
      }
    } catch (error) {
      this.emit("error", error as WalletError);
      throw error;
    }
  }
}

/** Official Solflare adapter icon (copied verbatim from
 * the official Solflare adapter package so the wallet modal is unchanged). */
const SOLFLARE_ICON_DATA_URI =
  "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c3ZnIGlkPSJTIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MCA1MCI+PGRlZnM+PHN0eWxlPi5jbHMtMXtmaWxsOiMwMjA1MGE7c3Ryb2tlOiNmZmVmNDY7c3Ryb2tlLXdpZHRoOi41cHg7fS5jbHMtMntmaWxsOiNmZmVmNDY7fTwvc3R5bGU+PHJlY3QgY2xhc3M9ImNscy0yIiB4PSIwIiB5PSIwIiB3aWR0aD0iNTAiIGhlaWdodD0iNTAiIHJ4PSIxMiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTI0LjIzLDI2LjQybDIuNDYtMi4zOCw0LjU5LDEuNWMzLjAxLDEsNC41MSwyLjg0LDQuNTEsNS40MywwLDEuOTYtLjc1LDMuMjYtMi4yNSw0LjkzbC0uNDYuNS4xNy0xLjE3Yy42Ny00LjI2LS41OC02LjA5LTQuNzItNy40M2wtNC4zLTEuMzhoMFpNMTguMDUsMTEuODVsMTIuNTIsNC4xNy0yLjcxLDIuNTktNi41MS0yLjE3Yy0yLjI1LS43NS0zLjAxLTEuOTYtMy4zLTQuNTF2LS4wOGgwWk0xNy4zLDMzLjA2bDIuODQtMi43MSw1LjM0LDEuNzVjMi44LjkyLDMuNzYsMi4xMywzLjQ2LDUuMThsLTExLjY1LTQuMjJoMFpNMTMuNzEsMjAuOTVjMC0uNzkuNDItMS41NCwxLjEzLTIuMTcuNzUsMS4wOSwyLjA1LDIuMDUsNC4wOSwyLjcxbDQuNDIsMS40Ni0yLjQ2LDIuMzgtNC4zNC0xLjQyYy0yLS42Ny0yLjg0LTEuNjctMi44NC0yLjk2TTI2LjgyLDQyLjg3YzkuMTgtNi4wOSwxNC4xMS0xMC4yMywxNC4xMS0xNS4zMiwwLTMuMzgtMi01LjI2LTYuNDMtNi43MmwtMy4zNC0xLjEzLDkuMTQtOC43Ny0xLjg0LTEuOTYtMi43MSwyLjM4LTEyLjgxLTQuMjJjLTMuOTcsMS4yOS04Ljk3LDUuMDktOC45Nyw4Ljg5LDAsLjQyLjA0LjgzLjE3LDEuMjktMy4zLDEuODgtNC42MywzLjYzLTQuNjMsNS44LDAsMi4wNSwxLjA5LDQuMDksNC41NSw1LjIybDIuNzUuOTItOS41Miw5LjE0LDEuODQsMS45NiwyLjk2LTIuNzEsMTQuNzMsNS4yMmgwWiIvPjwvc3ZnPg==";