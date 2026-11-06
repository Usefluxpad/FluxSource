import type { PrismaClient, Prisma } from "@prisma/client";
import { PublicKey } from "@solana/web3.js";
import { getAdapter } from "./adapters";
import { FluxpadError, resolveServerNetworkConfig, getConnection } from "./connection";
import type { LaunchRoute } from "./adapters/types";

/**
 * Server-side lifecycle reconciliation.
 *
 * Rule: on-chain state is the source of truth. The database never decides on
 * its own that a launch graduated — every transition below is backed by an
 * account read through the route adapters:
 *  - confirmed:    launch transaction succeeded (status recorded by client,
 *                  re-validated here via getSignatureStatus).
 *  - curve_trading / graduation_detected: from the bonding-curve account.
 *  - pool_verified: from the destination pool account (program owner checked).
 *
 * Event writes are idempotent (unique dedupeKey per launch), so duplicated
 * reconciles are harmless.
 */

const ROUTE_BY_DB: Record<string, LaunchRoute> = {
  PUMP_PUMPSWAP: "pump",
  LAUNCHLAB_CPMM: "launchlab",
};

export async function resolveLaunch(
  db: PrismaClient,
  launchId: string,
): Promise<Record<string, unknown>> {
  const launch = await db.launch.findUnique({ where: { id: launchId } });
  if (!launch) throw new Error("launch not found");

  if (!launch.mintAddress) return launch;

  const cfg = resolveServerNetworkConfig(launch.network);
  const connection = getConnection(cfg);
  const mint = new PublicKey(launch.mintAddress);
  const route = ROUTE_BY_DB[launch.route];
  const adapter = await getAdapter(route);

  const updates: Record<string, unknown> = {};
  const events: {
    kind: string;
    dedupeKey: string;
    detail: Prisma.InputJsonValue;
  }[] = [];

  // 1) Signature status (if known).
  if (launch.signature) {
    try {
      const status = await connection.getSignatureStatus(launch.signature);
      if (status.value?.err) {
        updates.status = "FAILED";
        updates.lastError = `On-chain failure: ${JSON.stringify(status.value.err)}`;
        events.push({
          kind: "failed",
          dedupeKey: `failed:${launch.signature}`,
          detail: { source: "signature_status" },
        });
      } else if (status.value) {
        updates.slot = status.value.slot ?? launch.slot;
        if (launch.status === "SUBMITTED" || launch.status === "PREPARATION") {
          // Verify the transaction actually belongs to this launch route
          // before promoting: the launch program must appear in the
          // transaction logs and the mint must be among its accounts. An
          // unavailable lookup (indexing lag) falls back to the
          // signature-status evidence; an explicit mismatch withholds
          // promotion — the record stays unverified rather than being
          // attributed to the wrong route.
          const programAddress = adapter.describePrograms(cfg.cluster)[0]?.address;
          let programVerified: "yes" | "unavailable" | "mismatch" = "unavailable";
          try {
            const txInfo = await connection.getTransaction(launch.signature, {
              maxSupportedTransactionVersion: 0,
            });
            if (txInfo) {
              const logs: string[] = txInfo.meta?.logMessages ?? [];
              const rawMessage = (
                txInfo.transaction as { message?: { accountKeys?: unknown } }
              )?.message;
              const accountKeys: unknown[] = Array.isArray(rawMessage?.accountKeys)
                ? (rawMessage.accountKeys as unknown[])
                : [];
              const programInLogs =
                programAddress != null && logs.some((l) => l.includes(programAddress));
              const mintInAccounts = accountKeys.some((k) => {
                const pk =
                  typeof k === "string"
                    ? k
                    : ((k as { pubkey?: string | { toBase58(): string } }).pubkey ?? "");
                return typeof pk === "string" ? pk === launch.mintAddress : false;
              });
              programVerified =
                programInLogs && mintInAccounts ? "yes" : "mismatch";
            }
          } catch {
            // Transaction lookup unavailable (indexing lag) — signature
            // status remains the promotion evidence.
          }
          if (programVerified !== "mismatch") {
            updates.status = "CONFIRMED";
            events.push({
              kind: "confirmed",
              dedupeKey: `confirmed:${launch.signature}`,
              detail: { source: "signature_status", programVerified },
            });
          } else {
            updates.lastError =
              "reconcile: transaction/route mismatch — CONFIRMED promotion withheld";
          }
        }
      }
    } catch (err) {
      // RPC outage — leave the record untouched; a later reconcile retries.
      updates.lastError = `reconcile: signature status unavailable (${String(err).slice(0, 200)})`;
    }
  }

  // 2) Curve state (throws typed errors the caller maps to a failed reconcile).
  let curve = null;
  try {
    curve = await adapter.readCurveState(connection, mint);
    updates.curveState = curve.raw as Prisma.InputJsonObject;
    if (curve.onCurve && (launch.status === "CONFIRMED" || launch.status === "SUBMITTED")) {
      updates.status = "CURVE_TRADING";
      events.push({
        kind: "curve_trading",
        dedupeKey: `curve:${launch.mintAddress}`,
        detail: { raw: curve.raw as Prisma.InputJsonValue },
      });
    }
    if (curve.complete === true && launch.status !== "POOL_VERIFIED") {
      updates.status = "GRADUATION_DETECTED";
      events.push({
        kind: "graduation_detected",
        dedupeKey: `grad:${launch.mintAddress}`,
        detail: { raw: curve.raw as Prisma.InputJsonValue },
      });
    }
  } catch (err) {
    if (err instanceof FluxpadError && err.code === "PROTOCOL") {
      // Curve account may have been closed post-migration on some routes —
      // don't roll back a verified state; note it and continue to pool check.
      updates.lastError = `reconcile: ${err.message.slice(0, 200)}${
        updates.lastError ? ` | ${String(updates.lastError).slice(0, 200)}` : ""
      }`;
    } else {
      throw err;
    }
  }

  // 3) Destination pool verification.
  if (launch.status !== "POOL_VERIFIED" && launch.mintAddress) {
    try {
      const pool = await adapter.verifyPool(connection, mint);
      if (pool) {
        updates.poolAddress = pool.poolAddress;
        updates.poolVerifiedAt = new Date(pool.verifiedAt);
        updates.status = "POOL_VERIFIED";
        events.push({
          kind: "pool_verified",
          dedupeKey: `pool:${pool.poolAddress}`,
          detail: { pool } as unknown as Prisma.InputJsonValue,
        });
      }
    } catch (err) {
      updates.lastError = `reconcile: pool verify failed (${String(err).slice(0, 150)})${
        updates.lastError ? ` | ${String(updates.lastError).slice(0, 200)}` : ""
      }`;
    }
  }

  // Apply updates + idempotent events in sequence.
  const updated = await db.launch.update({
    where: { id: launch.id },
    data: updates as unknown as Prisma.LaunchUpdateInput,
  });
  for (const ev of events) {
    await db.launchEvent.upsert({
      where: { launchId_dedupeKey: { launchId: launch.id, dedupeKey: ev.dedupeKey } },
      create: {
        launchId: launch.id,
        kind: ev.kind,
        dedupeKey: ev.dedupeKey,
        detail: ev.detail,
      },
      update: {},
    });
  }
  return updated;
}
