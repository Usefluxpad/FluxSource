import { z } from "zod";

/**
 * Shared token metadata validation. Runs identically on the client (form UX)
 * and on the server (upload API) so malicious or malformed payloads are
 * rejected in both places.
 */

export const TOKEN_SYMBOL_MAX = 10; // LaunchLab hard cap; Pump allows 10 too

/** X/Twitter handle or absolute URL → normalized https URL; null when invalid. */
export function normalizeTwitterInput(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const handle = v.startsWith("@") ? v.slice(1) : v;
  if (v.startsWith("@")) {
    return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? `https://x.com/${handle}` : null;
  }
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "x.com" && host !== "twitter.com") return null;
    return `https://x.com${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return null;
  }
}

/** Telegram @handle or absolute URL → normalized https URL; null when invalid. */
export function normalizeTelegramInput(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (v.startsWith("@")) {
    const handle = v.slice(1);
    return /^[A-Za-z0-9_]{3,32}$/.test(handle) ? `https://t.me/${handle}` : null;
  }
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "t.me" && host !== "telegram.me") return null;
    return `https://t.me${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return null;
  }
}

/** Absolute http(s) website URL → normalized href; null when invalid/unsafe. */
export function normalizeWebsiteInput(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const s = u.toString();
    // Collapse the root-path trailing slash ("https://a.example/" → origin)
    // so links round-trip exactly as entered; path slashes are preserved.
    return s === u.origin + "/" ? u.origin : s;
  } catch {
    return null;
  }
}

export const tokenMetadataSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(64, "Name must be 64 characters or fewer"),
  symbol: z
    .string()
    .trim()
    .min(1, "Symbol is required")
    .max(TOKEN_SYMBOL_MAX, `Symbol must be ${TOKEN_SYMBOL_MAX} characters or fewer`)
    .regex(/^[A-Za-z0-9]+$/, "Symbol must be alphanumeric"),
  description: z
    .string()
    .trim()
    .max(1000, "Description must be 1000 characters or fewer")
    .optional()
    .or(z.literal("")),
  website: z
    .string()
    .trim()
    .max(300)
    .refine((v) => !v || normalizeWebsiteInput(v) !== null, "Enter a valid website URL (https://…)")
    .optional()
    .or(z.literal("")),
  twitter: z
    .string()
    .trim()
    .max(100)
    .refine((v) => !v || normalizeTwitterInput(v) !== null, "Enter a valid X/Twitter handle or URL")
    .optional()
    .or(z.literal("")),
  telegram: z
    .string()
    .trim()
    .max(100)
    .refine((v) => !v || normalizeTelegramInput(v) !== null, "Enter a valid Telegram handle or URL")
    .optional()
    .or(z.literal("")),
});

export type TokenMetadataInput = z.infer<typeof tokenMetadataSchema>;

export interface ArtworkFileConstraints {
  maxBytes: number;
  allowedMime: string[];
}

export const ARTWORK_CONSTRAINTS: ArtworkFileConstraints = {
  maxBytes: 10 * 1024 * 1024, // 10 MB
  allowedMime: ["image/png", "image/jpeg", "image/webp", "image/gif"],
};

export function validateArtwork(
  sizeBytes: number,
  mime: string,
  constraints: ArtworkFileConstraints = ARTWORK_CONSTRAINTS,
): { ok: true } | { ok: false; reason: string } {
  if (sizeBytes <= 0) return { ok: false, reason: "Artwork file is empty" };
  if (sizeBytes > constraints.maxBytes) {
    return {
      ok: false,
      reason: `Artwork exceeds the ${(constraints.maxBytes / 1024 / 1024).toFixed(0)} MB limit`,
    };
  }
  if (!constraints.allowedMime.includes(mime)) {
    return {
      ok: false,
      reason: `Unsupported type ${mime}. Allowed: ${constraints.allowedMime.join(", ")}`,
    };
  }
  return { ok: true };
}

/**
 * Build the off-chain metadata JSON in the shape the launch protocols and CA
 * scanners actually read: `name`, `symbol`, `description`, `image` plus
 * TOP-LEVEL `website`, `twitter`, `telegram` social fields (the convention
 * used by Pump.fun, LaunchLab/LetsBonk and third-party scanners), with
 * `external_url` mirroring the website for Metaplex-standard consumers.
 *
 * Handles/URLs are normalized here (e.g. `@dotpad` → `https://x.com/dotpad`)
 * so the on-chain JSON always carries absolute, validated https links.
 * Invalid values are omitted rather than written broken.
 */
export function buildOffchainMetadata(
  input: TokenMetadataInput,
  imageUrl: string,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    name: input.name,
    symbol: input.symbol,
    image: imageUrl,
  };
  if (input.description) meta.description = input.description;
  const website = input.website ? normalizeWebsiteInput(input.website) : null;
  const twitter = input.twitter ? normalizeTwitterInput(input.twitter) : null;
  const telegram = input.telegram ? normalizeTelegramInput(input.telegram) : null;
  if (website) {
    meta.website = website;
    meta.external_url = website;
  }
  if (twitter) meta.twitter = twitter;
  if (telegram) meta.telegram = telegram;
  return meta;
}

export interface TokenSocials {
  website: string | null;
  twitter: string | null;
  telegram: string | null;
}

/**
 * Normalize social links from an arbitrary metadata JSON. Accepts the field
 * conventions seen in the wild without trusting them:
 * - top-level `website` / `twitter` / `telegram` (Pump.fun, LaunchLab, FluxPad)
 * - `x` as a Twitter alias, `external_url` as a website fallback
 * - legacy DotPad shape: a `social: { website, twitter, telegram }` object
 * - `extensions: { website, twitter, telegram }` (Metaplex convention)
 *
 * Every value must be an absolute http(s) URL — `javascript:`, `data:` and
 * relative values are dropped (never rendered, never re-published). Missing
 * or invalid links come back as `null`; this function never throws.
 */
export function parseTokenSocials(raw: unknown): TokenSocials {
  const empty: TokenSocials = { website: null, twitter: null, telegram: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const obj = raw as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };
  const socialObj = obj.social && typeof obj.social === "object" && !Array.isArray(obj.social) ? (obj.social as Record<string, unknown>) : null;
  const extObj = obj.extensions && typeof obj.extensions === "object" && !Array.isArray(obj.extensions) ? (obj.extensions as Record<string, unknown>) : null;
  const websiteRaw = pick("website", "external_url") ?? (socialObj ? String(socialObj.website ?? "") || null : null) ?? (extObj ? String(extObj.website ?? "") || null : null);
  const twitterRaw = pick("twitter", "x") ?? (socialObj ? String(socialObj.twitter ?? "") || null : null) ?? (extObj ? String(extObj.twitter ?? "") || null : null);
  const telegramRaw = pick("telegram") ?? (socialObj ? String(socialObj.telegram ?? "") || null : null) ?? (extObj ? String(extObj.telegram ?? "") || null : null);
  return {
    website: websiteRaw ? normalizeWebsiteInput(websiteRaw) : null,
    twitter: twitterRaw ? normalizeTwitterInput(twitterRaw) : null,
    telegram: telegramRaw ? normalizeTelegramInput(telegramRaw) : null,
  };
}

/**
 * Map an on-chain metadata URI to an http(s) URL a server can fetch:
 * `ipfs://<cid>` and bare CIDs resolve through the public gateway (or the
 * configured Pinata gateway), http(s) URLs pass through unchanged.
 */
export function resolveMetadataHttpUrl(uri: string, gatewayHost: string = "ipfs.io"): string | null {
  const v = uri.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  const cid = (v.startsWith("ipfs://") ? v.slice("ipfs://".length) : v).replace(/^ipfs\//, "").replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_-]{4,120}$/.test(cid)) return null; // strict: bare CID only — "javascript:" etc. never resolve
  return `https://${gatewayHost}/ipfs/${cid}`;
}

/**
 * Default on-chain metadata URI cap, enforced by the upload API and by
 * adapters that have no tighter route-specific limit. Measured anchors
 * (Solana packet limit = 1,232 bytes): LaunchLab bundled create+buy with a
 * 400-character URI serializes to 1209 bytes (23 bytes of headroom) and
 * Pump.fun create-only with a 400-character URI to 1218 bytes (14 bytes of
 * headroom), so 400 remains safe for every path except Pump.fun's bundled
 * create+buy, which has its own cap below.
 */
export const METADATA_URI_MAX = 400;

/**
 * Pump.fun's bundled create+buy transaction (legacy wire format,
 * compute-unit instruction, 26 accounts) measures 1231/1232 bytes with a
 * 70-character gateway URI — every additional URI byte overflows the packet.
 * Only the default ipfs.io gateway shape (~67 characters) fits; longer URIs
 * must use the create-only path.
 */
export const PUMP_COMBINED_URI_MAX = 70;

/** Validate a metadata URI returned by an uploader before it is used on-chain. */
export function validateMetadataUri(
  uri: string,
  maxUriLength: number = METADATA_URI_MAX,
): { ok: true } | { ok: false; reason: string } {
  if (uri.length === 0) return { ok: false, reason: "Metadata URI is empty" };
  if (uri.length > maxUriLength) {
    return {
      ok: false,
      reason: `Metadata URI is ${uri.length} chars; keep it under ${maxUriLength} so the mint transaction stays within Solana's 1,232-byte transaction size limit.`,
    };
  }
  if (!/^https?:\/\//i.test(uri) && !uri.startsWith("ipfs://") && !uri.startsWith("data:")) {
    return { ok: false, reason: "Metadata URI must be http(s), ipfs, or data URI" };
  }
  return { ok: true };
}
