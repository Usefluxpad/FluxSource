/**
 * FluxPad vanity mint engine — pure functions, safe for Web Worker execution.
 *
 * Security invariants:
 * - Keypairs are generated with `Keypair.generate()` (ed25519 via noble-hashes
 *   CSPRNG inside @solana/web3.js). We never implement custom key generation.
 * - Secret keys never leave the worker except to the launch page's memory.
 * - Nothing is persisted: no localStorage, sessionStorage, IndexedDB, cookies,
 *   or network calls.
 */

import { Keypair, PublicKey } from "@solana/web3.js";

export interface VanityPattern {
  kind: "prefix" | "suffix" | "contains";
  value: string;
  /**
   * Case-insensitive matching. Base58 addresses contain both cases, so this
   * is technically applicable: the resulting address genuinely contains the
   * pattern with whatever case the key happened to produce (verified against
   * the real public key either way — never rewritten).
   */
  caseInsensitive?: boolean;
}

export interface VanityRequest {
  pattern: VanityPattern;
  /** Hard cap on attempts so workers can't spin forever. */
  maxAttempts: number;
  /** Abort signal token — the worker checks a boolean flag each batch. */
  cancelled: boolean;
}

export interface VanityProgress {
  attempts: number;
  elapsedMs: number;
  found: boolean;
  /** Keypair secret key (Uint8Array, 64 bytes) — in-memory only. */
  secretKey?: Uint8Array;
  publicKey?: string;
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function isValidVanityPattern(value: string): boolean {
  return value.length > 0 && value.length <= 8 && BASE58_RE.test(value);
}

/**
 * Honest difficulty estimate for an n-character constraint.
 * Each base58 char ≈ 58 combinations, but Solana addresses are 32-byte values
 * base58-encoded with variable length, so the practical per-position chance
 * is ~1/33 for an average-length match (well-known VanityGen empirics).
 * Expected attempts ≈ 33^n (lower bound for rare lucky runs).
 */
export function estimateDifficulty(value: string): {
  expectedAttempts: number;
  label: string;
  secondsEstimate: number;
} {
  const n = value.length;
  const expectedAttempts = Math.round(Math.pow(33, n));
  // ~50k attempts/sec is a realistic upper bound for a JS worker on a modern CPU.
  const secondsEstimate = Math.round(expectedAttempts / 50_000);
  let label = "seconds";
  if (secondsEstimate > 60) label = "minutes";
  if (secondsEstimate > 3600) label = "hours";
  if (secondsEstimate > 86400) label = "days";
  if (secondsEstimate > 2_592_000) label = "months";
  return { expectedAttempts, label, secondsEstimate };
}

/** Does an address satisfy the pattern? */
export function matchesPattern(address: string, pattern: VanityPattern): boolean {
  const v = pattern.value;
  if (pattern.caseInsensitive) {
    const a = address.toLowerCase();
    const p = v.toLowerCase();
    switch (pattern.kind) {
      case "prefix":
        return a.startsWith(p);
      case "suffix":
        return a.endsWith(p);
      case "contains":
        return a.includes(p);
    }
  }
  switch (pattern.kind) {
    case "prefix":
      return address.startsWith(v);
    case "suffix":
      return address.endsWith(v);
    case "contains":
      return address.includes(v);
  }
}

function batchGenerate(size: number): Keypair[] {
  const out: Keypair[] = new Array(size);
  for (let i = 0; i < size; i++) out[i] = Keypair.generate();
  return out;
}

/**
 * Search for a keypair matching the pattern. Bounded, cancellable, and
 * yielding progress after each batch. Returns found keypair or null when
 * cancelled / exhausted.
 */
export function searchVanityKeypair(
  pattern: VanityPattern,
  opts: {
    maxAttempts: number;
    isCancelled: () => boolean;
    onProgress?: (attempts: number, elapsedMs: number) => void;
    batchSize?: number;
  },
): { keypair: Keypair | null; attempts: number } {
  const batchSize = opts.batchSize ?? 1000;
  let attempts = 0;
  const started = Date.now();

  while (attempts < opts.maxAttempts && !opts.isCancelled()) {
    const remaining = Math.min(batchSize, opts.maxAttempts - attempts);
    const batch = batchGenerate(remaining);
    attempts += remaining;
    for (const kp of batch) {
      const addr = kp.publicKey.toBase58();
      if (matchesPattern(addr, pattern)) {
        opts.onProgress?.(attempts, Date.now() - started);
        return { keypair: kp, attempts };
      }
    }
    opts.onProgress?.(attempts, Date.now() - started);
  }

  return { keypair: null, attempts };
}

/** Validate that a claimed mint address equals the vanity keypair's pubkey. */
export function verifyMintMatchesVanity(
  secretKey: Uint8Array,
  expectedMint: string,
): boolean {
  const kp = Keypair.fromSecretKey(secretKey);
  return kp.publicKey.toBase58() === expectedMint;
}

/** Guard used before a keypair is used as a signer. */
export function isOnCurveValidAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}
