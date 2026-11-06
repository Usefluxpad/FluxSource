/* Dev tooling: HTTP smoke check against the local dev server. */
const http = require("http");
function get(path) {
  return new Promise((res) => {
    const req = http.get({ host: "localhost", port: 3210, path, timeout: 240000 }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => res({ s: r.statusCode, b }));
    });
    req.on("error", (e) => res({ s: 0, b: String(e) }));
    req.on("timeout", () => { req.destroy(); res({ s: 0, b: "TIMEOUT" }); });
  });
}
(async () => {
  const paths = process.argv.slice(2);
  for (const p of paths) {
    const r = await get(p);
    console.log(p, "status=" + r.s, "brand=" + r.b.includes("FluxPad"), "len=" + r.b.length);
  }
  process.exit(0);
})();
