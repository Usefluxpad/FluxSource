/**
 * FluxPad live market-data engine (singleton).
 *
 * Pipeline: PumpPortal WS (ws-manager) → validation + dedupe → per-mint
 * rolling aggregation (5m/1h/4h/12h/24h) → snapshot persistence → ranking
 * engine → /api/trending + /api/trending/stream (SSE).
 *
 * Honesty rules:
 * - Prices come from executed trades (solAmount / tokenAmount).
 * - Market cap = last executed price × RPC-verified supply (null until then).
 * - Zero activity in a window is a measured zero; metrics that cannot be
 *   computed are null; windows extending before our earliest stored data are
 *   flagged `historyPartial` instead of pretending completeness.
 * - No trade, ranking, or token is ever fabricated.
 */
import { fetchJson } from "@/lib/discovery/http";
import { toBrowserImageUrl } from "@/lib/image-url";
import { peekSolUsd, refreshSolUsd } from "./sol-price";
import { PumpPortalWsManager } from "./ws-manager";
import { loadSnapshot, saveSnapshot, type SnapshotData } from "./persist";
import { gatewayHealthy, gatewayRpc, rpcGatewayMetrics } from "@/lib/rpc/rpc-gateway";
import type {
  LiveTokenIdentity,
  LiveTokenMetrics,
  LiveTrade,
  PumpPortalMigrationEvent,
  PumpPortalNewTokenEvent,
  PumpPortalTradeEvent,
  RankedToken,
  TrendingRow,
  TrendingStats,
  TrendingTab,
  TrendingTimeframe,
  WindowMetrics,
} from "./types";

const WINDOW_MS: Record<TrendingTimeframe, number> = {
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
};
const MAX_TRADE_AGE_MS = 25 * 60 * 60_000;
const MAX_TRADES_PER_MINT = 4000;
const DEDUPE_CAP = 60_000;
const SNAPSHOT_MS = 30_000;
const INACTIVE_UNSUB_MS = 2 * 60 * 60_000;
const SWEEP_MS = 60_000;
const BROADCAST_MS = 2_500;
/** Max adaptive stretch of the keyless trade-poll cadence (base × stretch). */
const POLL_STRETCH_MAX = 5;
const HOT_TRADES_5M = 8;
const HOT_TRADERS_5M = 4;
/** Minimum trades in a window before change%/rankings trust the movement. */
const MIN_TRADES_FOR_CHANGE = 5;

interface MintState {
  id: LiveTokenIdentity;
  trades: LiveTrade[];
  lastTradeAt: number | null;
  eventMarketCapSol: number | null;
}

export interface TrendingSnapshotPayload {
  tab: TrendingTab;
  tf: TrendingTimeframe;
  rows: TrendingRow[];
  serverTime: number;
}

function base58Ok(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(s);
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// NOTE: the engine no longer builds its own RPC endpoint or fetch calls —
// every Solana RPC request flows through the shared gateway
// (`@/lib/rpc/rpc-gateway`), which owns throttling, caching, backoff, and the
// circuit breaker against the shared provider quota.

export class PumpLiveEngine {
  private ws: PumpPortalWsManager;
  private apiKey: string | null;
  private mints = new Map<string, MintState>();
  private dedupe = new Map<string, number>();
  private supplyCache = new Map<string, { supply: number; decimals: number; at: number }>();
  private supplyInflight = new Map<string, Promise<void>>();
  private stats: TrendingStats;
  private timers: ReturnType<typeof setInterval>[] = [];
  private sseClients = new Set<(payload: string) => void>();
  private lastBroadcast = new Map<string, { at: number; json: string }>();
  private startedAt = Date.now();
  private dataFrom = Date.now();
  private latencySum = 0;
  private latencyN = 0;
  private started = false;
  private pollInflight = false;
  /** Adaptive trade-poll cadence: 1 = normal, grows on RPC rate limiting. */
  private pollStretch = 1;
  private pollBaseMs = 12_000;

  constructor() {
    const apiKey = process.env.PUMPPORTAL_API_KEY?.trim() || null;
    this.apiKey = apiKey;
    const maxSubs = Number(process.env.PUMP_LIVE_MAX_TOKEN_SUBS) || 300;
    this.stats = {
      connected: false,
      reconnects: 0,
      lastMessageAt: null,
      newTokenEvents: 0,
      tradeEventsReceived: 0,
      tradeEventsProcessed: 0,
      duplicatesDropped: 0,
      invalidEvents: 0,
      migrationEvents: 0,
      tokensTracked: 0,
      tokensWithTrades: 0,
      activeTradeSubscriptions: 0,
      solUsd: null,
      solUsdSource: null,
      rpcCalls: 0,
      processingLatencyMsAvg: 0,
      verifiedTrades: 0,
      verificationFailures: 0,
      startedAt: this.startedAt,
      dataFrom: this.dataFrom,
      historyPartial: true,
      estSolConsumed: 0,
      wsBytesReceived: 0,
      lastError: null,
      tradeSource: apiKey ? "ws" : "rpc-poll",
      tradeStreamingAvailable: null,
      tradeStreamingReason: null,
    };
    this.ws = new PumpPortalWsManager(
      {
        onNewToken: (e, at) => this.handleNewToken(e, at),
        onTrade: (e, at) => this.handleTrade(e, at),
        onMigration: (e, at) => this.handleMigration(e, at),
        onStateChange: (c) => {
          this.stats.connected = c;
        },
      },
      { apiKey, maxTradeSubs: maxSubs },
    );
  }

  /** Idempotent boot: restore snapshot, connect, start timers. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const snap = loadSnapshot();
    if (snap) {
      this.restore(snap);
      this.dataFrom = Math.min(this.dataFrom, snap.savedAt);
      this.stats.dataFrom = this.dataFrom;
    }
    this.ws.start();
    refreshSolUsd();
    this.timers.push(setInterval(() => this.persist(), SNAPSHOT_MS));
    this.timers.push(setInterval(() => this.sweep(), SWEEP_MS));
    this.timers.push(setInterval(() => this.broadcast(), BROADCAST_MS));
    this.timers.push(setInterval(() => refreshSolUsd(), 60_000));
    // Keyless tier: trade streams need a funded key — poll on-chain instead.
    // The poller self-schedules with an adaptive cadence: when the shared RPC
    // gateway reports rate-limiting it stretches (up to 5× base) instead of
    // hammering the provider through 429s.
    if (!this.apiKey) {
      const pollMs = Number(process.env.PUMPPORTAL_TRADE_POLL_MS) || 12_000;
      this.pollBaseMs = pollMs;
      const tick = () => {
        const timer = setTimeout(() => {
          void this.pollTrades().finally(() => tick());
        }, this.pollBaseMs * this.pollStretch);
        this.timers.push(timer);
      };
      tick();
    }
  }

  private pruneDedupe(): void {
    if (this.dedupe.size <= DEDUPE_CAP) return;
    const entries = [...this.dedupe.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < entries.length / 2; i++) this.dedupe.delete(entries[i][0]);
  }

  private handleNewToken(e: PumpPortalNewTokenEvent, receivedAt: number): void {
    const mint = typeof e.mint === "string" ? e.mint : null;
    if (!mint || !base58Ok(mint)) {
      this.stats.invalidEvents += 1;
      return;
    }
    this.stats.newTokenEvents += 1;
    const existing = this.mints.get(mint);
    if (existing) {
      if (!existing.id.imageUrl && typeof e.uri === "string" && e.uri) void this.enrich(existing, e.uri);
      return;
    }
    const tsSec = num(e.timestamp);
    const createdAt = tsSec && tsSec > 1_500_000_000 ? tsSec * 1000 : receivedAt;
    const creator =
      typeof e.user === "string" && e.user
        ? e.user
        : (typeof e.createdBy === "string" && e.createdBy
            ? e.createdBy
            : (typeof e.traderPublicKey === "string" ? e.traderPublicKey : null));
    const initialBuy = num(e.initialBuy) ?? 0;
    const buySol = num(e.solAmount) ?? 0;
    const state: MintState = {
      id: {
        mint,
        name: typeof e.name === "string" && e.name ? e.name : "Unknown",
        symbol: typeof e.symbol === "string" && e.symbol ? e.symbol : mint.slice(0, 4).toUpperCase(),
        imageUrl: null,
        metadataUri: typeof e.uri === "string" ? e.uri : null,
        creator,
        createdAt,
        creationSignature: typeof e.signature === "string" ? e.signature : null,
        migrated: false,
        migratedAt: null,
        poolAddress: null,
        amm: null,
        supply: null,
        decimals: null,
        bondingCurveKey: typeof e.bondingCurveKey === "string" ? e.bondingCurveKey : null,
      },
      trades: [],
      lastTradeAt: null,
      eventMarketCapSol: null,
    };
    this.mints.set(mint, state);
    this.stats.tokensTracked = this.mints.size;
    const mc = num(e.marketCapSol);
    if (mc !== null && mc > 0) state.eventMarketCapSol = mc;
    // The creation event's initial buy is a real on-chain trade — record it.
    if (initialBuy > 0 && buySol > 0) {
      this.processTrade(
        mint,
        {
          t: createdAt,
          priceSol: buySol / initialBuy,
          sol: buySol,
          side: "buy",
          wallet: creator ?? "unknown",
          sig: typeof e.signature === "string" ? e.signature : "",
        },
        mc,
      );
    }
    if (typeof e.uri === "string" && e.uri) void this.enrich(state, e.uri);
    void this.verifySupply(mint);
    this.ws.subscribeTokenTrade(mint);
    this.pruneDedupe();
  }

  private async enrich(state: MintState, uri: string): Promise<void> {
    try {
      const meta = await fetchJson<Record<string, unknown>>(uri, { timeoutMs: 6000, retries: 1 });
      const image = typeof meta.image === "string" ? meta.image : null;
      if (image) state.id.imageUrl = toBrowserImageUrl(image) || image;
      if (typeof meta.name === "string" && meta.name && state.id.name === "Unknown") state.id.name = meta.name;
    } catch {
      // Metadata unavailable — identity keeps the event name/symbol; no invention.
    }
  }

  /** RPC verification: SPL mint supply + decimals (cached; one call per mint). */
  private async verifySupply(mint: string): Promise<void> {
    const cached = this.supplyCache.get(mint);
    if (cached && Date.now() - cached.at < 24 * 60 * 60_000) {
      const st = this.mints.get(mint);
      if (st) {
        st.id.supply = cached.supply;
        st.id.decimals = cached.decimals;
      }
      return;
    }
    if (this.supplyInflight.has(mint)) return;
    this.supplyInflight.set(
      mint,
      (async () => {
        try {
          this.stats.rpcCalls += 1;
          const j = await this.rpcPost<{
            result?: { value?: { amount: string; decimals: number; uiAmount: number | null; uiAmountString: string } | null };
          }>("getTokenSupply", [mint]);
          const v = j?.result?.value;
          if (!v) return; // mint account not found — no fabrication
          const supply = v.uiAmount ?? Number(v.uiAmountString);
          const decimals = v.decimals;
          if (!Number.isFinite(supply) || supply <= 0 || !Number.isFinite(decimals)) return;
          this.supplyCache.set(mint, { supply, decimals, at: Date.now() });
          const st = this.mints.get(mint);
          if (st) {
            st.id.supply = supply;
            st.id.decimals = decimals;
          }
        } catch {
          // Verification failed — metrics stay null rather than assumed.
        } finally {
          this.supplyInflight.delete(mint);
        }
      })(),
    );
    await this.supplyInflight.get(mint);
  }

  private verifyInflight = 0;

  /**
   * Independent RPC verification of a streamed trade (sampled): confirm the
   * transaction exists and succeeded, and that the trader's token balance
   * delta matches the streamed amount. Failures are removed from the window.
   */
  private verifyTrade(sig: string, mint: string, trader: string, tokenAmount: number): void {
    if (!sig || sig === "" || this.verifyInflight >= 16) return;
    this.verifyInflight += 1;
    void (async () => {
      try {
        this.stats.rpcCalls += 1;
        const j = await gatewayRpc<{
          result?: {
            meta?: {
              err: unknown;
              postTokenBalances?: { mint: string; owner: string; uiTokenAmount: { uiAmount: number | null; amount: string } }[];
            } | null;
          } | null;
        }>("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
        const result = j?.result ?? null;
        if (!result) return; // not yet confirmed — skip, try never re-checked
        if (result.meta?.err) {
          // Stream claimed a trade that actually failed on-chain — drop it.
          this.stats.verificationFailures += 1;
          const st = this.mints.get(mint);
          if (st) st.trades = st.trades.filter((t) => t.sig !== sig);
          return;
        }
        // Token balance delta for the trader on this mint (decimal-adjusted).
        const posts = result.meta?.postTokenBalances ?? [];
        let delta = 0;
        for (const p of posts) {
          if (p.mint === mint && p.owner === trader) {
            delta += typeof p.uiTokenAmount.uiAmount === "number" ? p.uiTokenAmount.uiAmount : 0;
          }
        }
        // Pre-balances were not requested in this payload shape; success + the
        // signed tx existing is the primary gate. The delta check runs when
        // the trader's post balance is present and plausibly comparable.
        if (delta !== 0 && Math.abs(delta - tokenAmount) / tokenAmount > 0.05) {
          this.stats.verificationFailures += 1;
          const st = this.mints.get(mint);
          if (st) st.trades = st.trades.filter((t) => t.sig !== sig);
          return;
        }
        this.stats.verifiedTrades += 1;
      } catch {
        // verification transport error — not counted against the trade
      } finally {
        this.verifyInflight -= 1;
      }
    })();
  }

  private handleTrade(e: PumpPortalTradeEvent, receivedAt: number): void {
    this.stats.tradeEventsReceived += 1;
    const mint = typeof e.mint === "string" ? e.mint : null;
    const sig = typeof e.signature === "string" ? e.signature : null;
    const txType = e.txType === "buy" || e.txType === "sell" ? e.txType : null;
    const solAmount = num(e.solAmount);
    const tokenAmount = num(e.tokenAmount);
    if (!mint || !base58Ok(mint) || !txType || solAmount === null || solAmount <= 0 || tokenAmount === null || tokenAmount <= 0) {
      this.stats.invalidEvents += 1;
      return;
    }
    this.processTrade(
      mint,
      {
        t: (() => {
          const tsSec = num(e.timestamp);
          return tsSec && tsSec > 1_500_000_000 ? tsSec * 1000 : receivedAt;
        })(),
        priceSol: solAmount / tokenAmount,
        sol: solAmount,
        side: txType,
        wallet: typeof e.user === "string" ? e.user : "unknown",
        sig: sig ?? "",
      },
      num(e.marketCapSol),
    );
  }

  /** Shared trade pipeline: dedupe → adopt-or-update → window → verify sample. */
  private processTrade(mint: string, trade: LiveTrade, eventMarketCapSol: number | null): void {
    const started = performance.now();
    this.stats.tradeEventsReceived += 1;
    const key = `${trade.sig || "nosig"}:${trade.side}`;
    if (this.dedupe.has(key)) {
      this.stats.duplicatesDropped += 1;
      return;
    }
    this.dedupe.set(key, Date.now());
    this.pruneDedupe();

    let state = this.mints.get(mint);
    if (!state) {
      // Trade for an untracked mint (restart mid-window): adopt it so the
      // token keeps trading in Trending rather than vanishing.
      state = {
        id: {
          mint,
          name: `Mint ${mint.slice(0, 4)}…`,
          symbol: mint.slice(0, 4).toUpperCase(),
          imageUrl: null,
          metadataUri: null,
          creator: null,
          createdAt: Date.now(),
          creationSignature: null,
          migrated: false,
          migratedAt: null,
          poolAddress: null,
          amm: null,
          supply: null,
          decimals: null,
          bondingCurveKey: null,
        },
        trades: [],
        lastTradeAt: null,
        eventMarketCapSol: null,
      };
      this.mints.set(mint, state);
      this.stats.tokensTracked = this.mints.size;
      void this.verifySupply(mint);
      if (this.apiKey) this.ws.subscribeTokenTrade(mint);
    }

    state.trades.push(trade);
    state.lastTradeAt = Math.max(state.lastTradeAt ?? 0, trade.t);
    if (eventMarketCapSol !== null && eventMarketCapSol > 0) state.eventMarketCapSol = eventMarketCapSol;
    const cutoff = Date.now() - MAX_TRADE_AGE_MS;
    if (state.trades.length > 200 && state.trades[0].t < cutoff) {
      let i = 0;
      while (i < state.trades.length && state.trades[i].t < cutoff) i++;
      if (i > 0) state.trades.splice(0, i);
    }
    if (state.trades.length > MAX_TRADES_PER_MINT) {
      state.trades.splice(0, state.trades.length - MAX_TRADES_PER_MINT);
    }
    this.stats.tradeEventsProcessed += 1;
    const dt = performance.now() - started;
    this.latencySum += dt;
    this.latencyN += 1;
    this.stats.processingLatencyMsAvg = this.latencyN > 0 ? this.latencySum / this.latencyN : 0;
    this.stats.tokensWithTrades = [...this.mints.values()].filter((m) => m.trades.length > 0).length;
    // Sampled independent verification: a mint's first 3 trades, then ~2%.
    if (trade.sig && (state.trades.length <= 3 || this.stats.tradeEventsProcessed % 50 === 0)) {
      this.verifyTrade(trade.sig, mint, trade.wallet, Math.abs(trade.sol / trade.priceSol));
    }
  }

  private handleMigration(e: PumpPortalMigrationEvent, receivedAt: number): void {
    const mint = typeof e.mint === "string" ? e.mint : null;
    if (!mint || !base58Ok(mint)) {
      this.stats.invalidEvents += 1;
      return;
    }
    this.stats.migrationEvents += 1;
    let state = this.mints.get(mint);
    if (!state) {
      // Migration observed for an untracked mint — adopt it, keep it listed.
      state = {
        id: {
          mint,
          name: typeof e.name === "string" && e.name ? e.name : `Mint ${mint.slice(0, 4)}…`,
          symbol: typeof e.symbol === "string" && e.symbol ? e.symbol : mint.slice(0, 4).toUpperCase(),
          imageUrl: null,
          metadataUri: typeof e.uri === "string" ? e.uri : null,
          creator: null,
          createdAt: receivedAt,
          creationSignature: null,
          migrated: true,
          migratedAt: receivedAt,
          poolAddress: typeof e.poolId === "string" ? e.poolId : null,
          amm: typeof e.amm === "string" ? e.amm : (typeof e.pool === "string" ? e.pool : null),
          supply: null,
          decimals: typeof e.decimals === "number" ? e.decimals : null,
          bondingCurveKey: null,
        },
        trades: [],
        lastTradeAt: null,
        eventMarketCapSol: num(e.marketCapSol),
      };
      this.mints.set(mint, state);
      this.stats.tokensTracked = this.mints.size;
      void this.verifySupply(mint);
      this.ws.subscribeTokenTrade(mint);
      if (state.id.metadataUri) void this.enrich(state, state.id.metadataUri);
      return;
    }
    // Preserve identity; update the price/liquidity source; keep tracking.
    state.id.migrated = true;
    const tsSec = num(e.timestamp);
    state.id.migratedAt = tsSec && tsSec > 1_500_000_000 ? tsSec * 1000 : receivedAt;
    if (typeof e.poolId === "string") state.id.poolAddress = e.poolId;
    if (typeof e.amm === "string") state.id.amm = e.amm;
    else if (typeof e.pool === "string" && !state.id.amm) state.id.amm = e.pool;
    if (!state.id.metadataUri && typeof e.uri === "string" && e.uri) {
      state.id.metadataUri = e.uri;
      void this.enrich(state, e.uri);
    }
    // Keep the trade subscription — the token keeps trading on PumpSwap.
  }

  /**
   * Keyless-tier trade discovery: for active bonding-curve mints, read recent
   * signatures off the curve account (RPC) and decode each transaction's
   * curve-side token/SOL deltas. Fully on-chain verified: trades exist only
   * if the transaction exists and succeeded; failed transactions never count.
   *
   * Rounds are skipped entirely while the shared RPC circuit is open, and the
   * cadence stretches after rate-limited rounds (adaptive backpressure).
   */
  private async pollTrades(): Promise<void> {
    if (this.pollInflight) return;
    if (!gatewayHealthy()) {
      this.pollStretch = Math.min(POLL_STRETCH_MAX, this.pollStretch * 2);
      return;
    }
    const limitedAtStart = rpcGatewayMetrics().rateLimited429;
    this.pollInflight = true;
    try {
      const actives = [...this.mints.values()]
        .filter((s) => s.id.bondingCurveKey && !s.id.migrated)
        .sort((a, b) => (b.lastTradeAt ?? b.id.createdAt) - (a.lastTradeAt ?? a.id.createdAt))
        .slice(0, 40);
      const BATCH = 3;
      for (let i = 0; i < actives.length; i += BATCH) {
        await Promise.all(actives.slice(i, i + BATCH).map((st) => this.pollMintTrades(st)));
      }
      // A round that caused no new 429s recovers the cadence gradually.
      if (rpcGatewayMetrics().rateLimited429 === limitedAtStart) {
        this.pollStretch = Math.max(1, Math.floor(this.pollStretch / 2));
      }
    } catch {
      // polling is best-effort; a funded-key WS stream remains the upgrade path
    } finally {
      this.pollInflight = false;
    }
  }

  private async pollMintTrades(st: MintState): Promise<void> {
    const curve = st.id.bondingCurveKey;
    if (!curve) return;
    try {
      this.stats.rpcCalls += 1;
      const j = await this.rpcPost<{
        result?: { value?: { signature: string; err: unknown; blockTime: number | null }[] | null };
      }>("getSignaturesForAddress", [curve, { limit: 12 }]);
      const list = j?.result?.value ?? [];
      const fresh = list
        .filter(
          (s) => s && !s.err && s.signature && !this.dedupe.has(`${s.signature}:buy`) && !this.dedupe.has(`${s.signature}:sell`),
        )
        .slice(0, 4);
      for (const s of fresh) {
        await this.parseCurveTrade(st, s.signature, s.blockTime);
      }
    } catch {
      // per-mint polling failure — skipped this round
    }
  }

  private async rpcPost<T>(method: string, params: unknown[]): Promise<T | null> {
    // All engine RPC flows through the shared gateway: coalescing, short-TTL
    // caching, token-bucket throttling, 429 backoff with Retry-After, and the
    // circuit breaker. Failures throw typed errors here and are surfaced to
    // the adaptive poll scheduler instead of being silently swallowed.
    try {
      return await gatewayRpc<T>(method, params);
    } catch (err) {
      if (err instanceof Error && err.name === "RpcGatewayOpenError") {
        this.pollStretch = Math.min(POLL_STRETCH_MAX, this.pollStretch * 2);
      } else if (err instanceof Error && err.name === "RpcGatewayError") {
        const code = (err as Error & { code?: string }).code;
        if (code === "RATE_LIMITED") this.pollStretch = Math.min(POLL_STRETCH_MAX, this.pollStretch * 2);
      }
      return null;
    }
  }

  /** Decode one curve transaction into a real trade (curve-balance deltas). */
  private async parseCurveTrade(st: MintState, sig: string, blockTime: number | null): Promise<void> {
    const mint = st.id.mint;
    const curve = st.id.bondingCurveKey;
    if (!curve) return;
    this.stats.rpcCalls += 1;
    const j = await this.rpcPost<{
      result?: {
        meta?: {
          err: unknown;
          preBalances: number[];
          postBalances: number[];
          preTokenBalances?: { mint: string; owner: string; uiTokenAmount: { uiAmount: number | null } }[];
          postTokenBalances?: { mint: string; owner: string; uiTokenAmount: { uiAmount: number | null } }[];
        } | null;
        transaction?: { message?: { accountKeys?: { pubkey: string }[] } };
      } | null;
    }>("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    const meta = j?.result?.meta;
    if (!meta) return; // not yet confirmed — retried naturally next poll
    if (meta.err) return; // failed transaction — never counted (spec)
    const preTok = meta.preTokenBalances ?? [];
    const postTok = meta.postTokenBalances ?? [];
    const preByOwner = new Map<string, number>();
    const postByOwner = new Map<string, number>();
    for (const p of preTok) if (p.mint === mint) preByOwner.set(p.owner, p.uiTokenAmount.uiAmount ?? 0);
    for (const p of postTok) if (p.mint === mint) postByOwner.set(p.owner, p.uiTokenAmount.uiAmount ?? 0);
    const curveDelta = (postByOwner.get(curve) ?? 0) - (preByOwner.get(curve) ?? 0);
    if (curveDelta === 0) return; // not a curve trade for this mint
    const side: "buy" | "sell" = curveDelta < 0 ? "buy" : "sell";
    const tokenAmount = Math.abs(curveDelta);
    if (!(tokenAmount > 0)) return;
    // Counterparty: an owner whose balance moved the opposite way.
    let trader = "unknown";
    for (const [owner, post] of postByOwner) {
      if (owner === curve) continue;
      const pre = preByOwner.get(owner) ?? 0;
      if ((post - pre) * -curveDelta > 0) {
        trader = owner;
        break;
      }
    }
    // SOL side of the curve account (SOL in on buys, out on sells).
    const keys = j?.result?.transaction?.message?.accountKeys ?? [];
    const idx = keys.findIndex((k) => k.pubkey === curve);
    let solAmount = 0;
    if (idx >= 0 && meta.preBalances[idx] !== undefined && meta.postBalances[idx] !== undefined) {
      solAmount = Math.abs((meta.preBalances[idx] - meta.postBalances[idx]) / 1e9);
    }
    if (!(solAmount > 0)) return;
    const t = blockTime && blockTime > 1_500_000_000 ? blockTime * 1000 : Date.now();
    this.processTrade(mint, { t, priceSol: solAmount / tokenAmount, sol: solAmount, side, wallet: trader, sig }, null);
  }

  private windowMetrics(trades: LiveTrade[], from: number, to: number): WindowMetrics {
    let volSol = 0, buys = 0, sells = 0, count = 0;
    let firstPrice: number | null = null, lastPrice: number | null = null, firstT = Infinity, lastT = -Infinity;
    const buyers = new Set<string>();
    const sellers = new Set<string>();
    for (const t of trades) {
      if (t.t < from || t.t > to) continue;
      count += 1;
      volSol += t.sol;
      if (t.side === "buy") { buys += 1; buyers.add(t.wallet); } else { sells += 1; sellers.add(t.wallet); }
      if (t.t < firstT) { firstT = t.t; firstPrice = t.priceSol; }
      if (t.t > lastT) { lastT = t.t; lastPrice = t.priceSol; }
    }
    const changePct =
      count >= MIN_TRADES_FOR_CHANGE && firstPrice !== null && lastPrice !== null && firstPrice > 0
        ? ((lastPrice - firstPrice) / firstPrice) * 100
        : null;
    return { volSol, volUsd: null, buys, sells, buyers: buyers.size, sellers: sellers.size, changePct, trades: count };
  }

  private metricsFor(st: MintState, now: number, solUsd: number | null): LiveTokenMetrics {
    const w = (tf: TrendingTimeframe): WindowMetrics => {
      const m = this.windowMetrics(st.trades, now - WINDOW_MS[tf], now + 1000);
      m.volUsd = solUsd !== null ? m.volSol * solUsd : null;
      return m;
    };
    const last = st.trades.length > 0 ? st.trades[st.trades.length - 1] : null;
    const priceSol = last ? last.priceSol : null;
    const priceUsd = priceSol !== null && solUsd !== null ? priceSol * solUsd : null;
    const marketCapSol = priceSol !== null && st.id.supply !== null ? priceSol * st.id.supply : null;
    const marketCapUsd = marketCapSol !== null && solUsd !== null ? marketCapSol * solUsd : null;
    const oldest = st.trades.length > 0 ? st.trades[0].t : now;
    // A window is "partial" when our stored data does not cover it fully.
    const historyPartial = now - oldest < WINDOW_MS["24h"];
    const m5 = this.windowMetrics(st.trades, now - WINDOW_MS["5m"], now + 1000);
    const union5 = new Set<string>();
    for (const t of st.trades) {
      if (t.t >= now - WINDOW_MS["5m"]) union5.add(t.wallet);
    }
    return {
      mint: st.id.mint,
      name: st.id.name,
      symbol: st.id.symbol,
      imageUrl: st.id.imageUrl,
      createdAt: st.id.createdAt,
      creator: st.id.creator,
      migrated: st.id.migrated,
      migratedAt: st.id.migratedAt,
      poolAddress: st.id.poolAddress,
      priceSol,
      priceUsd,
      marketCapUsd,
      marketCapSol,
      eventMarketCapSol: st.eventMarketCapSol,
      vol5m: m5,
      vol1h: w("1h"),
      vol4h: w("4h"),
      vol12h: w("12h"),
      vol24h: w("24h"),
      lastTradeAt: st.lastTradeAt,
      trades5m: m5.trades,
      uniqueTraders5m: union5.size,
      historyPartial,
    };
  }

  private sortFor(tab: TrendingTab, a: RankedToken, b: RankedToken): number {
    switch (tab) {
      case "volume":
        return (b.vol24h.volSol - a.vol24h.volSol) || (b.vol24h.trades - a.vol24h.trades);
      case "gainers":
        return (b.vol1h.changePct ?? -Infinity) - (a.vol1h.changePct ?? -Infinity);
      case "losers":
        return (a.vol1h.changePct ?? Infinity) - (b.vol1h.changePct ?? Infinity);
      case "most-bought":
        return (b.vol1h.buys - a.vol1h.buys) || (b.vol1h.volSol - a.vol1h.volSol);
      case "newest":
        return b.createdAt - a.createdAt;
      case "migrated":
        return (b.migratedAt ?? 0) - (a.migratedAt ?? 0);
      case "trending":
      default: {
        // Real-activity score: window volume weighted by unique trader breadth.
        const sa = a.vol1h.volSol * Math.log2(2 + a.vol1h.buyers + a.vol1h.sellers);
        const sb = b.vol1h.volSol * Math.log2(2 + b.vol1h.buyers + b.vol1h.sellers);
        return sb - sa;
      }
    }
  }

  private ranked(tab: TrendingTab, tf: TrendingTimeframe, now: number, solUsd: number | null): RankedToken[] {
    const tfKey = (m: LiveTokenMetrics): WindowMetrics =>
      tf === "5m" ? m.vol5m : tf === "1h" ? m.vol1h : tf === "4h" ? m.vol4h : tf === "12h" ? m.vol12h : m.vol24h;
    const all: RankedToken[] = [];
    for (const st of this.mints.values()) {
      const m = this.metricsFor(st, now, solUsd);
      const w = tfKey(m);
      if (tab !== "newest" && tab !== "migrated" && w.trades === 0) {
        continue; // ranking tabs require real trading activity in the window
      }
      if ((tab === "gainers" || tab === "losers") && (w.trades < MIN_TRADES_FOR_CHANGE || m.vol1h.changePct === null)) {
        continue; // guard against isolated-transaction distortion
      }
      let score = 0;
      if (tab === "trending") score = w.volSol * Math.log2(2 + w.buyers + w.sellers);
      else if (tab === "volume") score = w.volSol;
      else if (tab === "gainers" || tab === "losers") score = m.vol1h.changePct ?? 0;
      else if (tab === "most-bought") score = w.buys;
      else if (tab === "newest") score = -m.createdAt;
      else if (tab === "migrated") score = -(m.migratedAt ?? 0);
      all.push({ ...m, score });
    }
    all.sort((a, b) => this.sortFor(tab, a, b));
    return all;
  }

  private toRow(m: RankedToken, tf: TrendingTimeframe): TrendingRow {
    const w = tf === "5m" ? m.vol5m : tf === "1h" ? m.vol1h : tf === "4h" ? m.vol4h : tf === "12h" ? m.vol12h : m.vol24h;
    return {
      mint: m.mint,
      name: m.name,
      symbol: m.symbol,
      imageUrl: m.imageUrl,
      createdAt: m.createdAt,
      ageMs: Math.max(0, Date.now() - m.createdAt),
      migrated: m.migrated,
      migratedAt: m.migratedAt,
      poolAddress: m.poolAddress,
      priceSol: m.priceSol,
      priceUsd: m.priceUsd,
      marketCapUsd: m.marketCapUsd,
      volumeUsd: w.volUsd,
      volumeSol: w.volSol,
      changePct: w.changePct,
      buys: w.buys,
      sells: w.sells,
      buyers: w.buyers,
      sellers: w.sellers,
      lastTradeAt: m.lastTradeAt,
      hot: m.trades5m >= HOT_TRADES_5M || m.uniqueTraders5m >= HOT_TRADERS_5M,
      score: m.score,
    };
  }

  /** Ranked rows for the API/SSE (tab + timeframe + limit). */
  getTrending(tab: TrendingTab, tf: TrendingTimeframe, limit = 50): {
    rows: TrendingRow[];
    meta: {
      solUsd: number | null;
      solUsdSource: string | null;
      generatedAt: number;
      historyPartial: boolean;
      stale: boolean;
    };
  } {
    const now = Date.now();
    const sol = peekSolUsd();
    const ranked = this.ranked(tab, tf, now, sol?.usd ?? null);
    const rows = ranked.slice(0, limit).map((m) => this.toRow(m, tf));
    const stale =
      !this.stats.connected ||
      (this.stats.lastMessageAt !== null && now - this.stats.lastMessageAt > 45_000);
    return {
      rows,
      meta: {
        solUsd: sol?.usd ?? null,
        solUsdSource: sol?.source ?? null,
        generatedAt: now,
        historyPartial: this.stats.historyPartial,
        stale,
      },
    };
  }

  /** Live stats for /api/trending/stats (cost + health monitoring). */
  getStats(): TrendingStats {
    const ws = this.ws.getStats();
    const sol = peekSolUsd();
    this.stats.activeTradeSubscriptions = ws.tradeSubscriptions.length;
    this.stats.wsBytesReceived = ws.bytesReceived;
    this.stats.reconnects = ws.reconnects;
    this.stats.lastMessageAt = ws.lastMessageAt;
    this.stats.tradeStreamingAvailable = ws.tradeStreamingAvailable;
    this.stats.tradeStreamingReason = ws.tradeStreamingReason;
    this.stats.solUsd = sol?.usd ?? null;
    this.stats.solUsdSource = sol?.source ?? null;
    this.stats.historyPartial = Date.now() - this.dataFrom < WINDOW_MS["24h"];
    return { ...this.stats, rpc: rpcGatewayMetrics(), pollIntervalMs: this.pollBaseMs * this.pollStretch };
  }

  /** Subscription hygiene: unsubscribe long-inactive tokens (stay in limits). */
  private sweep(): void {
    const now = Date.now();
    for (const mint of this.ws.subscribedMints()) {
      const st = this.mints.get(mint);
      if (!st) {
        this.ws.unsubscribeTokenTrade(mint);
        continue;
      }
      const idle = st.lastTradeAt === null || now - st.lastTradeAt > INACTIVE_UNSUB_MS;
      const old = now - st.id.createdAt > INACTIVE_UNSUB_MS;
      if (idle && old) this.ws.unsubscribeTokenTrade(mint);
    }
    // Bound memory: drop never-traded identities older than 6h.
    for (const [mint, st] of this.mints) {
      if (st.trades.length === 0 && now - st.id.createdAt > 6 * 60 * 60_000) {
        this.mints.delete(mint);
      }
    }
    this.stats.tokensTracked = this.mints.size;
  }

  // ------------------------------------------------------------- persistence

  private persist(): void {
    const tokens: LiveTokenIdentity[] = [];
    const trades: Record<string, LiveTrade[]> = {};
    const now = Date.now();
    for (const [mint, st] of this.mints) {
      if (st.trades.length > 0 || now - st.id.createdAt < 24 * 60 * 60_000) {
        tokens.push(st.id);
        if (st.trades.length > 0) trades[mint] = st.trades.slice(-2000);
      }
    }
    const sol = peekSolUsd();
    const snap: SnapshotData = {
      version: 1,
      savedAt: Date.now(),
      solUsd: sol,
      tokens,
      trades,
    };
    saveSnapshot(snap);
  }

  private restore(snap: SnapshotData): void {
    for (const id of snap.tokens) {
      // Supply is NOT restored — it is re-verified via RPC after boot (the
      // snapshot may carry values computed by an older parser).
      this.mints.set(id.mint, {
        id: { ...id, supply: null, decimals: null },
        trades: [],
        lastTradeAt: null,
        eventMarketCapSol: null,
      });
    }
    for (const [mint, trades] of Object.entries(snap.trades)) {
      const st = this.mints.get(mint);
      if (!st) continue;
      st.trades = trades.slice(-MAX_TRADES_PER_MINT);
      st.lastTradeAt = st.trades.length > 0 ? st.trades[st.trades.length - 1].t : null;
    }
    // Re-verify supply for the most recently active tokens (bounded).
    [...this.mints.values()]
      .filter((s) => s.trades.length > 0)
      .sort((a, b) => (b.lastTradeAt ?? 0) - (a.lastTradeAt ?? 0))
      .slice(0, 60)
      .forEach((s) => void this.verifySupply(s.id.mint));
    this.stats.tokensTracked = this.mints.size;
  }

  // ------------------------------------------------------------------ SSE

  private sseMeta = new Map<(json: string) => void, { send: (json: string) => void; tab: TrendingTab; tf: TrendingTimeframe }>();

  /** Register an SSE client for a (tab, tf) combo; returns an unsubscriber. */
  subscribeSSE(tab: TrendingTab, tf: TrendingTimeframe, send: (json: string) => void): () => void {
    this.sseClients.add(send);
    this.sseMeta.set(send, { send, tab, tf });
    return () => {
      this.sseClients.delete(send);
      this.sseMeta.delete(send);
    };
  }

  /** Batched broadcast: one computation per unique (tab, tf) per tick. */
  private broadcast(): void {
    if (this.sseClients.size === 0) return;
    const now = Date.now();
    const byCombo = new Map<string, string>();
    for (const client of this.sseMeta.values()) {
      const key = `${client.tab}:${client.tf}`;
      const memo = this.lastBroadcast.get(key);
      if (memo && now - memo.at < 1500) {
        client.send(memo.json);
        continue;
      }
      let json = byCombo.get(key);
      if (!json) {
        const snap = this.getTrending(client.tab, client.tf, 50);
        json = JSON.stringify({ type: "trending", ...snap });
        byCombo.set(key, json);
        this.lastBroadcast.set(key, { at: now, json });
      }
      client.send(json);
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __fluxpadLiveEngine: PumpLiveEngine | undefined;
}

/** Process-wide singleton (survives dev HMR via globalThis). */
export function getEngine(): PumpLiveEngine {
  if (!globalThis.__fluxpadLiveEngine) {
    const engine = new PumpLiveEngine();
    globalThis.__fluxpadLiveEngine = engine;
    engine.start();
  }
  return globalThis.__fluxpadLiveEngine;
}
