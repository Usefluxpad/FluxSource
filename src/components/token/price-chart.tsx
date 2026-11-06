"use client";
/**
 * Canvas price chart — candlesticks + line toggle + volume bars + trade
 * markers, rendered from REAL on-chain trade data only (no fabricated
 * candles). The data payload carries its own coverage window, which the
 * component displays verbatim.
 */
import { useEffect, useRef, useState } from "react";
import type { Candle, TokenTrade } from "@/lib/token/trades";
import { useIsDarkMode } from "@/components/theme/theme-provider";

const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;

/** Theme-aware canvas palette (CSS vars can't paint inside a canvas). */
function chartPalette(isDark: boolean) {
  return isDark
    ? {
        bg: "#0E1C32",
        grid: "#253A57",
        label: "#A6B5CA",
        up: "#4ADE80",
        down: "#F87171",
        line: "#5B9BFF",
        volUp: "rgba(74,222,128,0.25)",
        volDown: "rgba(248,113,113,0.25)",
        lastPrice: "#5B9BFF",
        lastLabel: "#9FC2FF",
        crosshair: "#31486B",
        readout: "#A6B5CA",
      }
    : {
        bg: "#FFFFFF",
        grid: "#E8EEF7",
        label: "#718096",
        up: "#16A34A",
        down: "#E05252",
        line: "#155EEF",
        volUp: "rgba(22,163,74,0.30)",
        volDown: "rgba(224,82,82,0.30)",
        lastPrice: "#155EEF",
        lastLabel: "#1746B8",
        crosshair: "#C9D8EC",
        readout: "#718096",
      };
}

export function PriceChart({
  candles,
  trades,
  interval,
  onIntervalChange,
  coverageNote,
  coverageFrom,
  coverageTo,
  loading,
}: {
  candles: Candle[];
  trades: TokenTrade[];
  interval: string;
  onIntervalChange: (i: string) => void;
  coverageNote: string;
  coverageFrom: number | null;
  coverageTo: number | null;
  loading: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<"candles" | "line">("candles");
  const [hover, setHover] = useState<{ x: number; index: number } | null>(null);
  const isDark = useIsDarkMode();
  const P = chartPalette(isDark);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, w, h);
    if (candles.length === 0) return;

    const padL = 8;
    const padR = 62;
    const padT = 10;
    const volH = Math.min(70, h * 0.18);
    const chartH = h - padT - volH - 26;
    const chartW = w - padL - padR;
    const prices = candles.flatMap((c) => [c.high, c.low]);
    let max = Math.max(...prices);
    let min = Math.min(...prices);
    const span = max - min || max * 0.02 || 1;
    max += span * 0.06;
    min = Math.max(0, min - span * 0.06);
    const t0 = candles[0].time;
    const t1 = candles[candles.length - 1].time;
    const tSpan = Math.max(1, t1 - t0);
    const x = (time: number) => padL + ((time - t0) / tSpan) * chartW;
    const y = (p: number) => padT + (1 - (p - min) / (max - min)) * chartH;
    const bw = Math.max(2, Math.min(14, (chartW / candles.length) * 0.7));

    // Grid + y labels
    ctx.strokeStyle = P.grid;
    ctx.fillStyle = P.label;
    ctx.font = "10px monospace";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const p = min + ((max - min) * i) / 4;
      const yy = y(p);
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(w - padR, yy);
      ctx.stroke();
      ctx.fillText(p < 1 ? p.toPrecision(3) : p.toLocaleString(undefined, { maximumFractionDigits: 2 }), w - padR + 4, yy + 3);
    }
    ctx.fillStyle = P.label;
    ctx.fillText(new Date(t0 * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), padL, h - 8);
    ctx.fillText(new Date(t1 * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), w - padR - 46, h - 8);

    if (mode === "candles") {
      candles.forEach((c) => {
        const cx = x(c.time) + (chartW / candles.length) / 2 - bw / 2;
        const up = c.close >= c.open;
        ctx.strokeStyle = up ? P.up : P.down;
        ctx.fillStyle = up ? P.up : P.down;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + bw / 2, y(c.high));
        ctx.lineTo(cx + bw / 2, y(c.low));
        ctx.stroke();
        const yo = y(c.open);
        const yc = y(c.close);
        ctx.fillRect(cx, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
      });
    } else {
      ctx.strokeStyle = P.line;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      candles.forEach((c, i) => {
        const px = x(c.time) + (chartW / candles.length) / 2;
        const py = y(c.close);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }

    // Volume bars
    const maxVol = Math.max(...candles.map((c) => c.volume), 1);
    candles.forEach((c) => {
      const cx = x(c.time) + (chartW / candles.length) / 2 - bw / 2;
      const vh = (c.volume / maxVol) * volH;
      ctx.fillStyle = c.close >= c.open ? P.volUp : P.volDown;
      ctx.fillRect(cx, h - 26 - vh, bw, vh);
    });

    // Last price dashed line
    const last = candles[candles.length - 1].close;
    ctx.strokeStyle = P.lastPrice;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, y(last));
    ctx.lineTo(w - padR, y(last));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = P.lastLabel;
    ctx.fillText(last < 1 ? last.toPrecision(3) : last.toLocaleString(undefined, { maximumFractionDigits: 2 }), w - padR + 4, y(last) - 3);

    // Trade markers (on-page trades with a known time and price)
    trades.slice(0, 40).forEach((t) => {
      if (t.blockTime == null || t.priceSol == null || t.kind === "unknown") return;
      if (t.blockTime < t0 || t.blockTime > t1) return;
      const px = x(t.blockTime);
      const py = y(t.priceSol);
      ctx.fillStyle = t.kind === "buy" ? P.up : P.down;
      ctx.beginPath();
      ctx.arc(px, py, 2.2, 0, Math.PI * 2);
      ctx.fill();
    });

    // Hover crosshair + readout
    if (hover) {
      const c = candles[Math.min(hover.index, candles.length - 1)];
      if (c) {
        const cx = x(c.time) + (chartW / candles.length) / 2;
        ctx.strokeStyle = P.crosshair;
        ctx.beginPath();
        ctx.moveTo(cx, padT);
        ctx.lineTo(cx, h - 26);
        ctx.stroke();
        ctx.fillStyle = P.readout;
        ctx.font = "10px monospace";
        const f = (v: number) => (v < 1 ? v.toPrecision(3) : v.toFixed(4));
        ctx.fillText(
          `${new Date(c.time * 1000).toLocaleTimeString()}  O:${f(c.open)}  H:${f(c.high)}  L:${f(c.low)}  C:${f(c.close)}  VOL:${c.volume.toFixed(3)} SOL`,
          padL,
          h - 16,
        );
      }
    }
  }, [candles, mode, hover, interval, P]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = e.clientX - rect.left - 8;
    const chartW = rect.width - 8 - 62;
    if (candles.length === 0 || chartW <= 0) return;
    const t0 = candles[0].time;
    const t1 = candles[candles.length - 1].time;
    const time = t0 + (relX / chartW) * Math.max(1, t1 - t0);
    let index = 0;
    let bestD = Infinity;
    candles.forEach((c, i) => {
      const d = Math.abs(c.time - time);
      if (d < bestD) {
        bestD = d;
        index = i;
      }
    });
    setHover({ x: relX, index });
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-0.5 rounded-md bg-night-800 p-0.5">
          {INTERVALS.map((i) => (
            <button
              key={i}
              onClick={() => onIntervalChange(i)}
              className={`rounded px-2 py-1 text-2xs font-medium transition ${
                interval === i ? "bg-night-700 text-ink" : "text-night-400 hover:text-ink"
              }`}
            >
              {i}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5 rounded-md bg-night-800 p-0.5">
          {(["candles", "line"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded px-2 py-1 text-2xs font-medium capitalize transition ${
                mode === m ? "bg-night-700 text-ink" : "text-night-400 hover:text-ink"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <canvas
        ref={canvasRef}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        className="h-[320px] w-full rounded-lg border border-night-700 bg-night-900"
      />
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-2xs text-night-500">
        <span>{coverageNote}</span>
        {coverageFrom != null && coverageTo != null && (
          <span>
            real-swap coverage: {new Date(coverageFrom * 1000).toLocaleString()} →{" "}
            {new Date(coverageTo * 1000).toLocaleString()}
          </span>
        )}
        {loading && <span className="text-ice-300">updating…</span>}
      </div>
    </div>
  );
}