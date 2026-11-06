/// <reference lib="webworker" />
/**
 * FluxPad vanity mint Web Worker.
 *
 * Runs the bounded search loop off the main thread. Receives a pattern,
 * streams progress back, and transfers the found secret key once. The secret
 * key exists only in this worker's memory and the receiving page's memory.
 * It is never sent to any server, never logged, and never persisted.
 */
import { searchVanityKeypair, type VanityPattern } from "../lib/vanity/vanity-core";

export type WorkerRequest =
  | { type: "start"; pattern: VanityPattern; maxAttempts: number; token: number }
  | { type: "cancel" };

export type WorkerResponse =
  | { type: "progress"; token: number; attempts: number; elapsedMs: number }
  | { type: "found"; token: number; attempts: number; elapsedMs: number; secretKey: Uint8Array; publicKey: string }
  | { type: "exhausted"; token: number; attempts: number }
  | { type: "cancelled"; token: number; attempts: number };

let cancelled = false;

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === "cancel") {
    cancelled = true;
    return;
  }
  if (msg.type === "start") {
    cancelled = false;
    const { pattern, maxAttempts, token } = msg;

    const result = searchVanityKeypair(pattern, {
      maxAttempts,
      isCancelled: () => cancelled,
      onProgress: (attempts, elapsedMs) => {
        const res: WorkerResponse = { type: "progress", token, attempts, elapsedMs };
        (self as unknown as Worker).postMessage(res);
      },
      batchSize: 500,
    });

    if (cancelled) {
      const res: WorkerResponse = { type: "cancelled", token, attempts: result.attempts };
      (self as unknown as Worker).postMessage(res);
      return;
    }
    if (result.keypair) {
      const res: WorkerResponse = {
        type: "found",
        token,
        attempts: result.attempts,
        elapsedMs: 0,
        secretKey: result.keypair.secretKey,
        publicKey: result.keypair.publicKey.toBase58(),
      };
      (self as unknown as Worker).postMessage(res, [
        // transfer the buffer — the worker loses its copy immediately
        result.keypair.secretKey.buffer,
      ]);
      return;
    }
    const res: WorkerResponse = { type: "exhausted", token, attempts: result.attempts };
    (self as unknown as Worker).postMessage(res);
  }
};
