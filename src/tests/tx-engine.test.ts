import { describe, expect, it, vi } from "vitest";
import { FluxpadError, toFluxpadError } from "@/lib/connection";
import {
  getFreshBlockhash,
  isBlockhashUsable,
  makeBlockhashAwareBuildTx,
  submitAndConfirm,
  type WalletSigner,
} from "@/lib/tx-engine";
import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";

/** Minimal Connection stub covering the paths submitAndConfirm touches. */
function makeConnectionStub(opts: {
  sendError?: Error;
  /** Send results in order (last repeats); Error entries throw. */
  sendQueue?: (string | Error)[];
  /** Status results returned per poll (null = not yet seen); last repeats. */
  pollQueue?: ({ err: unknown; slot?: number; confirmationStatus?: string } | null)[];
  /** Make every getSignatureStatuses call throw (RPC outage). */
  pollThrows?: Error | true;
  /** Result of the final historical search (after the window closes). */
  historical?: { err: unknown; slot?: number; confirmationStatus?: string } | null;
  latestBlockhash?: { lastValidBlockHeight: number };
  blockHeight?: number;
  /** getFeeForMessage blockhash probe: default = valid blockhash. */
  feeProbe?: "valid" | "expired" | "notFound" | "rpcError";
  /** Post-sign simulation results in order (last repeats). */
  simulateQueue?: ({ err: unknown; logs?: string[] } | null)[];
}) {
  let pollIndex = 0;
  let sendIndex = 0;
  let simIndex = 0;
  return {
    simulateTransaction: vi.fn(async () => {
      const q = opts.simulateQueue ?? [{ err: null, logs: [] }];
      const item = simIndex < q.length ? q[simIndex] : (q[q.length - 1] ?? null);
      simIndex += 1;
      return { value: item ?? { err: null, logs: [] } };
    }),
    sendRawTransaction: vi.fn(async () => {
      if (opts.sendQueue?.length) {
        const item =
          sendIndex < opts.sendQueue.length
            ? opts.sendQueue[sendIndex]
            : opts.sendQueue[opts.sendQueue.length - 1];
        sendIndex += 1;
        if (item instanceof Error) throw item;
        return item;
      }
      if (opts.sendError) throw opts.sendError;
      return "sig123";
    }),
    getFeeForMessage: vi.fn(async () => {
      if (opts.feeProbe === "expired") return { value: null };
      if (opts.feeProbe === "notFound") throw new Error("BlockhashNotFound");
      if (opts.feeProbe === "rpcError") throw new Error("connection interrupted");
      return { value: { feeCalculator: { lamportsPerSignature: 5000 } } };
    }),
    getSignatureStatuses: vi.fn(async (...args: unknown[]) => {
      const isHistorical = !!(
        args[1] as { searchTransactionHistory?: boolean } | undefined
      )?.searchTransactionHistory;
      // Final resolution pass reads the historical fixture.
      if (isHistorical) return { value: [opts.historical ?? null] };
      if (opts.pollThrows) {
        throw opts.pollThrows === true
          ? new Error("connection interrupted")
          : opts.pollThrows;
      }
      const q = opts.pollQueue ?? [{ err: null, slot: 1, confirmationStatus: "confirmed" }];
      const item = pollIndex < q.length ? q[pollIndex] : (q[q.length - 1] ?? null);
      pollIndex += 1;
      return { value: [item] };
    }),
    getLatestBlockhash: vi.fn(
      async () => opts.latestBlockhash ?? { lastValidBlockHeight: 1_000_000 },
    ),
    getBlockHeight: vi.fn(async () => opts.blockHeight ?? 0),
    // Legacy WS-based surface — must never be used by the HTTP-only strategy.
    confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
    getSignatureStatus: vi.fn(async () => ({ value: { err: null, slot: 1 } })),
  } as never;
}

function walletSigner(): WalletSigner {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx) => {
      if (tx instanceof Transaction) {
        tx.feePayer = kp.publicKey;
        if (!tx.recentBlockhash) tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
        tx.sign(kp);
      } else if (tx instanceof VersionedTransaction) {
        tx.sign([kp]);
      }
      return tx;
    },
  };
}

const buildTx = async () => {
  const tx = new Transaction();
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.feePayer = Keypair.generate().publicKey;
  return tx;
};

describe("wallet rejection mapping", () => {
  it("maps user rejection to WALLET_REJECTED", () => {
    const mapped = toFluxpadError(new Error("User rejected the request."));
    expect(mapped.code).toBe("WALLET_REJECTED");
  });
});

describe("submitAndConfirm", () => {
  it("returns the signature and slot on success", async () => {
    const conn = makeConnectionStub({});
    const res = await submitAndConfirm(conn, buildTx, walletSigner());
    expect(res.signature).toBe("sig123");
    expect(res.slot).toBe(1);
  });

  it("throws INSUFFICIENT_FUNDS on on-chain failure", async () => {
    const conn = makeConnectionStub({
      pollQueue: [{ err: { InsufficientFundsForFee: {} } }],
    });
    await expect(submitAndConfirm(conn, buildTx, walletSigner())).rejects.toMatchObject({
      code: "INSUFFICIENT_FUNDS",
    });
  });

  it("retries on stale blockhash and resolves the landed signature", async () => {
    let calls = 0;
    const conn = makeConnectionStub({ sendError: new Error("Block height exceeded") });
    // First attempt fails transport; second attempt succeeds.
    (conn as unknown as { sendRawTransaction: ReturnType<typeof vi.fn> })
      .sendRawTransaction.mockImplementation(async () => {
        calls += 1;
        if (calls === 1) throw new Error("Block height exceeded");
        return "sig-landed";
      });
    const res = await submitAndConfirm(conn, buildTx, walletSigner(), { maxAttempts: 2 });
    expect(res.signature).toBe("sig-landed");
  });

  it("reports a typed error after exhausting send attempts (nothing accepted)", async () => {
    const conn = makeConnectionStub({
      sendError: new Error("Blockhash not found"),
    });
    // Nothing was ever accepted by the RPC, so the failure is unambiguous:
    // a stale-blockhash send error, not an unresolved submission.
    await expect(
      submitAndConfirm(conn, buildTx, walletSigner(), { maxAttempts: 2 }),
    ).rejects.toMatchObject({ code: "STALE_BLOCKHASH" });
  });
});

describe("getFreshBlockhash", () => {
  it("throws typed RPC errors on outage", async () => {
    const conn = {
      getLatestBlockhash: async () => {
        throw new Error("429 Too Many Requests");
      },
    } as never;
    await expect(getFreshBlockhash(conn)).rejects.toMatchObject({ code: "RPC_ERROR" });
  });
});

describe("FluxpadError taxonomy", () => {
  it("preserves codes", () => {
    expect(new FluxpadError("PROTOCOL", "x").code).toBe("PROTOCOL");
  });
});

describe("submitAndConfirm confirmation strategy", () => {
  /** Tiny window/interval so timeout paths resolve fast in tests. */
  const tiny = { confirmWindowMs: 120, pollIntervalMs: 10 };

  const mocks = (conn: unknown) => conn as unknown as Record<string, ReturnType<typeof vi.fn>>;

  it("resolves a transaction confirmed within the initial polling window", async () => {
    const conn = makeConnectionStub({});
    const res = await submitAndConfirm(conn, buildTx, walletSigner(), tiny);
    expect(res.signature).toBe("sig123");
    expect(res.slot).toBe(1);
  });

  it("never uses WebSocket-based confirmTransaction (HTTP-only polling)", async () => {
    const conn = makeConnectionStub({});
    await submitAndConfirm(conn, buildTx, walletSigner(), tiny);
    expect(mocks(conn).confirmTransaction).not.toHaveBeenCalled();
    expect(mocks(conn).getSignatureStatuses).toHaveBeenCalled();
  });

  it("preserves the original blockhash and last-valid-block-height context", async () => {
    const conn = makeConnectionStub({ latestBlockhash: { lastValidBlockHeight: 555 } });
    const res = await submitAndConfirm(conn, buildTx, walletSigner(), tiny);
    expect(res.blockhash).toBeTruthy();
    expect(res.lastValidBlockHeight).toBe(555);
  });

  it("resolves a transaction that confirms only after the polling window", async () => {
    const conn = makeConnectionStub({
      pollQueue: [null, null],
      historical: { err: null, slot: 42, confirmationStatus: "confirmed" },
    });
    const res = await submitAndConfirm(conn, buildTx, walletSigner(), tiny);
    expect(res.signature).toBe("sig123");
    expect(res.slot).toBe(42);
    expect(mocks(conn).sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("classifies an on-chain failure discovered after the window", async () => {
    const conn = makeConnectionStub({
      pollQueue: [null],
      historical: { err: { Custom: 6001 }, slot: 9 },
    });
    await expect(
      submitAndConfirm(conn, buildTx, walletSigner(), tiny),
    ).rejects.toMatchObject({ code: "SIMULATION_FAILED" });
  });

  it("classifies an on-chain failure observed while polling", async () => {
    const conn = makeConnectionStub({
      pollQueue: [{ err: { InstructionError: [1, "Custom"] }, slot: 3 }],
    });
    await expect(
      submitAndConfirm(conn, buildTx, walletSigner(), tiny),
    ).rejects.toMatchObject({ code: "SIMULATION_FAILED" });
  });

  it("tolerates RPC failures while polling and still resolves via history", async () => {
    const conn = makeConnectionStub({
      pollThrows: true,
      historical: { err: null, slot: 7, confirmationStatus: "confirmed" },
    });
    const res = await submitAndConfirm(conn, buildTx, walletSigner(), tiny);
    expect(res.slot).toBe(7);
    expect(mocks(conn).sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("reports UNRESOLVED with the signature when the result stays unknown", async () => {
    const conn = makeConnectionStub({ pollQueue: [null], historical: null });
    let caught: FluxpadError | null = null;
    try {
      await submitAndConfirm(conn, buildTx, walletSigner(), tiny);
    } catch (err) {
      caught = err as FluxpadError;
    }
    expect(caught?.code).toBe("UNRESOLVED");
    expect(caught?.signature).toBe("sig123");
    expect(caught?.message).toContain("sig123");
    expect(caught?.message).toContain("Do NOT launch again");
    // Timeout must never trigger a duplicate submission.
    expect(mocks(conn).sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mocks(conn).confirmTransaction).not.toHaveBeenCalled();
  });

  it("closes the polling window early once the blockhash has expired", async () => {
    const conn = makeConnectionStub({
      pollQueue: [null],
      latestBlockhash: { lastValidBlockHeight: 1_000 },
      blockHeight: 2_000, // > lastValid + 25 → window closed on the first poll
      historical: { err: null, slot: 11, confirmationStatus: "finalized" },
    });
    const res = await submitAndConfirm(conn, buildTx, walletSigner(), tiny);
    expect(res.slot).toBe(11);
    expect(mocks(conn).sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("maps the web3.js confirmation-timeout message to UNRESOLVED", () => {
    const mapped = toFluxpadError(
      new Error(
        "Transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded or failed. Check signature abc using the Solana Explorer or CLI tools.",
      ),
    );
    expect(mapped.code).toBe("UNRESOLVED");
  });
});

describe("blockhash freshness + rebuild-and-resign (LaunchLab CPMM fix)", () => {
  const tiny = { confirmWindowMs: 120, pollIntervalMs: 10 };
  const mocks = (conn: unknown) => conn as unknown as Record<string, ReturnType<typeof vi.fn>>;
  const legacyTx = () => {
    const tx = new Transaction();
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.feePayer = Keypair.generate().publicKey;
    return tx;
  };

  it("isBlockhashUsable: valid blockhash → true", async () => {
    const conn = makeConnectionStub({});
    expect(await isBlockhashUsable(conn, legacyTx())).toBe(true);
  });

  it("isBlockhashUsable: expired blockhash (null fee) → false", async () => {
    const conn = makeConnectionStub({ feeProbe: "expired" });
    expect(await isBlockhashUsable(conn, legacyTx())).toBe(false);
  });

  it("isBlockhashUsable: BlockhashNotFound probe → false", async () => {
    const conn = makeConnectionStub({ feeProbe: "notFound" });
    expect(await isBlockhashUsable(conn, legacyTx())).toBe(false);
  });

  it("isBlockhashUsable: transient RPC failure fails open → true", async () => {
    const conn = makeConnectionStub({ feeProbe: "rpcError" });
    expect(await isBlockhashUsable(conn, legacyTx())).toBe(true);
  });

  it("makeBlockhashAwareBuildTx: fresh blockhash returns the prebuilt tx without rebuilding", async () => {
    const conn = makeConnectionStub({});
    const prebuilt = await buildTx();
    const fresh = await buildTx();
    let rebuildCalls = 0;
    const build = makeBlockhashAwareBuildTx({
      connection: conn,
      getTx: () => prebuilt,
      rebuild: async () => {
        rebuildCalls += 1;
        return fresh;
      },
    });
    expect(await build()).toBe(prebuilt);
    expect(rebuildCalls).toBe(0);
  });

  it("makeBlockhashAwareBuildTx: expired blockhash triggers the rebuild (NEW object, hooks fired)", async () => {
    const conn = makeConnectionStub({ feeProbe: "expired" });
    const prebuilt = await buildTx();
    const fresh = await buildTx();
    let rebuildCalls = 0;
    let started = 0;
    let done = 0;
    const build = makeBlockhashAwareBuildTx({
      connection: conn,
      getTx: () => prebuilt,
      rebuild: async () => {
        rebuildCalls += 1;
        return fresh;
      },
      onRebuildStart: () => {
        started += 1;
      },
      onRebuildDone: () => {
        done += 1;
      },
    });
    const out = await build();
    expect(out).toBe(fresh);
    expect(out).not.toBe(prebuilt);
    expect(rebuildCalls).toBe(1);
    expect(started).toBe(1);
    expect(done).toBe(1);
  });

  it("makeBlockhashAwareBuildTx: no rebuild capability → coded BLOCKHASH_EXPIRED", async () => {
    const conn = makeConnectionStub({ feeProbe: "expired" });
    const build = makeBlockhashAwareBuildTx({
      connection: conn,
      getTx: () => legacyTx(),
    });
    await expect(build()).rejects.toMatchObject({ code: "BLOCKHASH_EXPIRED" });
  });

  it("makeBlockhashAwareBuildTx: probe outage fails open (prebuilt used, no rebuild)", async () => {
    const conn = makeConnectionStub({ feeProbe: "rpcError" });
    const prebuilt = await buildTx();
    let rebuildCalls = 0;
    const build = makeBlockhashAwareBuildTx({
      connection: conn,
      getTx: () => prebuilt,
      rebuild: async () => {
        rebuildCalls += 1;
        return prebuilt;
      },
    });
    expect(await build()).toBe(prebuilt);
    expect(rebuildCalls).toBe(0);
  });

  it("submitAndConfirm: heals an expired blockhash BEFORE wallet signing (rebuild → one submission)", async () => {
    const conn = makeConnectionStub({ feeProbe: "expired" });
    const stale = await buildTx();
    const fresh = await buildTx();
    const build = makeBlockhashAwareBuildTx({
      connection: conn,
      getTx: () => stale,
      rebuild: async () => fresh,
    });
    const res = await submitAndConfirm(conn, build, walletSigner(), tiny);
    expect(res.signature).toBe("sig123");
    expect(mocks(conn).sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mocks(conn).getFeeForMessage).toHaveBeenCalled();
  });

  it("submitAndConfirm: retries via rebuild after a post-sign BlockhashNotFound simulation (nothing was submitted)", async () => {
    const conn = makeConnectionStub({
      simulateQueue: [{ err: "BlockhashNotFound" }, { err: null }],
    });
    const builds = [await buildTx(), await buildTx()];
    let buildCount = 0;
    const res = await submitAndConfirm(
      conn,
      async () => builds[Math.min(buildCount++, builds.length - 1)],
      walletSigner(),
      { ...tiny, maxAttempts: 2 },
    );
    expect(res.signature).toBe("sig123");
    // The first attempt was never submitted — only the rebuilt one was sent.
    expect(mocks(conn).sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(buildCount).toBe(2);
  });

  it("submitAndConfirm: send-rejected BlockhashNotFound retries with a fresh submission", async () => {
    const conn = makeConnectionStub({
      sendQueue: [new Error("BlockhashNotFound"), "sig-fresh"],
    });
    const res = await submitAndConfirm(conn, buildTx, walletSigner(), {
      ...tiny,
      maxAttempts: 2,
    });
    expect(res.signature).toBe("sig-fresh");
    expect(mocks(conn).sendRawTransaction).toHaveBeenCalledTimes(2);
  });

  it("submitAndConfirm: exhausted blockhash expiry surfaces the honest BLOCKHASH_EXPIRED code", async () => {
    const conn = makeConnectionStub({
      simulateQueue: [{ err: "BlockhashNotFound" }],
    });
    await expect(
      submitAndConfirm(conn, buildTx, walletSigner(), { ...tiny, maxAttempts: 2 }),
    ).rejects.toMatchObject({ code: "BLOCKHASH_EXPIRED" });
    expect(mocks(conn).sendRawTransaction).not.toHaveBeenCalled();
  });

  it("maps transaction-level BlockhashNotFound to BLOCKHASH_EXPIRED (not SIMULATION_FAILED)", () => {
    expect(toFluxpadError(new Error("BlockhashNotFound")).code).toBe("BLOCKHASH_EXPIRED");
  });
});
