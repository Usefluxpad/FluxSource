import { ActivityPanel } from "@/components/dashboard/activity-panel";

export const metadata = { title: "Live Launches" };

export default function LivePage() {
  return (
    <div className="animate-fade-up">
      <header className="mb-4">
        <h1 className="font-display text-lg font-semibold tracking-tight text-ink">Live Launches</h1>
        <p className="mt-0.5 text-2xs text-night-500">
          Real lifecycle events from FluxPad&apos;s registry — preparation, confirmation,
          curve progress, graduation, and pool verification. Auto-refreshes every 20s.
        </p>
      </header>
      <ActivityPanel full />
    </div>
  );
}
