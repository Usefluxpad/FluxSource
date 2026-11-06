"use client";
/**
 * FluxPad application shell: auto-collapsing desktop sidebar, mobile drawer,
 * top bar, and content area. The rail starts at 68px and expands to 240px
 * while hovered, pinned, or keyboard-focused; the content area adapts.
 */
import { useEffect, useRef, useState } from "react";
import { Sidebar, MobileDrawer } from "./sidebar";
import { Topbar } from "./topbar";

/** Small delay before collapsing so edge-crossing never flickers. */
const COLLAPSE_DELAY_MS = 150;

export function AppShell({ children }: { children: React.ReactNode }) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const collapseTimer = useRef<number | null>(null);

  const clearCollapseTimer = () => {
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
  };

  const handleHoverChange = (entering: boolean) => {
    clearCollapseTimer();
    if (entering) {
      setHovered(true);
    } else {
      collapseTimer.current = window.setTimeout(() => setHovered(false), COLLAPSE_DELAY_MS);
    }
  };

  useEffect(() => clearCollapseTimer, []);

  const expanded = pinned || hovered || focusWithin;

  return (
    <div className="min-h-screen">
      <Sidebar
        expanded={expanded}
        pinned={pinned}
        onHoverChange={handleHoverChange}
        onFocusWithinChange={setFocusWithin}
        onTogglePin={() => setPinned((p) => !p)}
      />
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <div
        className={`flex min-h-screen flex-col transition-[padding] duration-200 ease-in-out motion-reduce:transition-none ${
          expanded ? "md:pl-60" : "md:pl-[68px]"
        }`}
      >
        <Topbar onMenu={() => setDrawerOpen(true)} />
        <main className="mx-auto w-full max-w-[1560px] flex-1 px-3 py-4 sm:px-5">{children}</main>
        <footer className="mt-2 bg-gradient-to-r from-deep to-mint-500 px-4 py-5 text-center">
          <p className="font-display text-sm font-semibold text-white">
            FluxPad — Two Ways to Launch. One Place to Build.
          </p>
          <p className="mt-1 text-2xs text-white/70">
            Launches involve risk; verify every transaction before signing.
          </p>
        </footer>
      </div>
    </div>
  );
}
