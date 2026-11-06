import type { Metadata } from "next";
import TreasuryDashboard from "@/components/treasury/treasury-dashboard";
import { OfficialTokenCard } from "@/components/official/official-token-card";
import { getOfficialTokenConfig } from "@/lib/official-token/config";
import { officialTokenView } from "@/lib/official-token/token-display";

/**
 * /treasury — public, read-only Treasury & On-Chain Activity dashboard for
 * FluxPad's official $FLUX token. Renders only verified on-chain data;
 * missing configuration renders as explicit placeholder states.
 *
 * Force-dynamic: the Official $FLUX contract address must reflect the
 * CURRENT FLUXPAD_OFFICIAL_MINT configuration on every request.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Treasury",
  description:
    "Public, verifiable treasury overview for the official $FLUX token: creator fees collected, allocations, buybacks, burns, and on-chain activity.",
};

export default function TreasuryPage() {
  const officialToken = officialTokenView(getOfficialTokenConfig());
  return (
    <div className="animate-fade-up mx-auto max-w-5xl">
      <header className="mb-4">
        <h1 className="font-display text-lg font-semibold tracking-tight text-ink">Treasury</h1>
        <p className="mt-0.5 text-2xs text-night-500">
          Public, read-only overview of the official $FLUX treasury — verified on-chain
          activity only. Nothing on this page can initiate transfers.
        </p>
      </header>
      {/* Same official-token source of truth as the homepage section */}
      <div className="mb-4">
        <OfficialTokenCard initialView={officialToken} />
      </div>
      <TreasuryDashboard />
    </div>
  );
}