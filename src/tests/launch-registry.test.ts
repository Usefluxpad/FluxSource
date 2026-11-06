import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

/**
 * Launch-registry regression tests (missing-deployments fix).
 *
 * The real POST /api/launches/[id] handler and the real resolveLaunch
 * reconciler run against an in-memory fake Prisma client and a stub Solana
 * connection — the full provenance-binding → on-chain reconciliation →
 * status-promotion path is exercised without touching the real database or
 * submitting any transaction.
 */

const holders = vi.hoisted(() => ({
  db: { current: null as unknown },
  connection: { current: null as unknown },
}));

vi.mock("@/lib/db", () => ({
  getDb: () => holders.db.current,
}));

vi.mock("@/lib/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/connection")>();
  return {
    ...actual,
    getConnection: () => holders.connection.current,
    resolveServerNetworkConfig: () => ({
      cluster: "mainnet-beta" as const,
      rpcUrl: "stub",
      commitment: "confirmed" as const,
      wsUrl: null,
      provider: "alchemy" as const,
    }),
  };
});

import { POST } from "@/app/api/launches/[id]/route";
import { relayRouteOf } from "@/lib/discovery/runtime";

const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

interface FakeLaunchRow {
  id: string;
  name: string;
  symbol: string;
  route: string;
  network: string;
  status: string;
  mintAddress: string | null;
  signature: string | null;
  slot: number | null;
  poolAddress: string | null;
  lastError: string | null;
}

function makeFakeDb(seed: FakeLaunchRow) {
  const state: { row: FakeLaunchRow; updates: Record<string, unknown>[]; events: unknown[] } = {
    row: { ...seed },
    updates: [],
    events: [],
  };
  const db = {
    launch: {
      findFirst: vi.fn(async () => ({ ...state.row })),
      findUnique: vi.fn(async () => ({ ...state.row })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.row, data);
        state.updates.push({ ...data });
        return { ...state.row };
      }),
    },
    launchEvent: {
      upsert: vi.fn(async ({ create }: { create: unknown }) => {
        state.events.push(create);
        return create;
      }),
    },
  };
  return { db, state };
}

function makeConnection(opts: {
  signatureStatus: { err: unknown } | null | undefined;
  transaction?: {
    meta: { logMessages: string[] };
    transaction: { message: { accountKeys: unknown[] } };
  } | null;
}) {
  return {
    getSignatureStatus: vi.fn(async () => ({ value: opts.signatureStatus ?? null })),
    getTransaction: vi.fn(async () => opts.transaction ?? null),
    getAccountInfo: vi.fn(async () => null),
  };
}

async function postEvent(launchRef: string, payload: Record<string, unknown>) {
  const req = new Request("http://localhost/api/launches/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const ctx = { params: Promise.resolve({ id: launchRef }) };
  return POST(req as never, ctx as never);
}

const seedLaunch = (over: Partial<FakeLaunchRow> = {}): FakeLaunchRow => ({
  id: "launch-1",
  name: "Registry Test",
  symbol: "RGT",
  route: "PUMP_PUMPSWAP",
  network: "mainnet-beta",
  status: "PREPARATION",
  mintAddress: null,
  signature: null,
  slot: null,
  poolAddress: null,
  lastError: null,
  ...over,
});

const mintA = Keypair.generate().publicKey.toBase58();
const mintB = Keypair.generate().publicKey.toBase58();
const signature = "5" + "a".repeat(86); // fixture — mocked RPC, not a real signature

beforeEach(() => {
  holders.db.current = null;
  holders.connection.current = null;
});

describe("launch event → provenance binding → on-chain reconciliation", () => {
  it("a confirmed event binds mint + signature and promotes the record to CONFIRMED", async () => {
    const fake = makeFakeDb(seedLaunch());
    holders.db.current = fake.db;
    holders.connection.current = makeConnection({
      signatureStatus: { err: null },
      transaction: {
        meta: { logMessages: [`Program ${PUMP_PROGRAM_ID} invoke [1]`, "Program log: Success"] },
        transaction: { message: { accountKeys: [{ pubkey: mintA }, { pubkey: Keypair.generate().publicKey.toBase58() }] } },
      },
    });
    const res = await postEvent("launch-1", {
      kind: "confirmed",
      signature,
      mintAddress: mintA,
      detail: { network: "mainnet-beta" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { launch: { status: string; mintAddress: string; signature: string } };
    // On-chain evidence (signature status + program/mint match) → CONFIRMED.
    expect(body.launch.status).toBe("CONFIRMED");
    expect(body.launch.mintAddress).toBe(mintA);
    expect(body.launch.signature).toBe(signature);
    // Provenance was persisted (write-once) before reconciliation.
    expect(fake.state.updates[0]).toMatchObject({ mintAddress: mintA, signature });
    // The promotion update carries the verified status.
    expect(fake.state.updates[fake.state.updates.length - 1]).toMatchObject({ status: "CONFIRMED" });
    // The confirmed event records the program/mint verification outcome.
    expect(fake.state.events.some((e) => {
      const ev = e as { kind: string; detail?: { programVerified?: string } };
      return ev.kind === "confirmed" && ev.detail?.programVerified === "yes";
    })).toBe(true);
  });

  it("a transaction/route mismatch withholds promotion (record stays unverified)", async () => {
    const fake = makeFakeDb(seedLaunch());
    holders.db.current = fake.db;
    holders.connection.current = makeConnection({
      signatureStatus: { err: null },
      transaction: {
        // Logs from an unrelated program; the mint is not in the accounts.
        meta: { logMessages: ["Program SomeOtherProgram111111111111111111111111111 invoke [1]"] },
        transaction: { message: { accountKeys: [{ pubkey: Keypair.generate().publicKey.toBase58() }] } },
      },
    });
    const res = await postEvent("launch-1", {
      kind: "confirmed",
      signature,
      mintAddress: mintA,
    });
    const body = (await res.json()) as { launch: { status: string; lastError: string | null } };
    expect(body.launch.status).toBe("PREPARATION");
    expect(body.launch.lastError ?? "").toContain("mismatch");
    // Provenance is still bound, but no CONFIRMED promotion happened.
    expect(fake.state.updates[0]).toMatchObject({ mintAddress: mintA, signature });
    expect(fake.state.updates.some((u) => (u as { status?: string }).status === "CONFIRMED")).toBe(false);
  });

  it("provenance is write-once: an existing mint is never re-attributed", async () => {
    const fake = makeFakeDb(seedLaunch({ mintAddress: mintA }));
    holders.db.current = fake.db;
    holders.connection.current = makeConnection({ signatureStatus: { err: null } });
    await postEvent("launch-1", {
      kind: "confirmed",
      signature,
      mintAddress: mintB, // conflicting mint — must be ignored
    });
    const provenanceUpdate = fake.state.updates[0] as { mintAddress?: string; signature?: string };
    expect(provenanceUpdate.mintAddress).toBeUndefined(); // existing mint untouched
    expect(provenanceUpdate.signature).toBe(signature);
    // The record stays bound to the original mint.
    expect(fake.state.row.mintAddress).toBe(mintA);
  });

  it("an unresolved outcome with an unknown signature stays PREPARATION (status unknown)", async () => {
    const fake = makeFakeDb(seedLaunch());
    holders.db.current = fake.db;
    holders.connection.current = makeConnection({ signatureStatus: null });
    const res = await postEvent("launch-1", {
      kind: "unresolved",
      signature,
      mintAddress: mintA,
    });
    const body = (await res.json()) as { launch: { status: string } };
    expect(body.launch.status).toBe("PREPARATION");
    // Provenance is bound so a later reconcile can still resolve it.
    expect(fake.state.row.mintAddress).toBe(mintA);
    expect(fake.state.row.signature).toBe(signature);
    expect(fake.state.updates.some((u) => (u as { status?: string }).status === "FAILED")).toBe(false);
  });

  it("a client-reported failure is re-validated: a landed signature resolves to CONFIRMED", async () => {
    const fake = makeFakeDb(seedLaunch());
    holders.db.current = fake.db;
    holders.connection.current = makeConnection({
      signatureStatus: { err: null }, // the "failed" signature actually landed
      transaction: {
        meta: { logMessages: [`Program ${PUMP_PROGRAM_ID} invoke [1]`] },
        transaction: { message: { accountKeys: [{ pubkey: mintA }] } },
      },
    });
    const res = await postEvent("launch-1", {
      kind: "failed",
      signature,
      mintAddress: mintA,
      error: "Transaction was not confirmed in time",
    });
    const body = (await res.json()) as { launch: { status: string } };
    // The chain is the source of truth — the client's failed claim does not
    // demote a transaction that actually succeeded.
    expect(body.launch.status).toBe("CONFIRMED");
    expect(fake.state.updates.some((u) => (u as { status?: string }).status === "FAILED")).toBe(false);
  });
});

describe("relayRouteOf (FluxPad-tab route filters)", () => {
  it("parses the registry provenance route prefix", () => {
    expect(
      relayRouteOf({ source: "relaypad", provenance: "relaypad-registry(pump_pumpswap)" } as never),
    ).toBe("pump");
    expect(
      relayRouteOf({ source: "relaypad", provenance: "relaypad-registry(launchlab_cpmm)" } as never),
    ).toBe("launchlab");
  });

  it("returns null when the route cannot be established", () => {
    expect(relayRouteOf({ source: "relaypad", provenance: "relaypad-registry(unknown)" } as never)).toBeNull();
    expect(relayRouteOf({ source: "pumpfun.curve", provenance: "x" } as never)).toBe("pump");
  });
});