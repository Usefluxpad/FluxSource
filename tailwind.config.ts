import type { Config } from "tailwindcss";

/**
 * Theme tokens are CSS variables (RGB channel triplets) so the entire palette
 * can switch between Light and Dark by toggling a `.dark` class on <html>.
 * `rgb(var(--fp-*) / <alpha-value>)` keeps Tailwind opacity modifiers working.
 * Variable values live in src/app/globals.css (:root = light, .dark = dark).
 */
const v = (name: string) => `rgb(var(--fp-${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // FluxPad "Electric Blue Launch Studio" — theme-aware tokens.
        // Legacy scale names (night/mint/ice) are preserved deliberately so the
        // existing call sites keep compiling. night-* = surfaces/neutrals,
        // mint-* = cobalt accents, ice-* = highlight blues.
        night: {
          950: v("n950"), // page background
          900: v("n900"), // topbar / sidebar / modals
          850: v("n850"), // cards
          800: v("n800"), // recessed tint / hover fills
          700: v("n700"), // resting borders
          600: v("n600"), // hover borders
          500: v("n500"), // faint text / strong hover borders
          400: v("n400"), // secondary text
        },
        mint: {
          300: v("m300"), // accent text
          400: v("m400"), // secondary accent
          500: v("m500"), // primary cobalt
          600: v("m600"), // pressed / darker accent
          700: v("m700"), // accent text on tinted chips
        },
        ice: {
          300: v("i300"),
          400: v("i400"),
          500: v("i500"), // highlight
          600: v("i600"),
        },
        ink: v("ink"), // main typography
        paper: v("paper"), // card/chrome surface
        pale: v("pale"), // page background
        sky: {
          50: v("s50"), // faintest cobalt tint
          100: v("s100"), // light blue chip fill
          200: v("s200"),
        },
        deep: v("deep"), // deep-blue sections (hero/footer overlays)
        // Static brand constants — identical in both themes.
        snow: "#FFFFFF", // text on cobalt/deep fills
        frost: "#DCEAFF", // light-blue accent text on cobalt/deep fills
        // Status colors (theme-aware for contrast)
        danger: v("danger"),
        warn: v("warn"),
        // Performance colors (verified positive/negative only — data, not brand)
        up: v("up"),
        down: v("down"),
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", "1rem"],
      },
      boxShadow: {
        // Theme-aware elevation (values in globals.css).
        panel: "var(--fp-shadow-panel)",
        "glow-mint": "var(--fp-shadow-glow)",
        "glow-emerald": "var(--fp-shadow-glow-strong)",
      },
      keyframes: {
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "pulse-soft": "pulse-soft 2s ease-in-out infinite",
        "fade-up": "fade-up 0.25s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;

