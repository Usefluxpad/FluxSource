// @vitest-environment jsdom
/**
 * Official $FLUX card + homepage/treasury freshness regression tests.
 *
 * The configured contract address must reach the page from the CURRENT
 * RELAY_OFFICIAL_MINT environment configuration:
 * - the homepage and treasury routes are force-dynamic (no baked-in CA);
 * - the card revalidates against /api/relay-official/token on mount even
 *   when a server-rendered view exists.
 * Written with React.createElement (no JSX), matching the project's
 * vitest include pattern.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

afterEach(cleanup);

import { OfficialTokenCard } from "@/components/official/official-token-card";
import type { OfficialTokenView } from "@/lib/relay-official/token-display";
import { OFFICIAL_MINT_UNCONFIGURED_TEXT } from "@/lib/relay-official/token-display";
import { explorerUrl } from "@/lib/constants";

const RELAY_MINT = "Re1ayMintAddressAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const placeholderView: OfficialTokenView = {
  status: "placeholder",
  network: "mainnet-beta",
  networkLabel: "Solana Mainnet",
  displayValue: OFFICIAL_MINT_UNCONFIGURED_TEXT,
  mint: null,
  copyable: false,
  badgeLabel: "CA NOT OFFICIAL YET",
  message: "The official $FLUX token has not been announced yet.",
  explorerHref: null,
};

const configuredView: OfficialTokenView = {
  status: "configured",
  network: "mainnet-beta",
  networkLabel: "Solana Mainnet",
  displayValue: RELAY_MINT,
  mint: RELAY_MINT,
  copyable: true,
  badgeLabel: "NOT YET VERIFIED",
  message: "Valid Solana address format.",
  explorerHref: explorerUrl("mainnet-beta", "address", RELAY_MINT),
};

describe("OfficialTokenCard — placeholder vs configured", () => {
  it("renders the not-configured CA text with a disabled copy button and no explorer link", () => {
    render(createElement(OfficialTokenCard, { initialView: placeholderView }));
    expect(screen.getByText(OFFICIAL_MINT_UNCONFIGURED_TEXT)).toBeTruthy();
    // The legacy placeholder string must never appear as the contract address.
    expect(screen.queryByText("REPLACE_WITH_OFFICIAL_RELAY_MINT")).toBeNull();
    expect(screen.getByText("CA NOT OFFICIAL YET")).toBeTruthy();
    const copy = screen.getByRole("button", { name: /copying is disabled/i });
    expect((copy as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Explorer")).toBeNull();
  });

  it("renders the configured mint with an enabled copy button, a clickable CA, and the explorer token page", () => {
    render(createElement(OfficialTokenCard, { initialView: configuredView }));
    expect(screen.getByText(RELAY_MINT)).toBeTruthy();
    expect(screen.getByText("NOT YET VERIFIED")).toBeTruthy();
    const copy = screen.getByRole("button", { name: /copy official token address/i });
    expect((copy as HTMLButtonElement).disabled).toBe(false);
    const caLink = screen.getByText(RELAY_MINT).closest("a");
    expect(caLink?.getAttribute("href")).toBe(explorerUrl("mainnet-beta", "address", RELAY_MINT));
    expect(caLink?.getAttribute("target")).toBe("_blank");
    expect(screen.getByText("Explorer").closest("a")?.getAttribute("href")).toBe(
      explorerUrl("mainnet-beta", "address", RELAY_MINT),
    );
  });
});

describe("OfficialTokenCard — configuration freshness", () => {
  const fetchMock = vi.hoisted(() => ({ impl: vi.fn() }));

  beforeEach(() => {
    fetchMock.impl = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (String(url).includes("/api/relay-official/token")) {
        return {
          ok: true,
          json: async () => configuredView,
        } as unknown as Response;
      }
      throw new Error("unexpected fetch " + String(url));
    });
    // Delegating wrapper: re-assigning fetchMock.impl inside a test takes
    // effect because the global always dispatches through the current impl.
    vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock.impl(...(args as [Request])));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("revalidates on mount even when a server-rendered view exists — env changes reach the page", async () => {
    // Server rendered the placeholder (env not yet configured); the API now
    // returns the configured mint — the card must update automatically.
    render(createElement(OfficialTokenCard, { initialView: placeholderView }));
    expect(screen.getByText(OFFICIAL_MINT_UNCONFIGURED_TEXT)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(RELAY_MINT)).toBeTruthy());
    expect(fetchMock.impl).toHaveBeenCalledTimes(1);
  });

  it("keeps the server-rendered honest view when silent revalidation fails", async () => {
    fetchMock.impl = vi.fn(async () => {
      throw new Error("network down");
    });
    render(createElement(OfficialTokenCard, { initialView: placeholderView }));
    await waitFor(() => expect(fetchMock.impl).toHaveBeenCalled());
    // Still the honest not-configured view — no fabricated state, no error flash.
    expect(screen.getByText(OFFICIAL_MINT_UNCONFIGURED_TEXT)).toBeTruthy();
    expect(screen.getByText("CA NOT OFFICIAL YET")).toBeTruthy();
  });

  it("fetches with loading state when no server view is provided", async () => {
    render(createElement(OfficialTokenCard));
    await waitFor(() => expect(screen.getByText(RELAY_MINT)).toBeTruthy());
  });
});

describe("homepage + treasury freshness exports", () => {
  it("the homepage and treasury routes are force-dynamic (no baked-in CA)", async () => {
    const home = await import("@/app/page");
    const treasury = await import("@/app/treasury/page");
    expect((home as unknown as { dynamic?: string }).dynamic).toBe("force-dynamic");
    expect((treasury as unknown as { dynamic?: string }).dynamic).toBe("force-dynamic");
  });
});
