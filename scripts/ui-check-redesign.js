/**
 * Post-redesign live verification: HTTP status + content probes for every
 * page and the new/updated API endpoints. Writes PASS/FAIL lines to stdout.
 * Usage: node scripts/ui-check-redesign.js [baseUrl]
 */
const BASE = process.argv[2] || "http://localhost:3210";

async function get(path, accept = "text/html") {
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { accept } });
    const text = await res.text();
    return { status: res.status, text };
  } catch (e) {
    return { status: 0, text: String(e) };
  }
}

const results = [];
function check(name, ok, detail) {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const PAGES = [
  ["/", "Launch Dashboard"],
  ["/tokens", "Explore"],
  // /create renders the disconnected "Create token" prompt server-side; the
  // "Launch a token" heading appears only after a wallet connects. The
  // Stepper's first step label renders in both states.
  ["/create", "Token Details"],
  ["/dashboard", "My Tokens"],
  ["/trending", "Trending"],
  ["/live", "Live Launches"],
  ["/leaderboard", "Creator Leaderboard"],
  ["/watchlist", "Watchlist"],
  ["/vanity", "Vanity Mint Generator"],
  ["/status", "Network Status"],
  ["/docs", "Documentation"],
  ["/settings", "Settings"],
];

for (const [path, marker] of PAGES) {
  const { status, text } = await get(path);
  const branded = text.includes("FluxPad");
  check(`page ${path}`, status === 200 && branded, `status=${status}, branding=${branded}, marker="${marker}" found=${text.includes(marker)}`);
}

// Sidebar navigation present on a page
{
  const { text } = await get("/");
  const navOk =
    text.includes("Trending") &&
    text.includes("Leaderboard") &&
    text.includes("Watchlist") &&
    text.includes("Vanity Mint Generator") &&
    text.includes("Network Status") &&
    text.includes("Documentation");
  check("sidebar nav items", navOk);
  const shellOk = text.includes("Search tokens") && text.includes("Create");
  check("topbar search + create", shellOk);
}

// API checks
{
  const { status, text } = await get("/api/launches?limit=3", "application/json");
  let ok = status === 200;
  let count = -1;
  try {
    const data = JSON.parse(text);
    count = data.launches?.length ?? -1;
    ok = ok && Array.isArray(data.launches);
  } catch {
    ok = false;
  }
  check("api /api/launches", ok, `status=${status}, launches=${count}`);
}
{
  const { status, text } = await get("/api/activity?limit=5", "application/json");
  let ok = status === 200;
  try {
    const data = JSON.parse(text);
    ok = ok && Array.isArray(data.events);
  } catch {
    ok = false;
  }
  check("api /api/activity", ok, `status=${status}`);
}
{
  const { status, text } = await get("/api/leaderboard?metric=launches&limit=5", "application/json");
  let ok = status === 200;
  try {
    const data = JSON.parse(text);
    ok = ok && Array.isArray(data.leaderboard);
  } catch {
    ok = false;
  }
  check("api /api/leaderboard", ok, `status=${status}`);
}
{
  const { status, text } = await get("/api/launches?q=zzznomatch&limit=5", "application/json");
  let ok = status === 200;
  try {
    const data = JSON.parse(text);
    ok = ok && data.launches.length === 0;
  } catch {
    ok = false;
  }
  check("api search empty state", ok, `status=${status}`);
}
{
  const { status } = await get("/api/launches/definitely-not-a-real-id", "application/json");
  check("api missing launch -> 404", status === 404, `status=${status}`);
}

console.log(results.join("\n"));
console.log(`SUMMARY: ${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`);
