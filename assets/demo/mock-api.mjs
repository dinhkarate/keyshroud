// The "Acme API" of the Claude demos (agent-shell.sh): a local mock that
// accepts only the demo's fake key. It logs every request as
// "<status> <Authorization header>", so the recording can show what the API
// received. Usage: node mock-api.mjs LOG_FILE PORT_FILE [PARENT_PID]
// It listens on a free port of 127.0.0.1, writes that port to PORT_FILE, and
// stops when PARENT_PID (the demo shell) exits.
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const KEY = "acme_DEMO_not_a_real_key_4f9c2e7a1b";
const [log, portFile, parent] = process.argv.slice(2);

const server = createServer((req, res) => {
  const auth = req.headers.authorization ?? "-";
  const ok = req.method === "GET" && req.url === "/v1/ping" && auth === `Bearer ${KEY}`;
  appendFileSync(log, `${ok ? 200 : 401} ${auth}\n`);
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
  res.end(ok ? '{"ok":true,"account":"acme-demo"}\n' : '{"ok":false,"error":"invalid API key"}\n');
});
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));

if (parent) {
  setInterval(() => {
    try { process.kill(Number(parent), 0); } catch { process.exit(0); }
  }, 2000);
}
