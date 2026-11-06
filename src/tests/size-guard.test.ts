import { describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { isTransactionTooLargeError, FluxpadError, toFluxpadError } from "@/lib/connection";
import { assertTransactionFits, measureTransactionSize } from "@/lib/tx-engine";

const BLOCKHASH = "11111111111111111111111111111111";

/**
 * Legacy transaction mirroring the Pump.fun adapter shape: compute-unit
 * instruction + a payload instruction requiring an extra signer (the mint
 * keypair role). The wallet (fee payer) signature is intentionally absent —
 * the guard must measure without it.
 */
function legacyTx(dataBytes: number, signExtra = true): Transaction {
  const payer = Keypair.generate();
  const extra = Keypair.generate();
  const program = Keypair.generate();
  const tx = new Transaction();
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = BLOCKHASH;
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  tx.add(
    new TransactionInstruction({
      programId: program.publicKey,
      keys: [{ pubkey: extra.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.alloc(dataBytes, 1),
    }),
  );
  if (signExtra) tx.partialSign(extra);
  return tx;
}

/** V0 transaction mirroring the LaunchLab adapter shape (unsigned). */
function v0Tx(dataBytes: number): VersionedTransaction {
  const payer = Keypair.generate();
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      new TransactionInstruction({
        programId: payer.publicKey,
        keys: [],
        data: Buffer.alloc(dataBytes, 1),
      }),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

function catchGuard(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

describe("pre-signing transaction size guard (P0.2)", () => {
  it("accepts a small legacy transaction", () => {
    expect(catchGuard(() => assertTransactionFits(legacyTx(32), "small legacy"))).toBeNull();
  });

  it("accepts a small unsigned v0 transaction", () => {
    expect(catchGuard(() => assertTransactionFits(v0Tx(32), "small v0"))).toBeNull();
  });

  it("measures unsigned and partially-signed legacy txs identically", () => {
    // The payer signature slot is preallocated on the wire either way, so the
    // measurement must not depend on the wallet having signed.
    expect(measureTransactionSize(legacyTx(32, true))).toBe(
      measureTransactionSize(legacyTx(32, false)),
    );
  });

  it("rejects oversized legacy transactions with TX_TOO_LARGE", () => {
    // Both payloads keep fixture construction survivable (partialSign
    // serializes internally and throws its own raw packet-overflow error for
    // much larger messages) while pushing the full wire size past 1,232
    // bytes, so the web3.js wire assert fires inside the guard and must map
    // to TX_TOO_LARGE. Measured anchors: 1100B payload → 1407-byte wire,
    // 1000B payload → 1307-byte wire.
    for (const dataBytes of [1100, 1000]) {
      const err = catchGuard(() =>
        assertTransactionFits(legacyTx(dataBytes), "Pump.fun launch"),
      );
      expect(err).toBeInstanceOf(FluxpadError);
      expect((err as FluxpadError).code).toBe("TX_TOO_LARGE");
      expect((err as FluxpadError).message).toContain("Pump.fun launch");
      expect((err as FluxpadError).message).toContain("1232");
    }
  });

  it("rejects an oversized v0 transaction with TX_TOO_LARGE", () => {
    const err = catchGuard(() => assertTransactionFits(v0Tx(2000), "LaunchLab launch"));
    expect(err).toBeInstanceOf(FluxpadError);
    expect((err as FluxpadError).code).toBe("TX_TOO_LARGE");
    expect((err as FluxpadError).message).toContain("LaunchLab launch");
  });
});

describe("size-error classification and mapping (P0.3)", () => {
  it("classifies every observed web3.js size-error shape", () => {
    expect(isTransactionTooLargeError(new Error("Transaction too large: 1243 > 1232"))).toBe(true);
    expect(isTransactionTooLargeError(new Error("encoding overruns Uint8Array"))).toBe(true);
    expect(
      isTransactionTooLargeError(
        new Error('The value of "offset" is out of range. It must be >= 0 and <= 1231. Received 1232'),
      ),
    ).toBe(true);
    expect(isTransactionTooLargeError(new Error("Signature verification failed."))).toBe(false);
    expect(isTransactionTooLargeError(new Error("unknown signer: X"))).toBe(false);
  });

  it("maps raw web3.js size errors to TX_TOO_LARGE", () => {
    expect(toFluxpadError(new Error("Transaction too large: 1243 > 1232")).code).toBe(
      "TX_TOO_LARGE",
    );
    expect(toFluxpadError(new Error("encoding overruns Uint8Array")).code).toBe("TX_TOO_LARGE");
    expect(toFluxpadError(new Error("some other failure")).code).toBe("UNKNOWN");
  });

  it("passes coded FluxpadError instances through unchanged", () => {
    const coded = new FluxpadError("TX_TOO_LARGE", "canned message");
    expect(toFluxpadError(coded)).toBe(coded);
  });
});
