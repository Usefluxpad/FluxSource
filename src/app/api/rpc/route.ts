import { NextRequest, NextResponse } from "next/server";
import {
  BROWSER_RPC_BODY_LIMIT_BYTES,
  isJsonRpcPayload,
  payloadMethodsAllowed,
  PerIpRateLimiter,
} from "@/lib/rpc-proxy-policy";
import { gatewayForward } from "@/lib/rpc/rpc-gateway";

/**
 * POST /api/rpc — server-side Solana RPC proxy for the browser.
 *
 * Forwards JSON-RPC to ALCHEMY_SOLANA_RPC_URL (configured server-side; the key
 * never appears in the request path, response, or logs). The browser launch
 * flow (blockhash → sign in wallet → submit → confirm-poll → account read)
 * is pure HTTP JSON-RPC, so the wallet-adapter connection can safely point
 * here. Signing stays in the browser wallet.
 *
 * Guards: POST only, JSON-RPC shape, strict method allowlist (blocks
 * expensive indexing calls), bounded body size, per-IP rate limiting
 * (60 req/min; 429 + Retry-After when exceeded), no-store. Upstream calls go
 * through the shared RPC gateway (coalescing, read caching, throttle, 429
 * backoff, circuit breaker). The provider is never exposed in errors;
 * failures degrade to honest 429/502 responses.
 */
export const dynamic = "force-dynamic";

/** Per-IP fixed-window limit: generous for the launch flow, tight enough to
 * stop a single client from draining the shared provider quota. */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

const limiter = new PerIpRateLimiter(RATE_LIMIT, RATE_WINDOW_MS);

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    ""
  );
}

export async function GET() {
  return NextResponse.json(
    { error: "method_not_allowed", message: "POST JSON-RPC requests only." },
    { status: 405 },
  );
}

export async function POST(req: NextRequest) {
  // 0) Per-IP rate limit (honest 429 with Retry-After; never silently dropped).
  const ip = clientIp(req);
  if (!limiter.allow(ip)) {
    const retryAfter = limiter.retryAfterSeconds();
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many RPC requests from this client. Retry shortly.",
      },
      { status: 429, headers: { "retry-after": String(retryAfter) } },
    );
  }

  // 1) Upstream must be configured (server-side only; never exposed).
  const upstream = process.env.ALCHEMY_SOLANA_RPC_URL?.trim() || "";
  if (!upstream) {
    return NextResponse.json(
      { error: "rpc_proxy_not_configured", message: "No server-side RPC provider configured." },
      { status: 503 },
    );
  }

  // 2) Bounded body, JSON only.
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > BROWSER_RPC_BODY_LIMIT_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", message: "RPC request body exceeds the allowed size." },
      { status: 413 },
    );
  }
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > BROWSER_RPC_BODY_LIMIT_BYTES) {
      return NextResponse.json(
        { error: "payload_too_large", message: "RPC request body exceeds the allowed size." },
        { status: 413 },
      );
    }
    body = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  // 3) JSON-RPC shape + strict method allowlist.
  if (!isJsonRpcPayload(body) || !payloadMethodsAllowed(body)) {
    return NextResponse.json(
      {
        error: "method_not_allowed",
        message: "RPC method not permitted for browser requests.",
      },
      { status: 403 },
    );
  }

  // 4) Forward through the shared RPC gateway (server-side; key never echoed).
  // The gateway adds coalescing (identical concurrent browser reads share one
  // upstream call), short-TTL caching for immutable reads, token-bucket
  // throttling, 429 backoff honoring Retry-After with jitter, and a circuit
  // breaker. Honest failures: 429 + Retry-After when still limited, 502 for
  // other upstream failures. The provider is never exposed.
  const fwd = await gatewayForward(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
  };
  if (fwd.status === 429) headers["retry-after"] = String(fwd.retryAfterSeconds ?? 1);
  return new NextResponse(fwd.body, { status: fwd.status, headers });
}