import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetRpcGatewayForTests,
  gatewayForward,
  gatewayHealthy,
  gatewayRetryAfterSeconds,
  gatewayRpc,
  rpcFetchMiddleware,
  rpcGatewayMetrics,
  RpcGatewayError,
  RpcGatewayOpenError,
} from "@/lib/rpc/rpc-gateway";

/**
 * Shared RPC gateway behavior (no network): coalescing, short-TTL read
 * caching, 429 Retry-After backoff with jitter + retry cap, circuit breaker,
 * bounded concurrency, and secret-free diagnostics.
 */

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function ok(result: unknown): Response {
  return jsonResponse(200, { jsonrpc: "2.0", id: 1, result });
}

function makeFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
  opts: { concurrency?: { current: number; max: number } } = {},
): ((url: string, init?: RequestInit) => Promise<Response>) & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push(String((init?.body as string) ?? ""));
    if (opts.concurrency) {
      opts.concurrency.current += 1;
      opts.concurrency.max = Math.max(opts.concurrency.max, opts.concurrency.current);
    }
    try {
      return await responder(url, init);
    } finally {
      if (opts.concurrency) opts.concurrency.current -= 1;
    }
  }) as ((url: string, init?: RequestInit) => Promise<Response>) & { calls: string[] };
  // Attach the recorder to the returned function (a cast alone does not).
  fn.calls = calls;
  return fn;
}

/** Sleep recorder: records requested backoff waits, then yields briefly on
 * the real clock so the gateway's refill loop can make progress. */
function fakeSleep(): ((ms: number) => Promise<void>) & { waits: number[] } {
  const waits: number[] = [];
  const fn = async (ms: number) => {
    waits.push(ms);
    await new Promise((r) => setTimeout(r, 1));
  };
  return Object.assign(fn, { waits });
}

beforeEach(() => {
  __resetRpcGatewayForTests();
  // Tests run on the real clock with a near-unlimited refill rate so the
  // token bucket never starves (avoids long busy-waits in tests).
  process.env.RPC_GATEWAY_RATE_RPS = "1000";
  delete process.env.RPC_GATEWAY_OPEN_BASE_MS;
});

afterEach(() => {
  delete process.env.RPC_GATEWAY_RATE_RPS;
  delete process.env.RPC_GATEWAY_OPEN_BASE_MS;
});


describe("rpc gateway — coalescing and read caching", () => {
  it("coalesces identical concurrent reads into ONE upstream call", async () => {
    const f = makeFetch(() => ok({ supply: 1 }));
    const sleep = fakeSleep();
    const opts = { doFetch: f as unknown as typeof fetch, sleep };
    const [a, b, c] = await Promise.all([
      gatewayRpc("getTokenSupply", ["Mint1"], opts),
      gatewayRpc("getTokenSupply", ["Mint1"], opts),
      gatewayRpc("getTokenSupply", ["Mint1"], opts),
    ]);
    expect(a).toEqual({ supply: 1 });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(f.calls).toHaveLength(1);
    expect(rpcGatewayMetrics().coalescedHits).toBe(2);
  });

  it("serves cached idempotent reads within the TTL (cache hit, no extra fetch)", async () => {
    const f = makeFetch(() => ok({ ctx: "account" }));
    const sleep = fakeSleep();
    const opts = { doFetch: f as unknown as typeof fetch, sleep };
    await gatewayRpc("getAccountInfo", ["Acc1"], opts);
    const again = await gatewayRpc("getAccountInfo", ["Acc1"], opts);
    expect(again).toEqual({ ctx: "account" });
    expect(f.calls).toHaveLength(1);
    expect(rpcGatewayMetrics().cacheHits).toBe(1);
  });

  it("never caches getLatestBlockhash (mutable, must be fresh)", async () => {
    let n = 0;
    const f = makeFetch(() => ok({ blockhash: `bh-${++n}` }));
    const sleep = fakeSleep();
    const opts = { doFetch: f as unknown as typeof fetch, sleep };
    const first = await gatewayRpc("getLatestBlockhash", [], opts);
    const second = await gatewayRpc("getLatestBlockhash", [], opts);
    expect(first).toEqual({ blockhash: "bh-1" });
    expect(second).toEqual({ blockhash: "bh-2" });
    expect(f.calls).toHaveLength(2);
  });

  it("expires cache entries after the TTL", async () => {
    const f = makeFetch(() => ok({ v: 1 }));
    const sleep = fakeSleep();
    const opts = { doFetch: f as unknown as typeof fetch, sleep };
    await gatewayRpc("getSlot", [], opts); // getSlot TTL is 750ms
    await new Promise((r) => setTimeout(r, 900)); // real wait past the TTL
    await gatewayRpc("getSlot", [], opts);
    expect(f.calls).toHaveLength(2);
  });
});

describe("rpc gateway — 429 handling, backoff, circuit breaker", () => {
  it("honors Retry-After on 429 and retries to success", async () => {
    let n = 0;
    const f = makeFetch(() => (++n === 1 ? jsonResponse(429, { error: "rate" }, { "retry-after": "2" }) : ok({ good: true })));
    const sleep = fakeSleep();
    const out = await gatewayRpc("getBalance", ["W"], { doFetch: f as unknown as typeof fetch, sleep });
    expect(out).toEqual({ good: true });
    expect(f.calls).toHaveLength(2);
    expect(sleep.waits.some((ms) => ms >= 2_000)).toBe(true); // Retry-After honored (base backoff is 500ms)
    expect(rpcGatewayMetrics().rateLimited429).toBe(1);
    expect(rpcGatewayMetrics().retriesTotal).toBe(1);
  });

  it("fails honestly after exhausting retries on persistent 429s", async () => {
    const f = makeFetch(() => jsonResponse(429, { error: "rate" }, { "retry-after": "1" }));
    const sleep = fakeSleep();
    await expect(
      gatewayRpc("getBalance", ["W"], { doFetch: f as unknown as typeof fetch, sleep }),
    ).rejects.toBeInstanceOf(RpcGatewayError);
    expect(f.calls).toHaveLength(3); // 1 attempt + 2 retries — no runaway storm
    expect(rpcGatewayMetrics().rateLimited429).toBe(3);
  });

  it("opens the circuit after repeated failures and then fails FAST without new fetches", async () => {
    const f = makeFetch(() => jsonResponse(429, { error: "rate" }, { "retry-after": "1" }));
    const sleep = fakeSleep();
    const opts = { doFetch: f as unknown as typeof fetch, sleep };
    // 5 consecutive failed calls (each: 3 attempts) trip the breaker.
    for (let i = 0; i < 5; i++) {
      await expect(gatewayRpc("getBalance", ["W"], opts)).rejects.toBeInstanceOf(RpcGatewayError);
    }
    const callsAtTrip = f.calls.length;
    expect(gatewayHealthy()).toBe(false);
    expect(rpcGatewayMetrics().circuit.state).toBe("open");
    expect(gatewayRetryAfterSeconds()).toBeGreaterThanOrEqual(1);
    await expect(gatewayRpc("getBalance", ["W"], opts)).rejects.toBeInstanceOf(RpcGatewayOpenError);
    expect(f.calls).toHaveLength(callsAtTrip); // fail-fast: zero new upstream calls
  });

  it("recovers via half-open after the cooldown", async () => {
    // Shorten the circuit-open window for a fast, real-clock test.
    process.env.RPC_GATEWAY_OPEN_BASE_MS = "60";
    __resetRpcGatewayForTests();
    let n = 0;
    const f = makeFetch(() => (++n <= 5 ? jsonResponse(429, { error: "rate" }, { "retry-after": "1" }) : ok({ back: true })));
    const sleep = fakeSleep();
    const opts = { doFetch: f as unknown as typeof fetch, sleep };
    for (let i = 0; i < 5; i++) {
      await expect(gatewayRpc("getBalance", ["W"], opts)).rejects.toBeInstanceOf(RpcGatewayError);
    }
    expect(gatewayHealthy()).toBe(false);
    // Wait past the shortened open window; the next call probes and succeeds.
    await new Promise((r) => setTimeout(r, 120));
    const out = await gatewayRpc("getBalance", ["W"], opts);
    expect(out).toEqual({ back: true });
    expect(gatewayHealthy()).toBe(true);
  });

  it("does not count JSON-RPC-level errors as provider-health failures", async () => {
    const f = makeFetch(() => jsonResponse(200, { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } }));
    const sleep = fakeSleep();
    await expect(gatewayRpc("getBalance", ["bad"], { doFetch: f as unknown as typeof fetch, sleep })).rejects.toBeInstanceOf(
      RpcGatewayError,
    );
    expect(rpcGatewayMetrics().circuit.consecutiveFailures).toBe(0);
  });
});

describe("rpc gateway — bounded concurrency and diagnostics", () => {
  it("bounds concurrent upstream requests", async () => {
    const conc = { current: 0, max: 0 };
    const f = makeFetch(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(ok({ x: 1 })), 5)),
      { concurrency: conc },
    );
    const sleep = fakeSleep();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        gatewayRpc("getBalance", [`W${i}`], { doFetch: f as unknown as typeof fetch, sleep }),
      ),
    );
    expect(conc.max).toBeLessThanOrEqual(6); // default RPC_GATEWAY_CONCURRENCY
  });

  it("exposes the upstream HOSTNAME only — never the URL or key", async () => {
    const f = makeFetch(() => ok({ v: 1 }));
    const sleep = fakeSleep();
    await gatewayRpc(
      "getBalance",
      ["W"],
      { doFetch: f as unknown as typeof fetch, sleep, url: "https://solana-mainnet.g.alchemy.com/v2/SECRETKEY123" },
    );
    const m = rpcGatewayMetrics();
    expect(m.upstreamHost).toBe("solana-mainnet.g.alchemy.com");
    expect(JSON.stringify(m)).not.toContain("SECRETKEY");
    expect(JSON.stringify(m)).not.toContain("/v2/");
  });

  it("reports latency and cache-hit telemetry", async () => {
    const f = makeFetch(() => ok({ v: 1 }));
    const sleep = fakeSleep();
    const opts = { doFetch: f as unknown as typeof fetch, sleep };
    await gatewayRpc("getTokenSupply", ["M"], opts);
    await gatewayRpc("getTokenSupply", ["M"], opts);
    const m = rpcGatewayMetrics();
    expect(m.requestsTotal).toBe(1);
    expect(m.cacheHits).toBe(1);
    expect(m.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(m.tokensAvailable).toBeGreaterThan(0);
  });
});

describe("rpc gateway — browser proxy forwarding", () => {
  it("preserves request ids for single and batch payloads", async () => {
    const f = makeFetch(() => ok({ slot: 42 }));
    const sleep = fakeSleep();
    const opts = { doFetch: f as unknown as typeof fetch, sleep };
    const single = await gatewayForward({ jsonrpc: "2.0", id: 7, method: "getSlot", params: [] }, opts);
    expect(single.status).toBe(200);
    expect(JSON.parse(single.body)).toEqual({ id: 7, result: { slot: 42 } });
    const batch = await gatewayForward(
      [
        { jsonrpc: "2.0", id: "a", method: "getSlot", params: [] },
        { jsonrpc: "2.0", id: "b", method: "getHealth", params: [] },
      ],
      opts,
    );
    expect(batch.status).toBe(200);
    const parsed = JSON.parse(batch.body) as { id: unknown; result: unknown }[];
    expect(parsed.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("returns an honest 429 with Retry-After when the gateway is still limited", async () => {
    const f = makeFetch(() => jsonResponse(429, { error: "rate" }, { "retry-after": "3" }));
    const sleep = fakeSleep();
    const out = await gatewayForward(
      { jsonrpc: "2.0", id: 9, method: "getBalance", params: ["W"] },
      { doFetch: f as unknown as typeof fetch, sleep },
    );
    expect(out.status).toBe(429);
    expect(out.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(out.body) as { id: number; error: { code: number } };
    expect(parsed.id).toBe(9);
    expect(parsed.error.code).toBe(-32005);
  });
});

describe("rpc gateway — web3.js fetch middleware (CPS admission gate)", () => {
  it("admits JSON-RPC requests through the shared bucket and passes args to the continuation", async () => {
    const before = rpcGatewayMetrics().tokensAvailable;
    const mw = rpcFetchMiddleware();
    let captured: [unknown, unknown] | null = null;
    mw(
      "https://rpc.example",
      { body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "getTokenSupply", params: ["MintX"] }) },
      (info, init) => {
        captured = [info, init];
      },
    );
    // Admission is async — wait a tick for the IIFE to run.
    await new Promise((r) => setTimeout(r, 30));
    const cap = captured as unknown as [unknown, unknown] | null;
    expect(cap).not.toBeNull();
    const [info, init] = cap as [unknown, unknown];
    expect(info).toBe("https://rpc.example");
    expect((init as RequestInit).body).toContain("getTokenSupply");
    // One token was spent on admission.
    expect(rpcGatewayMetrics().tokensAvailable).toBeLessThanOrEqual(before);
  });

  it("throws synchronously while the circuit is open (fail-fast, no request)", async () => {
    const f = makeFetch(() => jsonResponse(429, { error: "rate" }, { "retry-after": "1" }));
    const sleep = fakeSleep();
    const opts = { doFetch: f as unknown as typeof fetch, sleep };
    for (let i = 0; i < 5; i++) {
      await expect(gatewayRpc("getBalance", ["W"], opts)).rejects.toBeInstanceOf(RpcGatewayError);
    }
    expect(gatewayHealthy()).toBe(false);
    const mw = rpcFetchMiddleware();
    let nextCalled = false;
    expect(() =>
      mw("https://rpc.example", { body: "{}" }, () => {
        nextCalled = true;
      }),
    ).toThrow(RpcGatewayOpenError);
    expect(nextCalled).toBe(false);
  });

  it("releases the concurrency slot after admission", async () => {
    const mw = rpcFetchMiddleware();
    mw("https://rpc.example", { body: "{}" }, () => {});
    await new Promise((r) => setTimeout(r, 30));
    expect(rpcGatewayMetrics().inFlight).toBe(0);
  });
});


