import {
  Commitment,
  Connection,
  PACKET_DATA_SIZE,
  PublicKey,
  Transaction,
  TransactionSignature,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  isTransactionTooLargeError,
  RelaypadError,
  toRelaypadError,
} from "./connection";

/**
 * The wallet-facing signer surface. In the browser this is satisfied by a
 * wallet-adapter wallet. In tests it is a mock. RelayPad never holds user
 * keys — all signing happens in the wallet (plus the ephemeral mint keypair,
 * which stays in client memory when a vanity mint is requested).
 */
export interface WalletSigner {
  publicKey: PublicKey;
  /**
   * Signs all signatures required by `tx` that are not already present
   * (wallet-adapter wallets support both legacy and versioned transactions).
   */
  signTransaction(tx: Transaction | VersionedTransaction): Promise<Transaction | VersionedTransaction>;
}

export interface SubmitOptions {
  commitment?: Commitment;
  /** Pre-send rebuild attempts (transport/stale blockhash; nothing accepted). */
  maxAttempts?: number;
  onAttempt?: (attempt: number, sig: TransactionSignature | null) => void;
  /** Total wall-clock window for the confirmation poll loop. */
  confirmWindowMs?: number;
  /** Delay between confirmation status polls. */
  pollIntervalMs?: number;
}

export interface SubmitResult {
  signature: TransactionSignature;
  slot: number | null;
  /** Blockhash of the submitted transaction (when extractable). */
  blockhash: string | null;
  /** Last-valid-block-height snapshot taken at submit time (when available). */
  lastValidBlockHeight: number | null;
}

const DEFAULT_COMMITMENT: Commitment = "confirmed";

/**
 * Simulate a fully-signed transaction. Returns logs, or null when the
 * transaction is not fully signed (wallet-only flows before signing).
 */
export async function simulateTransaction(
  connection: Connection,
  tx: Transaction | VersionedTransaction,
): Promise<{ ok: true; logs: string[] } | null> {
  try {
    const value =
      tx instanceof VersionedTransaction
        ? (await connection.simulateTransaction(tx, { sigVerify: false })).value
        : (await connection.simulateTransaction(tx)).value;
    if (value.err) {
      const errJson = JSON.stringify(value.err);
      if (errJson.includes("InsufficientFunds") || errJson.includes("InsufficientFundsForFee")) {
        throw new RelaypadError(
          "INSUFFICIENT_FUNDS",
          "Simulation failed: insufficient funds for fees/buy amount.",
        );
      }
      if (errJson.includes("BlockhashNotFound")) {
        // The transaction's referenced blockhash is no longer valid (e.g. the
        // wallet approval took too long). NOT a program-logic failure and
        // nothing was submitted — retryable via a rebuild + fresh approval.
        throw new RelaypadError(
          "BLOCKHASH_EXPIRED",
          "The transaction's blockhash expired before it could be submitted — the approval took too long or the network moved on. Nothing was submitted. FluxPad rebuilds the transaction with a fresh blockhash and asks for approval again.",
        );
      }
      throw new RelaypadError(
        "SIMULATION_FAILED",
        `Simulation failed: ${errJson}`,
      );
    }
    return { ok: true, logs: value.logs ?? [] };
  } catch (err) {
    if (err instanceof RelaypadError) throw err;
    return null; // not fully signed — simulation not possible pre-wallet
  }
}

export { toRelaypadError };

const DEFAULT_CONFIRM_WINDOW_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 2_500;
/** Blocks past the snapshot's last-valid height before closing the window. */
const EXPIRY_BUFFER_BLOCKS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Submit a fully-signed transaction with safe retries and HTTP-only
 * confirmation.
 *
 * Retry policy: transport-level failures and stale blockhashes rebuild the
 * transaction with a fresh blockhash before resubmitting — this only ever
 * happens when nothing was accepted by the RPC. Once a signature is accepted,
 * the transaction is never rebuilt or resubmitted.
 *
 * Confirmation strategy: poll `getSignatureStatuses` over plain HTTP until a
 * terminal state or the blockhash window closes, then resolve via a
 * historical search. WebSocket confirmation is intentionally not used: the
 * browser RPC proxy (/api/rpc) is HTTP-only, so the WS-based
 * connection.confirmTransaction could never resolve there and produced a
 * false "UNKNOWN" error after 30s while the transaction had actually landed.
 */
export async function submitAndConfirm(
  connection: Connection,
  buildTx: () => Promise<Transaction | VersionedTransaction>,
  signer: WalletSigner,
  opts: SubmitOptions = {},
): Promise<SubmitResult> {
  const commitment = opts.commitment ?? DEFAULT_COMMITMENT;
  const confirmWindowMs = opts.confirmWindowMs ?? DEFAULT_CONFIRM_WINDOW_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxAttempts = opts.maxAttempts ?? 3;

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    opts.onAttempt?.(attempt, null);

    let tx: Transaction | VersionedTransaction;
    try {
      tx = await buildTx();
    } catch (err) {
      throw toRelaypadError(err);
    }

    let signed: Transaction | VersionedTransaction;
    try {
      signed = await signer.signTransaction(tx);
    } catch (err) {
      throw toRelaypadError(err);
    }

    // Best-effort simulation (skipped when the tx isn't fully signed). It
    // runs BEFORE submission, so a BlockhashNotFound here means the blockhash
    // expired while the wallet popup was open — nothing was ever submitted,
    // which makes a rebuild + fresh wallet approval safe (wallet-gated, never
    // an automatic duplicate submission).
    try {
      await simulateTransaction(connection, signed).catch((err) => {
        if (err instanceof RelaypadError) throw err;
        return null;
      });
    } catch (err) {
      const mapped = err instanceof RelaypadError ? err : toRelaypadError(err);
      if (mapped.code === "BLOCKHASH_EXPIRED" && attempt < maxAttempts) {
        lastError = err;
        continue; // rebuild (buildTx) + re-sign on the next attempt
      }
      throw mapped;
    }

    let signature: TransactionSignature;
    try {
      signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 5,
      });    } catch (err) {
      lastError = err;
      const mapped = toRelaypadError(err);
      if (
        (mapped.code === "STALE_BLOCKHASH" ||
          mapped.code === "BLOCKHASH_EXPIRED" ||
          mapped.code === "RPC_ERROR") &&
        attempt < maxAttempts
      ) {
        continue; // nothing was accepted — safe to rebuild
      }
      throw mapped;
    }

    opts.onAttempt?.(attempt, signature);

    // The RPC accepted the transaction — from here on it must never be
    // rebuilt or resubmitted, no matter how confirmation goes: resubmitting
    // the same launch would spend SOL a second time. A timeout never implies
    // failure; the outcome is resolved by status polling and, as a last
    // resort, a historical search.
    opts.onAttempt?.(attempt, signature);

    const blockhash =
      (signed instanceof VersionedTransaction
        ? signed.message.recentBlockhash
        : signed.recentBlockhash) ?? null;

    // Snapshot the validity window right after submission: the transaction's
    // own blockhash is valid at least this long, so once the chain passes
    // this height the transaction can no longer land for the first time.
    let lastValidBlockHeight: number | null = null;
    try {
      lastValidBlockHeight =
        (await connection.getLatestBlockhash(commitment))?.lastValidBlockHeight ?? null;
    } catch {
      // Fall back to the wall-clock deadline when the snapshot is unavailable.
    }

    const deadline = Date.now() + confirmWindowMs;
    let lastPollError: unknown = null;

    while (Date.now() < deadline) {
      let statuses: { value: ({ err: unknown; slot?: number | null } | null)[] } | null;
      try {
        statuses = await connection.getSignatureStatuses([signature]);
      } catch (err) {
        // Temporary RPC failures (rate limits, 5xx, proxy hiccups) never imply
        // the transaction failed — keep polling until the deadline.
        lastPollError = err;
        if (Date.now() + pollIntervalMs >= deadline) break;
        await sleep(pollIntervalMs);
        continue;
      }
      const status = statuses?.value?.[0] ?? null;
      if (status) {
        if (status.err) {
          const errJson = JSON.stringify(status.err);
          if (
            errJson.includes("InsufficientFunds") ||
            errJson.includes("InsufficientFundsForFee")
          ) {
            throw new RelaypadError("INSUFFICIENT_FUNDS", `On-chain failure: ${errJson}`);
          }
          throw new RelaypadError(
            "SIMULATION_FAILED",
            `Transaction landed but failed on-chain: ${errJson}`,
          );
        }
        // err === null: the transaction executed successfully on-chain.
        return { signature, slot: status.slot ?? null, blockhash, lastValidBlockHeight };
      }
      // No status yet — still pending. Close the window early once the
      // blockhash has definitively expired (nothing lands on an expired
      // blockhash); blockhash expiry alone is not a failure verdict.
      if (lastValidBlockHeight !== null) {
        let height: number | null = null;
        try {
          height = await connection.getBlockHeight(commitment);
        } catch {
          height = null;
        }
        if (height !== null && height > lastValidBlockHeight + EXPIRY_BUFFER_BLOCKS) break;
      }
      if (Date.now() + pollIntervalMs >= deadline) break;
      await sleep(pollIntervalMs);
    }

    // Final resolution pass, including transaction history: this catches
    // transactions that landed while polling was impaired or after the
    // window closed.
    let historical: { err: unknown; slot: number | null } | null = null;
    try {
      const res = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const s = res?.value?.[0] ?? null;
      if (s) {
        historical = {
          err: (s as { err?: unknown }).err ?? null,
          slot: (s as { slot?: number | null }).slot ?? null,
        };
      }
    } catch (err) {
      lastPollError = err;
    }

    if (historical) {
      if (historical.err) {
        const errJson = JSON.stringify(historical.err);
        if (
          errJson.includes("InsufficientFunds") ||
          errJson.includes("InsufficientFundsForFee")
        ) {
          throw new RelaypadError("INSUFFICIENT_FUNDS", `On-chain failure: ${errJson}`);
        }
        throw new RelaypadError(
          "SIMULATION_FAILED",
          `Transaction landed but failed on-chain: ${errJson}`,
        );
      }
      return { signature, slot: historical.slot, blockhash, lastValidBlockHeight };
    }

    // Genuinely unresolved — reported as unknown, never as a failure, and
    // never a reason to resubmit.
    throw new RelaypadError(
      "UNRESOLVED",
      `FluxPad could not verify the launch result in time. The transaction (signature ${signature}) may still land. Do NOT launch again — check the signature on the Solana Explorer first.`,
      lastError ?? lastPollError,
      signature,
    );
  }

  throw new RelaypadError(
    "UNRESOLVED",
    `Transaction could not be confirmed after ${maxAttempts} attempts. The launch may still have landed — verify recent signatures before retrying.`,
    lastError,
  );
}

/** "ok" | "failed" | "unknown" for a submitted signature. */
export async function resolveSignature(
  connection: Connection,
  signature: TransactionSignature,
): Promise<"ok" | "failed" | "unknown"> {
  try {
    const status = await connection.getSignatureStatus(signature);
    if (!status.value) return "unknown";
    return status.value.err ? "failed" : "ok";
  } catch {
    return "unknown";
  }
}

/**
 * Cheap pre-sign blockhash-freshness probe: `getFeeForMessage` returns null
 * for a message whose blockhash is expired or unknown to the RPC. Fails OPEN
 * on transient RPC errors — only a definitive expired/unknown blockhash marks
 * the transaction unusable, so a probe outage never blocks a launch that
 * would otherwise succeed (the real simulation/submission still surfaces
 * reality downstream).
 */
export async function isBlockhashUsable(
  connection: Connection,
  tx: Transaction | VersionedTransaction,
): Promise<boolean> {
  try {
    const message = tx instanceof VersionedTransaction ? tx.message : tx.compileMessage();
    const res = await connection.getFeeForMessage(message, "confirmed");
    return res?.value != null;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (raw.toLowerCase().replace(/\s+/g, "").includes("blockhashnotfound")) return false;
    return true;
  }
}

export interface BlockhashAwareBuildTxOptions {
  connection: Connection;
  /** The current prebuilt transaction for this step. */
  getTx: () => Transaction | VersionedTransaction;
  /**
   * Safe rebuild-and-resign: produce a NEW transaction with a fresh blockhash
   * (re-signed by all local signers; size guards re-run). Never mutates a
   * wallet-signed message — the wallet signs the rebuilt transaction fresh.
   * Optional: without it, a stale blockhash surfaces as a coded, actionable
   * BLOCKHASH_EXPIRED error.
   */
  rebuild?: () => Promise<Transaction | VersionedTransaction>;
  /** UI hooks around the rebuild (progress messaging). */
  onRebuildStart?: () => void;
  onRebuildDone?: () => void;
  /** Override for the no-rebuild error message. */
  expiredMessage?: string;
}

/**
 * buildTx factory for submitAndConfirm: before the wallet is asked to sign —
 * and on every retry — it probes the prebuilt transaction's blockhash
 * freshness and rebuilds when the blockhash can no longer be used. This
 * closes the review-screen staleness gap (the blockhash is fetched at
 * prepare time and must survive until wallet approval), which is what
 * produced LaunchLab CPMM's false "Simulation failed: BlockhashNotFound".
 */
export function makeBlockhashAwareBuildTx(
  opts: BlockhashAwareBuildTxOptions,
): () => Promise<Transaction | VersionedTransaction> {
  return async () => {
    const tx = opts.getTx();
    if (await isBlockhashUsable(opts.connection, tx)) return tx;
    if (!opts.rebuild) {
      throw new RelaypadError(
        "BLOCKHASH_EXPIRED",
        opts.expiredMessage ??
          "This launch was prepared more than about a minute ago and its blockhash has expired. Click Launch again — FluxPad will rebuild it with a fresh blockhash before asking your wallet to sign. No transaction was submitted.",
      );
    }
    opts.onRebuildStart?.();
    const fresh = await opts.rebuild();
    opts.onRebuildDone?.();
    return fresh;
  };
}

/** Convenience: get balance with a clear error naming the shortfall. */
export async function assertMinBalance(
  connection: Connection,
  pubkey: PublicKey,
  requiredLamports: bigint,
): Promise<void> {
  let lamports: number;
  try {
    lamports = await connection.getBalance(pubkey, "confirmed");
  } catch (err) {
    throw toRelaypadError(err);
  }
  if (BigInt(lamports) < requiredLamports) {
    throw new RelaypadError(
      "INSUFFICIENT_FUNDS",
      `Wallet balance ${(Number(lamports) / 1e9).toFixed(4)} SOL is below the required minimum ${(Number(requiredLamports) / 1e9).toFixed(4)} SOL.`,
    );
  }
}

/**
 * Fetch a fresh, durable blockhash. Throws a typed error on RPC failure so
 * callers can distinguish outage from wallet issues.
 */
export async function getFreshBlockhash(
  connection: Connection,
  commitment: Commitment = "finalized",
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  try {
    const res = await connection.getLatestBlockhash(commitment);
    if (!res || !res.blockhash) {
      throw new RelaypadError("RPC_ERROR", "RPC returned an empty blockhash.");
    }
    return res;
  } catch (err) {
    if (err instanceof RelaypadError) throw err;
    throw toRelaypadError(err);
  }
}

/**
 * Measure a transaction's serialized wire size without any wallet signature
 * and without broadcasting (P0.2). Unsigned signature slots occupy their full
 * 64 bytes on the wire, so the measurement matches the final signed
 * transaction:
 * - legacy: `serialize({ requireAllSignatures: false, verifySignatures: false })`
 *   (verified on web3.js 1.98.2: no signedness check runs with this config)
 * - v0: `VersionedTransaction.serialize()` (zeroed signature slots)
 *
 * When the message itself cannot fit the packet buffer, web3.js throws before
 * returning a size (legacy: a Node `ERR_OUT_OF_RANGE` RangeError from the
 * fixed 1,232-byte message buffer; v0: BufferLayout's `encoding overruns
 * Uint8Array`). That throw is converted to a coded `TX_TOO_LARGE`
 * RelaypadError here, so no raw web3.js/Node error can ever escape the size
 * guard.
 */
export function measureTransactionSize(
  tx: Transaction | VersionedTransaction,
  label = "launch",
): number {
  try {
    if (tx instanceof VersionedTransaction) return tx.serialize().length;
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  } catch (err) {
    if (err instanceof RelaypadError) throw err;
    throw new RelaypadError(
      "TX_TOO_LARGE",
      `The ${label} transaction exceeds Solana's ${PACKET_DATA_SIZE}-byte packet limit and cannot be signed or broadcast. Shorten the metadata URI (the default IPFS gateway produces the shortest URIs) or adjust the launch options — for example launch without the initial buy — then try again.`,
      err,
    );
  }
}

/**
 * Pre-signing transaction-size guard (P0.2): run after a launch transaction
 * is constructed and before it is presented for wallet signing. Throws a
 * coded `TX_TOO_LARGE` RelaypadError with an actionable message when the
 * transaction exceeds Solana's 1,232-byte packet limit. Never requires
 * broadcasting or a real wallet signature.
 */
export function assertTransactionFits(
  tx: Transaction | VersionedTransaction,
  label: string,
): void {
  let size: number;
  try {
    size = measureTransactionSize(tx, label);
  } catch (err) {
    // measureTransactionSize already maps serialization overflow to a coded
    // TX_TOO_LARGE carrying the label — rethrow unchanged.
    if (err instanceof RelaypadError && err.code === "TX_TOO_LARGE") throw err;
    if (err instanceof RelaypadError) throw err;
    if (isTransactionTooLargeError(err)) {
      throw new RelaypadError(
        "TX_TOO_LARGE",
        `The ${label} transaction exceeds Solana's ${PACKET_DATA_SIZE}-byte packet limit and cannot be signed or broadcast. Shorten the metadata URI (the default IPFS gateway produces the shortest URIs) or adjust the launch options — for example launch without the initial buy — then try again.`,
        err,
      );
    }
    throw toRelaypadError(err);
  }
  if (size > PACKET_DATA_SIZE) {
    throw new RelaypadError(
      "TX_TOO_LARGE",
      `The ${label} transaction is ${size} bytes — over Solana's ${PACKET_DATA_SIZE}-byte packet limit. Shorten the metadata URI (the default IPFS gateway produces the shortest URIs) or adjust the launch options — for example launch without the initial buy — then try again.`,
    );
  }
}
