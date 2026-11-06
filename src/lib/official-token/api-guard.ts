import { NextResponse } from "next/server";
import { PerIpRateLimiter } from "@/lib/rpc-proxy-policy";

/**
 * Shared guard for the public read-only /api/official-token/* endpoints:
 * GET-only method allowlist + per-IP rate limiting + no-store headers.
 * Public requests can never initiate transfers, buybacks, burns, or
 * configuration changes — these endpoints contain no such logic at all.
 */

const limiter = new PerIpRateLimiter(60, 60_000);

export function ipOf(req: Request): string {
  // Prefer the platform-provided client IP (set by the hosting edge, not
  // client-controllable); x-forwarded-for is only a fallback and is
  // client-spoofable when no trusted proxy sets it — rate limiting is a
  // load bound, not a security control (see docs/VERIFICATION.md).
  const realIp = req.headers.get("x-real-ip") ?? req.headers.get("cf-connecting-ip");
  if (realIp?.trim()) return realIp.split(",")[0].trim();
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "local";
}

/** Returns a rejection response, or null when the request may proceed. */
export function publicApiGuard(req: Request): NextResponse | null {
  if (req.method !== "GET") {
    return NextResponse.json(
      { error: "method_not_allowed", message: "Read-only endpoint." },
      { status: 405, headers: { Allow: "GET" } },
    );
  }
  const ip = ipOf(req);
  if (!limiter.allow(ip)) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(limiter.retryAfterSeconds()) } },
    );
  }
  return null;
}

export function jsonHeaders(): HeadersInit {
  return { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
}

/** Explicit rejection for mutating methods (always returns a response). */
export function mutationRejected(req: Request): NextResponse {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message: "Read-only endpoint — no transfers, buybacks, burns, or configuration changes.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}

/** Test hook: reset the in-memory limiter between test cases. */
export function resetPublicApiLimiter(): void {
  limiter.clear();
}