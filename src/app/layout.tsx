import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { WalletProviders } from "@/components/wallet/wallet-providers";
import { AppShell } from "@/components/layout/app-shell";
import { ThemeProvider } from "@/components/theme/theme-provider";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-display" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

/**
 * Theme bootstrap — runs before first paint (no flash of the wrong theme).
 * Reads the persisted preference (default: light) and applies the `.dark`
 * class to <html>; System follows prefers-color-scheme. Kept in sync with
 * src/components/theme/theme-provider.tsx (STORAGE_KEY + apply logic).
 */
const themeBootstrap = `(function(){try{var t=localStorage.getItem("fluxpad-theme");if(t!=="light"&&t!=="dark"&&t!=="system")t="light";var d=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var e=document.documentElement.classList;d?e.add("dark"):e.remove("dark");document.documentElement.style.colorScheme=d?"dark":"light";}catch(e){}})();`;

/**
 * metadataBase origin — resolves relative Open Graph / Twitter image URLs
 * (e.g. /flux-banner.jpg) to absolute URLs.
 *
 * - Production (Vercel builds): VERCEL_PROJECT_PRODUCTION_URL is injected by
 *   the platform and reflects the production domain (currently
 *   https://relaypad-solflow.vercel.app — verified live; note the project is
 *   behind Vercel Deployment Protection/SSO until public launch, and any
 *   custom domain added in the Vercel dashboard is picked up automatically).
 * - Local development: NEXT_PUBLIC_APP_URL from .env.local
 *   (http://localhost:3300).
 */
const metadataOrigin = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3300";

export const metadata: Metadata = {
  metadataBase: new URL(metadataOrigin),
  title: {
    default: "FluxPad — Two Ways to Launch. One Place to Build.",
    template: "%s | FluxPad",
  },
  description:
    "FluxPad brings two established Solana launch mechanisms into one seamless experience: Pump.fun bonding curve to PumpSwap, or Raydium LaunchLab bonding curve to a Raydium CPMM pool. Choose your path, configure your token, and launch directly on-chain.",
  applicationName: "FluxPad",
  openGraph: {
    title: "FluxPad — Two Ways to Launch. One Place to Build.",
    description:
      "Choose your preferred launch path — Pump.fun bonding curve to PumpSwap, or Raydium LaunchLab to a Raydium CPMM pool — and launch directly on-chain.",
    siteName: "FluxPad",
    type: "website",
    images: [{ url: "/flux-banner.jpg", width: 1200, height: 630, alt: "FluxPad — Two Ways to Launch. One Place to Build." }],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F4F7FC" },
    { media: "(prefers-color-scheme: dark)", color: "#081426" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} ${display.variable}`} suppressHydrationWarning>
      <body className="min-h-screen font-sans antialiased">
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <ThemeProvider>
          <WalletProviders>
            <AppShell>{children}</AppShell>
          </WalletProviders>
        </ThemeProvider>
      </body>
    </html>
  );
}
