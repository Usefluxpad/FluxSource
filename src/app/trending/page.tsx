import { TrendingBoard } from "@/components/trending/trending-board";

export const metadata = { title: "Trending" };
export const dynamic = "force-dynamic";

export default function TrendingPage() {
  return (
    <div className="animate-fade-up">
      <header className="mb-4">
        <h1 className="font-display text-lg font-semibold tracking-tight text-ink">Trending</h1>
        <p className="mt-0.5 text-2xs text-night-500">
          Live Pump.fun rankings from real trades streamed through FluxPad&apos;s backend — new
          tokens, volume, price movement, and migrations as they happen.
        </p>
      </header>
      <TrendingBoard />
    </div>
  );
}
