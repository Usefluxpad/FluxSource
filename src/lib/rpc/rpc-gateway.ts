/**
 * Shared server-side Solana RPC gateway.
 *
 * ONE choke point for every server-side JSON-RPC request — the pump-live
 * engine's poller, all web3.js `Connection` instances created through
 * `getConnection`, and the browser-facing `/api/rpc` proxy. All of these
 * share the same upstream provider quota (e.g. one Alchemy key), so they
 * must also share one admission-control layer:
 *
 * - Token-bucket rate limiting (bounded requests/second upstream).
 * - Bounded concurrent in-flight requests.
 * - In-flight coalescing: identical concurrent reads share one upstream call.
 * - Short-lived result caching for immutable/idempotent read methods.
 * - HTTP 429 handling: Retry-After is honored, retries use exponential
 *   backoff with randomized jitter and a hard retry cap.
 * - Circuit breaker: repeated provider failures trip an open state that
 *   fails fast (no independent component retry storms); a half-open probe
 *   checks recovery.
 * - Diagnostics: request/429/retry/cache/concurrency counters and the
 *   upstream HOSTNAME only — never the URL, key, or auth headers.
 *
 * Mutable operations (sendTransaction, blockhash fetches, simulations) are
 * never cached or coalesced — only rate-limited and backed off.
 */

export type GatewayCircuitState = "closed" | "open" | "half-open";

export interface RpcGatewayMetrics {
  requestsTotal: number;
  rateLimited429: number;
  serverErrors5xx: number;
  networkErrors: number;
  retriesTotal: number;
  cacheHits: number;
  coalescedHits: number;
  circuitOpens: number;
  avgLatencyMs: number;
  inFlight: number;
  tokensAvailable: number;
  circuit: { state: GatewayCircuitState; openUntil: number | null; consecutiveFailures: number };
  /** Upstream hostname only — never the full URL or credentials. */
  upstreamHost: string;
  last429At: number | null;
  lastErrorCode: string | null;
}

export class RpcGatewayError extends Error {
  readonly code: "RATE_LIMITED" | "UPSTREAM" | "UNREACHABLE";
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  constructor(code: RpcGatewayError["code"], message: string, status?: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "RpcGatewayError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Thrown while the circuit is open — callers should skip, not stack-retry. */
export class RpcGatewayOpenError extends RpcGatewayError {
  constructor(retryAfterSeconds: number) {
    super("RATE_LIMITED", "RPC circuit open — provider repeatedly rate-limiting or failing.", 429, retryAfterSeconds);
    this.name = "RpcGatewayOpenError";
  }
}

/* ------------------------------------------------------------------ config */

const DEFAULT_RATE_RPS = 8;
const DEFAULT_BURST = 16;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_RETRIES = 2; // attempts = retries + 1
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_BASE_MS = 15_000;
const CIRCUIT_OPEN_MAX_MS = 120_000;
/** Per-method short-TTL result cache for immutable/idempotent reads. A method
 * absent from this table is never cached or coalesced. */
const READ_CACHE_TTL_MS: Record<string, number> = {
  getAccountInfo: 1_500,
  getMultipleAccounts: 1_500,
  getBalance: 2_000,
  getTokenSupply: 60_000,
  getMinimumBalanceForRentExemption: 60_000,
  getSignaturesForAddress: 2_000,
  getTransaction: 3_000,
  getEpochInfo: 1_000,
  getSlot: 750,
  getBlockHeight: 750,
  getHealth: 2_000,
  getVersion: 60_000,
  getTokenAccountsByOwner: 2_000,
};

function cacheTtlFor(method: string): number {
  return READ_CACHE_TTL_MS[method] ?? 0;
}

/* ------------------------------------------------------------------- state */

interface GatewayState {
  rateRps: number;
  burst: number;
  concurrency: number;
  retries: number;
  openBaseMs: number;
  tokens: number;
  lastRefillAt: number;
  inFlight: number;
  cache: Map<string, { at: number; ttl: number; payload: string }>;
  inflightCoalesce: Map<string, Promise<string>>;
  consecutiveFailures: number;
  circuitOpenUntil: number;
  circuitOpens: number;
  halfOpenProbe: boolean;
  metrics: {
    requestsTotal: number;
    rateLimited429: number;
    serverErrors5xx: number;
    networkErrors: number;
    retriesTotal: number;
    cacheHits: number;
    coalescedHits: number;
    circuitOpens: number;
    latencySum: number;
    latencyN: number;
    last429At: number | null;
    lastErrorCode: string | null;
  };
  upstreamHost: string;
}

/** Singleton across dev HMR and route-module reloads (same pattern as the
 * pump-live engine) so every consumer shares one bucket and one circuit. */
function gw(): GatewayState {
  const g = globalThis as typeof globalThis & { __fluxpadRpcGateway?: GatewayState };
  if (!g.__fluxpadRpcGateway) {
    const burst = Number(process.env.RPC_GATEWAY_BURST) || DEFAULT_BURST;
    g.__fluxpadRpcGateway = {
      rateRps: Number(process.env.RPC_GATEWAY_RATE_RPS) || DEFAULT_RATE_RPS,
      burst,
      concurrency: Number(process.env.RPC_GATEWAY_CONCURRENCY) || DEFAULT_CONCURRENCY,
      retries: DEFAULT_RETRIES,
      openBaseMs: Number(process.env.RPC_GATEWAY_OPEN_BASE_MS) || CIRCUIT_OPEN_BASE_MS,
      tokens: burst,
      lastRefillAt: Date.now(),
      inFlight: 0,
      cache: new Map(),
      inflightCoalesce: new Map(),
      consecutiveFailures: 0,
      circuitOpenUntil: 0,
      circuitOpens: 0,
      halfOpenProbe: false,
      metrics: {
        requestsTotal: 0,
        rateLimited429: 0,
        serverErrors5xx: 0,
        networkErrors: 0,
        retriesTotal: 0,
        cacheHits: 0,
        coalescedHits: 0,
        circuitOpens: 0,
        latencySum: 0,
        latencyN: 0,
        last429At: null,
        lastErrorCode: null,
      },
      upstreamHost: "",
    };
  }
  return g.__fluxpadRpcGateway;
}

/** Test hook: reset all gateway state between tests. */
export function __resetRpcGatewayForTests(): void {
  const g = globalThis as typeof globalThis & { __fluxpadRpcGateway?: GatewayState };
  delete g.__fluxpadRpcGateway;
}

function refillTokens(s: GatewayState, now: number): void {
  const elapsed = now - s.lastRefillAt;
  if (elapsed <= 0) return;
  s.tokens = Math.min(s.burst, s.tokens + (elapsed / 1000) * s.rateRps);
  s.lastRefillAt = now;
}

function circuitState(s: GatewayState, now: number): GatewayCircuitState {
  if (s.circuitOpenUntil > now) return "open";
  if (s.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) return "half-open";
  return "closed";
}

function retryAfterSecondsWhileOpen(s: GatewayState, now: number): number {
  return s.circuitOpenUntil > now ? Math.ceil((s.circuitOpenUntil - now) / 1000) : 1;
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 0;
}

function jitterMs(ms: number): number {
  return Math.max(0, Math.round(ms * (0.75 + Math.random() * 0.5)));
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- core call */

export interface GatewayCallOptions {
  /** Overridable sleep for tests (default real timer). */
  sleep?: (ms: number) => Promise<void>;
  /** Overridable upstream URL (default the configured server RPC). */
  url?: string;
  /** Overridable fetch for tests. */
  doFetch?: typeof fetch;
}

function resolveUpstreamUrl(explicit?: string): string {
  if (explicit) return explicit;
  return (
    process.env.ALCHEMY_SOLANA_RPC_URL?.trim() ||
    process.env.SOLANA_RPC_URL?.trim() ||
    "https://api.mainnet-beta.solana.com"
  );
}

/** Circuit-failure bookkeeping; trips the breaker at the threshold. */
function noteFailure(s: GatewayState): void {
  s.consecutiveFailures += 1;
  if (s.consecutiveFailures === CIRCUIT_FAILURE_THRESHOLD) {
    // Trip: open exponentially longer each consecutive re-trip, capped.
    const openMs = Math.min(CIRCUIT_OPEN_MAX_MS, s.openBaseMs * 2 ** Math.min(4, s.circuitOpens));
    s.circuitOpenUntil = Date.now() + openMs;
    s.circuitOpens += 1;
    s.metrics.circuitOpens += 1;
  }
}

/** A real successful response resets the failure streak (and any half-open probe). */
function noteSuccess(s: GatewayState): void {
  s.consecutiveFailures = 0;
}

async function singleRpcCall<T>(
  method: string,
  params: unknown[],
  opts: GatewayCallOptions,
): Promise<T> {
  const s = gw();
  const sleep = opts.sleep ?? defaultSleep;
  const now0 = Date.now();
  refillTokens(s, now0);
  if (circuitState(s, now0) === "open") {
    throw new RpcGatewayOpenError(retryAfterSecondsWhileOpen(s, now0));
  }

  // Admission: token bucket — waits (never drops) until a token is available.
  while (s.tokens < 1) {
    await sleep(25);
    refillTokens(s, Date.now());
  }

  // Concurrency bound — queue rather than stampede the provider.
  while (s.inFlight >= s.concurrency) {
    await sleep(20);
  }

  s.tokens -= 1;
  s.inFlight += 1;
  const startedAt = Date.now();
  try {
    const url = resolveUpstreamUrl(opts.url);
    if (!s.upstreamHost) {
      try {
        s.upstreamHost = new URL(url).hostname;
      } catch {
        s.upstreamHost = "unknown";
      }
    }
    let lastErr: RpcGatewayError | null = null;
    for (let attempt = 0; attempt <= s.retries; attempt++) {
      if (attempt > 0) {
        s.metrics.retriesTotal += 1;
        // Exponential backoff with jitter, extended to at least the
        // provider's Retry-After, capped at MAX_BACKOFF_MS.
        const backoff = jitterMs(Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1)));
        const raMs =
          lastErr instanceof RpcGatewayError && lastErr.code === "RATE_LIMITED"
            ? parseRetryAfterMs(String((lastErr as RpcGatewayError & { __raRaw?: string }).__raRaw ?? ""))
            : 0;
        const waitMs = Math.max(backoff, Math.min(MAX_BACKOFF_MS, raMs));
        await sleep(waitMs);
        // Re-check the circuit between attempts: if other callers' failures
        // opened it, stop contributing load immediately (no stacked retries).
        if (circuitState(s, Date.now()) === "open") {
          throw new RpcGatewayOpenError(retryAfterSecondsWhileOpen(s, Date.now()));
        }
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      try {
        s.metrics.requestsTotal += 1;
        const res = await (opts.doFetch ?? fetch)(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: controller.signal,
          cache: "no-store",
        });
        if (res.status === 429) {
          s.metrics.rateLimited429 += 1;
          s.metrics.last429At = Date.now();
          s.metrics.lastErrorCode = "RATE_LIMITED";
          const raRaw = res.headers.get("retry-after");
          const raMs = parseRetryAfterMs(raRaw);
          lastErr = new RpcGatewayError("RATE_LIMITED", "Upstream RPC rate-limited (429).", 429, raMs ? Math.ceil(raMs / 1000) : undefined);
          (lastErr as RpcGatewayError & { __raRaw?: string }).__raRaw = raRaw ?? "";
          noteFailure(s);
          continue;
        }
        if (res.status >= 500) {
          s.metrics.serverErrors5xx += 1;
          s.metrics.lastErrorCode = "UPSTREAM";
          lastErr = new RpcGatewayError("UPSTREAM", `Upstream RPC error (${res.status}).`, res.status);
          noteFailure(s);
          continue;
        }
        if (!res.ok) {
          // Other 4xx: definitive rejection (bad shape/disallowed) — do not
          // retry and do not count as a provider-health failure.
          throw new RpcGatewayError("UPSTREAM", `Upstream RPC rejected the request (${res.status}).`, res.status);
        }
        const j = (await res.json()) as { result?: T; error?: { message?: string } | null };
        if (j && typeof j === "object" && "error" in j && j.error) {
          // JSON-RPC-level error is a real response, not a provider outage.
          throw new RpcGatewayError("UPSTREAM", j.error?.message || "RPC returned an error.", undefined);
        }
        noteSuccess(s);
        return (j?.result ?? null) as T;
      } catch (err) {
        if (err instanceof RpcGatewayError) throw err;
        s.metrics.networkErrors += 1;
        s.metrics.lastErrorCode = "UNREACHABLE";
        lastErr = new RpcGatewayError("UNREACHABLE", err instanceof Error ? err.message : String(err));
        noteFailure(s);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr ?? new RpcGatewayError("UPSTREAM", "RPC request failed.");
  } finally {
    s.inFlight -= 1;
    const dt = Date.now() - startedAt;
    s.metrics.latencySum += dt;
    s.metrics.latencyN += 1;
  }
}

/**
 * Gateway-managed JSON-RPC call with coalescing + short-TTL caching for
 * idempotent reads. Mutable methods (blockhash, send, simulate, statuses)
 * always hit the upstream — under throttle/backoff only.
 */
export async function gatewayRpc<T>(
  method: string,
  params: unknown[],
  opts: GatewayCallOptions = {},
): Promise<T> {
  const s = gw();
  const ttl = cacheTtlFor(method);
  const key = ttl > 0 ? `${method}:${JSON.stringify(params)}` : null;
  const now = Date.now();

  if (key) {
    const hit = s.cache.get(key);
    if (hit && now - hit.at < hit.ttl) {
      s.metrics.cacheHits += 1;
      return JSON.parse(hit.payload) as T;
    }
    const pending = s.inflightCoalesce.get(key);
    if (pending) {
      s.metrics.coalescedHits += 1;
      return (await pending) as T;
    }
  }

  const exec = singleRpcCall<T>(method, params, opts)
    .then((result) => {
      if (key && result !== null && result !== undefined) {
        // Bounded cache: drop the oldest half past 512 entries.
        if (s.cache.size > 512) {
          let n = 0;
          for (const k of s.cache.keys()) {
            if (n++ >= 256) break;
            s.cache.delete(k);
          }
        }
        s.cache.set(key, { at: Date.now(), ttl, payload: JSON.stringify(result) });
      }
      if (key) s.inflightCoalesce.delete(key);
      return result;
    })
    .catch((err) => {
      if (key) s.inflightCoalesce.delete(key);
      throw err;
    });

  if (key) s.inflightCoalesce.set(key, exec as Promise<string>);
  return exec;
}

/** Whether the gateway is currently admitting requests (circuit not open). */
export function gatewayHealthy(): boolean {
  const s = gw();
  return circuitState(s, Date.now()) !== "open";
}

/** Seconds until the gateway expects to admit requests again (Retry-After). */
export function gatewayRetryAfterSeconds(): number {
  const s = gw();
  const now = Date.now();
  if (s.circuitOpenUntil > now) return Math.ceil((s.circuitOpenUntil - now) / 1000);
  return 1;
}

/* -------------------------------------------------------- web3.js middleware */

/**
 * web3.js `FetchMiddleware` (CPS contract — see lib/index.cjs.js): the
 * middleware receives `(info, init, next)` and must call `next(info, init)`
 * to let web3.js perform the actual fetch. It can therefore only SHAPE the
 * request flow, not synthesize responses.
 *
 * Behavior here:
 * - Synchronous circuit check: while the breaker is open the middleware
 *   THROWS synchronously, which web3.js converts into a rejected request —
 *   fail-fast instead of stacking more load on a rate-limited provider.
 * - Admission control: each request waits for a token-bucket token and a
 *   concurrency slot before `next` is called, so server-side web3.js
 *   consumers (discovery, market reads, treasury, reconcile) cannot stampede
 *   the shared provider quota. web3.js's built-in 429 retry loop continues
 *   to handle transient rate limits for these low-rate paths.
 * - WebSocket subscriptions do not pass through here.
 */
export function rpcFetchMiddleware(): (
  info: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  next: (modifiedInfo: Parameters<typeof fetch>[0], modifiedInit: Parameters<typeof fetch>[1]) => void,
) => void {
  return (info, init, next) => {
    // Sync circuit check — a sync throw rejects web3.js's pending fetch promise.
    const s = gw();
    if (circuitState(s, Date.now()) === "open") {
      throw new RpcGatewayOpenError(retryAfterSecondsWhileOpen(s, Date.now()));
    }
    void (async () => {
      // Admission: token + concurrency slot (waits, never drops).
      await gatewayAdmit();
      try {
        next(info, init);
      } finally {
        gatewayRelease();
      }
    })();
  };
}

/**
 * Acquire one admission slot: wait for a rate-bucket token and a free
 * concurrency slot. Used by the web3.js middleware (its CPS contract cannot
 * return a response, so admission is the protection it can provide).
 */
export async function gatewayAdmit(): Promise<void> {
  const s = gw();
  refillTokens(s, Date.now());
  while (s.tokens < 1) {
    await defaultSleep(25);
    refillTokens(s, Date.now());
  }
  while (s.inFlight >= s.concurrency) {
    await defaultSleep(20);
  }
  s.tokens -= 1;
  s.inFlight += 1;
}

/** Release a slot acquired through gatewayAdmit. */
export function gatewayRelease(): void {
  const s = gw();
  s.inFlight = Math.max(0, s.inFlight - 1);
}

type JsonRpcLike = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };

export interface GatewayForwardResult {
  status: number;
  /** Response body (JSON text) to return to the caller verbatim. */
  body: string;
  retryAfterSeconds?: number;
}

/**
 * Forward a JSON-RPC payload (single or batch) through the gateway. Request
 * ids are preserved exactly; cached/coalesced results are re-wrapped per
 * request so ids stay correct. Honest failures: 429 with Retry-After when
 * still rate-limited after retries, 502 for other upstream failures.
 */
export async function gatewayForward(
  body: JsonRpcLike | JsonRpcLike[],
  opts: GatewayCallOptions = {},
): Promise<GatewayForwardResult> {
  const entries = Array.isArray(body) ? body : [body];
  const settled = await Promise.all(
    entries.map(async (entry) => {
      const method = typeof entry.method === "string" ? entry.method : "";
      const params = Array.isArray(entry.params) ? (entry.params as unknown[]) : [];
      if (!method) {
        return { id: entry.id, error: { code: -32600, message: "Invalid JSON-RPC request." } };
      }
      try {
        const result = await gatewayRpc<unknown>(method, params, opts);
        return { id: entry.id, result };
      } catch (err) {
        const limited = err instanceof RpcGatewayError && err.code === "RATE_LIMITED";
        const retryAfter = err instanceof RpcGatewayError ? err.retryAfterSeconds : undefined;
        return {
          id: entry.id,
          error: {
            code: limited ? -32005 : -32000,
            message: err instanceof Error ? err.message : "RPC unavailable.",
          },
          __rateLimited: limited,
          __retryAfter: retryAfter,
        };
      }
    }),
  );
  const anyLimited = settled.some((r) => (r as { __rateLimited?: boolean }).__rateLimited === true);
  const cleaned = settled.map((r) => {
    const rest = { ...(r as Record<string, unknown>) };
    delete rest.__rateLimited;
    delete rest.__retryAfter;
    return rest;
  });
  if (anyLimited) {
    return {
      status: 429,
      body: JSON.stringify(Array.isArray(body) ? cleaned : cleaned[0]),
      retryAfterSeconds: Math.max(
        1,
        ...settled.map((r) => (r as { __retryAfter?: number }).__retryAfter ?? gatewayRetryAfterSeconds()),
      ),
    };
  }
  return { status: 200, body: JSON.stringify(Array.isArray(body) ? cleaned : cleaned[0]) };
}

/* -------------------------------------------------------------- diagnostics */

/** Diagnostic metrics — hostnames only, never URLs, keys, or auth headers. */
export function rpcGatewayMetrics(): RpcGatewayMetrics {
  const s = gw();
  refillTokens(s, Date.now());
  return {
    requestsTotal: s.metrics.requestsTotal,
    rateLimited429: s.metrics.rateLimited429,
    serverErrors5xx: s.metrics.serverErrors5xx,
    networkErrors: s.metrics.networkErrors,
    retriesTotal: s.metrics.retriesTotal,
    cacheHits: s.metrics.cacheHits,
    coalescedHits: s.metrics.coalescedHits,
    circuitOpens: s.metrics.circuitOpens,
    avgLatencyMs: s.metrics.latencyN > 0 ? Math.round(s.metrics.latencySum / s.metrics.latencyN) : 0,
    inFlight: s.inFlight,
    tokensAvailable: Math.floor(s.tokens),
    circuit: {
      state: circuitState(s, Date.now()),
      openUntil: s.circuitOpenUntil > Date.now() ? s.circuitOpenUntil : null,
      consecutiveFailures: s.consecutiveFailures,
    },
    upstreamHost: s.upstreamHost,
    last429At: s.metrics.last429At,
    lastErrorCode: s.metrics.lastErrorCode,
  };
}


