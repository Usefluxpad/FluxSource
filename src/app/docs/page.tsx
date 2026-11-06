import Link from "next/link";
import { Panel } from "@/components/dashboard/panel";
import { RouteBadge } from "@/components/brand/route-badge";

export const metadata = { title: "Documentation" };

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20">
      <Panel title={title} icon="book">
        <div className="space-y-3 p-4 text-[13px] leading-relaxed text-night-400 [&_a]:text-mint-400 [&_a:hover]:underline [&_code]:rounded [&_code]:bg-night-700 [&_code]:px-1 [&_code]:font-mono [&_code]:text-2xs [&_code]:text-mint-300 [&_strong]:text-ink">
          {children}
        </div>
      </Panel>
    </section>
  );
}
export default function DocsPage() {
  return (
    <div className="animate-fade-up mx-auto max-w-3xl space-y-3">
      <header className="mb-4">
        <h1 className="font-display text-lg font-semibold tracking-tight text-ink">Documentation</h1>
        <p className="mt-0.5 text-2xs text-night-500">
          How FluxPad works, how your keys stay yours, and what is verified on-chain.
        </p>
      </header>

      <Section id="routes" title="Two Ways to Launch. One Place to Build.">
        <p>
          FluxPad brings two established Solana launch mechanisms into one seamless experience. You
          choose your launch path when creating a token; the choice determines the bonding-curve
          program, fees, and where the token graduates:
        </p>
        <ul className="space-y-2">
          <li className="flex items-start gap-2">
            <RouteBadge route="PUMP_PUMPSWAP" />
            <span>
              Created via the official Pump program (Token-2022, 6 decimals) and traded on the
              pump.fun bonding curve. When the curve completes, <strong>pump.fun&apos;s own
              protocol</strong> migrates liquidity to PumpSwap — FluxPad detects and verifies the
              pool, it never performs the migration.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <RouteBadge route="LAUNCHLAB_CPMM" />
            <span>
              Created via Raydium LaunchLab and traded on its bonding curve. After the funding
              threshold is crossed, <strong>Raydium&apos;s migration wallet</strong> graduates the
              launch into a standard Raydium CPMM pool, which FluxPad then verifies on-chain.
            </span>
          </li>
        </ul>
        <p>The migration destination is fixed by the route you pick at creation — it cannot be changed afterwards.</p>
      </Section>

      <Section id="security" title="Security model">
        <ul className="list-disc space-y-1.5 pl-4">
          <li><strong>No custody.</strong> FluxPad never holds user keys or signs launches. Every transaction is approved in your wallet.</li>
          <li><strong>Vanity mints</strong> are generated in a sandboxed Web Worker and live only in the browser tab&apos;s memory — never sent to a server, never stored.</li>
          <li><strong>Upload credentials</strong> stay on the server; artwork is validated (type, size) before pinning.</li>
          <li><strong>On-chain is the source of truth.</strong> A launch shows as confirmed only when the mint exists on-chain; graduation and pool status come from protocol accounts.</li>
          <li><strong>Safe retries.</strong> A submitted signature is always resolved before any retry, so launches can never be double-sent.</li>
        </ul>
      </Section>
      <Section id="lifecycle" title="Launch lifecycle">
        <p>
          Every launch moves through the same observable stages, sourced from on-chain accounts:
        </p>
        <p>
          <code>preparing</code> → <code>confirmed</code> → <code>on curve</code> →{" "}
          <code>graduating</code> → <code>pool verified</code>. Failures are shown as{" "}
          <code>failed</code> or <code>unresolved</code> with the exact on-chain error.
        </p>
        <p>
          FluxPad displays only verifiable data. Where market metrics (price, market cap,
          volume) have no verified source, the interface shows that they are unavailable rather
          than inventing numbers.
        </p>
      </Section>

      <Section id="quickstart" title="Quick start">
        <ol className="list-decimal space-y-1.5 pl-4">
          <li>Connect a Solana wallet (Phantom or Solflare) from the top bar.</li>
          <li>
            Open <Link href="/create">Create Token</Link> and follow the five steps: details →
            route → configure → review → launch.
          </li>
          <li>
            Review the full transaction and estimated fees before signing. Test on{" "}
            <strong>devnet</strong> first; mainnet is disabled by default.
          </li>
          <li>
            Track your launch under <Link href="/dashboard">My Tokens</Link> and watch graduation
            under <Link href="/live">Live Launches</Link>.
          </li>
        </ol>
      </Section>

      <Section id="help" title="Help & FAQ">
        <p><strong>Why does my launch say “unresolved”?</strong><br />
          The transaction was submitted but its final status could not be confirmed before the
          RPC stopped responding. Check the signature on an explorer before retrying — a landed
          transaction must never be re-sent blindly.</p>
        <p><strong>Why is market cap blank?</strong><br />
          FluxPad only displays metrics it can verify from on-chain or registry data. When a
          verified market-data source is not connected, those fields stay empty by design.</p>
        <p><strong>I lost my vanity keypair.</strong><br />
          By design, vanity keys vanish when the tab closes. Generate a new one, or complete the
          launch in the same session.</p>
        <p><strong>Which networks are supported?</strong><br />
          Devnet by default. Mainnet requires explicitly switching{" "}
          <code>NEXT_PUBLIC_FLUXPAD_NETWORK</code> in the environment — and each route only works
          where its program is actually deployed.</p>
      </Section>
    </div>
  );
}
