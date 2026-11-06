import { PublicKey } from "@solana/web3.js";

/**
 * Pure classification of confirmed Solana transactions into treasury
 * activity records.
 *
 * Everything here is verification, not inference:
 * - status comes from the transaction's own result (meta.err);
 * - burns are recognized ONLY from actual SPL burn instructions
 *   (burn / burnChecked) — a token transfer to any address, including a
 *   "dead" address, is a transfer, never a burn. Amounts/mints follow the
 *   REAL parsed-RPC shapes: burnChecked carries {account, mint,
 *   tokenAmount:{amount,decimals}}; legacy burn carries {account, amount}
 *   and the mint/decimals are derived from the transaction's token
 *   balances — never guessed;
 * - token transfers attribute sender/recipient to the OWNERS of the source
 *   and destination token accounts (from token balances), because SPL
 *   transfer instructions carry token-account addresses, not wallets;
 * - swap input/output amounts are derived from the transaction's own
 *   pre/post token balance deltas, never from instruction data alone;
 * - fee-collection amounts are GROSS of the network fee for the fee payer
 *   (pre/post balances are net of the fee for the payer);
 * - inner (CPI) instructions are scanned alongside top-level instructions,
 *   since program-mediated burns/transfers only appear there;
 * - entry keys carry an occurrence index, so multiple identical operations
 *   inside one transaction are all recorded (never collapsed).
 *
 * The classifier is network-agnostic and takes no I/O — fully unit testable
 * against fixtures that mirror real parser output
 * (see src/tests/official-token.test.ts).
 */

export const ACTIVITY_TYPES = ["fee_collect", "transfer", "swap", "burn", "other"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_STATUS = ["confirmed", "failed"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUS)[number];

/** Public program IDs (official docs; mirrors src/lib/constants.ts). */
export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const SOL_ASSET = "SOL";

export interface ActivityRecord {
  signature: string;
  entryKey: string;
  type: ActivityType;
  status: ActivityStatus;
  slot: number | null;
  blockTime: Date | null;
  walletRole: string | null;
  sender: string | null;
  recipient: string | null;
  inputAmount: string | null;
  inputAsset: string | null;
  inputDecimals: number | null;
  outputAmount: string | null;
  outputAsset: string | null;
  outputDecimals: number | null;
  burnMint: string | null;
  burnVerified: boolean;
  programId: string | null;
  network: string;
  detail: Record<string, unknown> | null;
}

/** Parsed account key entry (web3.js ParsedMessageAccount subset). */
export interface AccountKeyEntry {
  pubkey: string | PublicKey;
  signer?: boolean;
  writable?: boolean;
}

/** Structural subset of ParsedTransactionWithMeta we rely on. */
export interface ClassifiedTransaction {
  slot?: number;
  blockTime?: number | null;
  meta: {
    err: unknown | null;
    fee: number | number[] | null;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    innerInstructions?: InnerInstructionGroup[] | null;
    logMessages?: string[] | null;
  } | null;
  transaction: {
    message: {
      accountKeys?: (string | AccountKeyEntry)[];
      instructions: ParsedInstruction[];
    };
  };
}

export interface InnerInstructionGroup {
  index: number;
  instructions?: ParsedInstruction[];
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string | null;
  programId?: string;
  uiTokenAmount?: { amount: string; decimals: number } | null;
}

/** web3.js returns string or PublicKey programIds depending on parsing. */
export type ParsedInstruction = {
  programId: string | PublicKey;
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> } | null;
  inner?: ParsedInstruction[];
};

/** Collect nested instructions depth-first. */
export function* walk(instructions: ParsedInstruction[]): Generator<ParsedInstruction> {
  for (const ix of instructions) {
    yield ix;
    if (Array.isArray(ix.inner)) yield* walk(ix.inner);
  }
}

/**
 * All instructions of a transaction: top-level first, then every inner
 * (CPI) group, depth-first. CPI token movements (burns/transfers executed
 * by programs) live ONLY in innerInstructions.
 */
export function* allInstructions(tx: ClassifiedTransaction): Generator<ParsedInstruction> {
  yield* walk(tx.transaction.message.instructions);
  for (const group of tx.meta?.innerInstructions ?? []) {
    yield* walk(group.instructions ?? []);
  }
}

function programIdOf(ix: ParsedInstruction): string {
  if (typeof ix.programId === "string") return ix.programId;
  return ix.programId.toBase58();
}

function accountKey(tx: ClassifiedTransaction, index: number): string | null {
  const keys = tx.transaction.message.accountKeys ?? [];
  const entry = keys[index];
  if (!entry) return null;
  return typeof entry === "string" ? entry : String(entry.pubkey);
}

function findAccountIndex(tx: ClassifiedTransaction, address: string): number {
  const keys = tx.transaction.message.accountKeys ?? [];
  return keys.findIndex((k) => (typeof k === "string" ? k : String(k.pubkey)) === address);
}

function addressOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isZeroPublicKey(value: string): boolean {
  return value === SYSTEM_PROGRAM_ID;
}

/** True when a parsed token instruction is a genuine burn. */
function isBurnInstruction(ix: ParsedInstruction): boolean {
  if (ix.program !== "spl-token" && ix.program !== "spl-token-2022") return false;
  return ix.parsed?.type === "burn" || ix.parsed?.type === "burnChecked";
}

function isTokenTransfer(ix: ParsedInstruction): boolean {
  if (ix.program !== "spl-token" && ix.program !== "spl-token-2022") return false;
  return ix.parsed?.type === "transfer" || ix.parsed?.type === "transferChecked";
}

function isSystemTransfer(ix: ParsedInstruction): boolean {
  return ix.program === "system" && ix.parsed?.type === "transfer";
}

/** Instruction-name markers pump.fun / pump-amm log for fee collection. */
const FEE_COLLECT_LOG_MARKERS = [
  "Instruction: CollectCreatorFee",
  "Instruction: CollectCoinCreatorFee",
  "Instruction: SweepCreatorFee",
  "Instruction: SweepPoolCreatorFee",
  "Instruction: TransferCreatorFeesToPump",
];

const SWAP_LOG_MARKERS = [
  "Instruction: Buy",
  "Instruction: Sell",
  "Instruction: buy",
  "Instruction: sell",
  "Instruction: BuyExactIn",
  "Instruction: SellExactIn",
];

function logsSay(tx: ClassifiedTransaction, markers: string[]): boolean {
  return (tx.meta?.logMessages ?? []).some((line) =>
    markers.some((m) => line.includes(m)),
  );
}

/**
 * The program that executed a swap, derived from the transaction's own log
 * ("Program <ID> invoke" lines) — pump-amm preferred, then the pump bonding
 * curve. Never hardcoded when the logs can attribute it.
 */
export function detectSwapProgram(tx: ClassifiedTransaction): string | null {
  const invoked = new Set<string>();
  for (const line of tx.meta?.logMessages ?? []) {
    const m = /Program \s*([1-9A-HJ-NP-Za-km-z]{32,44}) invoke/.exec(line);
    if (m) invoked.add(m[1]);
  }
  if (invoked.has(PUMP_AMM_PROGRAM_ID)) return PUMP_AMM_PROGRAM_ID;
  if (invoked.has(PUMP_PROGRAM_ID)) return PUMP_PROGRAM_ID;
  return null;
}

/**
 * accountIndex → token-balance info (owner/mint/decimals) from the
 * transaction's own pre/post token balances (post wins on conflicts).
 */
export function tokenBalanceInfoMap(tx: ClassifiedTransaction): Map<number, TokenBalance> {
  const map = new Map<number, TokenBalance>();
  for (const b of [
    ...(tx.meta?.preTokenBalances ?? []),
    ...(tx.meta?.postTokenBalances ?? []),
  ]) {
    map.set(b.accountIndex, b);
  }
  return map;
}

/**
 * Index of the fee payer (first signer account — standard Solana layout;
 * the payer's pre/post balances are net of the transaction fee).
 */
export function findFeePayerIndex(tx: ClassifiedTransaction): number {
  const keys = tx.transaction.message.accountKeys ?? [];
  const i = keys.findIndex((k) => typeof k !== "string" && k.signer === true);
  return i === -1 ? 0 : i;
}

/**
 * Net per-mint token delta for one owner from the transaction's own
 * pre/post token balances. Input delta is negative, output positive.
 */
export function tokenDeltaByMint(
  tx: ClassifiedTransaction,
  owner: string,
): { mint: string; delta: string; decimals: number | null }[] {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const preSum = new Map<string, bigint>();
  const postSum = new Map<string, bigint>();
  const decimals = new Map<string, number>();
  for (const b of pre) {
    if (!b.owner || b.owner !== owner) continue;
    preSum.set(b.mint, (preSum.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount?.amount ?? "0"));
    decimals.set(b.mint, b.uiTokenAmount?.decimals ?? decimals.get(b.mint) ?? -1);
  }
  for (const b of post) {
    if (!b.owner || b.owner !== owner) continue;
    postSum.set(b.mint, (postSum.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount?.amount ?? "0"));
    decimals.set(b.mint, b.uiTokenAmount?.decimals ?? decimals.get(b.mint) ?? -1);
  }
  const mints = new Set([...preSum.keys(), ...postSum.keys()]);
  const out: { mint: string; delta: string; decimals: number | null }[] = [];
  for (const mint of mints) {
    const delta = (postSum.get(mint) ?? 0n) - (preSum.get(mint) ?? 0n);
    out.push({ mint, delta: delta.toString(), decimals: decimals.get(mint) ?? null });
  }
  return out;
}

/** SOL (lamports) delta for an account index from pre/post balances. */
export function solDeltaForIndex(tx: ClassifiedTransaction, index: number): bigint {
  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];
  return BigInt(post[index] ?? 0) - BigInt(pre[index] ?? 0);
}

function buildRecord(
  tx: ClassifiedTransaction,
  partial: Omit<ActivityRecord, "status" | "slot" | "blockTime" | "network"> &
    Partial<Pick<ActivityRecord, "status" | "slot" | "blockTime">>,
): Omit<ActivityRecord, "network"> {
  return {
    status: (partial.status ??
      (tx.meta?.err == null ? "confirmed" : "failed")) as ActivityStatus,
    slot: partial.slot ?? (typeof tx.slot === "number" ? tx.slot : null),
    blockTime:
      partial.blockTime ??
      (typeof tx.blockTime === "number" ? new Date(tx.blockTime * 1000) : null),
    ...partial,
  };
}

/**
 * Occurrence-indexed entry keys: identical operations inside one
 * transaction get distinct keys (base, base#1, base#2, …) so none is
 * silently collapsed by the (signature, entryKey) unique constraint.
 */
class EntryKeys {
  private readonly counts = new Map<string, number>();

  next(base: string): string {
    const n = this.counts.get(base) ?? 0;
    this.counts.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  }
}

/**
 * Classify one parsed transaction into zero or more activity records.
 * Only entries attributable to a configured treasury wallet are produced;
 * token-account addresses are resolved to their OWNERS before attribution.
 */
export function classifyTransaction(
  tx: ClassifiedTransaction,
  opts: {
    signature: string;
    network: string;
    roleByAddress: Map<string, string>;
  },
): ActivityRecord[] {
  const roleFor = (addr: string | null | undefined) =>
    addr ? opts.roleByAddress.get(addr) ?? null : null;

  const records: Omit<ActivityRecord, "network">[] = [];
  const keys = new EntryKeys();
  const balanceInfo = tokenBalanceInfoMap(tx);
  const feePayerIndex = findFeePayerIndex(tx);
  const feeLamports = networkFeeLamports(tx);

  // 1) Burns — genuine SPL burn instructions only (top-level + CPI).
  for (const ix of allInstructions(tx)) {
    if (!isBurnInstruction(ix)) continue;
    const info = ix.parsed?.info ?? {};
    // burnChecked: {account, mint, tokenAmount:{amount, decimals}}.
    // legacy burn: {account, amount} — mint/decimals derived from the
    // transaction's own token balances by accountIndex; never guessed.
    const amount: string | null =
      addressOf(info.amount) ??
      (typeof (info.tokenAmount as { amount?: string } | undefined)?.amount === "string"
        ? ((info.tokenAmount as { amount?: string }).amount as string)
        : null);
    let mint: string | null = addressOf(info.mint);
    let decimals: number | null =
      typeof (info.tokenAmount as { decimals?: number } | undefined)?.decimals === "number"
        ? ((info.tokenAmount as { decimals?: number }).decimals as number)
        : null;
    const account = addressOf(info.account);
    if (account) {
      const idx = findAccountIndex(tx, account);
      const bal = idx >= 0 ? balanceInfo.get(idx) : undefined;
      if (!mint && bal?.mint) mint = bal.mint;
      if (decimals === null && typeof bal?.uiTokenAmount?.decimals === "number") {
        decimals = bal.uiTokenAmount.decimals;
      }
      // Sanity: a burnChecked mint must match the account's mint.
      if (bal?.mint && mint && bal.mint !== mint) continue; // inconsistent — skip, never guess
    }
    if (!amount || !mint || !account) continue;
    // Attribute to the OWNER of the burned token account (the wallet that
    // lost tokens), not the token-account address itself.
    const idx = findAccountIndex(tx, account);
    const owner = balanceInfo.get(idx)?.owner ?? null;
    const role = roleFor(owner);
    if (!role) continue; // burn by an unrelated account — not treasury activity
    records.push(
      buildRecord(tx, {
        signature: opts.signature,
        entryKey: keys.next(`burn:${programIdOf(ix)}:${ix.parsed?.type ?? "burn"}:${account}:${amount}`),
        type: "burn",
        walletRole: role,
        sender: owner,
        recipient: null,
        inputAmount: amount,
        inputAsset: mint,
        inputDecimals: decimals,
        outputAmount: null,
        outputAsset: null,
        outputDecimals: null,
        burnMint: mint,
        burnVerified: true,
        programId: programIdOf(ix),
        detail: {
          instruction: ix.parsed?.type ?? "burn",
          mint,
          amount,
          tokenAccount: account,
          networkFeeLamports: feeLamports,
        },
      }),
    );
  }

  // 2) Transfers — system lamport transfers and SPL token transfers
  //    (top-level + CPI). SPL transfers name token ACCOUNTS, so the
  //    recorded sender/recipient are the resolved owners.
  for (const ix of allInstructions(tx)) {
    if (isSystemTransfer(ix)) {
      const info = ix.parsed?.info ?? {};
      const source = addressOf(info.source);
      const destination = addressOf(info.destination);
      const lamports = typeof info.lamports === "number" ? String(info.lamports) : null;
      if (!source || !destination || lamports === null || isZeroPublicKey(destination)) continue;
      const involved = roleFor(source) ?? roleFor(destination);
      if (!involved) continue; // only treasury-relevant transfers are tracked
      records.push(
        buildRecord(tx, {
          signature: opts.signature,
          entryKey: keys.next(`transfer:system:${source}:${destination}:${lamports}`),
          type: "transfer",
          walletRole: involved,
          sender: source,
          recipient: destination,
          inputAmount: lamports,
          inputAsset: SOL_ASSET,
          inputDecimals: 9,
          outputAmount: lamports,
          outputAsset: SOL_ASSET,
          outputDecimals: 9,
          burnMint: null,
          burnVerified: false,
          programId: SYSTEM_PROGRAM_ID,
          detail: { kind: "system_transfer", lamports, networkFeeLamports: feeLamports },
        }),
      );
      continue;
    }
    if (isTokenTransfer(ix)) {
      const info = ix.parsed?.info ?? {};
      const source = addressOf(info.source) ?? addressOf(info.account);
      const destination = addressOf(info.destination);
      // transferChecked: {source, mint, destination, tokenAmount}; legacy
      // transfer: {source, destination, amount} — mint/decimals derived
      // from the transaction's own token balances; never guessed.
      const tokenAmount =
        info.tokenAmount && typeof info.tokenAmount === "object"
          ? (info.tokenAmount as { amount?: string; decimals?: number })
          : null;
      const amount: string | null =
        addressOf(info.amount) ?? (tokenAmount?.amount ?? null);
      let mint: string | null = addressOf(info.mint);
      let decimals: number | null =
        typeof tokenAmount?.decimals === "number" ? tokenAmount.decimals : null;
      if (source) {
        const sIdx = findAccountIndex(tx, source);
        const sBal = sIdx >= 0 ? balanceInfo.get(sIdx) : undefined;
        if (!mint && sBal?.mint) mint = sBal.mint;
        if (decimals === null && typeof sBal?.uiTokenAmount?.decimals === "number") {
          decimals = sBal.uiTokenAmount.decimals;
        }
      }
      if (!amount || !destination || !mint) continue;
      const dIdx = findAccountIndex(tx, destination);
      const dOwner = dIdx >= 0 ? balanceInfo.get(dIdx)?.owner ?? null : null;
      // Ownership sanity: a checked mint must match the source account's.
      const sIdx2 = source ? findAccountIndex(tx, source) : -1;
      const sBal2 = sIdx2 >= 0 ? balanceInfo.get(sIdx2) : undefined;
      if (sBal2?.mint && mint && sBal2.mint !== mint) continue; // inconsistent — skip
      const involved = roleFor(sBal2?.owner ?? null) ?? roleFor(dOwner);
      if (!involved) continue;
      records.push(
        buildRecord(tx, {
          signature: opts.signature,
          entryKey: keys.next(`transfer:token:${source ?? "?"}:${destination}:${mint}:${amount}`),
          type: "transfer",
          walletRole: involved,
          sender: sBal2?.owner ?? source,
          recipient: dOwner ?? destination,
          inputAmount: amount,
          inputAsset: mint,
          inputDecimals: decimals,
          outputAmount: amount,
          outputAsset: mint,
          outputDecimals: decimals,
          burnMint: null,
          burnVerified: false,
          programId: programIdOf(ix),
          detail: {
            kind: "token_transfer",
            instruction: ix.parsed?.type ?? null,
            sourceTokenAccount: source,
            destinationTokenAccount: destination,
            networkFeeLamports: feeLamports,
          },
        }),
      );
    }
  }

  // 3) Fee collection — pump / pump-amm collect instructions (logged
  //    names), with the verified SOL delta of each configured treasury
  //    wallet. The fee payer's pre/post balances are NET of the network
  //    fee, so the payer's delta is corrected back to gross.
  if (logsSay(tx, FEE_COLLECT_LOG_MARKERS)) {
    for (const [addr, role] of opts.roleByAddress.entries()) {
      const idx = findAccountIndex(tx, addr);
      if (idx === -1) continue;
      let delta = solDeltaForIndex(tx, idx);
      if (idx === feePayerIndex && feeLamports != null && feeLamports > 0) {
        delta += BigInt(feeLamports); // gross up the fee payer's delta
      }
      if (delta <= 0n) continue;
      records.push(
        buildRecord(tx, {
          signature: opts.signature,
          entryKey: keys.next(`fee_collect:${addr}:${delta.toString()}`),
          type: "fee_collect",
          walletRole: role,
          sender: null,
          recipient: addr,
          inputAmount: delta.toString(),
          inputAsset: SOL_ASSET,
          inputDecimals: 9,
          outputAmount: delta.toString(),
          outputAsset: SOL_ASSET,
          outputDecimals: 9,
          burnMint: null,
          burnVerified: false,
          programId: PUMP_PROGRAM_ID,
          detail: {
            kind: "creator_fee_collection",
            lamports: delta.toString(),
            networkFeeLamports: feeLamports,
            feePayerCorrected: idx === feePayerIndex,
          },
        }),
      );
    }
  }

  // 4) Swaps — verified input/output from token-balance deltas, with the
  //    executing program attributed from the transaction's own logs.
  if (logsSay(tx, SWAP_LOG_MARKERS)) {
    const swapProgram = detectSwapProgram(tx) ?? PUMP_AMM_PROGRAM_ID;
    for (const [addr, role] of opts.roleByAddress.entries()) {
      const deltas = tokenDeltaByMint(tx, addr);
      const negative = deltas.find((d) => BigInt(d.delta) < 0n);
      const positive = deltas.find((d) => BigInt(d.delta) > 0n);
      if (!negative && !positive) continue;
      records.push(
        buildRecord(tx, {
          signature: opts.signature,
          entryKey: keys.next(`swap:${addr}:${negative?.mint ?? "none"}:${positive?.mint ?? "none"}`),
          type: "swap",
          walletRole: role,
          sender: negative ? addr : null,
          recipient: positive ? addr : null,
          inputAmount: negative ? (-BigInt(negative.delta)).toString() : null,
          inputAsset: negative?.mint ?? null,
          inputDecimals: negative?.decimals ?? null,
          outputAmount: positive ? positive.delta : null,
          outputAsset: positive?.mint ?? null,
          outputDecimals: positive?.decimals ?? null,
          burnMint: null,
          burnVerified: false,
          programId: swapProgram,
          detail: { kind: "swap", deltas, networkFeeLamports: feeLamports },
        }),
      );
    }
  }

  return records.map((r) => ({ ...r, network: opts.network }));
}

/** Public: total network fee of a transaction, in lamports (or null). */
export function networkFeeLamports(tx: ClassifiedTransaction): number | null {
  const fee = tx.meta?.fee;
  if (typeof fee === "number") return fee;
  if (Array.isArray(fee)) {
    return fee.reduce((sum, f) => sum + (typeof f === "number" ? f : 0), 0);
  }
  return null;
}

/** Public: is a parsed transaction confirmed (not failed)? */
export function isConfirmed(tx: ClassifiedTransaction): boolean {
  return tx.meta?.err == null;
}

/** Exported for tests. */
export {
  accountKey,
  findAccountIndex,
  isZeroPublicKey,
  programIdOf,
  isBurnInstruction,
  isTokenTransfer,
  isSystemTransfer,
  FEE_COLLECT_LOG_MARKERS,
  SWAP_LOG_MARKERS,
};


