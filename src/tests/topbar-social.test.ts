// @vitest-environment jsdom
/**
 * Topbar social-links regression tests (official GitHub link).
 * Wallet/connection/navigation modules are mocked at the boundary; the real
 * Topbar renders with the current social links.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(cleanup);

const walletState = vi.hoisted(() => ({
  publicKey: null as { toBase58: () => string } | null,
  wallet: null as { adapter: { name: string } } | null,
  connecting: false,
  disconnect: vi.fn(),
  select: vi.fn(),
  wallets: [] as { adapter: { name: string; url: string; icon: string }; readyState: string }[],
  connection: { getSlot: vi.fn(async () => 123) },
}));

vi.mock("@solana/wallet-adapter-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/wallet-adapter-react")>();
  return {
    ...actual,
    useWallet: () => walletState,
    useConnection: () => ({ connection: walletState.connection }),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { Topbar } from "@/components/layout/topbar";
import { WalletModalProvider } from "@/components/wallet/wallet-modal";

function renderTopbar() {
  return render(
    createElement(
      WalletModalProvider,
      null,
      createElement(Topbar, { onMenu: () => undefined }),
    ),
  );
}

describe("topbar social links (official GitHub)", () => {
  it("renders a GitHub icon link to https://github.com/Usefluxpad", () => {
    renderTopbar();
    const link = screen.getByRole("link", { name: "Official FluxPad GitHub" });
    expect(link.getAttribute("href")).toBe("https://github.com/Usefluxpad");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    const svg = link.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("fill")).toBe("currentColor");
  });

  it("does not link any legacy-brand social accounts (DotPad/RelayPad)", () => {
    renderTopbar();
    const links = Array.from(document.querySelectorAll("a[aria-label^='Official FluxPad']"));
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      const href = a.getAttribute("href") ?? "";
      expect(href).not.toContain("DotPad");
      expect(href).not.toContain("RelayPad");
      expect(href).not.toContain("dotpad");
      expect(href).not.toContain("relaypad");
    }
  });

  it("places the social link in the same top-right group as the wallet button", () => {
    renderTopbar();
    const github = screen.getByRole("link", { name: "Official FluxPad GitHub" });
    const connect = screen.getByRole("button", { name: /connect/i });
    // WalletButton wraps its own button; the shared top-right group is the
    // nearest ancestor with the ml-auto layout class.
    const group = connect.closest(".ml-auto");
    expect(group).not.toBeNull();
    expect(group?.contains(github)).toBe(true);
  });
});
