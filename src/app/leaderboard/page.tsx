import { LeaderboardPanel } from "@/components/dashboard/leaderboard-panel";

export const metadata = { title: "Leaderboard" };

export default function LeaderboardPage() {
  return (
    <div className="animate-fade-up">
      <header className="mb-4">
        <h1 className="font-display text-lg font-semibold tracking-tight text-ink">Creator Leaderboard</h1>
        <p className="mt-0.5 text-2xs text-night-500">
          Computed from FluxPad&apos;s launch registry. Launch counts and on-chain-verified
          graduations only — no earnings or volume data is implied.
        </p>
      </header>
      <LeaderboardPanel full />
    </div>
  );
}
