/**
 * RPC provider check — verifies the resolved server-side Solana endpoint with
 * a real `getSlot` request (mirrors src/lib/connection.ts resolveServerNetworkConfig).
 *
 * Never prints the API key or full credentialed URL — only the redacted host
 * and provider name. Exit code 0 when a valid slot is returned.
 *
 * Usage: node scripts/rpc-check.js
 */
const fs = require("fs");
const path = require("path");

function loadEnvLocal() {
  const file = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

function redact(url) {
  // Strip any /v2/<key> or key query parameter before printing.
  return url
    .replace(/(\/v2\/)[^/?#]+/i, "$1<redacted>")
    .replace(/(apikey|api_key|token)=([^&]+)/gi, "$1=<redacted>");
}

async function main() {
  loadEnvLocal();
  const cluster = process.env.NEXT_PUBLIC_FLUXPAD_NETWORK === "mainnet-beta" ? "mainnet-beta" : "devnet";
  const net = cluster === "mainnet-beta" ? "mainnet" : "devnet";

  const alchemyRpc = (process.env.ALCHEMY_SOLANA_RPC_URL || "").trim();
  const alchemyKey = (process.env.ALCHEMY_API_KEY || "").trim();
  const solRpc = (process.env.SOLANA_RPC_URL || "").trim();

  let provider, rpcUrl, wsUrl;
  if (alchemyRpc) {
    provider = "alchemy";
    rpcUrl = alchemyRpc;
    wsUrl = (process.env.ALCHEMY_SOLANA_WS_URL || "").trim() || (alchemyKey ? `wss://solana-${net}.g.alchemy.com/v2/${alchemyKey}` : null);
  } else if (alchemyKey) {
    provider = "alchemy";
    rpcUrl = `https://solana-${net}.g.alchemy.com/v2/${alchemyKey}`;
    wsUrl = (process.env.ALCHEMY_SOLANA_WS_URL || "").trim() || `wss://solana-${net}.g.alchemy.com/v2/${alchemyKey}`;
  } else if (solRpc) {
    provider = "custom";
    rpcUrl = solRpc;
    wsUrl = null;
  } else {
    provider = "public";
    rpcUrl = cluster === "mainnet-beta" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
    wsUrl = null;
  }

  console.log(`cluster:            ${cluster}`);
  console.log(`provider:           ${provider}`);
  console.log(`rpc endpoint:       ${redact(rpcUrl)}`);
  console.log(`ws endpoint:        ${wsUrl ? redact(wsUrl) : "(not configured — no subscriptions in use today)"}`);

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [{ commitment: "confirmed" }] }),
      signal: controller.signal,
    });
    const body = await res.json();
    const slot = body && body.result;
    const elapsed = Date.now() - started;
    if (typeof slot === "number" && Number.isInteger(slot) && slot > 0) {
      console.log(`getSlot:            OK (http ${res.status}) in ${elapsed}ms`);
      console.log(`slot:               ${slot}`);
      console.log(`validity:           valid (positive integer slot)`);
      process.exit(0);
    }
    console.error(`getSlot:            FAILED (http ${res.status})`);
    console.error(`response:           ${JSON.stringify(body.error ?? body).slice(0, 300)}`);
    process.exit(1);
  } catch (err) {
    console.error(`getSlot:            FAILED (${err.name}: ${err.message})`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
}

main();