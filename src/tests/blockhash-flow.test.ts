import { describe, expect, it } from "vitest";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
// web3.js's own ed25519 implementation (nested under its node_modules) — used
// only to prove that signatures bind the blockhash in tests.
import { ed25519 } from "../../node_modules/@solana/web3.js/node_modules/@noble/curves/ed25519.js";
import { ensureMintSignature } from "@/lib/adapters/launchlab";

/**
 * LaunchLab-shaped V0 transaction: the mint keypair is a required signer
 * (LaunchLab's createLaunchpad requires the mint to sign) and the wallet is
 * the fee payer. The mint signs locally at prepare time; the wallet signs
 * later in its popup.
 */
function makeV0Tx() {
  const payer = Keypair.generate();
  const mint = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: mint.publicKey, // mint = required signer (LaunchLab shape)
        toPubkey: payer.publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message();
  return { tx: new VersionedTransaction(message), payer, mint };
}

const mintIndex = (tx: VersionedTransaction, mint: Keypair) =>
  tx.message.staticAccountKeys.findIndex((k) => k.equals(mint.publicKey));
const hex = (u8: Uint8Array) => Buffer.from(u8).toString("hex");

describe("ensureMintSignature (LaunchLab mint-keypair signature preservation)", () => {
  it("fills the mint's empty signature slot", () => {
    const { tx, mint } = makeV0Tx();
    const idx = mintIndex(tx, mint);
    expect(idx).toBeGreaterThan(-1);
    expect(tx.signatures[idx].every((b) => b === 0)).toBe(true);
    ensureMintSignature(tx, mint);
    expect(tx.signatures[idx].some((b) => b !== 0)).toBe(true);
  });

  it("is idempotent: an already-signed mint slot is left untouched", () => {
    const { tx, mint } = makeV0Tx();
    ensureMintSignature(tx, mint);
    const before = hex(tx.signatures[mintIndex(tx, mint)]);
    ensureMintSignature(tx, mint);
    expect(hex(tx.signatures[mintIndex(tx, mint)])).toBe(before);
  });

  it("the wallet's later signature (addSignature) never disturbs the mint signature", () => {
    const { tx, mint, payer } = makeV0Tx();
    ensureMintSignature(tx, mint);
    const idx = mintIndex(tx, mint);
    const mintSigBefore = hex(tx.signatures[idx]);
    // Wallet approval path: the wallet adapter signs the message bytes and
    // merges its signature into its own slot only.
    tx.addSignature(payer.publicKey, new Uint8Array(64).fill(7));
    expect(hex(tx.signatures[idx])).toBe(mintSigBefore);
    expect(tx.signatures).toHaveLength(tx.message.header.numRequiredSignatures);
  });

  it("signatures bind the blockhash: mutating a signed message invalidates them — rebuilds must re-sign", () => {
    const { tx, mint } = makeV0Tx();
    ensureMintSignature(tx, mint); // the mint signs the CURRENT message bytes
    const msgBefore = tx.message.serialize();
    const sig = tx.signatures[mintIndex(tx, mint)];
    expect(ed25519.verify(sig, msgBefore, mint.publicKey.toBytes())).toBe(true);
    // Replacing the blockhash — the essence of a blockhash refresh — changes
    // the signed message bytes, so every previously-produced signature is
    // invalid against the new message. This is why FluxPad's rebuild flow
    // rebuilds and re-signs (mint locally, wallet via a fresh approval)
    // instead of mutating a signed transaction.
    tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    const msgAfter = tx.message.serialize();
    expect(hex(msgAfter)).not.toBe(hex(msgBefore));
    expect(ed25519.verify(sig, msgAfter, mint.publicKey.toBytes())).toBe(false);
  });
});
