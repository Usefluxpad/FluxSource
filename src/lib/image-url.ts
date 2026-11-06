/**
 * Token image URL normalization.
 *
 * Dashboard records store image URLs in different shapes depending on where
 * they were created:
 * - `https://ipfs.io/ipfs/<cid>/<path>` — baked in at upload time with the
 *   then-configured gateway (PINATA_GATEWAY defaults to `ipfs.io`).
 * - `ipfs://<cid>/<path>` — raw IPFS URIs (e.g. from on-chain metadata).
 * - plain `https://…` / `data:` URIs.
 *
 * Two verified problems make raw rendering break:
 * 1. The public `ipfs.io` gateway now answers browser requests with
 *    HTTP 429 ("switching to a service worker gateway only"), so even valid
 *    `ipfs.io` URLs fail. Rewriting the host to Pinata's public gateway
 *    (`gateway.pinata.cloud` — the same provider FluxPad already uses for
 *    uploads, verified serving our CIDs) keeps existing records renderable.
 * 2. `ipfs://…` is not browser-fetchable at all and must be converted.
 *
 * Invalid or missing values return `null` so callers can render their
 * fallback avatar instead of a broken-image icon.
 */

/**
 * Gateway used for `ipfs://` conversion and for rewriting `ipfs.io` URLs.
 * `gateway.pinata.cloud` is Pinata's public gateway — the same provider the
 * upload pipeline already uses — and was verified serving FluxPad's CIDs
 * while `ipfs.io` returned HTTP 429.
 */
export const DEFAULT_IPFS_GATEWAY = "gateway.pinata.cloud";

function stripIpfsPrefix(value: string): string {
  return value.replace(/^ipfs:\/\//, "").replace(/^ipfs\//, "");
}

/** Normalize any stored image reference into a browser-fetchable URL or null. */
export function toBrowserImageUrl(
  uri: string | null | undefined,
  gateway: string = DEFAULT_IPFS_GATEWAY,
): string | null {
  if (typeof uri !== "string") return null;
  const raw = uri.trim();
  if (!raw) return null;
  if (/^data:image\//i.test(raw)) return raw;
  if (/^ipfs:\/\//i.test(raw)) {
    return `https://${gateway}/ipfs/${stripIpfsPrefix(raw)}`;
  }
  if (/^https?:\/\//i.test(raw)) {
    // Rewrite the deprecated/rate-limited ipfs.io gateway host to the
    // configured one; leave every other host untouched.
    if (/^https?:\/\/ipfs\.io\//i.test(raw)) {
      return raw.replace(/^https?:\/\/ipfs\.io\//i, `https://${gateway}/`);
    }
    return raw;
  }
  // Relative or protocol-less values (e.g. bare CIDs) are not renderable.
  return null;
}
