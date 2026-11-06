/**
 * FluxPad protocol constants.
 *
 * Every address below is taken from official documentation, not invented:
 * - PumpSwap program + global config:
 *   https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md
 * - Pump bonding-curve program (pump.fun): 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 *   (as published in pump-public-docs / @pump-fun/pump-sdk).
 * - LaunchLab program IDs come from @raydium-io/raydium-sdk-v2 exports
 *   (LAUNCHPAD_PROGRAM / DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM) — see adapters/launchlab.ts.
 *
 * PDA seeds used in verification:
 * - Pump: global ["global"], mint authority ["mint-authority"],
 *   bonding curve ["bonding-curve", mint].
 * - PumpSwap pool: ["pool", index(u16 LE), creator, baseMint, quoteMint].
 */
import { PublicKey } from "@solana/web3.js";

export const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
);

export const PUMPSWAP_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
);

export const PUMPSWAP_GLOBAL_CONFIG = new PublicKey(
  "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw",
);

/** Token-2022 program — pump create_v2 mints Token-2022 with 6 decimals. */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

export const NATIVE_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
);

export function pumpGlobalPda(programId: PublicKey = PUMP_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    programId,
  )[0];
}

export function pumpMintAuthorityPda(
  programId: PublicKey = PUMP_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mint-authority")],
    programId,
  )[0];
}

export function pumpBondingCurvePda(
  mint: PublicKey,
  programId: PublicKey = PUMP_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    programId,
  )[0];
}

export function pumpEventAuthorityPda(
  programId: PublicKey = PUMP_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId,
  )[0];
}

/** PumpSwap pool PDA per PUMP_SWAP_README: ["pool", index(u16 LE), creator, base, quote]. */
export function pumpswapPoolPda(
  index: number,
  creator: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  programId: PublicKey = PUMPSWAP_PROGRAM_ID,
): PublicKey {
  const indexBuf = Buffer.alloc(2);
  indexBuf.writeUInt16LE(index, 0);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      indexBuf,
      creator.toBuffer(),
      baseMint.toBuffer(),
      quoteMint.toBuffer(),
    ],
    programId,
  )[0];
}

export type ClusterId = "devnet" | "mainnet-beta";

export function clusterApiEndpoint(cluster: ClusterId): string {
  return cluster === "devnet"
    ? "https://api.devnet.solana.com"
    : "https://api.mainnet-beta.solana.com";
}

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Explorer helpers (never fabricated; links render only for known addresses/sigs). */
export function explorerUrl(
  cluster: ClusterId,
  kind: "address" | "tx",
  value: string,
): string {
  const suffix = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/${kind}/${value}${suffix}`;
}

export function solscanUrl(
  cluster: ClusterId,
  kind: "account" | "tx",
  value: string,
): string {
  const suffix = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://solscan.io/${kind}/${value}${suffix}`;
}
