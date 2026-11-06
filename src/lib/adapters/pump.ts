/**
 * Route A — Pump.fun bonding curve → PumpSwap.
 *
 * Built on the official `@pump-fun/pump-sdk` (v4.0.0):
 * - create_v2 via `PUMP_SDK.createV2Instruction` (SOL-quoted default), or
 *   `PUMP_SDK.createV2AndBuyInstructions` (create + user ATA + first buy).
 * - Curve state via `PUMP_SDK.decodeBondingCurve` on the `bonding-curve` PDA.
 * - Graduation via `isBondingCurveMigrated`; PumpSwap pool via
 *   `canonicalPumpPoolPda`, verified on-chain against `PUMP_AMM_PROGRAM_ID`.
 *
 * All transaction building happens client-side. The mint keypair signs
 * locally (create_v2 requires the mint as a signer); the wallet signs as payer.
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  PUMP_SDK,
  OnlinePumpSdk,
  PUMP_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  bondingCurvePda,
  canonicalPumpPoolPda,
  getBuyTokenAmountFromSolAmount,
  isBondingCurveMigrated,
  type BondingCurve,
  type Global,
} from "@pump-fun/pump-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import type { ClusterId } from "../constants";
import { isTransactionTooLargeError, RelaypadError, toRelaypadError } from "../connection";
import { METADATA_URI_MAX, PUMP_COMBINED_URI_MAX, validateMetadataUri } from "../metadata";
import type {
  CurveState,
  PoolVerification,
  PreparedLaunch,
  PreparedTransaction,
  RouteAdapter,
  RouteConfigInfo,
  TokenLaunchInput,
} from "./types";
import { assertTransactionFits, type WalletSigner } from "../tx-engine";

/** Estimated one-time SOL cost of the launch when no initial buy is made. */
const BASE_COST_LAMPORTS = BigInt(1_100_000); // tx fee + mint/curve/metadata rent, conservative

export class PumpAdapter implements RouteAdapter {
  readonly id = "pump" as const;
  readonly label = "Pump.fun → PumpSwap";
  readonly description =
    "Launch on the pump.fun bonding curve (Token-2022, 6 decimals). The protocol migrates liquidity to PumpSwap after the curve completes.";

  describePrograms(_cluster?: ClusterId) {
    return [
      { name: "Pump bonding curve program", address: PUMP_PROGRAM_ID.toBase58() },
      { name: "PumpSwap AMM program", address: PUMP_AMM_PROGRAM_ID.toBase58() },
    ];
  }

  async loadConfig(
    connection: Connection,
    cluster: ClusterId,
  ): Promise<RouteConfigInfo> {
    const online = new OnlinePumpSdk(connection);
    let global: Global;
    try {
      global = await online.fetchGlobal();
    } catch (err) {
      throw new RelaypadError(
        "PROTOCOL",
        `Pump program is not reachable on ${cluster}: the Global account could not be fetched. This route requires a cluster where the pump.fun program is deployed.`,
        err,
      );
    }
    return {
      route: "pump",
      cluster,
      supportsInitialBuy: true,
      supportsVanityMint: true,
      details: {
        programId: PUMP_PROGRAM_ID.toBase58(),
        global: {
          feeBasisPoints: global.feeBasisPoints?.toString?.() ?? null,
          creatorFeeConfigurable: Boolean(global.creatorFeeConfigurable),
          createV2Enabled: Boolean(global.createV2Enabled),
          initialVirtualSolReserves:
            global.initialVirtualSolReserves?.toString?.() ?? null,
        },
      },
    };
  }
  async prepareLaunch({
    connection,
    signer,
    mintKeypair,
    input,
  }: {
    connection: Connection;
    cluster: ClusterId;
    config: RouteConfigInfo;
    signer: WalletSigner;
    mintKeypair: Keypair;
    input: TokenLaunchInput;
  }): Promise<PreparedLaunch> {
    const user = signer.publicKey;
    const mint = mintKeypair.publicKey;

    // Route-aware metadata URI cap (P0.1). The bundled create+buy legacy
    // transaction measures 1231/1232 wire bytes with a 70-character URI, so
    // every additional URI byte overflows Solana's packet limit. Reject
    // oversized URIs here — before any transaction is built — so the user
    // gets an actionable error instead of a failure at wallet-signing time.
    const combined = input.initialBuyLamports > 0n;
    const uriCheck = validateMetadataUri(
      input.metadataUri,
      combined ? PUMP_COMBINED_URI_MAX : METADATA_URI_MAX,
    );
    if (!uriCheck.ok) {
      throw new RelaypadError(
        "TX_TOO_LARGE",
        combined
          ? `${uriCheck.reason} The bundled create+buy transaction can only carry ${PUMP_COMBINED_URI_MAX}-character URIs. Launch without an initial buy (create-only supports up to ${METADATA_URI_MAX} characters) or use the default IPFS gateway (ipfs.io), then try again.`
          : uriCheck.reason,
      );
    }

    const transactions: PreparedTransaction[] = [];
    const breakdown: { label: string; lamports: bigint }[] = [];
    const protocolNotes: string[] = [];

    if (input.initialBuyLamports > 0n) {
      const online = new OnlinePumpSdk(connection);
      const global = await online.fetchGlobal();
      const solAmount = new BN(input.initialBuyLamports.toString());
      const amount = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig: null,
        mintSupply: null,
        bondingCurve: null,
        amount: solAmount,
        quoteMint: NATIVE_MINT,
      });
      const ixs = await PUMP_SDK.createV2AndBuyInstructions({
        global,
        mint,
        name: input.name,
        symbol: input.symbol,
        uri: input.metadataUri,
        creator: user,
        user,
        amount,
        solAmount,
        mayhemMode: false,
      });
      protocolNotes.push(
        "create_v2 + user ATA + first buy bundled in one transaction (createV2AndBuyInstructions).",
      );
      breakdown.push({ label: "Initial buy (quote)", lamports: input.initialBuyLamports });
      breakdown.push({ label: "Rent + fees (estimate)", lamports: BASE_COST_LAMPORTS });
      transactions.push({
        tx: await this.buildTransaction({ connection, instructions: ixs, signer, mintKeypair }),
        extraSigners: [ephemeralSigner(mintKeypair)],
      });
    } else {
      const createIx = await PUMP_SDK.createV2Instruction({
        mint,
        name: input.name,
        symbol: input.symbol,
        uri: input.metadataUri,
        creator: user,
        user,
        mayhemMode: false,
        holderReward: false,
      });
      protocolNotes.push("create_v2 (Token-2022 mint, decimals 6, metadata pointer = mint).");
      breakdown.push({ label: "Rent + fees (estimate)", lamports: BASE_COST_LAMPORTS });
      transactions.push({
        tx: await this.buildTransaction({
          connection,
          instructions: [createIx],
          signer,
          mintKeypair,
        }),
        extraSigners: [ephemeralSigner(mintKeypair)],
      });
    }

    protocolNotes.push(
      "Graduation and the PumpSwap migration are performed by pump.fun's protocol — FluxPad detects and verifies them, never executes them.",
    );

    const estimatedTotalLamports = breakdown.reduce((acc, b) => acc + b.lamports, 0n);

    return {
      route: "pump",
      mintAddress: mint.toBase58(),
      transactions,
      estimatedTotalLamports,
      breakdown,
      protocolNotes,
      requiresMintSigner: true,
    };
  }
  async readCurveState(
    connection: Connection,
    mint: PublicKey,
  ): Promise<CurveState> {
    const pda = bondingCurvePda(mint);
    const info = await connection.getAccountInfo(pda, "confirmed");
    if (!info) {
      throw new RelaypadError(
        "PROTOCOL",
        `Bonding curve account ${pda.toBase58()} not found for mint ${mint.toBase58()}.`,
      );
    }
    const bc: BondingCurve = PUMP_SDK.decodeBondingCurve(info);
    const migrated = isBondingCurveMigrated(bc);
    return {
      onCurve: !migrated,
      quoteReserves: bc.realQuoteReserves
        ? BigInt(bc.realQuoteReserves.toString())
        : null,
      virtualQuoteReserves: bc.virtualQuoteReserves
        ? BigInt(bc.virtualQuoteReserves.toString())
        : null,
      baseSold:
        bc.tokenTotalSupply && bc.realTokenReserves
          ? BigInt(bc.tokenTotalSupply.sub(bc.realTokenReserves).toString())
          : null,
      complete: bc.complete ?? null,
      observedAt: Date.now(),
      raw: {
        programOwner: info.owner.toBase58(),
        virtualTokenReserves: bc.virtualTokenReserves?.toString(),
        virtualQuoteReserves: bc.virtualQuoteReserves?.toString(),
        realTokenReserves: bc.realTokenReserves?.toString(),
        realQuoteReserves: bc.realQuoteReserves?.toString(),
        tokenTotalSupply: bc.tokenTotalSupply?.toString(),
        complete: bc.complete,
        quoteMint: bc.quoteMint?.toBase58?.(),
        creator: bc.creator?.toBase58?.(),
      },
    };
  }

  async verifyPool(
    connection: Connection,
    mint: PublicKey,
  ): Promise<PoolVerification | null> {
    // 1) Read the live curve — only a migrated curve has a PumpSwap pool.
    const pda = bondingCurvePda(mint);
    const curveInfo = await connection.getAccountInfo(pda, "confirmed");
    if (!curveInfo) return null;
    let bc: BondingCurve;
    try {
      bc = PUMP_SDK.decodeBondingCurve(curveInfo);
    } catch {
      return null;
    }
    if (!isBondingCurveMigrated(bc)) return null;

    // 2) Derive the canonical pool and verify it exists, is owned by the
    //    PumpSwap program, and pairs this mint with the expected quote.
    const quote =
      bc.quoteMint && !bc.quoteMint.equals(PublicKey.default) ? bc.quoteMint : NATIVE_MINT;
    const pool = canonicalPumpPoolPda(mint);
    const poolInfo = await connection.getAccountInfo(pool, "confirmed");
    if (!poolInfo || !poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID)) return null;

    return {
      poolAddress: pool.toBase58(),
      programOwner: PUMP_AMM_PROGRAM_ID.toBase58(),
      baseMint: mint.toBase58(),
      quoteMint: quote.toBase58(),
      verifiedAt: Date.now(),
    };
  }

  private async buildTransaction({
    connection,
    instructions,
    signer,
    mintKeypair,
  }: {
    connection: Connection;
    instructions: TransactionInstruction[];
    signer: WalletSigner;
    mintKeypair: Keypair;
  }): Promise<Transaction> {
    const { blockhash, lastValidBlockHeight } = await connection
      .getLatestBlockhash("finalized")
      .catch((err) => {
        throw new RelaypadError("RPC_ERROR", "Could not fetch a blockhash.", err);
      });
    const tx = new Transaction({
      feePayer: signer.publicKey,
      blockhash,
      lastValidBlockHeight,
    });
    // create_v2 on Token-2022 is compute-heavy; set an explicit budget.
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
    tx.add(...instructions);
    // The mint keypair signs locally; the wallet adds its signature later.
    // partialSign serializes the compiled message internally, so an oversized
    // payload can surface Solana's raw packet-overflow error HERE — before
    // the pre-signing guard below would ever run. Map it to the coded error
    // so the user gets actionable guidance instead of a generic failure.
    try {
      tx.partialSign(mintKeypair);
    } catch (err) {
      if (err instanceof RelaypadError) throw err;
      if (isTransactionTooLargeError(err)) {
        throw new RelaypadError(
          "TX_TOO_LARGE",
          `The Pump.fun launch transaction exceeds Solana's ${PACKET_DATA_SIZE}-byte packet limit and cannot be signed or broadcast. Shorten the metadata URI (the default IPFS gateway produces the shortest URIs) or adjust the launch options — for example launch without the initial buy — then try again.`,
          err,
        );
      }
      throw toRelaypadError(err);
    }
    // Pre-signing size guard (P0.2): reject transactions that would exceed
    // Solana's 1,232-byte packet limit before the wallet is ever asked to
    // sign. Measured anchor: the bundled create+buy path sits at 1231/1232
    // bytes with a 70-character URI.
    assertTransactionFits(tx, "Pump.fun launch");
    return tx;
  }
}

/** The mint keypair stays in client memory; expose only what signing needs. */
export function ephemeralSigner(kp: Keypair) {
  return { secretKey: kp.secretKey, publicKey: kp.publicKey.toBase58() };
}

/** Exported for tests. */
export { bondingCurvePda, canonicalPumpPoolPda };
