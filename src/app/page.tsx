import Link from "next/link";
import { Icon } from "@/components/ui/icons";
import { TrendingPanel } from "@/components/dashboard/trending-panel";
import { ActivityPanel } from "@/components/dashboard/activity-panel";
import { LeaderboardPanel } from "@/components/dashboard/leaderboard-panel";
import { LatestPanel } from "@/components/dashboard/latest-panel";
import { OfficialTokenCard } from "@/components/official/official-token-card";
import { getRelayOfficialConfig } from "@/lib/relay-official/config";
import { officialTokenView } from "@/lib/relay-official/token-display";

/**
 * RelayPad dashboard home — a dense, live launch terminal. All panels render
 * real registry data with honest empty states; no fabricated market metrics.
 *
 * Force-dynamic: the Official $FLUX contract address must reflect the
 * CURRENT RELAY_OFFICIAL_MINT configuration on every request — a statically
 * prerendered CA would keep showing a stale (or placeholder) address after
 * the official mint is configured.
 */
export const dynamic = "force-dynamic";

export default function DashboardHomePage() {
  const officialToken = officialTokenView(getRelayOfficialConfig());
  return (
    <div className="animate-fade-up">
      {/* Electric Blue hero — the official Flux banner as texture inside a deep-blue stage */}
      <section className="relative mb-5 overflow-hidden rounded-2xl border border-deep/40 shadow-panel">
        <div className="absolute inset-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/flux-banner.jpg"
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover object-center"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-deep via-deep/85 to-mint-500/25" />
          <div className="absolute inset-0 bg-gradient-to-t from-deep/60 via-transparent to-transparent" />
        </div>

        <div className="relative px-6 py-12 sm:px-12 sm:py-16">
          <div className="max-w-2xl">
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-3 py-1 text-2xs font-semibold uppercase tracking-widest text-white backdrop-blur-sm">
              <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-frost" />
              Solana launch studio
            </p>
            <h1 className="font-display text-4xl font-bold leading-[1.08] tracking-tight text-white sm:text-5xl">
              Two Ways to Launch.
              <br />
              <span className="text-frost">One Place to Build.</span>
            </h1>
            <p className="mt-4 max-w-lg text-sm leading-relaxed text-white/80 sm:text-base">
              FluxPad brings two established Solana launch mechanisms into one seamless experience.
              Choose your preferred launch path, configure your token, and launch directly on-chain.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/create"
                className="inline-flex items-center gap-2 rounded-lg bg-paper px-6 py-3 text-sm font-semibold text-ink shadow-glow-mint transition duration-200 hover:bg-sky-100"
              >
                <Icon name="rocket" size={15} className="text-mint-600" />
                Create Token
              </Link>
              <Link
                href="/tokens"
                className="inline-flex items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-6 py-3 text-sm font-semibold text-white backdrop-blur-sm transition duration-200 hover:bg-white/20"
              >
                <Icon name="compass" size={15} />
                Explore Tokens
              </Link>
              <Link
                href="/vanity"
                className="inline-flex items-center gap-2 rounded-lg border border-white/20 px-6 py-3 text-sm font-medium text-white/90 transition duration-200 hover:bg-white/10 hover:text-white"
              >
                <Icon name="wand" size={15} />
                Vanity Mint
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Launch-route cards — the core FluxPad concept */}
      <section aria-label="Launch routes" className="mb-5 grid gap-3 sm:grid-cols-2">
        <Link
          href="/create"
          className="group relative flex flex-col gap-3 rounded-xl border border-night-700 bg-paper p-5 shadow-panel transition-all duration-200 hover:border-mint-500/50 hover:shadow-glow-mint"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-100 text-mint-700">
            <Icon name="zap" size={18} />
          </span>
          <span>
            <span className="font-display block text-base font-semibold text-ink">
              Start with a Bonding Curve{" "}
              <span className="ml-1 text-2xs font-normal uppercase tracking-wider text-mint-500">
                Pump.fun
              </span>
            </span>
            <span className="mt-1 block text-xs text-night-400">
              Launch through Pump.fun&apos;s bonding curve mechanism. Create your token and let
              the market determine its progression.
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-mint-600">
            Launch on Pump.fun
            <Icon name="chevronRight" size={13} className="transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>
        <Link
          href="/create"
          className="group relative flex flex-col gap-3 rounded-xl border border-night-700 bg-paper p-5 shadow-panel transition-all duration-200 hover:border-mint-500/50 hover:shadow-glow-mint"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-50 text-mint-500">
            <Icon name="layers" size={18} />
          </span>
          <span>
            <span className="font-display block text-base font-semibold text-ink">
              Launch Through LaunchLab{" "}
              <span className="ml-1 text-2xs font-normal uppercase tracking-wider text-mint-500">
                Raydium LaunchLab
              </span>
            </span>
            <span className="mt-1 block text-xs text-night-400">
              Create your token through Raydium LaunchLab and use its launch and liquidity
              infrastructure.
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-mint-600">
            Launch on LaunchLab
            <Icon name="chevronRight" size={13} className="transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>
      </section>

      {/* Four-panel dashboard grid with independent panel scrolling on desktop */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-4">
        <div className="min-w-0">
          <TrendingPanel />
        </div>
        <div className="min-w-0">
          <ActivityPanel />
        </div>
        <div className="min-w-0">
          <LeaderboardPanel />
        </div>
        <div className="min-w-0">
          <LatestPanel />
        </div>
      </div>

      {/* Official $FLUX token — public CA display with honest status */}
      <section aria-label="Official $FLUX token" className="mt-3">
        <OfficialTokenCard initialView={officialToken} />
      </section>
    </div>
  );
}
