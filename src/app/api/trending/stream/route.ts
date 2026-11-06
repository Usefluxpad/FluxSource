/**
 * GET /api/trending/stream — Server-Sent Events for live Trending updates.
 * The backend keeps ONE centralized PumpPortal connection; browsers subscribe
 * here. Payloads are batched (2.5s tick, 1.5s memo per tab/timeframe) with a
 * 15s heartbeat. EventSource reconnects natively on drops.
 * Query: ?tab=...&tf=...
 */
import { getEngine } from "@/lib/pump-live/engine";
import type { TrendingTab, TrendingTimeframe } from "@/lib/pump-live/types";

export const dynamic = "force-dynamic";

const TABS: TrendingTab[] = ["trending", "volume", "gainers", "losers", "most-bought", "newest", "migrated"];
const TFS: TrendingTimeframe[] = ["5m", "1h", "4h", "12h", "24h"];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tabParam = url.searchParams.get("tab") as TrendingTab | null;
  const tfParam = url.searchParams.get("tf") as TrendingTimeframe | null;
  const tab = tabParam && TABS.includes(tabParam) ? tabParam : "trending";
  const tf = tfParam && TFS.includes(tfParam) ? tfParam : "1h";

  const engine = getEngine();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (json: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${json}\n\n`));
        } catch {
          closed = true;
        }
      };
      const unsubscribe = engine.subscribeSSE(tab, tf, send);

      // Heartbeat keeps intermediaries from idling the connection out.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          closed = true;
        }
      }, 15_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
