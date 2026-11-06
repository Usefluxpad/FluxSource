/**
 * FluxPad brand marks — the official supplied Flux assets, preserved untouched
 * in FLUX/Logo and served as optimized web copies:
 *   - public/flux-symbol.jpg   standalone Flux symbol (square, 512×512)
 *   - public/flux-wordmark.jpg horizontal FLUX wordmark (1200×403)
 *
 * The marks are server-safe <img> elements: they render identically everywhere
 * (topbar, sidebar, drawer) without client-side image optimization. Rendered
 * dimensions are derived from each asset's true aspect ratio so the artwork is
 * never stretched or cropped.
 */
const FLUX_WORDMARK_ASPECT = 1200 / 403;

export function FluxSymbol({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/flux-symbol.jpg"
      alt="FluxPad logo"
      width={size}
      height={size}
      className={`shrink-0 rounded-md ${className}`}
      draggable={false}
    />
  );
}

/** The supplied horizontal FLUX wordmark — desktop navigation and brand sections. */
export function FluxWordmark({ height = 30, className = "" }: { height?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/flux-wordmark.jpg"
      alt="FluxPad"
      width={Math.max(1, Math.round(height * FLUX_WORDMARK_ASPECT))}
      height={height}
      className={`shrink-0 rounded-md ${className}`}
      draggable={false}
    />
  );
}

/** Compact lockup: standalone symbol + FluxPad wordmark text (small UI). */
export function FluxPadLockup({ size = 26 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <FluxSymbol size={size} />
      <span className="text-[15px] font-semibold tracking-tight text-ink">
        Flux<span className="text-mint-400">Pad</span>
      </span>
    </span>
  );
}
