/**
 * PumpPortal WebSocket manager — the single centralized backend connection.
 *
 * Browsers never talk to PumpPortal directly; this manager owns:
 * - One persistent connection to wss://pumpportal.fun/api/data
 * - Permanent subscriptions: new tokens + migrations
 * - Managed per-token trade subscriptions (subscribe/unsubscribe, capped)
 * - Automatic reconnection with exponential backoff + jitter
 * - Stale-connection detection (forced reconnect on silence)
 * - Connection stats for /api/trending/stats
 *
 * Uses Node's native WebSocket (>=22) — no extra dependencies.
 * Never logs credentials; the API key (when configured) only rides the URL.
 */
import type { PumpPortalMigrationEvent, PumpPortalNewTokenEvent, PumpPortalTradeEvent } from "./types";

const BASE_URL = "wss://pumpportal.fun/api/data";
const STALE_MS = 45_000;
const MAX_BACKOFF_MS = 30_000;

export interface WsManagerStats {
  connected: boolean;
  reconnects: number;
  lastMessageAt: number | null;
  lastError: string | null;
  messagesReceived: number;
  bytesReceived: number;
  tradeSubscriptions: string[];
  pendingSubscribes: string[];
  /** False when PumpPortal gated trade streaming behind a funded key. */
  tradeStreamingAvailable: boolean | null;
  tradeStreamingReason: string | null;
}

export interface WsManagerHandlers {
  onNewToken: (e: PumpPortalNewTokenEvent, receivedAt: number) => void;
  onTrade: (e: PumpPortalTradeEvent, receivedAt: number) => void;
  onMigration: (e: PumpPortalMigrationEvent, receivedAt: number) => void;
  onStateChange?: (connected: boolean) => void;
}

export class PumpPortalWsManager {
  private ws: WebSocket | null = null;
  private handlers: WsManagerHandlers;
  private apiKey: string | null;
  private maxTradeSubs: number;

  private tradeSubs = new Set<string>();
  private pendingSubs = new Set<string>();
  private pendingUnsubs = new Set<string>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessageAt: number | null = null;
  private lastError: string | null = null;
  private messagesReceived = 0;
  private bytesReceived = 0;
  private reconnects = 0;
  private stopped = false;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private tradeStreamingAvailable: boolean | null = null;
  private tradeStreamingReason: string | null = null;

  constructor(handlers: WsManagerHandlers, opts: { apiKey?: string | null; maxTradeSubs?: number } = {}) {
    this.handlers = handlers;
    this.apiKey = opts.apiKey ?? null;
    this.maxTradeSubs = opts.maxTradeSubs ?? 300;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.staleTimer) clearTimeout(this.staleTimer);
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    this.ws = null;
  }

  getStats(): WsManagerStats {
    return {
      connected: !!this.ws && this.ws.readyState === WebSocket.OPEN,
      reconnects: this.reconnects,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
      messagesReceived: this.messagesReceived,
      bytesReceived: this.bytesReceived,
      tradeSubscriptions: [...this.tradeSubs],
      pendingSubscribes: [...this.pendingSubs],
      tradeStreamingAvailable: this.tradeStreamingAvailable,
      tradeStreamingReason: this.tradeStreamingReason,
    };
  }

  /** Queue a trade subscription for a mint (respects the cap; FIFO eviction). */
  subscribeTokenTrade(mint: string): void {
    if (this.tradeSubs.has(mint) || this.pendingSubs.has(mint)) return;
    if (this.tradeSubs.size + this.pendingSubs.size >= this.maxTradeSubs) {
      // Evict the oldest subscription to stay within limits.
      const oldest = this.tradeSubs.keys().next().value as string | undefined;
      if (oldest) {
        this.tradeSubs.delete(oldest);
        this.pendingUnsubs.add(oldest);
      }
    }
    this.pendingSubs.add(mint);
    this.flushSubscriptions();
  }

  /** Explicitly drop a mint's trade subscription (e.g. long-inactive token). */
  unsubscribeTokenTrade(mint: string): void {
    if (this.pendingSubs.has(mint)) {
      this.pendingSubs.delete(mint);
      return;
    }
    if (this.tradeSubs.has(mint)) {
      this.tradeSubs.delete(mint);
      this.pendingUnsubs.add(mint);
      this.flushSubscriptions();
    }
  }

  /** Names of currently subscribed mints (for the subscription manager). */
  subscribedMints(): string[] {
    return [...this.tradeSubs];
  }

  private socketUrl(): string {
    // Subscriptions are sent as messages after open (the query-param form is
    // not honored by the current API). The API key, when configured, rides
    // the URL and is never logged.
    const url = new URL(BASE_URL);
    if (this.apiKey) url.searchParams.set("apiKey", this.apiKey);
    return url.toString();
  }

  private connect(): void {
    if (this.stopped) return;
    try {
      const ws = new WebSocket(this.socketUrl());
      this.ws = ws;

      ws.onopen = () => {
        this.reconnectAttempt = 0;
        this.handlers.onStateChange?.(true);
        // Permanent subscriptions first; token-trade subs follow (only when a
        // funded API key is configured — the server otherwise rejects them).
        this.sendSafe({ method: "subscribeNewToken" });
        this.sendSafe({ method: "subscribeMigration" });
        const all = [...this.tradeSubs, ...this.pendingSubs];
        this.tradeSubs = new Set(all);
        this.pendingSubs.clear();
        if (this.apiKey && all.length > 0) {
          for (let i = 0; i < all.length; i += 50) {
            this.sendSafe({ method: "subscribeTokenTrade", keys: all.slice(i, i + 50) });
          }
        }
        this.flushSubscriptions();
        this.armStaleWatch();
      };

      ws.onmessage = (ev: MessageEvent) => {
        this.lastMessageAt = Date.now();
        this.messagesReceived += 1;
        if (typeof ev.data === "string") this.bytesReceived += ev.data.length;
        this.armStaleWatch();
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data as string) as Record<string, unknown>;
        } catch {
          return; // non-JSON frame — ignore
        }
        const receivedAt = Date.now();
        if (typeof msg.message === "string" && msg.message.includes("only available when connecting with an API key")) {
          this.tradeStreamingAvailable = false;
          this.tradeStreamingReason = msg.message;
          return;
        }
        if (typeof msg.message === "string") return; // subscription ack — not data
        if (typeof msg.mint !== "string") return;
        const txType = typeof msg.txType === "string" ? msg.txType : null;
        if (txType === "create") {
          this.handlers.onNewToken(msg as unknown as PumpPortalNewTokenEvent, receivedAt);
          return;
        }
        if (txType === "migrate") {
          this.handlers.onMigration(msg as unknown as PumpPortalMigrationEvent, receivedAt);
          return;
        }
        if (txType === "buy" || txType === "sell") {
          this.handlers.onTrade(msg as unknown as PumpPortalTradeEvent, receivedAt);
        }
      };

      ws.onerror = () => {
        this.lastError = "socket error";
      };

      ws.onclose = () => {
        this.handlers.onStateChange?.(false);
        if (!this.stopped) this.scheduleReconnect();
      };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect();
    }
  }

  private armStaleWatch(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    // PumpPortal continuously streams new-token events; silence means the
    // connection is silently dead (common behind proxies) — force reconnect.
    this.staleTimer = setTimeout(() => {
      if (this.stopped) return;
      if (this.lastMessageAt === null || Date.now() - this.lastMessageAt > STALE_MS) {
        try {
          this.ws?.close();
        } catch {
          // ignore
        }
      } else {
        this.armStaleWatch();
      }
    }, STALE_MS);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnects += 1;
    const attempt = Math.min(this.reconnectAttempt, 6);
    const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
    const jitter = Math.floor(Math.random() * 500);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, backoff + jitter);
  }

  private sendSafe(payload: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // socket closing — the reconnect path re-subscribes
    }
  }

  /** Send queued (un)subscriptions while the socket is open. */
  private flushSubscriptions(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.pendingSubs.size > 0) {
      const keys = [...this.pendingSubs];
      keys.forEach((k) => this.tradeSubs.add(k));
      this.pendingSubs.clear();
      // Batch keys (PumpPortal accepts arrays).
      for (let i = 0; i < keys.length; i += 50) {
        this.sendSafe({ method: "subscribeTokenTrade", keys: keys.slice(i, i + 50) });
      }
    }
    if (this.pendingUnsubs.size > 0) {
      const keys = [...this.pendingUnsubs];
      this.pendingUnsubs.clear();
      for (let i = 0; i < keys.length; i += 50) {
        this.sendSafe({ method: "unsubscribeTokenTrade", keys: keys.slice(i, i + 50) });
      }
    }
  }
}
