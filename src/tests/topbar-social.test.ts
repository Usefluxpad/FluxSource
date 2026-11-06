// @vitest-environment jsdom
/**
 * Topbar social-links regression tests (official X + GitHub).
 * Wallet/connection/navigation modules are mocked at the boundary; the real
 * Topbar renders with the new social links.
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

describe("topbar social links (official X + GitHub)", () => {
  it("renders an X icon link to https://x.com/DotPadHQ", () => {
    renderTopbar();
    const link = screen.getByRole("link", { name: "Official FluxPad on X" });
    expect(link.getAttribute("href")).toBe("https://x.com/DotPadHQ");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    // Official solid-fill brand glyph, not the generic line "close" icon.
    const svg = link.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("fill")).toBe("currentColor");
  });

  it("renders a GitHub icon link to https://github.com/DotPadTrade", () => {
    renderTopbar();
    const link = screen.getByRole("link", { name: "Official FluxPad GitHub" });
    expect(link.getAttribute("href")).toBe("https://github.com/DotPadTrade");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    const svg = link.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("fill")).toBe("currentColor");
  });

  it("places both social links in the same top-right group as the wallet button", () => {
    renderTopbar();
    const x = screen.getByRole("link", { name: "Official FluxPad on X" });
    const github = screen.getByRole("link", { name: "Official FluxPad GitHub" });
    const connect = screen.getByRole("button", { name: /connect/i });
    // WalletButton wraps its own button; the shared top-right group is the
    // nearest ancestor with the ml-auto layout class.
    const group = connect.closest(".ml-auto");
    expect(group).not.toBeNull();
    expect(group?.contains(x)).toBe(true);
    expect(group?.contains(github)).toBe(true);
    // Precede the wallet button (top-right, next to it).
    const children = Array.from(group!.children);
    expect(children.indexOf(x.closest("div") ?? x)).toBeLessThan(children.length - 1);
    expect(children.indexOf(x.closest("div") ?? x)).toBeLessThan(
      children.indexOf(connect.closest("div") ?? connect),
    );
  });
});
