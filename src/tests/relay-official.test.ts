import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  classifyTransaction,
  isConfirmed,
  tokenDeltaByMint,
  solDeltaForIndex,
  findFeePayerIndex,
  detectSwapProgram,
  type ActivityRecord,
  type ActivityType,
  type ClassifiedTransaction,
  type ParsedInstruction,
  type TokenBalance,
} from "@/lib/relay-official/classify";
import {
  MemoryRelayOfficialStore,
  type ActivityFilter,
} from "@/lib/relay-official/store";
import { indexTreasuryActivity, type IndexerConnection } from "@/lib/relay-official/indexer";
import { buildTreasurySummary, type BalanceConnection } from "@/lib/relay-official/summary";
import { getRelayOfficialConfig } from "@/lib/relay-official/config";
import { publicApiGuard, resetPublicApiLimiter, ipOf } from "@/lib/relay-official/api-guard";
import { publicErrorReason, logSafeDetail, publicInvalidRoles } from "@/lib/relay-official/sanitize";
import { shouldRunRefresh, REFRESH_MIN_INTERVAL_MS } from "@/lib/relay-official/refresh-gate";

/* ---------------------------------------------------------------- fixtures */

// Deterministic throwaway fixture addresses (pure base58 encodings of fixed
// 32-byte patterns — generated for tests only, not real wallets or keys).
const W1 = "52Y2w7NXvFk4zUsVGXaq3ai8xBVNV8FX7aME2Vpz2tH";
const W2 = "91PyJwjNrfqTK1JP7yAiJXjBH69A5MB3UCiJMuc35FU";
const OTHER = "7g1brfz5spz8VgShvSMsfkzn3at81MBpspR7nY7Bp5LT";
const W2_ATA = "Qoi8fYUFL6UW8ZB3RVzQJYjR8ijzYGaexp1GEGnqFbx";
const OTHER_ATA = "Una53Nq6GWZtT5L8fjNyx4wxY2go2MX4TouuxeNuFRR";
const RELAY_MINT = "Re1ayMintAddressAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_MINT = "0therMintAddressAAAAAAAAAAAAAAAAAAAAAAAAA0";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const CONFIG = getRelayOfficialConfig({
  RELAY_OFFICIAL_CREATOR_WALLET: W1,
  RELAY_OFFICIAL_BUYBACK_TREASURY: W2,
  RELAY_OFFICIAL_ENABLED: "true",
});
const ROLES = new Map([
  [W1, "W1"],
  [W2, "W2"],
]);

function tb(
  accountIndex: number,
  mint: string,
  owner: string,
  amount: string,
  decimals: number,
): TokenBalance {
  return { accountIndex, mint, owner, uiTokenAmount: { amount, decimals } };
}

function parsedIx(
  programId: string,
  program: string,
  type: string,
  info: Record<string, unknown>,
): ParsedInstruction {
  return { programId, program, parsed: { type, info } };
}

function baseTx(
  instructions: ParsedInstruction[],
  meta?: Partial<ClassifiedTransaction["meta"]>,
  accountKeys: (string | { pubkey: string; signer?: boolean; writable?: boolean })[] = [
    { pubkey: W1, signer: true, writable: true }, // index 0: fee payer
    W2, // index 1
  ],
): ClassifiedTransaction {
  return {
    slot: 123,
    blockTime: 1_700_000_000,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1_000_000, 2_000_000],
      postBalances: [1_000_000, 2_000_000],
      ...meta,
    },
    transaction: { message: { accountKeys, instructions } },
  };
}

const classifyOpts = (signature: string) => ({
  signature,
  network: "mainnet-beta",
  roleByAddress: ROLES,
});

/* ------------------------------------------------- confirmed vs failed txs */

describe("classifyTransaction — confirmed and failed transactions", () => {
  it("marks a transaction whose result contains an error as failed", () => {
    const tx = baseTx([], {
      err: { InsufficientFunds: {} },
      fee: 5000,
      logMessages: ["Program log: Instruction: CollectCreatorFee"],
      preBalances: [0, 0],
      postBalances: [0, 0],
    });
    expect(isConfirmed(tx)).toBe(false);
    const records = classifyTransaction(tx, classifyOpts("sig_failed"));
    expect(records.every((r) => r.status === "failed")).toBe(true);
  });

  it("marks a successful transaction as confirmed", () => {
    expect(isConfirmed(baseTx([]))).toBe(true);
  });
});

/* ------------------------------------------------------- burn verification */

describe("classifyTransaction — burn verification (real parser shapes)", () => {
  it("classifies a real burnChecked instruction (tokenAmount, no top-level amount)", () => {
    const tx = baseTx(
      [
        parsedIx(TOKEN_PROGRAM, "spl-token", "burnChecked", {
          account: W2_ATA,
          mint: RELAY_MINT,
          tokenAmount: { uiAmount: 1, amount: "1000000", decimals: 6 },
          authority: W2,
        }),
      ],
      {
        preTokenBalances: [tb(2, RELAY_MINT, W2, "5000000", 6)],
        postTokenBalances: [tb(2, RELAY_MINT, W2, "4000000", 6)],
      },
      [W1, W2, W2_ATA],
    );
    const [record] = classifyTransaction(tx, classifyOpts("sig_burn"));
    expect(record.type).toBe("burn");
    expect(record.burnVerified).toBe(true);
    expect(record.burnMint).toBe(RELAY_MINT);
    expect(record.inputAmount).toBe("1000000");
    expect(record.inputDecimals).toBe(6);
    // Attribution resolves the token account's OWNER, not the ATA address.
    expect(record.sender).toBe(W2);
    expect(record.walletRole).toBe("W2");
    expect(record.recipient).toBeNull();
  });

  it("classifies a legacy burn and derives mint/decimals from token balances", () => {
    // Real parsed shape: legacy burn has NO mint in info.
    const tx = baseTx(
      [
        parsedIx(TOKEN_PROGRAM, "spl-token", "burn", {
          account: W2_ATA,
          amount: "500000",
          authority: W2,
        }),
      ],
      {
        preTokenBalances: [tb(2, RELAY_MINT, W2, "1500000", 6)],
        postTokenBalances: [tb(2, RELAY_MINT, W2, "1000000", 6)],
      },
      [W1, W2, W2_ATA],
    );
    const [record] = classifyTransaction(tx, classifyOpts("sig_burn_legacy"));
    expect(record.type).toBe("burn");
    expect(record.burnVerified).toBe(true);
    expect(record.burnMint).toBe(RELAY_MINT); // derived, not guessed
    expect(record.inputAmount).toBe("500000");
    expect(record.inputDecimals).toBe(6);
    expect(record.sender).toBe(W2);
    expect(record.walletRole).toBe("W2");
  });

  it("never classifies a token transfer to an address as a burn", () => {
    const tx = baseTx(
      [
        parsedIx(TOKEN_PROGRAM, "spl-token", "transferChecked", {
          source: W2_ATA,
          destination: OTHER_ATA,
          mint: RELAY_MINT,
          tokenAmount: { uiAmount: 0.5, amount: "500000", decimals: 6 },
          authority: W2,
        }),
      ],
      {
        preTokenBalances: [
          tb(2, RELAY_MINT, W2, "1000000", 6),
          tb(3, RELAY_MINT, OTHER, "0", 6),
        ],
        postTokenBalances: [
          tb(2, RELAY_MINT, W2, "500000", 6),
          tb(3, RELAY_MINT, OTHER, "500000", 6),
        ],
      },
      [W1, W2, W2_ATA, OTHER_ATA],
    );
    const records = classifyTransaction(tx, classifyOpts("sig_notburn"));
    expect(records.map((r) => r.type)).toEqual(["transfer"]);
    expect(records[0].burnVerified).toBe(false);
    // Owners, not token-account addresses.
    expect(records[0].sender).toBe(W2);
    expect(records[0].recipient).toBe(OTHER);
  });

  it("skips burns by unconfigured accounts (involvement gate)", () => {
    const tx = baseTx(
      [
        parsedIx(TOKEN_PROGRAM, "spl-token", "burnChecked", {
          account: OTHER_ATA,
          mint: RELAY_MINT,
          tokenAmount: { uiAmount: 1, amount: "999999", decimals: 6 },
          authority: OTHER,
        }),
      ],
      {
        preTokenBalances: [tb(3, RELAY_MINT, OTHER, "999999", 6)],
        postTokenBalances: [tb(3, RELAY_MINT, OTHER, "0", 6)],
      },
      [W1, W2, OTHER_ATA],
    );
    expect(classifyTransaction(tx, classifyOpts("sig_unrelated_burn"))).toHaveLength(0);
  });

  it("records multiple identical burns with distinct occurrence-indexed keys", () => {
    const ix = () =>
      parsedIx(TOKEN_PROGRAM, "spl-token", "burnChecked", {
        account: W2_ATA,
        mint: RELAY_MINT,
        tokenAmount: { uiAmount: 1, amount: "1000", decimals: 6 },
        authority: W2,
      });
    const balances = {
      preTokenBalances: [tb(2, RELAY_MINT, W2, "3000", 6)],
      postTokenBalances: [tb(2, RELAY_MINT, W2, "1000", 6)],
    };
    const tx = baseTx([ix(), ix()], balances, [W1, W2, W2_ATA]);
    const records = classifyTransaction(tx, classifyOpts("sig_two_burns"));
    expect(records).toHaveLength(2);
    expect(records[0].entryKey).not.toBe(records[1].entryKey);
    expect(records[0].inputAmount).toBe("1000");
    expect(records[1].inputAmount).toBe("1000");
  });

  it("classifies a CPI burn found in inner instructions", () => {
    const tx = baseTx(
      [
        parsedIx(TOKEN_PROGRAM, "spl-token", "transferChecked", {
          source: OTHER_ATA,
          destination: W2_ATA,
          mint: OTHER_MINT,
          tokenAmount: { uiAmount: 0, amount: "0", decimals: 2 },
          authority: OTHER,
        }),
      ],
      {
        innerInstructions: [
          {
            index: 0,
            instructions: [
              parsedIx(TOKEN_PROGRAM, "spl-token", "burnChecked", {
                account: W2_ATA,
                mint: RELAY_MINT,
                tokenAmount: { uiAmount: 2, amount: "2000000", decimals: 6 },
                authority: W2,
              }),
            ],
          },
        ],
        preTokenBalances: [tb(2, RELAY_MINT, W2, "2000000", 6)],
        postTokenBalances: [tb(2, RELAY_MINT, W2, "0", 6)],
      },
      [W1, W2, W2_ATA, OTHER_ATA],
    );
    const burns = classifyTransaction(tx, classifyOpts("sig_cpi_burn")).filter(
      (r) => r.type === "burn",
    );
    expect(burns).toHaveLength(1);
    expect(burns[0].inputAmount).toBe("2000000");
    expect(burns[0].burnMint).toBe(RELAY_MINT);
  });
});

describe("classifyTransaction — swap input/output decoding", () => {
  const swapMeta = {
    err: null,
    fee: 5000,
    preTokenBalances: [
      tb(0, RELAY_MINT, W2, "1000", 6),
      tb(1, WSOL_MINT, W2, "5000000000", 9),
    ],
    postTokenBalances: [
      tb(0, RELAY_MINT, W2, "4000", 6),
      tb(1, WSOL_MINT, W2, "2000000000", 9),
    ],
    logMessages: [
      "Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]",
      "Program log: Instruction: Buy",
    ],
  };

  it("derives verified input/output amounts from pre/post balance deltas", () => {
    const tx = baseTx([], swapMeta);
    const deltas = tokenDeltaByMint(tx, W2);
    expect(deltas.find((d) => d.mint === RELAY_MINT)?.delta).toBe("3000");
    expect(deltas.find((d) => d.mint === WSOL_MINT)?.delta).toBe("-3000000000");

    const [swap] = classifyTransaction(tx, classifyOpts("sig_swap"));
    expect(swap.type).toBe("swap");
    expect(swap.inputAmount).toBe("3000000000");
    expect(swap.inputAsset).toBe(WSOL_MINT);
    expect(swap.outputAmount).toBe("3000");
    expect(swap.outputAsset).toBe(RELAY_MINT);
    expect(swap.walletRole).toBe("W2");
  });

  it("attributes the swap to the executing program from the logs", () => {
    const tx = baseTx([], swapMeta); // logs contain "Program <pAMM> invoke"
    const [swap] = classifyTransaction(tx, classifyOpts("sig_swap_prog"));
    expect(swap.programId).toBe("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
    expect(detectSwapProgram(tx)).toBe("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
    // Bonding-curve invocation (no AMM in the logs) → pump program id.
    const curveTx = baseTx([], { ...swapMeta, logMessages: [
      "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]",
      "Program log: Instruction: Buy",
    ] });
    expect(detectSwapProgram(curveTx)).toBe("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
  });

  it("does not fabricate a swap when balances did not change", () => {
    const flatMeta = {
      err: null,
      fee: 5000,
      preTokenBalances: [
        tb(0, RELAY_MINT, W2, "1000", 6),
        tb(1, WSOL_MINT, W2, "5000000000", 9),
      ],
      postTokenBalances: [
        tb(0, RELAY_MINT, W2, "1000", 6),
        tb(1, WSOL_MINT, W2, "5000000000", 9),
      ],
      logMessages: ["Program log: Instruction: Buy"],
    };
    const records = classifyTransaction(baseTx([], flatMeta), classifyOpts("sig_flat"));
    expect(records).toHaveLength(0);
  });
});

/* -------------------------------------- fee collections and transfers */

describe("classifyTransaction — fee collections and transfers", () => {
  it("records a creator-fee collection using the verified SOL delta", () => {
    const tx = baseTx([], {
      err: null,
      fee: 5000,
      logMessages: ["Program log: Instruction: CollectCreatorFee"],
      preBalances: [1_000_000, 0],
      postBalances: [6_000_000, 0],
    });
    expect(solDeltaForIndex(tx, 0)).toBe(5_000_000n);
    expect(findFeePayerIndex(tx)).toBe(0); // W1 pays the fee (index 0, signer)
    const [fee] = classifyTransaction(tx, classifyOpts("sig_fee"));
    expect(fee.type).toBe("fee_collect");
    expect(fee.walletRole).toBe("W1");
    expect(fee.recipient).toBe(W1);
    // GROSS of the network fee: the payer's balances are net of the fee.
    expect(fee.inputAmount).toBe("5005000");
    expect(fee.inputAsset).toBe("SOL");
    expect(fee.status).toBe("confirmed");
    expect((fee.detail as Record<string, unknown>).feePayerCorrected).toBe(true);
  });

  it("records a treasury system transfer with sender and recipient", () => {
    const tx = baseTx([
      parsedIx("11111111111111111111111111111111", "system", "transfer", {
        source: W1,
        destination: W2,
        lamports: 2_500_000_000,
      }),
    ]);
    const [transfer] = classifyTransaction(tx, classifyOpts("sig_sol_transfer"));
    expect(transfer.type).toBe("transfer");
    expect(transfer.sender).toBe(W1);
    expect(transfer.recipient).toBe(W2);
    expect(transfer.inputAmount).toBe("2500000000");
    expect(transfer.inputAsset).toBe("SOL");
  });

  it("attributes a checked token transfer to the token-account OWNERS", () => {
    const tx = baseTx(
      [
        parsedIx(TOKEN_PROGRAM, "spl-token", "transferChecked", {
          source: W2_ATA,
          destination: OTHER_ATA,
          mint: RELAY_MINT,
          tokenAmount: { uiAmount: 2, amount: "2000000", decimals: 6 },
          authority: W2,
        }),
      ],
      {
        preTokenBalances: [
          tb(2, RELAY_MINT, W2, "3000000", 6),
          tb(3, RELAY_MINT, OTHER, "0", 6),
        ],
        postTokenBalances: [
          tb(2, RELAY_MINT, W2, "1000000", 6),
          tb(3, RELAY_MINT, OTHER, "2000000", 6),
        ],
      },
      [W1, W2, W2_ATA, OTHER_ATA],
    );
    const [transfer] = classifyTransaction(tx, classifyOpts("sig_token_transfer"));
    expect(transfer.type).toBe("transfer");
    expect(transfer.sender).toBe(W2); // owner of the source token account
    expect(transfer.recipient).toBe(OTHER); // owner of the destination
    expect(transfer.inputAmount).toBe("2000000");
    expect(transfer.inputDecimals).toBe(6);
  });

  it("derives mint and decimals for a legacy token transfer from balances", () => {
    const tx = baseTx(
      [
        parsedIx(TOKEN_PROGRAM, "spl-token", "transfer", {
          source: W2_ATA,
          destination: OTHER_ATA,
          amount: "777",
          authority: W2,
        }),
      ],
      {
        preTokenBalances: [
          tb(2, RELAY_MINT, W2, "1000", 6),
          tb(3, RELAY_MINT, OTHER, "0", 6),
        ],
        postTokenBalances: [
          tb(2, RELAY_MINT, W2, "223", 6),
          tb(3, RELAY_MINT, OTHER, "777", 6),
        ],
      },
      [W1, W2, W2_ATA, OTHER_ATA],
    );
    const [transfer] = classifyTransaction(tx, classifyOpts("sig_legacy_transfer"));
    expect(transfer.type).toBe("transfer");
    expect(transfer.inputAsset).toBe(RELAY_MINT); // derived from balances
    expect(transfer.inputDecimals).toBe(6);
    expect(transfer.inputAmount).toBe("777");
    expect(transfer.sender).toBe(W2);
    expect(transfer.recipient).toBe(OTHER);
  });

  it("does not treat a transfer to the system-program zero key as valid", () => {
    const tx = baseTx([
      parsedIx("11111111111111111111111111111111", "system", "transfer", {
        source: W1,
        destination: "11111111111111111111111111111111",
        lamports: 1,
      }),
    ]);
    expect(classifyTransaction(tx, classifyOpts("sig_zero"))).toHaveLength(0);
  });

  it("rejects incorrect (non-numeric) transaction amounts", () => {
    const tx = baseTx([
      parsedIx("11111111111111111111111111111111", "system", "transfer", {
        source: W1,
        destination: W2,
        lamports: "not-a-number",
      }),
    ]);
    expect(classifyTransaction(tx, classifyOpts("sig_badamount"))).toHaveLength(0);
  });
});

/* --------------------------------------------- store: duplicates & filters */

describe("MemoryRelayOfficialStore — duplicates, pagination, filters", () => {
  let store: MemoryRelayOfficialStore;
  beforeEach(() => {
    store = new MemoryRelayOfficialStore();
  });

  const record = (
    signature: string,
    entryKey: string,
    type: string,
    blockTime: number,
    walletRole = "W1",
  ): ActivityRecord => ({
    signature,
    entryKey,
    type: type as ActivityType,
    status: "confirmed",
    slot: 1,
    blockTime: new Date(blockTime * 1000),
    walletRole,
    sender: walletRole === "W1" ? null : W1,
    recipient: W1,
    inputAmount: "100",
    inputAsset: "SOL",
    inputDecimals: 9,
    outputAmount: null,
    outputAsset: null,
    outputDecimals: null,
    burnMint: null,
    burnVerified: false,
    programId: null,
    network: "mainnet-beta",
    detail: null,
  });

  it("upserts idempotently — duplicate (signature, entryKey) is not written twice", async () => {
    const first = await store.upsertActivities([record("sig1", "burn:x", "burn", 1000)]);
    expect(first.written).toBe(1);
    const second = await store.upsertActivities([record("sig1", "burn:x", "burn", 1000)]);
    expect(second.duplicates).toBe(1);
    expect(second.written).toBe(0);
    expect(await store.countActivities({ page: 1, pageSize: 10 } as ActivityFilter)).toBe(1);
  });

  it("paginates and filters by type, role, signature query, and dates", async () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      record(`sig_${i}`, "burn:x", "burn", 1_700_000_000 + i * 1000),
    );
    rows.push(record("sig_transfer_1", "t", "transfer", 1_700_000_500));
    rows.push(record("fee_sig_special", "t", "fee_collect", 1_700_001_000, "W1"));
    await store.upsertActivities(rows);

    expect(await store.listActivities({ page: 1, pageSize: 10 } as ActivityFilter)).toHaveLength(10);
    // 32 rows total → page 3 is still full, page 4 holds the remainder.
    expect(await store.listActivities({ page: 3, pageSize: 10 } as ActivityFilter)).toHaveLength(10);
    expect(
      await store.listActivities({ type: "transfer", page: 1, pageSize: 10 } as ActivityFilter),
    ).toHaveLength(1);
    const byQuery = await store.listActivities({
      signatureQuery: "special",
      page: 1,
      pageSize: 10,
    } as ActivityFilter);
    expect(byQuery).toHaveLength(1);
    expect(byQuery[0].type).toBe("fee_collect");
    const dateFiltered = await store.listActivities({
      // sig_0..sig_4 sit at +0s..+4000s from the base time (1000s apart).
      from: new Date(1_700_000_000 * 1000),
      to: new Date(1_700_004_000 * 1000),
      page: 1,
      pageSize: 100,
    } as ActivityFilter);
    expect(dateFiltered).toHaveLength(7); // sig_0..sig_4 + the transfer (+500s) + the fee (+1000s)
  });

  it("aggregates totals over confirmed rows only", async () => {
    await store.upsertActivities([
      record("a", "t1", "fee_collect", 1000),
      record("b", "t1", "fee_collect", 2000),
      record("c", "t1", "fee_collect", 3000),
    ]);
    await store.upsertActivities([
      { ...record("d", "t1", "fee_collect", 4000), status: "failed" } as ActivityRecord,
    ]);
    const totals = await store.totalsByType("fee_collect");
    expect(totals.count).toBe(3);
    expect(totals.totalInput).toBe("300");
  });
});

/* ------------------------- indexer: RPC failures, dedupe, reconciliation */

function makeConnectionStub(opts: {
  signatures?: { signature: string; err: unknown; slot?: number }[];
  transactions?: Record<string, ClassifiedTransaction | null>;
  signaturesError?: Error;
  statuses?: { value: ({ err: unknown; slot?: number } | null)[] };
}) {
  return {
    getSignaturesForAddress: vi.fn(async () => {
      if (opts.signaturesError) throw opts.signaturesError;
      return opts.signatures ?? [];
    }),
    getParsedTransaction: vi.fn(async (signature: string) => {
      return opts.transactions?.[signature] ?? null;
    }),
    getSignatureStatuses: vi.fn(async () => {
      return opts.statuses ?? { value: [] };
    }),
  } satisfies IndexerConnection;
}

const burnTx = baseTx(
  [
    parsedIx(TOKEN_PROGRAM, "spl-token", "burnChecked", {
      account: W2_ATA,
      mint: RELAY_MINT,
      tokenAmount: { uiAmount: 42, amount: "42", decimals: 0 },
      authority: W2,
    }),
  ],
  {
    preTokenBalances: [tb(2, RELAY_MINT, W2, "100", 0)],
    postTokenBalances: [tb(2, RELAY_MINT, W2, "58", 0)],
  },
  [W1, W2, W2_ATA],
);

describe("indexTreasuryActivity", () => {
  let store: MemoryRelayOfficialStore;
  beforeEach(() => {
    store = new MemoryRelayOfficialStore();
  });

  it("scans configured wallets, classifies, and stores verified activity", async () => {
    const conn = makeConnectionStub({
      signatures: [
        { signature: "sig_a", err: null, slot: 1 },
        { signature: "sig_b", err: { SomeError: {} }, slot: 2 },
      ],
      transactions: { sig_a: burnTx, sig_b: burnTx },
    });
    const result = await indexTreasuryActivity({ connection: conn, store, config: CONFIG });
    expect(result.walletsScanned).toBe(2);
    expect(result.signaturesScanned).toBe(4); // 2 sigs × 2 wallets
    // The burn is attributed to W2 (the token-account owner); W1's scan
    // writes it, W2's scan sees it stored via knownSignatures.
    expect(result.written).toBe(2); // sig_a confirmed burn + sig_b failed burn
    expect(result.errors).toHaveLength(0);
    expect(store.rows.every((r) => r.walletRole === "W2")).toBe(true);
  });

  it("does not duplicate activity on repeated runs", async () => {
    const conn = makeConnectionStub({
      signatures: [{ signature: "sig_a", err: null, slot: 1 }],
      transactions: { sig_a: burnTx },
    });
    const first = await indexTreasuryActivity({ connection: conn, store, config: CONFIG });
    expect(first.written).toBe(1);
    const second = await indexTreasuryActivity({ connection: conn, store, config: CONFIG });
    expect(second.written).toBe(0);
    expect(await store.countActivities({ page: 1, pageSize: 10 } as ActivityFilter)).toBe(1);
  });

  it("contains RPC failures per wallet and records index state (stale data kept)", async () => {
    const conn = makeConnectionStub({ signaturesError: new Error("429 too many requests") });
    const result = await indexTreasuryActivity({ connection: conn, store, config: CONFIG });
    expect(result.errors).toHaveLength(2);
    expect(result.written).toBe(0);
    const state = await store.getIndexState(W1);
    expect(state?.lastStatus).toBe("error");
    expect(state?.lastError).toContain("429");
    expect(store.rows).toHaveLength(0);
  });

  it("reconciles stored rows against the node and marks them verified", async () => {
    const conn = makeConnectionStub({
      signatures: [{ signature: "sig_a", err: null, slot: 1 }],
      transactions: { sig_a: burnTx },
      statuses: { value: [{ err: null, slot: 1 }] },
    });
    await indexTreasuryActivity({ connection: conn, store, config: CONFIG });
    expect(store.rows.every((r) => r.onChainVerified)).toBe(true);
    const again = await indexTreasuryActivity({ connection: conn, store, config: CONFIG });
    expect(again.verified).toBe(0); // already verified
    expect(again.lastReconciledAt).not.toBeNull();
  });

  it("reconciles after a database write failure and never double-counts", async () => {
    store.failNextUpserts(1); // DB outage after the confirmed fetch
    const conn = makeConnectionStub({
      signatures: [{ signature: "sig_a", err: null, slot: 1 }],
      transactions: { sig_a: burnTx },
      statuses: { value: [{ err: null, slot: 1 }] },
    });
    const failed = await indexTreasuryActivity({ connection: conn, store, config: CONFIG });
    // W1's write failed and was contained; W2's scan re-derived the same
    // on-chain transaction from the node and stored it.
    expect(failed.errors.join(" ")).toContain("W1");
    // Retry: everything is already stored (upsert dedupe by signature) —
    // the pipeline recovers without double-counting.
    const retry = await indexTreasuryActivity({ connection: conn, store, config: CONFIG });
    expect(retry.written).toBe(0);
    expect(await store.countActivities({ page: 1, pageSize: 10 } as ActivityFilter)).toBe(1);
    expect(store.rows[0].signature).toBe("sig_a");
  });

  it("does nothing when no wallets are configured", async () => {
    const empty = getRelayOfficialConfig({});
    const conn = makeConnectionStub({ signaturesError: new Error("must not be called") });
    const result = await indexTreasuryActivity({ connection: conn, store, config: empty });
    expect(result.walletsScanned).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("does not scan when the master switch is disabled", async () => {
    const disabled = getRelayOfficialConfig({
      RELAY_OFFICIAL_CREATOR_WALLET: W1,
      RELAY_OFFICIAL_ENABLED: "false",
    });
    const conn = makeConnectionStub({ signaturesError: new Error("must not be called") });
    const result = await indexTreasuryActivity({ connection: conn, store, config: disabled });
    expect(result.walletsScanned).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("catches up across pages with the before-cursor until known overlap", async () => {
    // Pre-store the OLDEST signature (bulk_0149) so page 2's last item is
    // "known" — pagination must stop at that overlap boundary.
    await store.upsertActivities([
      {
        signature: "bulk_0149",
        entryKey: "burn:pre:stored",
        type: "burn" as ActivityType,
        status: "confirmed" as const,
        slot: 149,
        blockTime: new Date(1_700_000_000),
        walletRole: "W2",
        sender: W2,
        recipient: null,
        inputAmount: "7",
        inputAsset: RELAY_MINT,
        inputDecimals: 0,
        outputAmount: null,
        outputAsset: null,
        outputDecimals: null,
        burnMint: RELAY_MINT,
        burnVerified: true,
        programId: null,
        network: "mainnet-beta",
        detail: null,
      },
    ]);
    const allSigs = Array.from({ length: 150 }, (_, i) => ({
      signature: "bulk_" + String(i).padStart(4, "0"),
      err: null,
      slot: i,
    }));
    const cursors: (string | undefined)[] = [];
    const conn: IndexerConnection = {
      async getSignaturesForAddress(_addr, options) {
        cursors.push(options?.before);
        const before = options?.before;
        if (!before) return allSigs.slice(0, 100);
        // Page after a cursor: the next 50 sigs deeper into history.
        const idx = allSigs.findIndex((s) => s.signature === before);
        return allSigs.slice(idx + 1, idx + 1 + 50);
      },
      async getParsedTransaction() {
        return burnTx; // every fetched tx is a confirmed W2 burn
      },
      async getSignatureStatuses(signatures) {
        return { value: signatures.map(() => ({ err: null, slot: 1 })) };
      },
    };
    const result = await indexTreasuryActivity({
      connection: conn,
      store,
      config: CONFIG,
      maxPagesPerWallet: 3,
    });
    // The cursor moved past page 1 (catch-up happened).
    expect(cursors.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(result.signaturesScanned).toBeGreaterThanOrEqual(150);
    // 149 fresh burns stored + the pre-stored row = 150 total, no dupes.
    expect(await store.countActivities({ page: 1, pageSize: 500 } as ActivityFilter)).toBe(150);
    expect(result.errors).toHaveLength(0);
  });
});

/* --------------------------------------------- summary and public API security */

describe("buildTreasurySummary", () => {
  it("renders explicit unavailable states when nothing is configured", async () => {
    const summary = await buildTreasurySummary({
      balanceConnection: null,
      store: null,
      config: getRelayOfficialConfig({}),
    });
    expect(summary.configured).toBe(false);
    expect(summary.wallets.every((w) => !w.configured && w.lamports === null)).toBe(true);
    expect(summary.totals.feesCollected).toBeNull();
    expect(summary.totals.relayBurned).toBeNull();
  });

  it("reports unavailable balances with sanitized reasons, never raw provider text", async () => {
    const badConn = {
      getBalance: vi.fn(async () => {
        throw new Error("429 rate limited from https://solana-mainnet.g.alchemy.com/v2/SECRETKEY");
      }),
      getTokenAccountsByOwner: vi.fn(async () => ({ value: [] })),
      getParsedAccountInfo: vi.fn(async () => ({ value: null })),
    } satisfies BalanceConnection;
    const summary = await buildTreasurySummary({
      balanceConnection: badConn,
      store: null,
      config: CONFIG,
    });
    const w1 = summary.wallets.find((w) => w.role === "W1");
    expect(w1?.lamports).toBeNull();
    // Coarse reason only - no provider text, no endpoint URL, no key.
    expect(w1?.balanceError).toBe("rpc_rate_limited");
    expect(w1?.balanceError).not.toContain("alchemy");
    expect(w1?.balanceError).not.toContain("SECRETKEY");
    expect(summary.errors.length).toBeGreaterThan(0);
  });

  it("aggregates verified store data with live balances", async () => {
    const store = new MemoryRelayOfficialStore();
    await store.upsertActivities([
      {
        signature: "sig1",
        entryKey: "k",
        type: "fee_collect",
        status: "confirmed",
        slot: 1,
        blockTime: new Date(),
        walletRole: "W1",
        sender: null,
        recipient: W1,
        inputAmount: "12345",
        inputAsset: "SOL",
        inputDecimals: 9,
        outputAmount: "12345",
        outputAsset: "SOL",
        outputDecimals: 9,
        burnMint: null,
        burnVerified: false,
        programId: null,
        network: "mainnet-beta",
        detail: null,
      } as ActivityRecord,
    ]);
    // Aggregates only count rows re-verified against the node (L3).
    await store.markOnChainVerified(["sig1"], new Date());
    const goodConn = {
      getBalance: vi.fn(async () => 987),
      getTokenAccountsByOwner: vi.fn(async () => ({ value: [] })),
      getParsedAccountInfo: vi.fn(async () => ({ value: null })),
    } satisfies BalanceConnection;
    const summary = await buildTreasurySummary({
      balanceConnection: goodConn,
      store,
      config: CONFIG,
    });
    expect(summary.totals.feesCollected).toBe("12345");
    expect(summary.wallets.find((w) => w.role === "W1")?.lamports).toBe(987);
  });
});

describe("buildTreasurySummary — asset/mint scoping", () => {
  const row = (
    signature: string,
    type: ActivityType,
    assetIn: string,
    assetOut: string | null,
  ): ActivityRecord => ({
    signature,
    entryKey: "k",
    type,
    status: "confirmed",
    slot: 1,
    blockTime: new Date(),
    walletRole: "W1",
    sender: null,
    recipient: W1,
    inputAmount: "10",
    inputAsset: assetIn,
    inputDecimals: 9,
    outputAmount: assetOut ? "10" : null,
    outputAsset: assetOut,
    outputDecimals: 9,
    burnMint: type === "burn" ? assetIn : null,
    burnVerified: type === "burn",
    programId: null,
    network: "mainnet-beta",
    detail: null,
  });

  it("never mixes token units into SOL totals", async () => {
    const store = new MemoryRelayOfficialStore();
    await store.upsertActivities([
      row("t1", "transfer", "SOL", "SOL"),
      row("t2", "transfer", OTHER_MINT, OTHER_MINT), // token transfer
    ]);
    await store.markOnChainVerified(["t1", "t2"], new Date());
    const summary = await buildTreasurySummary({
      balanceConnection: null,
      store,
      config: CONFIG,
    });
    // Only the SOL transfer counts (lamports); the token transfer is
    // listed as activity but never mixed into the SOL metric.
    expect(summary.totals.transfers).toBe("10");
  });

  it("never mixes other mints into $FLUX purchase/burn totals", async () => {
    const store = new MemoryRelayOfficialStore();
    await store.upsertActivities([
      row("s1", "swap", WSOL_MINT, RELAY_MINT),
      row("s2", "swap", WSOL_MINT, OTHER_MINT), // unrelated swap
      row("b1", "burn", RELAY_MINT, null),
      row("b2", "burn", OTHER_MINT, null), // unrelated burn
    ]);
    await store.markOnChainVerified(["s1", "s2", "b1", "b2"], new Date());
    const mintedConfig = getRelayOfficialConfig({
      RELAY_OFFICIAL_CREATOR_WALLET: W1,
      FLUXPAD_OFFICIAL_MINT: RELAY_MINT,
      RELAY_OFFICIAL_ENABLED: "true",
    });
    const summary = await buildTreasurySummary({
      balanceConnection: null,
      store,
      config: mintedConfig,
    });
    expect(summary.totals.relayPurchased).toBe("10"); // s1 only
    expect(summary.totals.relayBurned).toBe("10"); // b1 only
  });

  it("renders $FLUX totals as unavailable while the mint is unconfigured", async () => {
    const store = new MemoryRelayOfficialStore();
    await store.upsertActivities([row("s1", "swap", WSOL_MINT, RELAY_MINT)]);
    await store.markOnChainVerified(["s1"], new Date());
    const summary = await buildTreasurySummary({
      balanceConnection: null,
      store,
      config: getRelayOfficialConfig({
        RELAY_OFFICIAL_CREATOR_WALLET: W1,
        RELAY_OFFICIAL_ENABLED: "true",
      }),
    });
    expect(summary.totals.relayPurchased).toBeNull();
    expect(summary.totals.relayBurned).toBeNull();
  });
});

describe("public API guard — security", () => {
  beforeEach(() => {
    resetPublicApiLimiter();
  });

  it("rejects non-GET methods with 405 (no transfers/buybacks/burns/config)", async () => {
    const res = publicApiGuard(new Request("http://localhost/api/x", { method: "POST" }));
    expect(res!.status).toBe(405);
    const put = publicApiGuard(new Request("http://localhost/api/x", { method: "PUT" }));
    expect(put!.status).toBe(405);
    const del = publicApiGuard(new Request("http://localhost/api/x", { method: "DELETE" }));
    expect(del!.status).toBe(405);
  });

  it("allows GET requests", () => {
    const res = publicApiGuard(new Request("http://localhost/api/x", { method: "GET" }));
    expect(res).toBeNull();
  });

  it("prefers the platform client IP over the spoofable forwarded header", () => {
    const req = new Request("http://localhost/api/x", {
      method: "GET",
      headers: {
        "x-forwarded-for": "1.2.3.4", // spoofable
        "x-real-ip": "9.9.9.9", // platform-provided
      },
    });
    expect(ipOf(req)).toBe("9.9.9.9");
  });

  it("rate limits excessive GET requests per IP with 429 + Retry-After", async () => {
    let blocked = 0;
    for (let i = 0; i < 80; i += 1) {
      const res = publicApiGuard(
        new Request("http://localhost/api/x", {
          method: "GET",
          headers: { "x-forwarded-for": "203.0.113.7" },
        }),
      );
      if (res?.status === 429) {
        blocked += 1;
        expect(res.headers.get("Retry-After")).toBeTruthy();
      }
    }
    expect(blocked).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------- config safety */

describe("getRelayOfficialConfig — placeholders and validation", () => {
  it("returns unconfigured placeholder roles when no addresses are set", () => {
    const config = getRelayOfficialConfig({});
    expect(config.wallets).toHaveLength(4);
    expect(config.wallets.map((w) => w.role)).toEqual(["W1", "W2", "W3", "W4"]);
    expect(config.wallets.every((w) => w.address === null)).toBe(true);
    expect(config.anyWalletConfigured).toBe(false);
    expect(config.mint).toBeNull();
  });

  it("rejects malformed addresses by treating them as unconfigured", () => {
    const config = getRelayOfficialConfig({
      RELAY_OFFICIAL_CREATOR_WALLET: "not-a-valid-base58-address!!!",
    });
    expect(config.wallets.find((w) => w.role === "W1")?.address).toBeNull();
    expect(config.anyWalletConfigured).toBe(false);
  });

  it("accepts valid public addresses for W1..W4", () => {
    const config = getRelayOfficialConfig({
      RELAY_OFFICIAL_CREATOR_WALLET: W1,
      RELAY_OFFICIAL_BUYBACK_TREASURY: W2,
      RELAY_OFFICIAL_OPS_TREASURY: W1,
      RELAY_OFFICIAL_DEV_WALLET: W2,
      FLUXPAD_OFFICIAL_MINT: RELAY_MINT,
    });
    expect(config.anyWalletConfigured).toBe(true);
    expect(config.wallets.filter((w) => w.address !== null)).toHaveLength(4);
  });
});

/* ---------------------------------------------- public error sanitization */

describe("public error sanitization", () => {
  it("maps provider failures to coarse reason codes only", () => {
    expect(publicErrorReason(new Error("429 Too Many Requests"))).toBe("rpc_rate_limited");
    expect(publicErrorReason(new Error("connection timed out"))).toBe("rpc_timeout");
    expect(publicErrorReason(new Error("403 Forbidden"))).toBe("rpc_auth_error");
    expect(publicErrorReason(new Error("fetch failed"))).toBe("rpc_network_error");
    expect(publicErrorReason(new Error("unexpected internal condition"))).toBe("rpc_error");
  });

  it("never returns provider text or endpoint URLs to clients", () => {
    const reason = publicErrorReason(
      new Error("getBalance failed on https://solana-mainnet.g.alchemy.com/v2/SECRETKEY"),
    );
    expect(reason).not.toContain("alchemy");
    expect(reason).not.toContain("SECRETKEY");
    expect(reason).not.toContain("https");
  });

  it("logSafeDetail strips endpoint URLs for server logs but keeps the message", () => {
    const detail = logSafeDetail(
      new Error("429 from https://rpc.example.com/v2/SECRETKEY - slow down"),
    );
    expect(detail).toContain("[endpoint]");
    expect(detail).not.toContain("SECRETKEY");
    expect(detail).toContain("slow down");
  });

  it("publicInvalidRoles exposes roles only, never the raw env values", () => {
    const config = getRelayOfficialConfig({
      RELAY_OFFICIAL_CREATOR_WALLET: "not-a-valid-base58-address!!!",
      FLUXPAD_OFFICIAL_MINT: "also-bad!!!",
    });
    // Server-side diagnostics keep the raw values internally.
    expect(config.invalid.map((i) => i.value)).toEqual([
      "not-a-valid-base58-address!!!",
      "also-bad!!!",
    ]);
    // The public form strips them.
    expect(publicInvalidRoles(config)).toEqual([{ role: "W1" }, { role: "MINT" }]);
    expect(JSON.stringify(publicInvalidRoles(config))).not.toContain("not-a-valid");
    expect(JSON.stringify(publicInvalidRoles(config))).not.toContain("also-bad");
  });
});

/* ----------------------------------------------------- refresh gate logic */

describe("shouldRunRefresh - layered refresh gate", () => {
  const base = {
    enabled: true,
    anyWalletConfigured: true,
    hasStore: true,
    inFlight: false,
    localLastRunAt: 0,
    dbLastRunAt: null as Date | null,
    now: 1_000_000,
  };

  it("runs when every gate is open", () => {
    expect(shouldRunRefresh(base)).toBe(true);
  });

  it("never runs when the master switch is off, nothing is configured, or the store is missing", () => {
    expect(shouldRunRefresh({ ...base, enabled: false })).toBe(false);
    expect(shouldRunRefresh({ ...base, anyWalletConfigured: false })).toBe(false);
    expect(shouldRunRefresh({ ...base, hasStore: false })).toBe(false);
  });

  it("single-flight: never runs while a refresh is in flight in this process", () => {
    expect(shouldRunRefresh({ ...base, inFlight: true })).toBe(false);
  });

  it("per-process throttle blocks refreshes inside the window", () => {
    expect(
      shouldRunRefresh({ ...base, localLastRunAt: base.now - REFRESH_MIN_INTERVAL_MS + 1 }),
    ).toBe(false);
    expect(
      shouldRunRefresh({ ...base, localLastRunAt: base.now - REFRESH_MIN_INTERVAL_MS - 1 }),
    ).toBe(true);
  });

  it("DB-backed gate dedupes refreshes across instances (best-effort, not a lock)", () => {
    const recent = new Date(base.now - REFRESH_MIN_INTERVAL_MS + 1);
    expect(shouldRunRefresh({ ...base, dbLastRunAt: recent })).toBe(false);
    const old = new Date(base.now - REFRESH_MIN_INTERVAL_MS - 1);
    expect(shouldRunRefresh({ ...base, dbLastRunAt: old })).toBe(true);
    // Unknown DB state (read failure) falls back to the per-process gates.
    expect(shouldRunRefresh({ ...base, dbLastRunAt: null })).toBe(true);
  });
});

/* ------------------------------- indexer: pending, statuses, duplicates */

describe("indexTreasuryActivity - pending, reconcile failures, duplicate upserts", () => {
  let store: MemoryRelayOfficialStore;
  beforeEach(() => {
    store = new MemoryRelayOfficialStore();
  });

  it("treats null RPC transactions as pending: never stored, retried next run", async () => {
    const conn = makeConnectionStub({
      signatures: [{ signature: "sig_too_new", err: null, slot: 9 }],
      transactions: {}, // getParsedTransaction returns null (too new)
    });
    const result = await indexTreasuryActivity({ connection: conn, store, config: CONFIG });
    expect(result.pending).toBe(2); // W1 scan + W2 scan both see it unset
    expect(result.written).toBe(0);
    expect(store.rows).toHaveLength(0);
  });

  it("contains getSignatureStatuses failures and keeps stored rows intact", async () => {
    const conn = {
      ...makeConnectionStub({
        signatures: [{ signature: "sig_a", err: null, slot: 1 }],
        transactions: { sig_a: burnTx },
      }),
      getSignatureStatuses: vi.fn(async () => {
        throw new Error("429 too many requests");
      }),
    } satisfies IndexerConnection;
    const result = await indexTreasuryActivity({ connection: conn, store, config: CONFIG });
    expect(result.errors.join(" ")).toContain("reconcile");
    expect(store.rows).toHaveLength(1); // scan data is preserved
    expect(store.rows.every((r) => r.onChainVerified)).toBe(false); // not verified
    const state = await store.getIndexState("reconcile");
    expect(state?.lastStatus).toBe("error");
  });

  it("duplicate upserts of the same (signature, entryKey) are counted, never written twice", async () => {
    const rec: ActivityRecord = {
      signature: "sig_dup",
      entryKey: "burn:k:1",
      type: "burn",
      status: "confirmed",
      slot: 1,
      blockTime: new Date(),
      walletRole: "W2",
      sender: W2,
      recipient: null,
      inputAmount: "1",
      inputAsset: RELAY_MINT,
      inputDecimals: 6,
      outputAmount: null,
      outputAsset: null,
      outputDecimals: null,
      burnMint: RELAY_MINT,
      burnVerified: true,
      programId: null,
      network: "mainnet-beta",
      detail: null,
    };
    const first = await store.upsertActivities([rec]);
    expect(first.written).toBe(1);
    const second = await store.upsertActivities([{ ...rec, entryKey: "burn:k:1" }]);
    expect(second.written).toBe(0);
    expect(second.duplicates).toBe(1);
    // A distinct occurrence inside the same tx is a separate row by design.
    const third = await store.upsertActivities([{ ...rec, entryKey: "burn:k:2" }]);
    expect(third.written).toBe(1);
  });
});
