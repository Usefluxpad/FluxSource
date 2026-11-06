/**
 * Public-safe error rendering for the official-token API surface.
 *
 * Public responses must never leak provider endpoints, API keys, internal
 * paths, or raw infrastructure messages. Servers keep the full detail in
 * their own logs (with URLs stripped so log aggregators do not capture
 * credentials embedded in endpoint URLs); clients receive a short, stable
 * coarse reason code.
 */

import type { OfficialTokenConfig } from "./config";

const URL_RE = /https?:\/\/[^\s"'<>]+/g;

/** Full detail for server-side logs, with endpoint URLs (and any key inside them) stripped. */
export function logSafeDetail(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(URL_RE, "[endpoint]").replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Coarse, stable reason for public API payloads. Never contains raw
 * provider text — only one of the fixed codes below.
 */
export function publicErrorReason(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/rate.?limit|429|too many|quota|throttl/.test(raw)) return "rpc_rate_limited";
  if (/timeout|timed out|aborted?|deadline/.test(raw)) return "rpc_timeout";
  if (/401|403|unauthorized|forbidden|invalid.{0,12}key|api.?key/.test(raw)) return "rpc_auth_error";
  if (/fetch|network|econn|enotfound|eai_again|socket|dns/.test(raw)) return "rpc_network_error";
  return "rpc_error";
}

/**
 * Public form of the configuration-invalid report: which role is set but
 * not a valid public key — WITHOUT the raw environment value. The raw
 * value stays available server-side in `config.invalid` for diagnostics.
 */
export function publicInvalidRoles(
  config: OfficialTokenConfig,
): { role: string }[] {
  return config.invalid.map((i) => ({ role: i.role }));
}

