// Read-only sources: HashiCorp Vault / OpenBao and Infisical over HTTP (servers faked here; the
// real ones are in live.test.ts), and the ones read through a vendor's CLI (faked on PATH).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { runCli, sandbox, writeAuth, type Sandbox } from "./helpers.ts";

const blank = () => sandbox([], { blank: true });
const CORE = JSON.stringify(new URL("../src/core.ts", import.meta.url).href);
const ROOT = "hvs.made-up-root-token-0000";

interface Hit { method: string; path: string; headers: IncomingHttpHeaders; body: string }
interface Reply { status?: number; json?: unknown; headers?: Record<string, string> }
interface Fake { addr: string; hits: Hit[]; paths(): string[]; close(): void }

async function serve(answer: (hit: Hit) => Reply | Promise<Reply>, tls?: { key: string; cert: string }): Promise<Fake> {
  const hits: Hit[] = [];
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      const hit = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body };
      hits.push(hit);
      const reply = await answer(hit);
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json", ...reply.headers });
      res.end(JSON.stringify(reply.json ?? {}));
    });
  };
  const server: Server = tls ? createTlsServer(tls, listener) : createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { addr: `${tls ? "https" : "http"}://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, paths: () => hits.map((hit) => `${hit.method} ${hit.path}`), close: () => { server.close(); server.closeAllConnections(); } };
}

// A Vault (or OpenBao) with KV mounts: `secret/` (v2), `kv1/` (v1), `team/kv/` (v2, two segments)
// and `transit/` (not KV). `tokens` are the ones it takes.
const MOUNTS: Record<string, { version?: string; type: string; secrets: Record<string, Record<string, unknown>> }> = {
  "secret/": { version: "2", type: "kv", secrets: { "app/db": { username: "svc", password: "kv2-made-up-password-0001", port: 5432, tls: { verify: true } }, single: { value: "kv2-made-up-single-0002" } } },
  "kv1/": { version: "1", type: "kv", secrets: { legacy: { token: "kv1-made-up-token-0003" } } },
  "team/kv/": { version: "2", type: "kv", secrets: { "with space/it": { k: "kv2-made-up-deep-0004" } } },
  "transit/": { type: "transit", secrets: {} },
};
function vault(tokens: string[] = [ROOT], logins: Record<string, string> = {}) {
  return (hit: Hit): Reply => {
    const path = decodeURIComponent(hit.path.replace(/^\/v1\//, ""));
    if (path === "auth/approle/login") {
      const body = JSON.parse(hit.body) as { role_id: string; secret_id: string };
      return logins[body.role_id] === body.secret_id ? { json: { auth: { client_token: tokens[0], lease_duration: 1200 } } } : { status: 400, json: { errors: ["invalid role or secret ID"] } };
    }
    if (!tokens.includes(String(hit.headers["x-vault-token"]))) return { status: 403, json: { errors: ["2 errors occurred:\n\t* permission denied\n\t* invalid token\n\n"] } };
    if (path === "auth/token/lookup-self") return { json: { data: { id: hit.headers["x-vault-token"], policies: ["default"] } } };
    if (path.startsWith("sys/internal/ui/mounts/")) {
      const wanted = `${path.slice("sys/internal/ui/mounts/".length)}/`;
      const mount = Object.keys(MOUNTS).find((name) => wanted.startsWith(name));
      return mount ? { json: { data: { path: mount, type: MOUNTS[mount].type, options: MOUNTS[mount].version ? { version: MOUNTS[mount].version } : null } } } : { status: 403, json: { errors: [`preflight capability check returned 403, please ensure client's policies grant access to path "${wanted}"`] } };
    }
    const mount = Object.keys(MOUNTS).find((name) => path.startsWith(name))!;
    const v2 = MOUNTS[mount]?.version === "2";
    const fields = MOUNTS[mount]?.secrets[path.slice(mount.length).replace(v2 ? /^data\// : /^/, "")];
    if (!fields || (v2 && !path.slice(mount.length).startsWith("data/"))) return { status: 404, json: { errors: [] } };
    return { json: v2 ? { data: { data: fields, metadata: { version: 1 } } } : { data: fields } };
  };
}

async function vaultBox(fake: Fake, extra: string[] = []): Promise<Sandbox> {
  const box = await blank();
  await writeFile(join(box.env.HOME, ".vault-token"), `${ROOT}\n`, { mode: 0o600 });
  const added = await runCli(box, ["source", "add", "vault", "--addr", fake.addr, ...extra]);
  assert.match(added.stdout, new RegExp(`^source=vault addr=${fake.addr} (namespace=\\S+ )?verified=yes$`, "m"), added.stderr);
  return box;
}

async function envFile(box: Sandbox, lines: string[]): Promise<string> {
  const file = join(box.dir, ".env.refs");
  await writeFile(file, lines.join("\n"));
  return file;
}

// Masked output of a command that prints the named variables.
async function printed(box: Sandbox, file: string, names: string[], env: Record<string, string> = {}): Promise<string> {
  const run = await runCli(box, ["run", "--no-auth", "--env-file", file, "--", "sh", "-c", names.map((name) => `echo "${name}=$${name}"`).join("; ")], undefined, env);
  return run.stdout + run.stderr;
}

test("vault://: KV v2 and v1 by mount/path, a field by #key or the only one, with the token `vault login` left", async () => {
  const fake = await serve(vault());
  try {
    const box = await vaultBox(fake, ["--namespace", "team-a"]);
    assert.deepEqual(fake.paths(), ["GET /v1/auth/token/lookup-self"]);
    assert.equal(fake.hits[0].headers["x-vault-token"], ROOT);
    assert.equal(fake.hits[0].headers["x-vault-namespace"], "team-a");
    assert.equal(fake.hits[0].headers["x-vault-request"], "true");
    assert.match((await runCli(box, ["source"])).stdout, new RegExp(`^vault addr=${fake.addr} namespace=team-a auth=token of \`vault login\` \\(~/.vault-token\\)$`, "m"));

    fake.hits.length = 0;
    const file = await envFile(box, [
      "DB_USER=vault://secret/app/db#username", "DB_PASSWORD=vault://secret/app/db#password", "DB_PORT=vault://secret/app/db#/port", "DB_TLS=vault://secret/app/db#tls",
      "ONLY=vault://secret/single", "LEGACY=vault://kv1/legacy#token", "DEEP=vault://team/kv/with space/it#k", "ENCODED=vault://team/kv/with%20space/it#k", "LOG_LEVEL=debug",
    ]);
    const out = await printed(box, file, ["DB_USER", "DB_PASSWORD", "DB_PORT", "DB_TLS", "ONLY", "LEGACY", "DEEP", "ENCODED", "LOG_LEVEL"]);
    for (const name of ["DB_PASSWORD", "ONLY", "LEGACY"]) assert.ok(out.includes(`${name}=<redacted:${name}>`), out);
    // One value under two names is masked under the first.
    assert.ok(out.includes("DEEP=<redacted:DEEP>") && out.includes("ENCODED=<redacted:DEEP>"), out);
    // A number and an object come as their text; values too short to mask are passed as they are.
    assert.ok(out.includes("DB_USER=svc") && out.includes("DB_PORT=5432") && out.includes("DB_TLS=<redacted:DB_TLS>") && out.includes("LOG_LEVEL=debug"), out);
    assert.ok(!out.includes("made-up"), out);
    // The mount is asked, then the secret: once for each path, however many names read it.
    const reads = fake.paths().filter((path) => !path.includes("/sys/"));
    assert.deepEqual(reads.sort(), ["GET /v1/kv1/legacy", "GET /v1/secret/data/app/db", "GET /v1/secret/data/single", "GET /v1/team/kv/data/with%20space/it"]);
    assert.ok(fake.hits.every((hit) => hit.headers["x-vault-token"] === ROOT && hit.headers["x-vault-namespace"] === "team-a"));

    assert.equal((await runCli(box, ["get", "vault://secret/app/db#password"])).stdout, "kv2-made-up-password-0001");
    const several = await runCli(box, ["get", "vault://secret/app/db"]);
    assert.equal(several.code, 4);
    assert.match(several.stderr, /vault:\/\/secret\/app\/db holds 4 fields \(username, password, port, tls\): name one as vault:\/\/secret\/app\/db#field/);
    const noField = await runCli(box, ["get", "vault://secret/app/db#nope"]);
    assert.match(noField.stderr, /has no field nope/);

    // The token is masked wherever a command prints it, in the run and by the Claude Code hook.
    const leak = await runCli(box, ["run", "--no-auth", "--env-file", file, "--", "cat", join(box.env.HOME, ".vault-token")]);
    assert.equal(leak.stdout.trim(), "<redacted:VAULT_SOURCE_TOKEN>");
    const post = await runCli(box, ["hook", "claude", "post-tool-use"], JSON.stringify({ tool_response: { stdout: `${ROOT} kv1-made-up-token-0003` } }));
    assert.equal(JSON.parse(post.stdout).hookSpecificOutput.updatedToolOutput.stdout, "<redacted:VAULT_SOURCE_TOKEN> <redacted:LEGACY>");
  } finally { fake.close(); }
});

test("vault://: an AppRole's secret id is kept in the vault, one login serves every reference, and neither it nor the token shows", async () => {
  const fake = await serve(vault(["hvs.made-up-approle-token-0005"], { "role-1": "made-up-secret-id-0006" }));
  try {
    const box = await blank();
    const added = await runCli(box, ["source", "add", "vault", "--addr", fake.addr, "--role-id", "role-1", "--stdin"], "made-up-secret-id-0006\n");
    assert.equal(added.stdout.trim(), `source=vault addr=${fake.addr} verified=yes`, added.stderr);
    assert.deepEqual(JSON.parse(fake.hits[0].body), { role_id: "role-1", secret_id: "made-up-secret-id-0006" });
    const sources = await readFile(join(box.configDir, "sources.json"), "utf8");
    assert.deepEqual(JSON.parse(sources), { vault: { addr: fake.addr, roleId: "role-1", secretId: "keyshroud://Source vault secret id" } });
    assert.match((await runCli(box, ["list"])).stdout, /^keyshroud:\/\/Source vault secret id {2}wired=none$/m);

    fake.hits.length = 0;
    const file = await envFile(box, ["DB_PASSWORD=vault://secret/app/db#password", "ONLY=vault://secret/single", "LEGACY=vault://kv1/legacy#token"]);
    const run = await runCli(box, ["run", "--no-auth", "--env-file", file, "--", "sh", "-c", "echo $DB_PASSWORD $ONLY; echo hvs.made-up-approle-token-0005 made-up-secret-id-0006"]);
    assert.equal(run.stdout, "<redacted:DB_PASSWORD> <redacted:ONLY>\n<redacted:VAULT_SOURCE_TOKEN> <redacted:Source vault secret id>\n");
    assert.equal(fake.paths().filter((path) => path === "POST /v1/auth/approle/login").length, 1);
    assert.ok(fake.hits.filter((hit) => hit.method === "GET").every((hit) => hit.headers["x-vault-token"] === "hvs.made-up-approle-token-0005"));

    // A second `source add` replaces the secret id; a wrong one is said, without it.
    const wrong = await runCli(box, ["source", "add", "vault", "--addr", fake.addr, "--role-id", "role-1", "--stdin"], "made-up-wrong-id-0007");
    assert.equal(wrong.code, 3);
    assert.equal(wrong.stdout.trim(), `source=vault addr=${fake.addr} verified=no (AppRole login: HTTP 400 (refused))`);
    assert.ok(!(wrong.stdout + wrong.stderr).includes("made-up-wrong-id-0007"));
    assert.equal((await runCli(box, ["get", "keyshroud://Source vault secret id"])).stdout, "made-up-wrong-id-0007");
    assert.equal((await runCli(box, ["source", "add", "vault", "--addr", fake.addr, "--role-id", "role-1", "--token"])).code, 2);

    const removed = await runCli(box, ["source", "rm", "vault"]);
    assert.match(removed.stdout, /^removed source=vault/);
    const after = await runCli(box, ["get", "vault://secret/single"]);
    assert.equal(after.code, 4);
    assert.match(after.stderr, /no vault source is set up: keyshroud source add vault/);
  } finally { fake.close(); }
});

test("vault://: a token goes only to the address `source add` was given, and a failure says why without a value", async () => {
  const other = await serve(() => ({ json: { data: { data: { password: "from-the-other-server" } } } }));
  // `echo`: an error that repeats the token it was sent. `leak`: one that repeats another secret.
  // `odd`: an answer that was taken, with a message in it.
  const fake = await serve((hit) => hit.path.includes("moved") ? { status: 307, headers: { Location: `${other.addr}${hit.path}` } }
    : hit.path.includes("echo") ? { status: 500, json: { errors: [`bad token ${hit.headers["x-vault-token"]}`] } }
    : hit.path.includes("leak") ? { status: 500, json: { errors: ["cannot decode kv2-made-up-single-0002"], message: "kv2-made-up-single-0002" } }
    : hit.path.includes("odd") ? { json: { message: "kv2-made-up-odd-0014" } } : vault()(hit));
  try {
    const box = await vaultBox(fake);
    fake.hits.length = 0;
    const cases: Array<[string, RegExp]> = [
      ["vault://secret/moved/x#password", /answered with a redirect \(HTTP 307\), which is not followed/],
      ["vault://secret/nope#x", /vault:\/\/secret\/nope: no such secret/],
      ["vault://nowhere/x#y", /vault:\/\/nowhere\/x: HTTP 403 \(not allowed\)/],
      ["vault://transit/keys/k#x", /transit\/ is not a KV mount/],
      ["vault://secret#x", /names the mount secret\/, not a secret in it/],
      ["vault://secret/../sys/seal-status#x", /is not <mount>\/<path>/],
      ["vault://secret/app/db?address=https://vault.example.net#password", /takes no \?parameters/],
    ];
    for (const [ref, reason] of cases) {
      const got = await runCli(box, ["get", ref]);
      assert.equal(got.code, 4, ref);
      assert.equal(got.stdout, "");
      assert.match(got.stderr, reason, ref);
    }
    assert.equal(other.hits.length, 0);
    assert.ok(!fake.paths().some((path) => path.includes("sys/seal-status") || path.includes("example.net")));

    // Nothing the server says is passed on, whatever it repeats: the status, in keyshroud's words.
    const echoed = await runCli(box, ["get", "vault://secret/echo/x#y"]);
    assert.equal(echoed.stderr.trim(), "Secret unresolved: vault://secret/echo/x#y (vault://secret/echo/x: HTTP 500 (the server failed))");
    const leaky = await runCli(box, ["run", "--no-auth", "--env-file", await envFile(box, ["ONLY=vault://secret/single", "BAD=vault://secret/leak/x#y"]), "--", "true"]);
    assert.equal(leaky.stderr.trim(), "keyshroud: unresolved (names only): BAD (vault://secret/leak/x: HTTP 500 (the server failed))");
    const template = join(box.dir, "config.tpl");
    await writeFile(template, "a={{ vault://secret/single }}\nb={{ vault://secret/leak/x#y }}\n");
    const injected = await runCli(box, ["inject", "-i", template, "-o", join(box.dir, "config")]);
    assert.equal(injected.code, 4);
    assert.equal(injected.stderr.trim(), "Secret reference unresolved: vault://secret/leak/x#y (vault://secret/leak/x: HTTP 500 (the server failed))");
    const odd = await runCli(box, ["get", "vault://secret/odd/x#y"]);
    assert.match(odd.stderr, /vault:\/\/secret\/odd\/x: HTTP 200\)/);
    assert.ok(!odd.stderr.includes("made-up"), odd.stderr);

    // A token the server does not take; a server that is away.
    await writeFile(join(box.env.HOME, ".vault-token"), "hvs.made-up-stale-token-0008");
    const stale = await runCli(box, ["get", "vault://secret/single"]);
    assert.match(stale.stderr, /vault:\/\/secret\/single: HTTP 403 \(not allowed\)/);
    assert.ok(!stale.stderr.includes("hvs.made-up-stale-token-0008"));
    await writeFile(join(box.env.HOME, ".vault-token"), "");
    assert.match((await runCli(box, ["get", "vault://secret/single"])).stderr, /no token in .*\.vault-token: run `vault login`/);
    fake.close();
    await writeFile(join(box.env.HOME, ".vault-token"), ROOT);
    assert.match((await runCli(box, ["get", "vault://secret/single"])).stderr, /127\.0\.0\.1:\d+: ECONNREFUSED/);

    // Only https, or http on this machine; a plain URL.
    for (const addr of ["http://vault.example.net:8200", "https://user:pw@vault.example.net", "https://vault.example.net/?x=1", "vault.example.net", "ftp://127.0.0.1"]) {
      const refused = await runCli(box, ["source", "add", "vault", "--addr", addr]);
      assert.equal(refused.code, 2, addr);
    }
    assert.equal((await runCli(box, ["source", "add", "vault"])).code, 2);
    assert.equal(JSON.parse(await readFile(join(box.configDir, "sources.json"), "utf8")).vault.addr, fake.addr);
    // An address written into the settings by hand is held to the same rule: nothing is sent.
    await writeFile(join(box.configDir, "sources.json"), JSON.stringify({ vault: { addr: "http://vault.example.net:8200" } }));
    assert.match((await runCli(box, ["get", "vault://secret/single"])).stderr, /A source's address must be https:\/\//);
  } finally { fake.close(); other.close(); }
});

test("vault://: a server with a private CA is trusted through --ca-file only", async (t) => {
  const dir = (await blank()).dir;
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
  try { await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"]); }
  catch { t.skip("no openssl that can make a certificate here"); return; }
  const fake = await serve(vault(), { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") });
  try {
    const box = await blank();
    await writeFile(join(box.env.HOME, ".vault-token"), ROOT);
    const untrusted = await runCli(box, ["source", "add", "vault", "--addr", fake.addr]);
    assert.equal(untrusted.code, 3);
    assert.match(untrusted.stdout, /verified=no \(127\.0\.0\.1:\d+: (DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\)/);
    // Node's switch for turning the check off does not reach a source.
    const forced = await runCli(box, ["source", "add", "vault", "--addr", fake.addr], undefined, { NODE_TLS_REJECT_UNAUTHORIZED: "0" });
    assert.match(forced.stdout, /verified=no \(127\.0\.0\.1:\d+: [A-Z_]*(SELF_SIGNED|UNABLE_TO_VERIFY)/);
    assert.equal(fake.hits.length, 0);
    assert.equal((await runCli(box, ["source", "add", "vault", "--addr", fake.addr, "--ca-file", key])).code, 2);
    // Without the flags, what the vault command goes by.
    const trusted = await runCli(box, ["source", "add", "vault"], undefined, { VAULT_ADDR: fake.addr, VAULT_CACERT: cert, VAULT_NAMESPACE: "team-b" });
    assert.equal(trusted.stdout.trim(), `source=vault addr=${fake.addr} namespace=team-b ca=${cert} verified=yes`, trusted.stderr);
    assert.equal(fake.hits[0].headers["x-vault-namespace"], "team-b");
    assert.equal((await runCli(box, ["get", "vault://secret/single"])).stdout, "kv2-made-up-single-0002");
  } finally { fake.close(); }
});

test("infisical://: a machine identity's client secret is kept in the vault; a secret is read by project, environment and folder", async () => {
  const TOKEN = "made-up-infisical-access-token-0009";
  const secrets: Record<string, string> = { "proj-1 dev / DB_PASSWORD": "inf-made-up-password-0010", "proj-1 dev /backend/api API_KEY": "inf-made-up-apikey-0011" };
  const fake = await serve((hit) => {
    if (hit.path === "/api/v1/auth/universal-auth/login") {
      const body = JSON.parse(hit.body) as { clientId: string; clientSecret: string };
      return body.clientId === "client-1" && body.clientSecret === "made-up-client-secret-0012" ? { json: { accessToken: TOKEN, expiresIn: 7200, tokenType: "Bearer" } } : { status: 401, json: { statusCode: 401, message: "Invalid credentials", error: "UnauthorizedError" } };
    }
    if (hit.headers.authorization !== `Bearer ${TOKEN}`) return { status: 403, json: { message: "The provided access token is malformed." } };
    const url = new URL(hit.path, "http://x");
    const value = secrets[`${url.searchParams.get("projectId")} ${url.searchParams.get("environment")} ${url.searchParams.get("secretPath")} ${decodeURIComponent(url.pathname.replace("/api/v4/secrets/", ""))}`];
    return value ? { json: { secret: { secretKey: "x", secretValue: value } } } : { status: 404, json: { statusCode: 404, message: "Secret with name 'NOPE' not found", error: "NotFound" } };
  });
  try {
    const box = await blank();
    assert.equal((await runCli(box, ["source", "add", "infisical", "--addr", fake.addr])).code, 2);
    const added = await runCli(box, ["source", "add", "infisical", "--addr", fake.addr, "--client-id", "client-1", "--stdin"], "made-up-client-secret-0012");
    assert.equal(added.stdout.trim(), `source=infisical addr=${fake.addr} verified=yes`, added.stderr);
    assert.match((await runCli(box, ["source"])).stdout, new RegExp(`^infisical addr=${fake.addr} auth=universal client-id=client-1 client-secret=keyshroud://Source infisical client secret$`, "m"));

    fake.hits.length = 0;
    const file = await envFile(box, ["DB_PASSWORD=infisical://proj-1/dev/DB_PASSWORD", "API_KEY=infisical://proj-1/dev/backend/api/API_KEY", "GONE=infisical://proj-1/dev/NOPE", "SHORT=infisical://proj-1/DB_PASSWORD"]);
    const run = await runCli(box, ["run", "--no-auth", "--env-file", file, "--", "sh", "-c", `echo $DB_PASSWORD $API_KEY; echo ${TOKEN} made-up-client-secret-0012`]);
    assert.equal(run.stdout, "<redacted:DB_PASSWORD> <redacted:API_KEY>\n<redacted:INFISICAL_SOURCE_TOKEN> <redacted:Source infisical client secret>\n");
    assert.match(run.stderr, /unresolved \(names only\): GONE, SHORT/);
    assert.equal(fake.paths().filter((path) => path.startsWith("POST")).length, 1);
    assert.ok(fake.paths().includes("GET /api/v4/secrets/API_KEY?projectId=proj-1&environment=dev&secretPath=%2Fbackend%2Fapi"));
    assert.match((await runCli(box, ["get", "infisical://proj-1/dev/NOPE"])).stderr, /infisical:\/\/proj-1\/dev\/NOPE: HTTP 404 \(not found\)\)/);
    assert.match((await runCli(box, ["get", "infisical://proj-1/DB_PASSWORD"])).stderr, /is not <project id>\/<environment>\/\[<folder>\/\]<NAME>/);
    // A name of dots would be another path on the server once the URL is put together.
    assert.match((await runCli(box, ["get", "infisical://proj-1/dev/.."])).stderr, /is not <project id>\/<environment>\/\[<folder>\/\]<NAME>/);

    const wrong = await runCli(box, ["source", "add", "infisical", "--addr", fake.addr, "--client-id", "client-1", "--stdin"], "made-up-wrong-secret-0013");
    assert.equal(wrong.stdout.trim(), `source=infisical addr=${fake.addr} verified=no (Infisical login: HTTP 401 (the sign-in was not accepted))`);

    // A credential rotated in the vault is masked by the hook before any source is read with it.
    fake.hits.length = 0;
    assert.equal((await runCli(box, ["rotate", "--item", "Source infisical client secret", "--stdin"], "made-up-rotated-secret-0015")).code, 0);
    const post = await runCli(box, ["hook", "claude", "post-tool-use"], JSON.stringify({ tool_response: { stdout: "made-up-rotated-secret-0015" } }));
    assert.equal(JSON.parse(post.stdout).hookSpecificOutput.updatedToolOutput.stdout, "<redacted:Source infisical client secret>");
    assert.equal(fake.hits.length, 0);
  } finally { fake.close(); }
});

// Fake vendor CLIs: each logs its argument count and arguments, and what it got of keyshroud's
// own environment, then prints `<name>.out` (and exits with `<name>.exit`).
async function fakeClis(box: Sandbox, outputs: Record<string, string>): Promise<{ env: Record<string, string>; calls(): Promise<string[]> }> {
  const bin = join(box.dir, "cli-bin"), log = join(box.dir, "cli.log");
  await mkdir(bin, { recursive: true });
  await writeFile(log, "");
  for (const [name, output] of Object.entries(outputs)) {
    await writeFile(join(bin, `${name}.out`), output);
    await writeFile(join(bin, name), `#!/bin/sh\nprintf '%s %s %s\\n' "$#" "$*" "\${KEYSHROUD_PASSPHRASE:-none}" >> "${log}"\n[ -f "$0.err" ] && { cat "$0.err" >&2; exit 1; }\ncat "$0.out"\n`);
    await chmod(join(bin, name), 0o755);
  }
  return { env: { PATH: `${bin}:${box.env.PATH}` }, calls: async () => (await readFile(log, "utf8")).split("\n").filter(Boolean) };
}

test("op://, awssecrets://, awsssm://, gcpsecrets://, azurekeyvault://: read through the vendor's CLI, each part of a reference one checked argument", async () => {
  const box = await blank();
  const clis = await fakeClis(box, {
    op: "op-made-up-token-0014",
    aws: JSON.stringify({ Name: "x", SecretString: JSON.stringify({ username: "svc", password: "aws-made-up-password-0015" }), Parameter: { Value: "aws-made-up-param-0016" } }),
    gcloud: "gcp-made-up-key-0017\n",
    az: JSON.stringify({ id: "https://kv.vault.azure.net/secrets/db/abc", value: "az-made-up-secret-0018" }),
  });
  const file = await envFile(box, [
    "OP=op://Private Vault/GitHub/token", "AWS_DB=awssecrets://prod/db?region=eu-west-1#password", "AWS_ARN=awssecrets://arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod/db-AbCdEf#/password",
    "PARAM=awsssm:///prod/db/token", "GCP=gcpsecrets://my-project/api-key?version=3", "GCP_LATEST=gcpsecrets://my-project/api-key", "AZ=azurekeyvault://kv-prod/db/abc123", "AZ_LATEST=azurekeyvault://kv-prod/db",
  ]);
  const names = ["OP", "AWS_DB", "AWS_ARN", "PARAM", "GCP", "GCP_LATEST", "AZ", "AZ_LATEST"];
  const out = await printed(box, file, names, { ...clis.env, KEYSHROUD_PASSPHRASE: "made-up-passphrase-0019" });
  for (const name of ["OP", "AWS_DB", "PARAM", "GCP", "AZ"]) assert.ok(out.includes(`${name}=<redacted:${name}>`), out);
  assert.ok(!out.includes("made-up") && !out.includes("unresolved"), out);
  // Argument count, arguments, and nothing of keyshroud's own vault in the CLI's environment.
  assert.deepEqual((await clis.calls()).sort(), [
    "11 keyvault secret show --vault-name kv-prod --name db --version abc123 --output json none",
    "3 read --no-newline op://Private Vault/GitHub/token none",
    "6 secrets versions access 3 --secret=api-key --project=my-project none",
    "6 secrets versions access latest --secret=api-key --project=my-project none",
    "6 secretsmanager get-secret-value --secret-id arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod/db-AbCdEf --output json none",
    "7 ssm get-parameter --name /prod/db/token --with-decryption --output json none",
    "8 secretsmanager get-secret-value --secret-id prod/db --output json --region eu-west-1 none",
    "9 keyvault secret show --vault-name kv-prod --name db --output json none",
  ]);
  assert.equal((await runCli(box, ["get", "awssecrets://prod/db#username"], undefined, clis.env)).stdout, "svc");
  // A payload is passed on as it is stored, a line break at its end included.
  assert.equal((await runCli(box, ["get", "gcpsecrets://my-project/api-key"], undefined, clis.env)).stdout, "gcp-made-up-key-0017\n");
  assert.match((await runCli(box, ["get", "gcpsecrets://my-project/api-key#field"], undefined, clis.env)).stderr, /is not a JSON object, so it has no #field/);

  // What could be taken for an option, a file or a URL to load never reaches a command line.
  const before = (await clis.calls()).length;
  const refused: Array<[string, RegExp]> = [
    ["awssecrets://file:///etc/passwd", /is not a secret's name or ARN/], ["awssecrets://--endpoint-url=x", /is not a secret's name or ARN/], ["awssecrets://prod/db?region=--profile", /is not in a region like eu-west-1/],
    ["awssecrets://prod/db?endpoint=http://127.0.0.1", /unknown parameter endpoint/], ["awsssm://-name", /is not a parameter's name/], ["awsssm:///prod/db?version=2", /unknown parameter version/],
    ["gcpsecrets://my-project/api-key?version=--x", /is not <project>\/<secret>/], ["gcpsecrets://my-project", /is not <project>\/<secret>/], ["gcpsecrets://--project/x", /is not <project>\/<secret>/],
    ["azurekeyvault://kv-prod/--name", /is not <vault name>\/<secret>/], ["azurekeyvault://kv-prod/db/v/extra", /is not <vault name>\/<secret>/], ["azurekeyvault://kv-prod", /is not <vault name>\/<secret>/],
  ];
  for (const [ref, reason] of refused) {
    const got = await runCli(box, ["get", ref], undefined, clis.env);
    assert.equal(got.code, 4, ref);
    assert.match(got.stderr, reason, ref);
  }
  assert.equal((await clis.calls()).length, before);

  // A CLI that fails says so in its own words; one that is not installed is named; a secret that is not text is no value.
  await writeFile(join(box.dir, "cli-bin", "op.err"), "[ERROR] 2026/11/15 12:00:00 \"Nope\" isn't a vault in this account.\nmore\n");
  // A CLI's own message is not passed on, only which kind of failure it tells of.
  assert.equal((await runCli(box, ["get", "op://Nope/x/y"], undefined, clis.env)).stderr.trim(), "Secret unresolved: op://Nope/x/y (op found no such secret)");
  for (const [said, kind] of [
    ["Unable to locate credentials. You can configure credentials by running \"aws login\".", "aws is not signed in (or its sign-in has ended)"],
    ["An error occurred (AccessDeniedException) when calling the GetSecretValue operation: User: arn:aws:iam::123456789012:user/login-bot is not authorized to perform: secretsmanager:GetSecretValue", "aws was refused access"],
    ["An error occurred (ResourceNotFoundException) when calling the GetSecretValue operation: Secrets Manager can't find the specified secret.", "aws found no such secret"],
    ["aws-made-up-password-0015 could not be shown", "aws failed"],
  ]) {
    await writeFile(join(box.dir, "cli-bin", "aws.err"), `\n${said}\n`);
    assert.equal((await runCli(box, ["get", "awssecrets://prod/other"], undefined, clis.env)).stderr.trim(), `Secret unresolved: awssecrets://prod/other (${kind})`);
  }
  await rm(join(box.dir, "cli-bin", "aws.err"));
  assert.match((await runCli(box, ["get", "op://Private/x/y"])).stderr, /the op command is not installed \(or not on PATH\)/);
  await writeFile(join(box.dir, "cli-bin", "aws.out"), JSON.stringify({ Name: "x", SecretBinary: "AAEC" }));
  const binary = await runCli(box, ["get", "awssecrets://prod/blob"], undefined, clis.env);
  assert.match(binary.stderr, /no text value in the answer/);
  assert.ok(!binary.stderr.includes("AAEC"));
  assert.match((await runCli(box, ["source"], undefined, clis.env)).stdout, /^CLIs: op=found aws=found gcloud=found az=found$/m);
  assert.match((await runCli(box, ["source"])).stdout, /^no source is set up .*\nCLIs: op=missing aws=missing gcloud=missing az=missing$/m);
});

test("a source reference is wired, injected and listed like any other, and is never an item of keyshroud's", async () => {
  const fake = await serve(vault());
  try {
    const box = await vaultBox(fake);
    const wired = await runCli(box, ["wire", "--env", "DB_PASSWORD", "--item", "vault://secret/app/db#password"]);
    assert.match(wired.stdout, /^wired env=DB_PASSWORD item=vault:\/\/secret\/app\/db#password /);
    assert.deepEqual(JSON.parse(await readFile(join(box.configDir, "env.json"), "utf8")).DB_PASSWORD, { type: "api_key", key: "!keyshroud get 'vault://secret/app/db#password'" });
    assert.equal((await runCli(box, ["env"])).stdout.trim(), "DB_PASSWORD");
    assert.equal((await runCli(box, ["run", "--only", "DB_PASSWORD", "--", "sh", "-c", "echo $DB_PASSWORD"])).stdout, "<redacted:DB_PASSWORD>\n");
    assert.equal((await runCli(box, ["get", "DB_PASSWORD"])).stdout, "kv2-made-up-password-0001");
    assert.equal((await runCli(box, ["wire", "--env", "X", "--item", "vault://secret/it's#k"])).code, 2);
    assert.equal((await runCli(box, ["wire", "--env", "X", "--item", "vault://#k"])).code, 2);

    // keyshroud stores nothing there: a reference is no item to add, rotate, remove or hand out.
    for (const args of [["add", "--env", "X", "--item", "vault://secret/new#k", "--stdin"], ["rotate", "--item", "vault://secret/single", "--stdin"], ["rm", "--item", "vault://secret/single"], ["api-key", "--item", "op://a/b/c"]]) {
      const refused = await runCli(box, args, "value");
      assert.equal(refused.code, 2, args.join(" "));
      assert.match(refused.stderr, /is a secret in another system: keyshroud reads it .* and never stores or changes it there/);
    }
    assert.ok(!fake.paths().some((path) => path.startsWith("POST") || path.startsWith("PUT") || path.startsWith("DELETE")));

    // An item of the local vault with the path's name is another thing: its wiring is its own.
    assert.equal((await runCli(box, ["add", "--env", "OTHER", "--item", "secret%2Fapp%2Fdb", "--stdin"], "local-made-up-value-0020")).code, 0);
    assert.match((await runCli(box, ["list"])).stdout, /^keyshroud:\/\/secret%252Fapp%252Fdb {2}wired=OTHER$/m);

    const template = join(box.dir, "config.tpl");
    await writeFile(template, "password = {{ vault://secret/app/db#password }}\nport = {{vault://secret/app/db#port}}\nplain = {{ not-a-ref }}\n");
    assert.equal((await runCli(box, ["inject", "-i", template])).stdout, "password = kv2-made-up-password-0001\nport = 5432\nplain = {{ not-a-ref }}\n");

    // What pi's auth.json holds for a provider is masked when this process has read it, and is not asked for otherwise.
    await writeAuth(box, { openai: { type: "api_key", key: "!keyshroud get 'vault://kv1/legacy#token'" } });
    fake.hits.length = 0;
    assert.equal((await runCli(box, ["run", "--only", "DB_PASSWORD", "--", "sh", "-c", "echo $DB_PASSWORD"])).stdout, "<redacted:DB_PASSWORD>\n");
    assert.ok(!fake.paths().some((path) => path.includes("kv1")), fake.paths().join("\n"));
  } finally { fake.close(); }
});

test("a long-lived process reads a source once, answers the inventory from what it has, and keeps an injected value while the server is away", async () => {
  const fake = await serve(vault());
  const box = await vaultBox(fake);
  const script = (body: string) => new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `const core = await import(${CORE});\nconst { parseRef } = await import(${JSON.stringify(new URL("../src/refs.ts", import.meta.url).href)});\n${body}`], { env: box.env });
    let text = ""; child.stdout.on("data", (chunk) => { text += chunk; }); child.stderr.on("data", (chunk) => { text += chunk; }); child.on("close", () => resolve(text));
  });
  try {
    fake.hits.length = 0;
    const out = await script(`
      const ref = parseRef("vault://secret/single");
      const before = await core.resolveRef(ref, { open: false });
      const first = await core.resolveRef(ref);
      const again = await core.resolveRef(ref);
      const held = await core.resolveRef(ref, { open: false });
      const index = Object.keys(core.indexValues());
      console.log(JSON.stringify({ before, same: first === again && again === held, length: first.length, index }));
    `);
    assert.deepEqual(JSON.parse(out), { before: null, same: true, length: "kv2-made-up-single-0002".length, index: ["VAULT_SOURCE_TOKEN"] });
    assert.deepEqual(fake.paths(), ["GET /v1/sys/internal/ui/mounts/secret/single", "GET /v1/secret/data/single"]);

    fake.close();
    const away = await script(`
      process.env.KEPT = "value-from-before"; process.env.LOCAL = "value-from-before";
      const env = await core.resolveEntries([{ name: "KEPT", raw: "vault://secret/single" }, { name: "LOCAL", raw: "keyshroud://Nothing" }], { preferProcessEnv: true, injected: { KEPT: "value-from-before", LOCAL: "value-from-before" } });
      console.log(JSON.stringify({ values: env.values, missing: env.missing }));
    `);
    assert.deepEqual(JSON.parse(away), { values: { KEPT: "value-from-before" }, missing: ["LOCAL"] });
  } finally { fake.close(); }
});

test("a long-lived process lets go of what it read when its time is over, and of everything with the cache off", async () => {
  const fake = await serve(vault());
  const box = await vaultBox(fake);
  const script = (env: Record<string, string>) => new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `const core = await import(${CORE});\nconst { parseRef } = await import(${JSON.stringify(new URL("../src/refs.ts", import.meta.url).href)});
      const ref = parseRef("vault://secret/single");
      const first = await core.resolveRef(ref);
      const held = await core.resolveRef(ref, { open: false });
      await new Promise((done) => setTimeout(done, 400));
      const later = await core.resolveRef(ref, { open: false });
      console.log(JSON.stringify({ read: first !== null, held: held !== null, later: later !== null }));`], { env: { ...box.env, ...env } });
    let text = ""; child.stdout.on("data", (chunk) => { text += chunk; }); child.stderr.on("data", (chunk) => { text += chunk; }); child.on("close", () => resolve(text));
  });
  try {
    assert.deepEqual(JSON.parse(await script({})), { read: true, held: true, later: true });
    assert.deepEqual(JSON.parse(await script({ KEYSHROUD_CACHE_TTL_MS: "200" })), { read: true, held: true, later: false });
    assert.deepEqual(JSON.parse(await script({ KEYSHROUD_CACHE_TTL_MS: "0" })), { read: true, held: false, later: false });
  } finally { fake.close(); }
});

test("vault://: a token refused late does not end the login that came after it, and is not shown", async () => {
  // The first login's token is refused (one read late, with the token in what the server says);
  // the second login takes a while.
  let logins = 0;
  const taken = vault(["hvs.made-up-second-token-0021"], { "role-1": "made-up-secret-id-0006" });
  const fake = await serve(async (hit) => {
    if (hit.path === "/v1/auth/approle/login" && ++logins === 1) return { json: { auth: { client_token: "hvs.made-up-first-token-0020", lease_duration: 1200 } } };
    if (hit.path === "/v1/auth/approle/login") await sleep(600);
    if (hit.headers["x-vault-token"] === "hvs.made-up-first-token-0020" && hit.path.includes("slow")) { await sleep(1500); return { status: 403, json: { errors: ["denied for hvs.made-up-first-token-0020"] } }; }
    return taken(hit);
  });
  try {
    const box = await blank();
    await runCli(box, ["source", "add", "vault", "--addr", fake.addr, "--role-id", "role-1", "--stdin"], "made-up-secret-id-0006\n");
    logins = 0;
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `const core = await import(${CORE});\nconst { parseRef } = await import(${JSON.stringify(new URL("../src/refs.ts", import.meta.url).href)});
        const read = (ref) => core.resolveRef(parseRef(ref));
        const a = read("vault://secret/app/db#password"), b = read("vault://secret/slow/x#y");
        await a;
        const c = read("vault://secret/single"), d = read("vault://kv1/legacy#token");
        const lengths = [(await c)?.length, (await d)?.length];
        const late = await b;
        const e = await read("vault://team/kv/with space/it#k");
        console.log(JSON.stringify([await a, late, ...lengths, e?.length, core.unresolvedReason("")]));`], { env: box.env });
      let text = ""; child.stdout.on("data", (chunk) => { text += chunk; }); child.stderr.on("data", (chunk) => { text += chunk; }); child.on("close", () => resolve(text));
    });
    const [a, late, c, d, e, reason] = JSON.parse(out);
    assert.deepEqual([a, late, c, d, e], [null, null, "kv2-made-up-single-0002".length, "kv1-made-up-token-0003".length, "kv2-made-up-deep-0004".length]);
    assert.equal(logins, 2);
    assert.equal(reason, " (vault://secret/app/db: HTTP 403 (not allowed); vault://secret/slow/x: HTTP 403 (not allowed))");
  } finally { fake.close(); }
});
