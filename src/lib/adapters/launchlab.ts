/**
 * Route B — Raydium LaunchLab bonding curve → Raydium CPMM.
 *
 * Built on the official `@raydium-io/raydium-sdk-v2` (0.2.74-alpha):
 * - Launch config via `getPdaLaunchpadConfigId(programId, quoteMint, 0, 0)`
 *   decoded with `LaunchpadConfig.decode` (quote mint, curve, fees, thresholds).
 * - Launch via `raydium.launchpad.createLaunchpad(...)` with
 *   `migrateType: "cpmm"` (post-2026-09 upgrade: all new launches are
 *   CPMM-only) and `extraSigners: [mintKeypair]` (required — omitting it
 *   fails signature verification).
 * - Curve state via `LaunchpadPool.decode` on the pool PDA from
 *   `getPdaLaunchpadPoolId(programId, mintA, mintB)`.
 * - Graduation: LaunchLab's migration wallet signs `MigrateToCpswap` —
 *   FluxPad never executes it. Destination pool discovery uses Raydium's
 *   launch-mint service (the endpoint used by Raydium's own demo) and every
 *   candidate pool is verified on-chain against the Raydium CPMM program
 *   before being displayed.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  Raydium,
  TxVersion,
  LAUNCHPAD_PROGRAM,
  DEVNET_PROGRAM_ID,
  LaunchpadConfig,
  LaunchpadPool,
  getPdaLaunchpadConfigId,
  getPdaLaunchpadPoolId,
} from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT } from "@solana/spl-token";
import type { ClusterId } from "../constants";
import { FluxpadError } from "../connection";
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

/** Raydium CPMM program (matches the SDK's CREATE_CPMM_POOL_PROGRAM). */
const CPMM_PROGRAM_ID = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";

/** Raydium's own launch-mint discovery service (official demo: src/launchpad/url.ts). */
const RAYDIUM_MINT_INFO_URL = "https://launch-mint-v1.raydium.io/get/by/mints";

/** LaunchLab status values (LaunchpadPool.status, numeric). */
export const LAUNCHPAD_STATUS = {
  INIT: 0,
  CREATE: 1,
  BUY: 2,
  SELL: 3,
  FUND: 4,
  MIGRATE: 5,
  MINT: 6,
} as const;

function programFor(cluster: ClusterId): PublicKey {
  return cluster === "devnet"
    ? DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM
    : LAUNCHPAD_PROGRAM;
}

/** Estimated SOL cost of launch + ATA + fees before any initial buy. */
const BASE_COST_LAMPORTS = BigInt(1_300_000);

interface MintInfoRow {
  mint: string;
  poolId?: string;
  migrateAmmId?: string;
  status?: number;
}
export class LaunchLabAdapter implements RouteAdapter {
  readonly id = "launchlab" as const;
  readonly label = "LaunchLab → CPMM";
  readonly description =
    "Launch on Raydium LaunchLab's bonding curve. After the funding threshold is crossed the curve graduates into a Raydium CPMM pool.";

  describePrograms(cluster: ClusterId) {
    return [
      { name: "LaunchLab program", address: programFor(cluster).toBase58() },
      { name: "Raydium CPMM program", address: CPMM_PROGRAM_ID },
    ];
  }

  async loadConfig(
    connection: Connection,
    cluster: ClusterId,
  ): Promise<RouteConfigInfo> {
    const programId = programFor(cluster);
    // Bind the default SOL-quoted curve config (curve type 0, index 0).
    const configId = getPdaLaunchpadConfigId(programId, NATIVE_MINT, 0, 0).publicKey;
    const data = await connection.getAccountInfo(configId, "confirmed");
    if (!data) {
      throw new FluxpadError(
        "PROTOCOL",
        `LaunchLab config account ${configId.toBase58()} not found on ${cluster}. LaunchLab is not deployed/configured for this cluster + quote mint.`,
      );
    }
    const config = LaunchpadConfig.decode(data.data);
    // Validate the quote mint side: the real mint account must exist.
    const mintB = await connection.getParsedAccountInfo(config.mintB);
    if (!mintB.value) {
      throw new FluxpadError(
        "PROTOCOL",
        `LaunchLab quote mint ${config.mintB.toBase58()} does not exist on ${cluster}.`,
      );
    }

    return {
      route: "launchlab",
      cluster,
      supportsInitialBuy: true,
      supportsVanityMint: true,
      details: {
        programId: programId.toBase58(),
        configId: configId.toBase58(),
        mintB: config.mintB.toBase58(),
        curveType: Number(config.curveType),
        // Observed config economics (decoded from the on-chain account).
        tradeFeeRate: config.tradeFeeRate?.toString?.() ?? null,
        minFundRaisingB: config.minFundRaisingB?.toString?.() ?? null,
        migrateFee: config.migrateFee?.toString?.() ?? null,
        minMigrateRateA: config.minMigrateRateA?.toString?.() ?? null,
      },
    };
  }
  async prepareLaunch({
    connection,
    cluster,
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
    const programId = programFor(cluster);
    const raydium = await Raydium.load({
      owner: signer.publicKey,
      connection,
      cluster: cluster === "devnet" ? "devnet" : "mainnet",
      disableFeatureCheck: true,
      blockhashCommitment: "finalized",
    });

    const configId = getPdaLaunchpadConfigId(programId, NATIVE_MINT, 0, 0).publicKey;
    const configData = await connection.getAccountInfo(configId, "confirmed");
    if (!configData) {
      throw new FluxpadError(
        "PROTOCOL",
        `LaunchLab config ${configId.toBase58()} disappeared before launch. Re-validate the route and retry.`,
      );
    }
    const configInfo = LaunchpadConfig.decode(configData.data);
    const mintBInfo = await raydium.token.getTokenInfo(configInfo.mintB);
    if (!mintBInfo) {
      throw new FluxpadError("PROTOCOL", "Quote mint info unavailable.");
    }

    const { transactions } = await raydium.launchpad.createLaunchpad({
      programId,
      // Devnet requires the devnet platform config; mainnet keeps the SDK's
      // default Raydium platform.
      ...(cluster === "devnet"
        ? { platformId: DEVNET_PROGRAM_ID.LAUNCHPAD_PLATFORM }
        : {}),
      mintA: mintKeypair.publicKey,
      decimals: 6,
      name: input.name,
      symbol: input.symbol,
      uri: input.metadataUri,
      // Post-2026-09 upgrade: all new launches are CPMM-only.
      migrateType: "cpmm",
      configId,
      configInfo,
      mintBDecimals: mintBInfo.decimals,
      mintBProgram: new PublicKey(mintBInfo.programId),
      createOnly: input.initialBuyLamports === 0n,
      buyAmount: new BN(
        (input.initialBuyLamports > 0n ? input.initialBuyLamports : 0n).toString(),
      ),
      slippage: new BN(input.slippageBps),
      txVersion: TxVersion.V0,
      // REQUIRED: the mint keypair must sign; omitting it fails signature
      // verification (LaunchLab docs, "Pitfalls").
      extraSigners: [mintKeypair],
    });
    const breakdown: { label: string; lamports: bigint }[] = [];
    const protocolNotes: string[] = [];
    breakdown.push({ label: "Rent + fees (estimate)", lamports: BASE_COST_LAMPORTS });
    if (input.initialBuyLamports > 0n) {
      breakdown.push({ label: "Initial buy (quote)", lamports: input.initialBuyLamports });
    }
    protocolNotes.push(
      "createLaunchpad with migrateType=cpmm — all new LaunchLab launches are CPMM-only.",
    );
    protocolNotes.push(
      "Graduation is executed by LaunchLab's migration wallet (MigrateToCpswap) — FluxPad detects and verifies it, never executes it.",
    );

    // The SDK builds V0 transactions with extraSigners; make sure the mint
    // signature slot is actually filled before the wallet signs.
    const prepared: PreparedTransaction[] = transactions.map((tx, index) => {
      const vt = tx as VersionedTransaction;
      ensureMintSignature(vt, mintKeypair);
      // Pre-signing size guard (P0.2): measured anchor — 1209/1232 bytes with
      // a 400-character URI; reject anything larger before wallet signing.
      assertTransactionFits(
        vt,
        `LaunchLab launch transaction ${index + 1} of ${transactions.length}`,
      );
      return {
        tx: vt,
        extraSigners: [
          {
            secretKey: mintKeypair.secretKey,
            publicKey: mintKeypair.publicKey.toBase58(),
          },
        ],
      };
    });

    return {
      route: "launchlab",
      mintAddress: mintKeypair.publicKey.toBase58(),
      transactions: prepared,
      estimatedTotalLamports: breakdown.reduce((acc, b) => acc + b.lamports, 0n),
      breakdown,
      protocolNotes,
      requiresMintSigner: true,
    };
  }
  /**
   * Resolve the LaunchLab curve account for a mint without knowing the
   * cluster: try both official program IDs and return the one whose pool PDA
   * actually exists. Throws when neither exists.
   */
  private async resolveCurveAccount(
    connection: Connection,
    mint: PublicKey,
  ): Promise<{ poolId: PublicKey; programId: PublicKey }> {
    for (const cluster of ["mainnet-beta", "devnet"] as const) {
      const programId = programFor(cluster);
      const poolId = getPdaLaunchpadPoolId(programId, mint, NATIVE_MINT).publicKey;
      const info = await connection.getAccountInfo(poolId, "confirmed");
      if (info) return { poolId, programId };
    }
    throw new FluxpadError(
      "PROTOCOL",
      `No LaunchLab curve account found for mint ${mint.toBase58()} on mainnet-beta or devnet.`,
    );
  }

  async readCurveState(
    connection: Connection,
    mint: PublicKey,
  ): Promise<CurveState> {
    const { poolId } = await this.resolveCurveAccount(connection, mint);
    const info = await connection.getAccountInfo(poolId, "confirmed");
    if (!info) {
      throw new FluxpadError(
        "PROTOCOL",
        `LaunchLab curve state not found for mint ${mint.toBase58()}.`,
      );
    }
    const state = LaunchpadPool.decode(info.data);
    const status = Number(state.status);
    const realB = BigInt(state.realB.toString());

    return {
      onCurve: status <= LAUNCHPAD_STATUS.SELL,
      quoteReserves: realB,
      virtualQuoteReserves: BigInt(state.virtualB.toString()),
      baseSold: BigInt(state.supply.sub(state.virtualA).toString()),
      complete: status >= LAUNCHPAD_STATUS.FUND,
      observedAt: Date.now(),
      raw: {
        programOwner: info.owner.toBase58(),
        poolId: poolId.toBase58(),
        status,
        statusHint:
          status <= LAUNCHPAD_STATUS.SELL
            ? "curve trading"
            : status === LAUNCHPAD_STATUS.FUND
              ? "funding threshold reached; awaiting protocol migration"
              : "migrated",
        mintB: state.mintB?.toBase58?.(),
        virtualA: state.virtualA.toString(),
        virtualB: state.virtualB.toString(),
        realA: state.realA.toString(),
        realB: state.realB.toString(),
        totalFundRaisingB: state.totalFundRaisingB.toString(),
        totalSellA: state.totalSellA.toString(),
        migrateType: state.migrateType,
        configId: state.configId?.toBase58?.(),
        creator: state.creator?.toBase58?.(),
      },
    };
  }

  async verifyPool(
    connection: Connection,
    mint: PublicKey,
  ): Promise<PoolVerification | null> {
    // 1) Discover candidate destination pool(s) via Raydium's launch-mint
    //    service, then verify on-chain. Discovery alone is never trusted.
    let rows: MintInfoRow[];
    try {
      const res = await fetch(`${RAYDIUM_MINT_INFO_URL}?ids=${mint.toBase58()}`);
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: { rows?: MintInfoRow[] } };
      rows = json.data?.rows ?? [];
    } catch {
      // Discovery service unreachable — cannot claim a pool exists.
      return null;
    }
    const row = rows.find((r) => r.mint === mint.toBase58());
    const candidate = row?.migrateAmmId;
    if (!candidate) return null;

    // 2) On-chain verification: exists and owned by the Raydium CPMM program.
    let poolInfo;
    try {
      poolInfo = await connection.getAccountInfo(new PublicKey(candidate), "confirmed");
    } catch {
      return null;
    }
    if (!poolInfo || !poolInfo.owner.toBase58().startsWith("CPMMoo8")) return null;

    return {
      poolAddress: candidate,
      programOwner: poolInfo.owner.toBase58(),
      baseMint: mint.toBase58(),
      quoteMint: NATIVE_MINT.toBase58(),
      verifiedAt: Date.now(),
    };
  }
}

/**
 * Fill the mint keypair's signature slot on a V0 transaction if it is empty.
 * The SDK may or may not have signed with extraSigners during build; this is
 * idempotent and keeps the wallet's signing step valid.
 */
export function ensureMintSignature(
  tx: VersionedTransaction,
  mintKeypair: Keypair,
): void {
  const mintIndex = tx.message.staticAccountKeys.findIndex((k) =>
    k.equals(mintKeypair.publicKey),
  );
  if (mintIndex === -1) return;
  const existing = tx.signatures[mintIndex];
  // A zeroed 64-byte buffer means the slot is unsigned.
  const isZero = existing?.every((b) => b === 0) ?? true;
  if (existing && !isZero) return;
  tx.sign([mintKeypair]);
}
