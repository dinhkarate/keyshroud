import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { CLI, item, runCli, sandbox, writeAuth } from "./helpers.ts";

const GH = "ghp_FAKE0123456789abcdef";
const NPM = "npm_FAKEabcdefghijklmnop";

async function wired() {
  const box = await sandbox([
    item("id-1", "GitHub CLI token", GH, { fields: [{ name: "org", value: "acme-org" }] }),
    item("id-2", "npm publish", NPM),
    item("id-3", "Dup", "dup-value-1"),
    item("id-4", "dup", "dup-value-2"),
  ]);
  await writeAuth(box, {
    anthropic: { type: "oauth" },
    GH_TOKEN: { type: "api_key", key: "!bw get password 'GitHub CLI token'" },
    NPM_TOKEN: "bw://npm publish",
    PLAIN: "not-a-secret-literal",
  });
  return box;
}

test("status unlocks from the keychain and stores a private session file", async () => {
  const box = await wired();
  const result = await runCli(box, ["status"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /status=unlocked items=4/);
  const info = await stat(join(box.configDir, "session"));
  assert.equal(info.mode & 0o777, 0o600);
  assert.ok(!result.stdout.includes("fake-session"));
});

test("env lists names only and resolves every reference with one batched list", async () => {
  const box = await wired();
  const result = await runCli(box, ["env"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n").sort(), ["GH_TOKEN", "NPM_TOKEN", "PLAIN"]);
  assert.ok(!result.stdout.includes(GH));
  const lists = (await box.bwCalls()).filter((call) => call === "list items");
  assert.equal(lists.length, 1);
  assert.ok(!(await box.bwCalls()).some((call) => call.startsWith("get password")));
});

test("get resolves wired names and bw:// references", async () => {
  const box = await wired();
  assert.equal((await runCli(box, ["get", "GH_TOKEN"])).stdout, GH);
  assert.equal((await runCli(box, ["get", "bw://GitHub CLI token/fields/org"])).stdout, "acme-org");
  assert.equal((await runCli(box, ["get", "bw://GitHub CLI token/username"])).stdout, "agent");
  const ambiguous = await runCli(box, ["get", "bw://dup"]);
  assert.equal(ambiguous.code, 4);
  assert.match(ambiguous.stderr, /Ambiguous/);
  assert.equal((await runCli(box, ["get", "bw://missing"])).code, 4);
});

test("run injects secrets and masks them in piped output", async () => {
  const box = await wired();
  await writeFile(join(box.dir, ".env.refs"), "EXTRA=bw://npm publish\nMODE=debug\n");
  const result = await runCli(box, ["run", "--env-file", ".env.refs", "--", "/bin/sh", "-c", "echo gh=$GH_TOKEN; echo extra=$EXTRA mode=$MODE; echo err=$NPM_TOKEN >&2; exit 7"]);
  assert.equal(result.code, 7);
  // EXTRA and NPM_TOKEN share a value; the first wired name labels it.
  assert.equal(result.stdout, "gh=<redacted:GH_TOKEN>\nextra=<redacted:NPM_TOKEN> mode=debug\n");
  assert.equal(result.stderr, "err=<redacted:NPM_TOKEN>\n");
  const audit = await readFile(join(box.configDir, "audit.jsonl"), "utf8");
  assert.match(audit, /"action":"run"/);
  assert.ok(!audit.includes(GH));
});

test("env files cannot run shell commands", async () => {
  const box = await wired();
  const marker = join(box.dir, "pwned");
  await writeFile(join(box.dir, ".env.refs"), `X=!touch ${marker}\n`);
  const result = await runCli(box, ["run", "--no-auth", "--env-file", ".env.refs", "--", "true"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /accept only bw:\/\/ references/);
  await assert.rejects(stat(marker));
});

test("an unreadable auth.json is never overwritten", async () => {
  const box = await wired();
  const path = join(box.env.PI_CODING_AGENT_DIR, "auth.json");
  await writeFile(path, "{ not json");
  const result = await runCli(box, ["wire", "--env", "NEW", "--item", "npm publish", "--target", "omp"]);
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(path, "utf8"), "{ not json");
});

test("values from env files used by run stay covered by the hook index", async () => {
  const box = await wired();
  await writeFile(join(box.dir, ".env.refs"), "ORG=bw://GitHub CLI token/fields/org\n");
  await runCli(box, ["hook", "claude", "session-start"], "{}");
  assert.equal((await runCli(box, ["run", "--env-file", ".env.refs", "--", "true"])).code, 0);
  await runCli(box, ["hook", "claude", "session-start"], "{}");
  const post = await runCli(box, ["hook", "claude", "post-tool-use"], JSON.stringify({ tool_response: { stdout: "org=acme-org" } }));
  assert.equal(JSON.parse(post.stdout).hookSpecificOutput.updatedToolOutput.stdout, "org=<redacted:ORG>");
});

test("children never receive the vault session or unlock credentials", async () => {
  const box = await wired();
  const result = await runCli(box, ["run", "--no-mask", "--", "/bin/sh", "-c", "echo s=${BW_SESSION:-none} p=${BW_PASSWORD:-none}"], "", { BW_SESSION: "fake-session", BW_PASSWORD: "master" });
  assert.equal(result.stdout, "s=none p=none\n");
});

test("auth.json writes respect pi's directory lock and symlinks", async () => {
  const box = await wired();
  const dir = join(box.env.HOME, ".pi", "agent");
  const real = join(box.dir, "real-auth.json");
  await writeFile(real, JSON.stringify({ anthropic: { type: "oauth" } }));
  const { unlink } = await import("node:fs/promises");
  await unlink(join(dir, "auth.json"));
  await symlink(real, join(dir, "auth.json"));
  await mkdir(join(dir, "auth.json.lock"));
  const old = new Date(Date.now() - 60_000);
  await utimes(join(dir, "auth.json.lock"), old, old);
  const result = await runCli(box, ["wire", "--env", "NEW", "--item", "npm publish", "--target", "pi"]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok((await import("node:fs")).lstatSync(join(dir, "auth.json")).isSymbolicLink());
  assert.deepEqual(Object.keys(JSON.parse(await readFile(real, "utf8"))), ["anthropic", "NEW"]);
});

test("run --no-mask passes values through and --only limits injection", async () => {
  const box = await wired();
  const raw = await runCli(box, ["run", "--no-mask", "--only", "GH_TOKEN", "--", "/bin/sh", "-c", "echo $GH_TOKEN-$NPM_TOKEN"]);
  assert.equal(raw.stdout, `${GH}-\n`);
  const unknown = await runCli(box, ["run", "--only", "NOPE", "--", "true"]);
  assert.equal(unknown.code, 4);
});

test("inject renders templates and refuses to overwrite", async () => {
  const box = await wired();
  await writeFile(join(box.dir, "npmrc.tpl"), "//registry.npmjs.org/:_authToken={{ bw://npm publish }}\n");
  const out = await runCli(box, ["inject", "-i", "npmrc.tpl", "-o", ".npmrc"]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(await readFile(join(box.dir, ".npmrc"), "utf8"), `//registry.npmjs.org/:_authToken=${NPM}\n`);
  assert.equal(((await stat(join(box.dir, ".npmrc"))).mode & 0o777), 0o600);
  assert.equal((await runCli(box, ["inject", "-i", "npmrc.tpl", "-o", ".npmrc"])).code, 5);
});

test("redact and scan find vault values", async () => {
  const box = await wired();
  const redacted = await runCli(box, ["redact"], `token ${GH} and ${NPM}\n`);
  assert.equal(redacted.stdout, "token <redacted:GH_TOKEN> and <redacted:NPM_TOKEN>\n");
  await writeFile(join(box.dir, "leak.ts"), `const key = "${NPM}";\n`);
  await symlink(join(box.dir, "missing"), join(box.dir, "dangling"));
  assert.equal((await runCli(box, ["scan", "."])).code, 1);
  const scan = await runCli(box, ["scan", "leak.ts"]);
  assert.equal(scan.code, 1);
  assert.equal(scan.stdout.trim(), "leak.ts:1 NPM_TOKEN");
});

test("add stores a piped secret, wires both agents, and never prints it", async () => {
  const box = await wired();
  const result = await runCli(box, ["add", "--env", "NEW_KEY", "--item", "New key", "--notes", "test", "--stdin"], "s3cret-value-xyz\n");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /created item=New key env=NEW_KEY .* verified=yes/);
  assert.ok(!result.stdout.includes("s3cret") && !result.stderr.includes("s3cret"));
  const created = (await box.vault()).items.find((entry) => entry.name === "New key") as { login: { password: string } };
  assert.equal(created.login.password, "s3cret-value-xyz");
  for (const path of [join(box.env.HOME, ".pi", "agent", "auth.json"), join(box.env.PI_CODING_AGENT_DIR, "auth.json")]) {
    const auth = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(auth.NEW_KEY, { type: "api_key", key: "!bw get password 'New key'" });
    assert.deepEqual(auth.anthropic, { type: "oauth" });
  }
  const again = await runCli(box, ["add", "--env", "NEW_KEY", "--item", "New key", "--stdin"], "x");
  assert.equal(again.code, 5);
});

test("rotate, wire, unwire, lock", async () => {
  const box = await wired();
  assert.equal((await runCli(box, ["rotate", "--item", "npm publish", "--stdin"], "rotated-value-123")).code, 0);
  assert.equal((await runCli(box, ["get", "NPM_TOKEN"])).stdout, "rotated-value-123");
  assert.equal((await runCli(box, ["wire", "--env", "GH_TOKEN", "--item", "npm publish"])).code, 5);
  assert.equal((await runCli(box, ["wire", "--env", "GH_TOKEN", "--item", "npm publish", "--force", "--target", "pi"])).code, 0);
  assert.match((await runCli(box, ["unwire", "--env", "GH_TOKEN"])).stdout, /removed env=GH_TOKEN/);
  assert.equal((await runCli(box, ["lock"])).stdout, "locked\n");
  await assert.rejects(stat(join(box.configDir, "session")));
});

test("argument errors exit 2", async () => {
  const box = await wired();
  assert.equal((await runCli(box, ["get"])).code, 2);
  assert.equal((await runCli(box, ["run", "--bogus", "--", "true"])).code, 2);
  assert.equal((await runCli(box, ["wire", "--env", "lower", "--item", "x"])).code, 2);
  assert.equal((await runCli(box, ["nope"])).code, 2);
});

test("Claude Code hooks: session-start writes the index, post-tool-use redacts", async () => {
  const box = await wired();
  const start = await runCli(box, ["hook", "claude", "session-start"], "{}");
  const context = JSON.parse(start.stdout).hookSpecificOutput.additionalContext as string;
  assert.match(context, /GH_TOKEN/);
  assert.ok(!context.includes(GH));
  const response = { stdout: `value ${GH}`, stderr: "", interrupted: false, isImage: false };
  const post = await runCli(box, ["hook", "claude", "post-tool-use"], JSON.stringify({ tool_name: "Bash", tool_response: response }));
  assert.deepEqual(JSON.parse(post.stdout).hookSpecificOutput.updatedToolOutput, { ...response, stdout: "value <redacted:GH_TOKEN>" });
  const clean = await runCli(box, ["hook", "claude", "post-tool-use"], JSON.stringify({ tool_response: { stdout: "nothing" } }));
  assert.equal(clean.stdout, "");
  const broken = await runCli(box, ["hook", "claude", "post-tool-use"], "not json");
  assert.equal(broken.code, 0);
});

test("MCP server lists tools and runs commands with masked output", async () => {
  const box = await wired();
  const child = spawn(process.execPath, [CLI, "mcp"], { env: box.env, cwd: box.dir });
  const responses: Array<Record<string, any>> = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      responses.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "secrets_run", arguments: { command: "echo $GH_TOKEN" } } });
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "secrets_list", arguments: {} } });
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "secrets_request", arguments: { env_name: "STRIPE_KEY", item_name: "Stripe" } } });
  send({ jsonrpc: "2.0", id: 6, method: "nope" });
  send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "secrets_run", arguments: { command: "echo s=${BW_SESSION:-none}" } } });
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.equal(byId.get(1)!.result.protocolVersion, "2025-06-18");
  assert.deepEqual(byId.get(2)!.result.tools.map((tool: { name: string }) => tool.name), ["secrets_list", "secrets_run", "secrets_request", "vault_status"]);
  const run = byId.get(3)!.result.content[0].text as string;
  assert.match(run, /exit: 0/);
  assert.match(run, /<redacted:GH_TOKEN>/);
  assert.ok(!run.includes(GH));
  assert.match(byId.get(4)!.result.content[0].text, /GH_TOKEN/);
  assert.match(byId.get(5)!.result.content[0].text, /add --env STRIPE_KEY --item 'Stripe'/);
  assert.equal(byId.get(6)!.error.code, -32601);
  assert.match(byId.get(7)!.result.content[0].text, /s=none/);
  assert.equal(responses.length, 7);
});
