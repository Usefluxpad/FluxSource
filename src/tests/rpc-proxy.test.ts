import { describe, expect, it } from "vitest";
import {
  isAllowedBrowserRpcMethod,
  isJsonRpcPayload,
  payloadMethodsAllowed,
  PerIpRateLimiter,
} from "@/lib/rpc-proxy-policy";
import { resolveBrowserRpcEndpoint } from "@/lib/connection";
import { clusterApiEndpoint } from "@/lib/constants";

/**
 * Browser RPC proxy policy + resolver tests (no network): the proxy must
 * accept every method the launch flow needs, reject expensive/indexing
 * methods, and the browser endpoint must never embed server credentials.
 */

describe("browser RPC method allowlist", () => {
  it("allows everything the launch flow needs", () => {
    for (const m of [
      "getHealth",
      "getVersion",
      "getLatestBlockhash",
      "getFeeForMessage",
      "getMinimumBalanceForRentExemption",
      "simulateTransaction",
      "sendTransaction",
      "getSignatureStatuses",
      "getAccountInfo",
      "getMultipleAccounts",
      "getBalance",
      "getTransaction",
    ]) {
      expect(isAllowedBrowserRpcMethod(m)).toBe(true);
    }
  });

  it("rejects expensive indexing and unneeded methods", () => {
    for (const m of [
      "getProgramAccounts",
      "getLogs",
      "getSignaturesForAddress",
      "getVoteAccounts",
      "sendRawTransaction", // not a real JSON-RPC method name
      "",
    ]) {
      expect(isAllowedBrowserRpcMethod(m)).toBe(false);
    }
  });

  it("requires every batch entry to be allowed", () => {
    const okSingle = { jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [] };
    const okBatch = [okSingle, { jsonrpc: "2.0", id: 2, method: "getSlot" }];
    const badBatch = [okSingle, { jsonrpc: "2.0", id: 3, method: "getProgramAccounts" }];
    expect(isJsonRpcPayload(okSingle)).toBe(true);
    expect(isJsonRpcPayload(okBatch)).toBe(true);
    expect(isJsonRpcPayload([])).toBe(false);
    expect(isJsonRpcPayload("not json")).toBe(false);
    expect(payloadMethodsAllowed(okSingle)).toBe(true);
    expect(payloadMethodsAllowed(okBatch)).toBe(true);
    expect(payloadMethodsAllowed(badBatch)).toBe(false);
  });
});

describe("browser RPC endpoint resolution", () => {
  it("absolutizes a relative proxy path against the page origin", () => {
    expect(
      resolveBrowserRpcEndpoint("/api/rpc", "mainnet-beta", "https://fluxpad.example"),
    ).toBe("https://fluxpad.example/api/rpc");
    expect(
      resolveBrowserRpcEndpoint("/api/rpc", "mainnet-beta", "https://fluxpad.example/"),
    ).toBe("https://fluxpad.example/api/rpc");
  });

  it("falls back to the public Mainnet endpoint when unset", () => {
    expect(resolveBrowserRpcEndpoint(undefined, "mainnet-beta", "https://x.test")).toBe(
      clusterApiEndpoint("mainnet-beta"),
    );
    expect(resolveBrowserRpcEndpoint("", "mainnet-beta", "https://x.test")).toBe(
      clusterApiEndpoint("mainnet-beta"),
    );
  });

  it("passes through absolute URLs unchanged and never contains credentials", () => {
    expect(
      resolveBrowserRpcEndpoint("https://my-rpc.example.org/v2/abc", "mainnet-beta", "https://x.test"),
    ).toBe("https://my-rpc.example.org/v2/abc");
    // The resolver itself never injects any secret-bearing URL.
    expect(resolveBrowserRpcEndpoint("/api/rpc", "mainnet-beta", "https://x.test")).not.toContain("alchemy");
    expect(resolveBrowserRpcEndpoint("/api/rpc", "mainnet-beta", "https://x.test")).not.toContain("api-key");
  });
});

describe("RPC proxy per-IP rate limiter", () => {
  it("allows requests up to the limit within the window, then rejects with honest 429 semantics", () => {
    const rl = new PerIpRateLimiter(3, 60_000);
    const t0 = 1_700_000_000_000;
    expect(rl.allow("1.2.3.4", t0)).toBe(true);
    expect(rl.allow("1.2.3.4", t0 + 1)).toBe(true);
    expect(rl.allow("1.2.3.4", t0 + 2)).toBe(true);
    expect(rl.allow("1.2.3.4", t0 + 3)).toBe(false); // limit exhausted
    expect(rl.retryAfterSeconds(t0 + 3)).toBeGreaterThan(0);
  });

  it("isolates clients by IP and resets when the window expires", () => {
    const rl = new PerIpRateLimiter(2, 60_000);
    const t0 = 1_700_000_000_000;
    expect(rl.allow("1.1.1.1", t0)).toBe(true);
    expect(rl.allow("1.1.1.1", t0)).toBe(true);
    expect(rl.allow("1.1.1.1", t0)).toBe(false);
    // A different client is unaffected.
    expect(rl.allow("2.2.2.2", t0)).toBe(true);
    // After the window expires the same client may proceed again, and prune
    // drops expired buckets so Retry-After has nothing pending.
    expect(rl.allow("1.1.1.1", t0 + 60_001)).toBe(true);
    rl.prune(t0 + 60_001);
    // 2.2.2.2's window is still active, so Retry-After reflects it (60s),
    // but 1.1.1.1's expired bucket is gone.
    expect(rl.retryAfterSeconds(t0 + 60_001)).toBe(60);
    rl.clear();
    expect(rl.retryAfterSeconds(t0 + 60_001)).toBe(0);
  });
});