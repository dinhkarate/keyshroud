// The local vault: the default backend on a machine keyshroud never used with bw.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, lstat, mkdir, readdir, readFile, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { sealSession } from "../src/vault.ts";
import { CLI, NODE, item, runCli, runCliTtySteps, sandbox, writeAuth, type Sandbox } from "./helpers.ts";

const TOKEN = "ghp_LOCAL0123456789abcdefXYZ";
const PASS = "correct horse battery staple";

const blank = () => sandbox([], { blank: true });
const vaultPath = (box: Sandbox) => join(box.configDir, "vault.json");
const keyEntries = async (box: Sandbox) => (await readdir(join(box.dir, "keychain"))).filter((name) => name.startsWith("keyshroud-vault-"));
const add = (box: Sandbox, env: string, itemName: string, value: string, extra: Record<string, string> = {}) =>
  runCli(box, ["add", "--env", env, "--item", itemName, "--stdin"], value, extra);
const CORE = JSON.stringify(new URL("../src/core.ts", import.meta.url).href);

// Runs an ES module script in its own process; its stdout.
function runScript(box: Sandbox, script: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: box.env });
    let text = ""; child.stdout.on("data", (chunk) => { text += chunk; }); child.on("close", () => resolve(text));
  });
}

// Script prelude: replaces node:fs/promises functions (`patch.name = fn`, each
// called with the original as `real`) for every module, core included.
const PATCH_FS = `
  const { createRequire, syncBuiltinESMExports } = await import("node:module");
  const require = createRequire(import.meta.url);
  const fs = require("node:fs"), fsp = require("node:fs/promises");
  const patch = (name, fn) => { const real = fsp[name]; fsp[name] = (...args) => fn(real, ...args); syncBuiltinESMExports(); };
`;

// A long-lived MCP server, as agents keep one.
function mcpServer(box: Sandbox, env: Record<string, string> = {}) {
  const child = spawn(NODE, [CLI, "mcp"], { env: { ...box.env, ...env }, cwd: box.dir });
  const responses = new Map<number, { result: { content: Array<{ text: string }> } }>();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) { const message = JSON.parse(buffer.slice(0, at)); responses.set(message.id, message); buffer = buffer.slice(at + 1); }
  });
  let id = 0;
  return {
    async call(name: string, args: object = {}): Promise<string> {
      const current = ++id;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method: "tools/call", params: { name, arguments: args } })}\n`);
      const deadline = Date.now() + 30000;
      while (!responses.has(current) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      return responses.get(current)!.result.content[0].text;
    },
    async initialize(): Promise<string> {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
      const deadline = Date.now() + 30000;
      while (!responses.has(0) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      return (responses.get(0)!.result as unknown as { instructions: string }).instructions;
    },
    close() { child.stdin.end(); child.kill(); },
  };
}

test("a blank machine: add creates the local vault, run masks, and bw is never called", async () => {
  const box = await blank();
  const empty = await runCli(box, ["status"]);
  assert.equal(empty.code, 0, empty.stderr);
  assert.equal(empty.stdout, "backend=local vault=none: no secrets yet (keyshroud add --env NAME --item ITEM)\n");
  assert.equal((await runCli(box, ["lock"])).stdout, "nothing to lock: no local vault yet\n");

  const added = await add(box, "GH_TOKEN", "GitHub token", TOKEN);
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stderr, /created the local vault .*vault\.json; its key is in the (macOS keychain|Secret Service keyring) \(keyshroud-vault-[0-9a-f]{16}\), so programs running as you can open it without asking/);
  assert.match(added.stdout, /created item=GitHub token env=GH_TOKEN .* verified=yes/);
  const text = await readFile(vaultPath(box), "utf8");
  assert.ok(!text.includes(TOKEN) && !text.includes("GitHub token"), "the file holds neither values nor names in the clear");
  assert.equal((await stat(vaultPath(box))).mode & 0o777, 0o600);
  assert.equal((await keyEntries(box)).length, 1);
  // Wiring is keyshroud's own file; no agent is installed here, so no agent directory appears.
  assert.match(added.stdout, /targets=[^,]*env\.json verified=yes/);
  assert.match(await readFile(join(box.configDir, "env.json"), "utf8"), /"!keyshroud get 'keyshroud:\/\/GitHub token'"/);
  assert.ok(!existsSync(join(box.env.HOME, ".pi")) && !existsSync(join(box.env.HOME, ".omp")));

  const run = await runCli(box, ["run", "--mask", "--", "sh", "-c", 'echo "deploying with $GH_TOKEN"']);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, "deploying with <redacted:GH_TOKEN>\n");
  assert.equal((await runCli(box, ["get", "GH_TOKEN"])).stdout, TOKEN);
  assert.equal((await runCli(box, ["get", "keyshroud://GitHub token"])).stdout, TOKEN);
  // local://, the first spelling, still reads the same item.
  assert.equal((await runCli(box, ["get", "local://GitHub token"])).stdout, TOKEN);
  assert.match((await runCli(box, ["env", "--shell"])).stdout, /^export GH_TOKEN=/m);
  assert.match((await runCli(box, ["status"])).stdout, /^backend=local vault=.*vault\.json key=keychain status=unlocked items=1$/m);
  const doctor = await runCli(box, ["doctor"]);
  assert.equal(doctor.code, 0, doctor.stdout);
  assert.match(doctor.stdout, /^backend=local \(.*backend says local\)$/m);
  assert.match(doctor.stdout, /GH_TOKEN resolved=yes/);
  assert.doesNotMatch(doctor.stdout, /^bw /m);
  assert.equal((await runCli(box, ["lock"])).stdout, "nothing to lock: the local vault opens with its key from the keychain\n");
  assert.equal((await runCli(box, ["unlock"])).stdout, "the local vault opens with its key from the keychain; nothing to unlock\n");
  const duplicate = await add(box, "OTHER", "github TOKEN", "other-value-1234");
  assert.equal(duplicate.code, 5);
  assert.deepEqual(await box.bwCalls(), []);
});

test("import writes keyshroud:// references; inject, scan, redact and hooks cover local values", async () => {
  const box = await blank();
  await writeFile(join(box.dir, ".env"), `API_TOKEN=${TOKEN}\nLOG_LEVEL=debug\n`);
  const imported = await runCli(box, ["import", "--yes", "--prefix", "app"]);
  assert.equal(imported.code, 0, imported.stderr);
  assert.match(imported.stdout, /API_TOKEN\s+secret\s+new\s+-> keyshroud:\/\/app API_TOKEN/);
  assert.match(await readFile(join(box.dir, ".env.refs"), "utf8"), /^API_TOKEN=keyshroud:\/\/app API_TOKEN$/m);
  const run = await runCli(box, ["run", "--env-file", ".env.refs", "--mask", "--", "sh", "-c", 'echo "$API_TOKEN $LOG_LEVEL"']);
  assert.equal(run.stdout, "<redacted:API_TOKEN> debug\n", run.stderr);
  assert.equal((await runCli(box, ["inject"], "token={{ keyshroud://app API_TOKEN }}\n")).stdout, `token=${TOKEN}\n`);
  await writeFile(join(box.dir, "leak.txt"), `oops ${TOKEN}\n`);
  const scan = await runCli(box, ["scan", "leak.txt"]);
  assert.equal(scan.code, 1);
  assert.match(scan.stdout, /leak\.txt:1 app API_TOKEN/);
  assert.equal((await runCli(box, ["redact"], `x ${TOKEN} y\n`)).stdout, "x <redacted:app API_TOKEN> y\n");

  await runCli(box, ["wire", "--env", "API_TOKEN", "--item", "app API_TOKEN"]);
  const start = await runCli(box, ["hook", "claude", "session-start"], "{}");
  assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /available by name only: API_TOKEN/);
  const post = await runCli(box, ["hook", "claude", "post-tool-use"], JSON.stringify({ tool_response: { stdout: `got ${TOKEN}` } }));
  assert.equal(JSON.parse(post.stdout).hookSpecificOutput.updatedToolOutput.stdout, "got <redacted:API_TOKEN>");
  assert.deepEqual(await box.bwCalls(), []);
});

test("rotate, wire and api-key take names or keyshroud:// references; bw references still resolve", async () => {
  const box = await blank();
  assert.equal((await add(box, "A_TOKEN", "Item A", "first-value-123")).code, 0);
  const rotated = await runCli(box, ["rotate", "--item", "keyshroud://Item A", "--stdin"], "second-value-456");
  assert.equal(rotated.code, 0, rotated.stderr);
  assert.equal((await runCli(box, ["get", "A_TOKEN"])).stdout, "second-value-456");
  assert.equal((await runCli(box, ["wire", "--env", "B_TOKEN", "--item", "Item A"])).code, 0);
  assert.equal((await runCli(box, ["get", "B_TOKEN"])).stdout, "second-value-456");
  assert.equal((await runCli(box, ["api-key", "--item", "Item A"])).stdout, "second-value-456");
  assert.equal((await runCli(box, ["rotate", "--item", "Nope", "--stdin"], "x-value-789")).code, 4);
  assert.equal((await runCli(box, ["wire", "--env", "D_TOKEN", "--item", "local://Item A"])).code, 0);
  assert.equal((await runCli(box, ["get", "D_TOKEN"])).stdout, "second-value-456");
  assert.equal((await runCli(box, ["add", "--env", "C_TOKEN", "--item", "local:///x", "--stdin"], "x")).code, 2);
  assert.equal((await runCli(box, ["add", "--env", "C_TOKEN", "--item", "keyshroud:///x", "--stdin"], "x")).code, 2);
  assert.deepEqual(await box.bwCalls(), []);

  // bw:// references keep working on a machine whose default is the local vault.
  await writeFile(box.vaultFile, JSON.stringify({ status: "locked", items: [item("id-1", "Old token", "bw-value-0001")] }));
  await writeFile(join(box.dir, "keychain", "vaultwarden-master-password"), "master\n");
  assert.equal((await runCli(box, ["get", "bw://Old token"])).stdout, "bw-value-0001");
  await writeFile(join(box.dir, "mixed.env"), "A=keyshroud://Item A\nB=bw://Old token\nC=local://Item A\n");
  const mixed = await runCli(box, ["run", "--env-file", "mixed.env", "--no-mask", "--", "sh", "-c", 'echo "$A $B $C"']);
  assert.equal(mixed.stdout, "second-value-456 bw-value-0001 second-value-456\n", mixed.stderr);
  // The value of A is also wired as A_TOKEN; either name may label it.
  assert.match((await runCli(box, ["run", "--env-file", "mixed.env", "--mask", "--", "sh", "-c", 'echo "$A $B"'])).stdout, /^<redacted:[A-Z_]+> <redacted:B>\n$/);
  assert.match((await runCli(box, ["status"])).stdout, /^backend=local/m);
});

test("concurrent first adds share one vault and one key, and keep every item", async () => {
  const box = await blank();
  const names = ["ONE", "TWO", "THREE", "FOUR"];
  const results = await Promise.all(names.map((name) => add(box, `${name}_TOKEN`, `Item ${name}`, `value-${name}-abcdef`)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  for (const name of names) assert.equal((await runCli(box, ["get", `local://Item ${name}`])).stdout, `value-${name}-abcdef`);
  assert.equal((await keyEntries(box)).length, 1, "keys of vaults that lost the race are removed");
  assert.equal(results.filter((result) => /created the local vault/.test(result.stderr)).length, 1);
});

test("a stale lock is broken, a leftover temp file is removed, and a paused holder never removes its successor's lock", async () => {
  const box = await blank();
  assert.equal((await add(box, "A_TOKEN", "Item A", "first-value-123")).code, 0);
  const lock = join(box.configDir, "vault.json.lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner"), "someone-else");
  const old = new Date(Date.now() - 40_000);
  await utimes(lock, old, old);
  await writeFile(join(box.configDir, "vault.json.tmp.deadbeef0000"), '{"v":1,"kind":"keyshroud-va');
  const added = await add(box, "B_TOKEN", "Item B", "second-value-456");
  assert.equal(added.code, 0, added.stderr);
  assert.equal((await runCli(box, ["get", "A_TOKEN"])).stdout, "first-value-123");
  assert.equal((await runCli(box, ["get", "B_TOKEN"])).stdout, "second-value-456");
  assert.ok(!existsSync(lock));
  assert.ok(!existsSync(join(box.configDir, "vault.json.tmp.deadbeef0000")));

  // In-process: a holder paused past 30 s finds the lock gone and leaves the new holder's lock alone.
  const script = `
    const core = await import(${JSON.stringify(new URL("../src/core.ts", import.meta.url).href)});
    const fs = await import("node:fs/promises");
    const lock = core.VAULT_FILE + ".lock";
    let second = "";
    const first = await core.withVaultLock(async (held) => {
      const old = new Date(Date.now() - 40000);
      await fs.utimes(lock, old, old);
      second = await core.withVaultLock(async (held2) => {
        return JSON.stringify({ firstHeld: await held(), secondHeld: await held2() });
      }).then(async (value) => value);
      return await held();
    });
    console.log(second, first);
  `;
  const out = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: box.env });
    let text = ""; child.stdout.on("data", (chunk) => { text += chunk; }); child.on("close", () => resolve(text));
  });
  assert.equal(out.trim(), '{"firstHeld":false,"secondHeld":true} false');
});

test("a writer paused past 30 s after checking its lock never overwrites what its successor wrote", async () => {
  const box = await blank();
  assert.equal((await add(box, "A_TOKEN", "Item A", "first-value-123")).code, 0);
  // In-process: just before its rename, the writer stalls while another process
  // breaks the (now stale) lock and adds an item.
  const out = await runScript(box, `${PATCH_FS}
    let stalled = false;
    patch("rename", async (real, from, to) => {
      if (!stalled && String(from).includes(".tmp.")) {
        stalled = true;
        const old = new Date(Date.now() - 40000);
        await fsp.utimes(to + ".lock", old, old);
        require("node:child_process").execFileSync(${JSON.stringify(NODE)}, [${JSON.stringify(CLI)}, "add", "--env", "B_TOKEN", "--item", "Item B", "--stdin"], { input: "second-value-456", stdio: ["pipe", "ignore", "ignore"] });
      }
      return real(from, to);
    });
    const core = await import(${CORE});
    await core.createSecretItem({ itemName: "Item C", secret: "third-value-789", envName: "C_TOKEN" }).then(() => console.log("written"), (error) => console.log(error.message));
  `);
  assert.match(out, /lost the lock of the local vault .*nothing was written/);
  assert.equal((await runCli(box, ["get", "A_TOKEN"])).stdout, "first-value-123");
  assert.equal((await runCli(box, ["get", "B_TOKEN"])).stdout, "second-value-456");
  assert.match((await runCli(box, ["status"])).stdout, /items=2$/m);
  assert.ok(!(await readdir(box.configDir)).some((name) => name.includes(".tmp.")));
});

test("a vault that was not written leaves no key in the keychain", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const box = await blank();
  const garbled = await add(box, "A_TOKEN", "Item A", "value-aaaa-1111", { FAKE_KEYCHAIN_GARBLE: "1" });
  assert.notEqual(garbled.code, 0);
  assert.match(garbled.stderr, /Could not store the key of the local vault/);
  assert.deepEqual(await keyEntries(box), []);
  // The key is stored, then the vault cannot be written.
  await mkdir(box.configDir, { recursive: true });
  await chmod(box.configDir, 0o500);
  const readOnly = await add(box, "A_TOKEN", "Item A", "value-aaaa-1111");
  await chmod(box.configDir, 0o700);
  assert.notEqual(readOnly.code, 0);
  assert.ok(!existsSync(vaultPath(box)));
  assert.deepEqual(await keyEntries(box), []);
  assert.equal((await add(box, "A_TOKEN", "Item A", "value-aaaa-1111")).code, 0);
  assert.equal((await keyEntries(box)).length, 1);
});

test("a passphrase session found ended is removed only if no other process replaced it meanwhile", { skip: process.platform === "win32" }, async () => {
  const box = await blank();
  const env = { KEYSHROUD_VAULT_KEY: "passphrase" };
  assert.equal((await runCliTtySteps(box, ["unlock"], [["New passphrase", PASS], ["Repeat it", PASS]], env)).code, 0);
  assert.equal((await add(box, "A_TOKEN", "Item A", "value-aaaa-1111", env)).code, 0);
  const files = [join(box.configDir, "vault.session"), join(box.configDir, "vault.token")];
  // A newer session, set aside; the one left on disk ends after 1 s.
  const newer = await Promise.all(files.map((file) => readFile(file, "utf8")));
  assert.equal((await runCli(box, ["lock"], undefined, env)).stdout, "locked\n");
  assert.equal((await runCliTtySteps(box, ["unlock"], [["Passphrase of the local vault", PASS]], { ...env, KEYSHROUD_SESSION_TTL_MS: "1000" })).code, 0);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  // In-process: another process writes the newer session right after this one read the ended one.
  const out = await runScript({ ...box, env: { ...box.env, ...env } }, `${PATCH_FS}
    const files = ${JSON.stringify(files)}, newer = ${JSON.stringify(newer)}, read = new Set();
    let swapped = false;
    const swap = () => { if (!swapped) { swapped = true; files.forEach((file, i) => fs.writeFileSync(file, newer[i])); } };
    patch("readFile", (real, path, ...rest) => { if (files.includes(path)) { if (read.size === 2) swap(); read.add(path); } return real(path, ...rest); });
    patch("unlink", (real, path) => { if (files.includes(path)) swap(); return real(path); });
    const core = await import(${CORE});
    console.log(await core.resolveShellValue("local://Item A"));
  `);
  assert.equal(out, "value-aaaa-1111\n");
  assert.deepEqual(await Promise.all(files.map((file) => readFile(file, "utf8"))), newer);
  assert.equal((await runCli(box, ["get", "A_TOKEN"], undefined, env)).stdout, "value-aaaa-1111");
});

test("a changed vault is never overwritten; a newer format and a missing key are named", async () => {
  const box = await blank();
  assert.equal((await add(box, "A_TOKEN", "Item A", "first-value-123")).code, 0);
  const original = await readFile(vaultPath(box), "utf8");
  const file = JSON.parse(original);
  const data = Buffer.from(file.data, "base64");
  data[0] ^= 1;
  const tampered = JSON.stringify({ ...file, data: data.toString("base64") });
  await writeFile(vaultPath(box), tampered);
  const refused = await add(box, "B_TOKEN", "Item B", "other-value-456");
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /failed its integrity check; nothing was changed/);
  assert.equal(await readFile(vaultPath(box), "utf8"), tampered, "never overwritten");
  const get = await runCli(box, ["get", "A_TOKEN"]);
  assert.equal(get.code, 4);
  assert.match(get.stderr, /integrity check/);

  await writeFile(vaultPath(box), JSON.stringify({ ...file, v: 3 }));
  const newer = await runCli(box, ["status"]);
  assert.equal(newer.code, 3);
  assert.match(newer.stdout, /written by a newer keyshroud/);

  await writeFile(vaultPath(box), original);
  for (const entry of await keyEntries(box)) await unlink(join(box.dir, "keychain", entry));
  const missing = await runCli(box, ["get", "A_TOKEN"]);
  assert.equal(missing.code, 4);
  assert.match(missing.stderr, /keychain entry keyshroud-vault-[0-9a-f]{16}\) is missing/);
  assert.equal(await readFile(vaultPath(box), "utf8"), original);
  assert.deepEqual(await box.bwCalls(), []);
});

const defaultBwDir = (box: Sandbox) => process.platform === "darwin"
  ? join(box.env.HOME, "Library", "Application Support", "Bitwarden CLI")
  : join(box.env.HOME, ".config", "Bitwarden CLI");
async function plantBwLogin(dir: string, account: string | null): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "data.json"), JSON.stringify({ global_account_activeAccountId: account }));
}

test("machines that used bw keep it as the default; a new machine writes its choice down", { skip: process.platform === "win32" }, async () => {
  const at = (box: Sandbox, name: string) => join(box.configDir, name);
  const signals: Array<[string, (box: Sandbox) => Promise<unknown>, Record<string, string>?]> = [
    ["keychain master password", (box) => writeFile(join(box.dir, "keychain", "vaultwarden-master-password"), "master\n")],
    ["keychain API key", (box) => writeFile(join(box.dir, "keychain", "vaultwarden-api-client-id"), "user.x\n")],
    ["BW_SESSION", async () => {}, { BW_SESSION: "fake-session" }],
    ["auth.json shell form", (box) => writeAuth(box, { GH_TOKEN: { type: "api_key", key: "!bw get password 'GitHub'" } })],
    ["auth.json provider bw:// ref", (box) => writeAuth(box, { anthropic: { type: "api_key", key: "bw://Anthropic" } })],
    ["master password verifier", async (box) => { await mkdir(box.configDir, { recursive: true }); await writeFile(at(box, "master-password.scrypt"), "scrypt$x\n"); }],
    ["audit log", async (box) => { await mkdir(box.configDir, { recursive: true }); await writeFile(at(box, "audit.jsonl"), "{}\n"); }],
    ["redact index", async (box) => { await mkdir(box.configDir, { recursive: true }); await writeFile(at(box, "redact-index.json"), '{"v":1,"entries":[]}\n'); }],
    ["own bw login", async (box) => { await mkdir(at(box, "bw"), { recursive: true }); await writeFile(at(box, join("bw", "data.json")), "{}"); }],
    ["bw logged in", (box) => plantBwLogin(defaultBwDir(box), "user-1")],
    ["bw logged in (BITWARDENCLI_APPDATA_DIR)", (box) => plantBwLogin(join(box.dir, "bwdata"), "user-1"), { BITWARDENCLI_APPDATA_DIR: "<box>/bwdata" }],
  ];
  for (const [label, plant, env = {}] of signals) {
    const box = await blank();
    await plant(box);
    const extra = Object.fromEntries(Object.entries(env).map(([name, value]) => [name, value.replace("<box>", box.dir)]));
    const status = await runCli(box, ["status"], undefined, extra);
    assert.match(status.stdout, /^server=/m, `${label}: ${status.stdout}`);
    assert.ok(!existsSync(vaultPath(box)), label);
    assert.equal(await readFile(at(box, "backend"), "utf8"), "bw\n", label);
  }
  // Written down: bw stays the default once the signal is gone.
  const once = await blank();
  await runCli(once, ["status"], undefined, { BW_SESSION: "fake-session" });
  assert.match((await runCli(once, ["status"])).stdout, /^server=/m);
  // A bw that is logged out is no signal.
  const loggedOut = await blank();
  await plantBwLogin(defaultBwDir(loggedOut), null);
  assert.match((await runCli(loggedOut, ["status"])).stdout, /^backend=local/m);

  const box = await blank();
  assert.match((await runCli(box, ["status"])).stdout, /^backend=local vault=none/m);
  assert.equal(await readFile(at(box, "backend"), "utf8"), "local\n");
  // Traces written later (the hook's index, a bw session) no longer flip it.
  await writeFile(at(box, "redact-index.json"), '{"v":1,"entries":[]}\n');
  assert.match((await runCli(box, ["status"], undefined, { BW_SESSION: "fake-session" })).stdout, /^backend=local/m);
  await writeFile(at(box, "backend"), "bw\n");
  assert.match((await runCli(box, ["status"])).stdout, /^server=/m);
  assert.match((await runCli(box, ["status"], undefined, { KEYSHROUD_BACKEND: "local" })).stdout, /^backend=local/m);
});

test("lock in another process reaches a live MCP server on bw too", async () => {
  const box = await sandbox([item("id-1", "Item A", "value-bbbb-2222")]);
  await writeAuth(box, { A_TOKEN: "bw://Item A" });
  const server = mcpServer(box);
  try {
    assert.match(await server.call("secrets_run", { command: "echo \"[$A_TOKEN]\"" }), /\[<redacted:A_TOKEN>\]/);
    await unlink(join(box.dir, "keychain", "vaultwarden-master-password"));
    assert.equal((await runCli(box, ["lock"])).stdout, "locked\n");
    const after = await server.call("secrets_run", { command: "echo \"[${A_TOKEN:-unset}]\"" });
    assert.match(after, /unresolved: A_TOKEN/);
    assert.match(after, /\[unset\]/);
  } finally { server.close(); }
});

test("a bw session from the environment ends with keyshroud's own session, or when bw says so", async () => {
  const box = await sandbox([item("id-1", "Item A", "value-bbbb-2222")]);
  await writeAuth(box, { A_TOKEN: "bw://Item A" });
  const run = (server: ReturnType<typeof mcpServer>) => server.call("secrets_run", { command: "echo \"[${A_TOKEN:-unset}]\"" });
  // keyshroud's own session, inherited (as by a process keyshroud started): its end is the token's.
  assert.equal((await runCli(box, ["get", "A_TOKEN"], undefined, { KEYSHROUD_SESSION_TTL_MS: "5000" })).stdout, "value-bbbb-2222");
  await unlink(join(box.dir, "keychain", "vaultwarden-master-password"));
  const [token, expires] = (await readFile(join(box.configDir, "session"), "utf8")).split("\n");
  const own = mcpServer(box, { BW_SESSION: token });
  try {
    assert.match(await run(own), /\[<redacted:A_TOKEN>\]/);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(expires.slice("expires=".length)) + 300 - Date.now())));
    assert.match(await run(own), /unresolved: A_TOKEN[^]*\[unset\]/);
  } finally { own.close(); }
  // Someone else's session (no session file): bw is asked on every use, so its lock ends it here too.
  await writeFile(box.vaultFile, JSON.stringify({ ...(await box.vault()), status: "unlocked" }));
  const theirs = mcpServer(box, { BW_SESSION: token });
  try {
    assert.match(await run(theirs), /\[<redacted:A_TOKEN>\]/);
    assert.equal((await runCli(box, ["lock"])).stdout, "locked\n");
    assert.match(await run(theirs), /unresolved: A_TOKEN[^]*\[unset\]/);
  } finally { theirs.close(); }
  // A process keyshroud starts gets the caller's token, never a copy of keyshroud's own session.
  await writeFile(join(box.dir, "keychain", "vaultwarden-master-password"), "master\n");
  const env = await runScript(box, `
    const core = await import(${CORE});
    process.env.BW_SESSION = "from-the-caller";
    const before = core.ownProcessEnv().BW_SESSION;
    await core.ensureBwSession();
    console.log(before, process.env.BW_SESSION === "from-the-caller", core.ownProcessEnv().BW_SESSION);
  `);
  assert.equal(env, "from-the-caller false undefined\n");
});

for (const stage of ["writeFile", "rename"]) test(`a writer of env.json paused past 30 s before its ${stage} never replaces what its successor wrote`, async () => {
  const box = await blank();
  assert.equal((await add(box, "A_TOKEN", "Item A", "first-value-123")).code, 0);
  const envJson = join(box.configDir, "env.json");
  const out = await runScript(box, `${PATCH_FS}
    let stalled = false;
    patch(${JSON.stringify(stage)}, async (real, file, ...rest) => {
      if (!stalled && String(file).includes("env.json.lock/pending.")) {
        stalled = true;
        const old = new Date(Date.now() - 40000);
        await fsp.utimes(${JSON.stringify(`${envJson}.lock`)}, old, old);
        require("node:child_process").execFileSync(${JSON.stringify(NODE)}, [${JSON.stringify(CLI)}, "wire", "--env", "B_TOKEN", "--item", "Item A"], { stdio: "ignore" });
      }
      return real(file, ...rest);
    });
    const core = await import(${CORE});
    await core.writeAuthEntry(${JSON.stringify(envJson)}, "C_TOKEN", core.referenceFor("Item A", "local")).then(() => console.log("written"), (error) => console.log(error.message));
  `);
  assert.match(out, /lost the lock of .*env\.json .*nothing was written/);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(envJson, "utf8"))).sort(), ["A_TOKEN", "B_TOKEN"]);
  assert.deepEqual((await readdir(box.configDir)).filter((name) => /\.lock$|\.tmp\./.test(name)), []);
});

test("a writer of the hook index paused past 30 s never replaces what its successor wrote", async () => {
  const box = await blank();
  const index = join(box.configDir, "redact-index.json");
  const successor = `const core = await import(${CORE}); await core.writeRedactIndex({ NEXT: "next-value-0123456789" });`;
  const out = await runScript(box, `${PATCH_FS}
    let stalled = true;
    patch("writeFile", async (real, file, ...rest) => {
      if (!stalled && String(file).includes("redact-index.json.lock/pending.")) {
        stalled = true;
        const old = new Date(Date.now() - 40000);
        await fsp.utimes(${JSON.stringify(`${index}.lock`)}, old, old);
        require("node:child_process").execFileSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(successor)}], { stdio: "ignore" });
      }
      return real(file, ...rest);
    });
    const core = await import(${CORE});
    await core.writeRedactIndex({ FIRST: "first-value-0123456789" });
    stalled = false;
    await core.writeRedactIndex({ STALE: "stale-value-0123456789" }).then(() => console.log("written"), (error) => console.log(error.message));
  `);
  assert.match(out, /lost the lock of .*redact-index\.json .*nothing was written/);
  const post = await runCli(box, ["hook", "claude", "post-tool-use"], JSON.stringify({ tool_response: { stdout: "first-value-0123456789 next-value-0123456789 stale-value-0123456789" } }));
  assert.equal(JSON.parse(post.stdout).hookSpecificOutput.updatedToolOutput.stdout, "<redacted:FIRST> <redacted:NEXT> stale-value-0123456789");
  assert.deepEqual((await readdir(box.configDir)).filter((name) => /\.lock$|\.tmp\./.test(name)), []);
});

test("two links to one auth file share a lock: writers through either keep each other's entries", async () => {
  const box = await blank();
  const real = join(box.dir, "real-auth.json");
  await writeFile(real, "{}");
  const links = [join(box.dir, "a", "auth.json"), join(box.dir, "b", "auth.json")];
  for (const link of links) { await mkdir(dirname(link)); await symlink(real, link); }
  const out = await runScript(box, `
    const core = await import(${CORE});
    const links = ${JSON.stringify(links)};
    const ref = core.referenceFor("Item A", "local");
    const written = await Promise.all(Array.from({ length: 8 }, (_, i) => core.writeAuthEntry(links[i % 2], "T" + i, ref)));
    const twice = await Promise.all(links.map((link) => core.writeAuthEntry(link, "SAME", ref)));
    console.log(JSON.stringify([...written, ...twice].map((result) => result.ok)));
  `);
  assert.deepEqual(JSON.parse(out || "null"), Array(10).fill(true));
  assert.deepEqual(Object.keys(JSON.parse(await readFile(real, "utf8"))).sort(), ["SAME", ...Array.from({ length: 8 }, (_, i) => `T${i}`)]);
  for (const link of links) assert.ok((await lstat(link)).isSymbolicLink());
  for (const dir of [box.dir, ...links.map((link) => dirname(link))]) assert.deepEqual((await readdir(dir)).filter((name) => /\.lock$|\.tmp\./.test(name)), []);
});

// The two ways pi locks auth.json (proper-lockfile, which removes a stale lock with rmdir): pi 1.5
// beside the file the path leads to, pi 1.2 and older beside the path as it is spelled.
const PI_BACKEND = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js", import.meta.url).href;
const PROPER_LOCKFILE = new URL("../node_modules/proper-lockfile/index.js", import.meta.url).href;
const piWrites = (auth: string) => `
  const { FileAuthStorageBackend } = await import(${JSON.stringify(PI_BACKEND)});
  const add = async (current) => ({ result: null, next: JSON.stringify({ ...JSON.parse(current || "{}"), anthropic: { type: "api_key", key: "from-pi" } }) });
  await new FileAuthStorageBackend(${JSON.stringify(auth)}).withLockAsync(add).then(() => console.log("pi wrote"), (error) => console.log("pi failed: " + error.code));
`;
const oldPiWrites = (auth: string) => `
  const fs = await import("node:fs");
  const lockfile = (await import(${JSON.stringify(PROPER_LOCKFILE)})).default;
  const auth = ${JSON.stringify(auth)};
  const release = await lockfile.lock(auth, { realpath: false, retries: 0, stale: 30000 }).catch((error) => { console.log("old pi failed: " + error.code); });
  if (release) {
    fs.writeFileSync(auth, JSON.stringify({ ...JSON.parse(fs.readFileSync(auth, "utf8") || "{}"), openai: { type: "api_key", key: "from-old-pi" } }));
    await release();
    console.log("old pi wrote");
  }
`;

test("a writer paused before its rename is voided by the next writer through another link, and by then an old pi through the first", async () => {
  const box = await blank();
  const real = join(box.dir, "real-auth.json");
  await writeFile(real, "{}");
  const links = [join(box.dir, "a", "auth.json"), join(box.dir, "b", "auth.json")];
  for (const link of links) { await mkdir(dirname(link)); await symlink(real, link); }
  const ref = `core.referenceFor("Item A", "local")`;
  const next = (link: string, name: string) => `const core = await import(${CORE}); await core.writeAuthEntry(${JSON.stringify(link)}, ${JSON.stringify(name)}, ${ref});`;
  const out = await runScript(box, `${PATCH_FS}
    const run = (script) => process.stdout.write(require("node:child_process").execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: "/" }));
    let stalled = false;
    patch("rename", async (real, from, to) => {
      if (!stalled && /auth\\.json\\.lock\\/via\\/pending\\./.test(String(from))) {
        stalled = true;
        const old = new Date(Date.now() - 40000);
        for (const lock of ${JSON.stringify([`${real}.lock`, `${links[0]}.lock`])}) await fsp.utimes(lock, old, old);
        // An old pi through the same link meets the lock beside it and cannot break it...
        run(${JSON.stringify(oldPiWrites(links[0]))});
        run(${JSON.stringify(next(links[1], "B_TOKEN"))});
        // ...nor after a writer through the other link, which leaves that lock alone; one through
        // this link takes it over, and by then nothing waits to be renamed.
        run(${JSON.stringify(oldPiWrites(links[0]))});
        run(${JSON.stringify(next(links[0], "D_TOKEN"))});
        run(${JSON.stringify(oldPiWrites(links[0]))});
      }
      return real(from, to);
    });
    const core = await import(${CORE});
    // A relative path, and next writers started in another directory.
    process.chdir(${JSON.stringify(box.dir)});
    await core.writeAuthEntry("a/auth.json", "A_TOKEN", ${ref}).then(() => console.log("written"), (error) => console.log(error.message));
  `);
  assert.match(out, /^old pi failed: ENOTEMPTY\nold pi failed: ENOTEMPTY\nold pi wrote\nThis process lost the lock of .*auth\.json .*nothing was written\n$/);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(real, "utf8"))), ["B_TOKEN", "D_TOKEN", "openai"]);
  for (const link of links) assert.ok((await lstat(link)).isSymbolicLink());
  for (const dir of [box.dir, ...links.map((link) => dirname(link))]) assert.deepEqual((await readdir(dir)).filter((name) => /\.lock$|\.tmp\./.test(name)), []);
});

for (const linked of [false, true]) test(`pi's auth writer cannot break the lock of a paused keyshroud writer${linked ? " through a link" : ""}; a lock left by a killed one is cleared`, async () => {
  const box = await blank();
  assert.equal((await add(box, "A_TOKEN", "Item A", "first-value-123")).code, 0);
  const auth = join(box.env.HOME, ".pi", "agent", "auth.json");
  const real = linked ? join(box.dir, "real-auth.json") : auth;
  await mkdir(dirname(auth), { recursive: true });
  await writeFile(real, "{}");
  if (linked) await symlink(real, auth);
  const pi = piWrites(auth);
  const out = await runScript(box, `${PATCH_FS}
    let stalled = false;
    patch("rename", async (real, from, to) => {
      if (!stalled && /auth\\.json\\.lock\\/(via\\/)?pending\\./.test(String(from))) {
        stalled = true;
        const old = new Date(Date.now() - 40000);
        for (const lock of ${JSON.stringify([...new Set([`${real}.lock`, `${auth}.lock`])])}) await fsp.utimes(lock, old, old);
        for (const script of ${JSON.stringify([pi, oldPiWrites(auth)])}) process.stdout.write(require("node:child_process").execFileSync(process.execPath, ["--input-type=module", "-e", script]));
      }
      return real(from, to);
    });
    const core = await import(${CORE});
    await core.writeAuthEntry(${JSON.stringify(auth)}, "C_TOKEN", core.referenceFor("Item A", "local")).then(() => console.log("written"), (error) => console.log(error.message));
  `);
  assert.equal(out, "pi failed: ENOTEMPTY\nold pi failed: ENOTEMPTY\nwritten\n");
  assert.deepEqual(Object.keys(JSON.parse(await readFile(real, "utf8"))), ["C_TOKEN"]);

  await mkdir(`${real}.lock`);
  await writeFile(join(`${real}.lock`, "owner"), "a-killed-writer");
  const old = new Date(Date.now() - 40000);
  await utimes(join(`${real}.lock`, "owner"), old, old);
  await utimes(`${real}.lock`, old, old);
  assert.equal(await runScript(box, pi), "pi failed: ENOTEMPTY\n");
  assert.equal((await runCli(box, ["env"])).code, 0);
  assert.equal(await runScript(box, pi), "pi wrote\n");
  assert.deepEqual(Object.keys(JSON.parse(await readFile(real, "utf8"))), ["C_TOKEN", "anthropic"]);
  assert.equal((await lstat(auth)).isSymbolicLink(), linked);
  for (const dir of new Set([dirname(auth), dirname(real)])) assert.deepEqual((await readdir(dir)).filter((name) => /\.lock$|\.tmp\./.test(name)), []);
});

// However a lock of auth.json went (a command acting on an old reading of it, say), a pi that
// locks there can take it from then on: the paused writer's rename must have nothing left to move.
// Through a link there are two (beside the file, where pi 1.5 locks; beside the link, where older ones do).
for (const gone of ["plain", "target", "link"]) test(`once a lock of auth.json is gone (${gone}), a writer paused before its rename replaces nothing, whatever removed it`, async () => {
  const box = await blank();
  assert.equal((await add(box, "A_TOKEN", "Item A", "first-value-123")).code, 0);
  const auth = join(box.env.HOME, ".pi", "agent", "auth.json");
  const real = gone === "plain" ? auth : join(box.dir, "real-auth.json");
  await mkdir(dirname(auth), { recursive: true });
  await writeFile(real, "{}");
  if (gone !== "plain") await symlink(real, auth);
  const out = await runScript(box, `${PATCH_FS}
    let stalled = false;
    patch("rename", async (real, from, to) => {
      if (!stalled && /auth\\.json\\.lock\\/(via\\/)?pending\\./.test(String(from))) {
        stalled = true;
        fs.rmSync(${JSON.stringify(`${gone === "link" ? auth : real}.lock`)}, { recursive: true });
        process.stdout.write(require("node:child_process").execFileSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(gone === "link" ? oldPiWrites(auth) : piWrites(auth))}]));
      }
      return real(from, to);
    });
    const core = await import(${CORE});
    await core.writeAuthEntry(${JSON.stringify(auth)}, "C_TOKEN", core.referenceFor("Item A", "local")).then(() => console.log("written"), (error) => console.log(error.message));
  `);
  assert.match(out, /^(old )?pi wrote\nThis process lost the lock of .*auth\.json .*nothing was written\n$/);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(real, "utf8"))), [gone === "link" ? "openai" : "anthropic"]);
  for (const dir of new Set([dirname(auth), dirname(real)])) assert.deepEqual((await readdir(dir)).filter((name) => /\.lock$|\.tmp\./.test(name)), []);
});

test("a passphrase protects the vault where there is no keychain; lock and the session's end close it, in a live MCP server too", { skip: process.platform === "win32" }, async () => {
  const box = await blank();
  const env = { KEYSHROUD_VAULT_KEY: "passphrase" };
  const agent = await add(box, "A_TOKEN", "Item A", "value-aaaa-1111", env);
  assert.equal(agent.code, 3);
  assert.match(agent.stderr, /run `keyshroud unlock` in a terminal to create it/);
  assert.ok(!existsSync(vaultPath(box)));
  const short = await runCliTtySteps(box, ["unlock"], [["New passphrase", "too short"]], env);
  assert.match(short.stdout, /at least 12 characters; nothing was created/);
  const differ = await runCliTtySteps(box, ["unlock"], [["New passphrase", PASS], ["Repeat it", `${PASS}!`]], env);
  assert.match(differ.stdout, /differ; nothing was created/);
  assert.ok(!existsSync(vaultPath(box)));

  const created = await runCliTtySteps(box, ["unlock"], [["New passphrase", PASS], ["Repeat it", PASS]], env);
  assert.equal(created.code, 0, created.stdout);
  assert.match(created.stdout, /created the local vault .*it opens with your passphrase; sessions end after 30 minutes/);
  assert.match(created.stdout, /unlocked until/);
  assert.ok(!created.stdout.includes(PASS));
  assert.equal(JSON.parse(await readFile(vaultPath(box), "utf8")).key.type, "passphrase");
  assert.deepEqual(await keyEntries(box), []);

  assert.equal((await add(box, "A_TOKEN", "Item A", "value-aaaa-1111", env)).code, 0);
  assert.equal((await runCli(box, ["get", "A_TOKEN"], undefined, env)).stdout, "value-aaaa-1111");
  const phished = await add(box, "P_TOKEN", "Phished", PASS, env);
  assert.match(phished.stderr, /passphrase of the local vault/);

  const server = mcpServer(box, env);
  try {
    assert.match(await server.call("secrets_run", { command: "echo \"[$A_TOKEN]\"" }), /\[<redacted:A_TOKEN>\]/);
    assert.equal((await runCli(box, ["lock"], undefined, env)).stdout, "locked\n");
    // Session files made without the vault's key (anyone can write them) open nothing, not even
    // the vault this server still holds in memory, and are removed.
    const secret = randomBytes(32);
    const forged = sealSession(JSON.parse(await readFile(vaultPath(box), "utf8")).id, null, secret, randomBytes(32));
    await writeFile(join(box.configDir, "vault.session"), `${JSON.stringify(forged)}\n`);
    await writeFile(join(box.configDir, "vault.token"), `${forged.id} ${secret.toString("hex")}\n`);
    const after = await server.call("secrets_run", { command: "echo \"[$A_TOKEN]\"" });
    assert.ok(!existsSync(join(box.configDir, "vault.session")));
    assert.match(after, /unresolved: A_TOKEN \(The local vault is locked/);
    assert.doesNotMatch(after, /value-aaaa-1111/);
    assert.match(await server.call("vault_status"), /^status=locked backend=local/);
    // Nor does a vault file edited to name a key that needs no session and given back its size
    // and mtime: what the server holds was opened with a session, and is those bytes only.
    const vault = vaultPath(box);
    assert.equal((await runCli(box, ["get", "A_TOKEN"], undefined, { ...env, DISPLAY: ":0", FAKE_DIALOG_VALUE: PASS })).stdout, "value-aaaa-1111");
    const at = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
    await utimes(vault, at, at);
    assert.match(await server.call("secrets_run", { command: "echo \"[$A_TOKEN]\"" }), /\[<redacted:A_TOKEN>\]/);
    assert.equal((await runCli(box, ["lock"], undefined, env)).stdout, "locked\n");
    const sealed = await readFile(vault, "utf8");
    const header = JSON.parse(sealed);
    const edited = JSON.stringify({ ...header, key: { type: "keychain", service: `keyshroud-vault-${header.id}` } });
    assert.ok(edited.length <= sealed.length);
    await writeFile(vault, edited.padEnd(sealed.length), { flag: "r+" });
    await utimes(vault, at, at);
    const swapped = await server.call("secrets_run", { command: "echo \"[$A_TOKEN]\"" });
    assert.match(swapped, /unresolved: A_TOKEN/);
    assert.doesNotMatch(swapped, /value-aaaa-1111/);
    await writeFile(vault, sealed);
  } finally { server.close(); }

  const wrong = await runCli(box, ["get", "A_TOKEN"], undefined, { ...env, DISPLAY: ":0", FAKE_DIALOG_VALUE: "not the passphrase" });
  assert.equal(wrong.code, 4);
  assert.match(wrong.stderr, /Wrong passphrase/);
  const dialog = await runCli(box, ["get", "A_TOKEN"], undefined, { ...env, DISPLAY: ":0", FAKE_DIALOG_VALUE: PASS, KEYSHROUD_SESSION_TTL_MS: "3000" });
  assert.equal(dialog.stdout, "value-aaaa-1111", dialog.stderr);
  assert.match((await runCli(box, ["status"], undefined, env)).stdout, /key=passphrase status=unlocked items=1/);
  await new Promise((resolve) => setTimeout(resolve, 3300));
  const ended = await runCli(box, ["get", "A_TOKEN"], undefined, env);
  assert.equal(ended.code, 4);
  assert.match(ended.stderr, /local vault is locked/);
  assert.ok(!existsSync(join(box.configDir, "vault.session")));
  assert.deepEqual(await box.bwCalls(), []);
});

const FAKE_POWERSHELL = `#!/usr/bin/env node
// Fake Windows PowerShell running keyshroud's DPAPI script: "protects" by tagging with the entropy.
const fs = require("node:fs");
const args = process.argv.slice(2);
const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
const input = fs.readFileSync(0, "utf8").trim();
const entropy = process.env.KEYSHROUD_VAULT_ID;
if (process.env.FAKE_DPAPI_DENIED) { process.stderr.write("Exception calling \\"Unprotect\\": \\"Access is denied.\\""); process.exit(1); }
if (script.includes("::Protect(")) process.stdout.write(Buffer.from("fake-dpapi|" + entropy + "|" + input).toString("base64"));
else {
  const [tag, id, key] = Buffer.from(input, "base64").toString().split("|");
  if (tag !== "fake-dpapi" || id !== entropy) process.exit(1);
  process.stdout.write(key);
}
`;

test("Windows keeps the key with DPAPI (a fake PowerShell here), entropy bound to the vault id", { skip: process.platform === "win32" }, async () => {
  const box = await blank();
  const root = join(box.dir, "win");
  const dir = join(root, "System32", "WindowsPowerShell", "v1.0");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "powershell.exe"), FAKE_POWERSHELL, { mode: 0o755 });
  const env = { SystemRoot: root, KEYSHROUD_VAULT_KEY: "dpapi" };
  const added = await add(box, "D_TOKEN", "Item D", "dpapi-value-1234", env);
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stderr, /protected by Windows DPAPI for your account/);
  const file = JSON.parse(await readFile(vaultPath(box), "utf8"));
  assert.equal(file.key.type, "dpapi");
  assert.equal((await runCli(box, ["get", "D_TOKEN"], undefined, env)).stdout, "dpapi-value-1234");
  assert.equal((await runCli(box, ["unlock"], undefined, env)).stdout, "the local vault opens with its key from Windows DPAPI; nothing to unlock\n");
  assert.deepEqual(await keyEntries(box), []);
  // Over a key-based SSH login Windows refuses DPAPI: say so, not that the vault belongs to someone else.
  const ssh = await runCli(box, ["get", "D_TOKEN"], undefined, { ...env, SSH_CONNECTION: "10.0.0.2 50000 10.0.0.1 22", FAKE_DPAPI_DENIED: "1" });
  assert.equal(ssh.code, 4, ssh.stderr);
  assert.match(ssh.stderr, /refused DPAPI to this SSH session/);
  assert.match(ssh.stderr, /keyshroud rekey --to passphrase/);
  // A blob moved to another vault does not open it.
  const other = { ...file, id: "0123456789abcdef" };
  await writeFile(vaultPath(box), JSON.stringify(other));
  assert.match((await runCli(box, ["get", "D_TOKEN"], undefined, env)).stderr, /DPAPI|integrity/);
});

test("MCP on a blank machine: instructions, vault_status and secrets_request use the local vault", async () => {
  const box = await blank();
  const server = mcpServer(box, { DISPLAY: ":0", FAKE_DIALOG_VALUE: "mcp-value-98765" });
  try {
    assert.match(await server.initialize(), /^Secrets live in the user's local keyshroud vault\./);
    assert.match(await server.call("vault_status"), /^status=empty backend=local vault=none/);
    const created = await server.call("secrets_request", { env_name: "MCP_TOKEN", item_name: "MCP token" });
    assert.match(created, /created the local vault/);
    assert.match(created, /created item=MCP token env=MCP_TOKEN verified=yes/);
    assert.match(await server.call("vault_status"), /^status=unlocked backend=local vault=.* key=keychain items=1/);
  } finally { server.close(); }
  assert.equal((await runCli(box, ["get", "MCP_TOKEN"])).stdout, "mcp-value-98765");
  assert.deepEqual(await box.bwCalls(), []);
});

// Touch ID vaults: the fake xcode-select/xcrun "build" test/fixtures/touchid-helper, a software
// P-256 key stands in for the Secure Enclave, and every operation and reason goes to dialog.log.
async function touchIdBox() {
  const box = await blank();
  const log = join(box.dir, "dialog.log");
  await writeFile(log, "");
  const env = { KEYSHROUD_VAULT_KEY: "secure-enclave", FAKE_DIALOG_LOG: log, FAKE_DIALOG_VALUE: "ok" };
  const lines = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean);
  const count = async (prefix: string) => (await lines()).filter((line) => line.startsWith(prefix)).length;
  return { box, env, log, lines, count };
}
const OPEN_REASON = "touchid|agree|open the keyshroud vault for 30 minutes";
const sessionFiles = (box: Sandbox) => ["vault.session", "vault.token"].map((name) => join(box.configDir, name));

test("a Touch ID vault: created with one approval, opens for a session, declines cool down, never asks from SSH or hooks", { skip: process.platform === "win32" }, async () => {
  const { box, env, lines, count } = await touchIdBox();
  const added = await add(box, "A_TOKEN", "A", "value-aaaa-1111", env);
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stderr, /building the Touch ID helper/);
  assert.match(added.stderr, /created the local vault .*it opens with Touch ID \(or your Mac's password\) on this Mac only; sessions end after 30 minutes/);
  const log = await lines();
  assert.match(log[0], /^xcrun\|swiftc -O -swift-version 5 -o /);
  assert.deepEqual(log.slice(1), ["touchid|create|", "touchid|agree|turn on Touch ID for the keyshroud vault"]);
  const file = JSON.parse(await readFile(vaultPath(box), "utf8"));
  assert.equal(file.v, 2);
  assert.deepEqual(Object.keys(file.key), ["type", "handle", "pub", "epk", "nonce", "wrapped"]);
  assert.deepEqual(await keyEntries(box), []);
  assert.match((await runCli(box, ["status"], undefined, env)).stdout, /key=secure-enclave status=unlocked items=1/);
  const masked = await runCli(box, ["run", "--", "sh", "-c", "echo \"[$A_TOKEN]\""], undefined, env);
  assert.equal(masked.stdout, "[<redacted:A_TOKEN>]\n", masked.stderr);
  assert.equal((await lines()).length, 3);

  assert.equal((await runCli(box, ["lock"], undefined, env)).stdout, "locked\n");
  const locked = await runCli(box, ["status"], undefined, env);
  assert.equal(locked.code, 3);
  assert.match(locked.stdout, /key=secure-enclave status=locked/);
  const reopened = await runCli(box, ["get", "A_TOKEN"], undefined, env);
  assert.equal(reopened.stdout, "value-aaaa-1111", reopened.stderr);
  assert.equal(await count(OPEN_REASON), 1);
  assert.equal(await count("xcrun|"), 1);
  assert.equal((await runCli(box, ["get", "A_TOKEN"], undefined, env)).stdout, "value-aaaa-1111");
  assert.equal(await count(OPEN_REASON), 1, "the session serves the next call");
  await runCli(box, ["lock"], undefined, env);
  assert.match((await runCli(box, ["unlock"], undefined, env)).stdout, /^unlocked until /);
  assert.equal(await count(OPEN_REASON), 2);

  await runCli(box, ["lock"], undefined, env);
  const declined = await runCli(box, ["get", "A_TOKEN"], undefined, { ...env, FAKE_DIALOG_VALUE: "", FAKE_DIALOG_CANCEL: "1" });
  assert.equal(declined.code, 4);
  assert.match(declined.stderr, /Cancelled/);
  assert.ok(sessionFiles(box).every((path) => !existsSync(path)));
  const cooling = await runCli(box, ["get", "A_TOKEN"], undefined, env);
  assert.match(cooling.stderr, /The last dialog was cancelled; wait 30 seconds/);
  assert.equal(await count(OPEN_REASON), 3, "no sheet during the cooldown");
  await unlink(join(box.configDir, "dialog.lock"));

  const nobody = await runCli(box, ["get", "A_TOKEN"], undefined, { ...env, FAKE_DIALOG_VALUE: "" });
  assert.match(nobody.stderr, /nobody can be asked from here/);
  const before = (await lines()).length;
  const ssh = await runCli(box, ["get", "A_TOKEN"], undefined, { ...env, SSH_CONNECTION: "x" });
  assert.match(ssh.stderr, /nobody can be asked from here/);
  assert.equal((await lines()).length, before, "nothing runs over SSH");

  const hook = await runCli(box, ["hook", "claude", "session-start"], "{}", env);
  assert.match(hook.stdout, /opens with Touch ID/);
  const doctor = await runCli(box, ["doctor"], undefined, env);
  assert.match(doctor.stdout, /touchid helper=built/);
  assert.equal((await lines()).length, before, "hooks and doctor never ask");

  const server = mcpServer(box, env);
  try {
    assert.match(await server.call("vault_status"), /status=locked/);
    assert.match(await server.call("secrets_list"), /A_TOKEN/);
    assert.equal((await lines()).length, before);
    assert.match(await server.call("secrets_run", { command: "echo \"[$A_TOKEN]\"" }), /\[<redacted:A_TOKEN>\]/);
    assert.equal(await count(OPEN_REASON), 5);
  } finally { server.close(); }
  assert.deepEqual(await box.bwCalls(), []);
});

test("Touch ID: parallel callers share one sheet; build, enclave and key failures are named", { skip: process.platform === "win32" }, async () => {
  const { box, env, count } = await touchIdBox();
  assert.equal((await add(box, "A_TOKEN", "A", "value-aaaa-1111", env)).code, 0);
  await runCli(box, ["lock"], undefined, env);
  const slow = { ...env, FAKE_TOUCHID_DELAY_MS: "1500" };
  const runs = await Promise.all([1, 2, 3].map(() => runCli(box, ["run", "--", "sh", "-c", "test -n \"$A_TOKEN\""], undefined, slow)));
  assert.deepEqual(runs.map((run) => run.code), [0, 0, 0], runs.map((run) => run.stderr).join("\n"));
  assert.equal(await count(OPEN_REASON), 1);

  // A lock file another process has created but not yet written is held, not stale.
  await runCli(box, ["lock"], undefined, env);
  await writeFile(join(box.configDir, "dialog.lock"), "", { mode: 0o600 });
  const taken = await runCliTtySteps(box, ["unlock", "--unattended"], [], env);
  assert.match(taken.stdout, /Another keyshroud dialog is already open/);
  assert.equal(await count(OPEN_REASON), 1);
  await unlink(join(box.configDir, "dialog.lock"));

  await runCli(box, ["lock"], undefined, env);
  await chmod(join(box.configDir, "touchid"), 0o700);
  for (const dir of await readdir(join(box.configDir, "touchid"))) for (const name of await readdir(join(box.configDir, "touchid", dir))) await unlink(join(box.configDir, "touchid", dir, name));
  assert.equal((await runCli(box, ["get", "A_TOKEN"], undefined, env)).code, 0);
  assert.equal(await count("xcrun|"), 2, "a missing helper is built again");

  await runCli(box, ["lock"], undefined, env);
  for (const name of (await readdir(join(box.dir, "keychain"))).filter((name) => name.startsWith("se-"))) await unlink(join(box.dir, "keychain", name));
  const foreign = await runCli(box, ["get", "A_TOKEN"], undefined, env);
  assert.match(foreign.stderr, /does not work on this Mac/);

  const fresh = await touchIdBox();
  const noTools = await add(fresh.box, "A_TOKEN", "A", "v", { ...fresh.env, FAKE_NO_XCODE: "1" });
  assert.match(noTools.stderr, /needs the Xcode Command Line Tools once/);
  const noBuild = await add(fresh.box, "A_TOKEN", "A", "v", { ...fresh.env, FAKE_SWIFTC_FAIL: "1" });
  assert.match(noBuild.stderr, /Could not build the Touch ID helper/);
  const noEnclave = await add(fresh.box, "A_TOKEN", "A", "v", { ...fresh.env, FAKE_NO_ENCLAVE: "1" });
  assert.match(noEnclave.stderr, /needs a Mac with a Secure Enclave/);
  const bogus = await add(fresh.box, "A_TOKEN", "A", "v", { KEYSHROUD_VAULT_KEY: "bogus" });
  assert.match(bogus.stderr, /KEYSHROUD_VAULT_KEY=bogus: use keychain, dpapi, passphrase or secure-enclave/);
  assert.ok(!existsSync(vaultPath(fresh.box)));
});

test("rekey moves a vault between keychain, Touch ID and a passphrase, with a new key and id each time", { skip: process.platform === "win32" }, async () => {
  const { box, env, lines, count } = await touchIdBox();
  assert.equal((await add(box, "A_TOKEN", "A", "value-aaaa-1111", { KEYSHROUD_VAULT_KEY: "keychain" })).code, 0);
  const firstId = JSON.parse(await readFile(vaultPath(box), "utf8")).id;
  assert.deepEqual(await keyEntries(box), [`keyshroud-vault-${firstId}`]);
  assert.equal((await runCli(box, ["rekey", "--to", "secure-enclave"], undefined, env)).code, 2, "terminal only");

  const toSe = await runCliTtySteps(box, ["rekey", "--to", "secure-enclave"], [], env);
  assert.equal(toSe.code, 0, toSe.stdout);
  assert.match(toSe.stdout, /rekeyed vault=.*key=keychain -> key=secure-enclave items=1/);
  const se = JSON.parse(await readFile(vaultPath(box), "utf8"));
  assert.notEqual(se.id, firstId);
  assert.equal(se.key.type, "secure-enclave");
  assert.deepEqual(await keyEntries(box), [], "the old keychain entry is gone");
  assert.equal(await count("touchid|agree|turn on Touch ID for the keyshroud vault"), 1);
  assert.equal((await runCli(box, ["get", "A_TOKEN"], undefined, env)).stdout, "value-aaaa-1111");

  const toPass = await runCliTtySteps(box, ["rekey", "--to", "passphrase"], [["New passphrase", PASS], ["Repeat it", PASS]], env);
  assert.equal(toPass.code, 0, toPass.stdout);
  assert.equal(await count("touchid|agree|move the keyshroud vault from Touch ID to a passphrase"), 1);
  assert.equal((await runCli(box, ["get", "A_TOKEN"], undefined, env)).stdout, "value-aaaa-1111");

  const before = await readFile(vaultPath(box), "utf8");
  const wrong = await runCliTtySteps(box, ["rekey", "--to", "secure-enclave"], [["Passphrase of the local vault", "not the passphrase"]], env);
  assert.match(wrong.stdout, /Wrong passphrase; nothing was changed/);
  assert.equal(await readFile(vaultPath(box), "utf8"), before);

  const back = await runCliTtySteps(box, ["rekey", "--to", "secure-enclave"], [["Passphrase of the local vault", PASS]], env);
  assert.equal(back.code, 0, back.stdout);
  const creates = await count("touchid|create|");
  const same = await runCliTtySteps(box, ["rekey"], [], env);
  assert.equal(same.code, 0, same.stdout);
  assert.equal(await count("touchid|agree|give the keyshroud vault a new key"), 1);
  assert.equal(await count("touchid|create|"), creates, "SE to SE reuses the enclave key");
  assert.equal(JSON.parse(await readFile(vaultPath(box), "utf8")).key.type, "secure-enclave");
  assert.equal((await runCli(box, ["get", "A_TOKEN"], undefined, env)).stdout, "value-aaaa-1111");
  assert.ok((await lines()).length > 0);
});

test("unlock --stdin opens an existing passphrase vault (CI, containers) but never creates one", { skip: process.platform === "win32" }, async () => {
  const box = await blank();
  const env = { KEYSHROUD_VAULT_KEY: "passphrase" };
  const none = await runCli(box, ["unlock", "--stdin"], `${PASS}\n`, env);
  assert.equal(none.code, 3);
  assert.match(none.stderr, /No local vault here: --stdin opens an existing one/);
  assert.ok(!existsSync(vaultPath(box)));

  assert.equal((await runCliTtySteps(box, ["unlock"], [["New passphrase", PASS], ["Repeat it", PASS]], env)).code, 0);
  assert.equal((await add(box, "A_TOKEN", "Item A", "value-aaaa-1111", env)).code, 0);
  assert.equal((await runCli(box, ["lock"], undefined, env)).stdout, "locked\n");
  assert.notEqual((await runCli(box, ["get", "A_TOKEN"], undefined, env)).code, 0);

  const wrong = await runCli(box, ["unlock", "--stdin"], "not the passphrase\n", env);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.stderr, /Wrong passphrase/);
  assert.equal((await runCli(box, ["unlock", "--stdin"], "", env)).code, 2);
  assert.equal((await runCli(box, ["unlock", "--stdin", "--unattended"], `${PASS}\n`, env)).code, 2);

  const ok = await runCli(box, ["unlock", "--stdin"], `${PASS}\n`, env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^unlocked until /);
  assert.ok(!ok.stdout.includes(PASS) && !ok.stderr.includes(PASS));
  assert.equal((await runCli(box, ["run", "--", "sh", "-c", 'echo "${#A_TOKEN}"'], undefined, env)).stdout, "15\n");
});

test("unlock --stdin refuses a vault whose key is not a passphrase", { skip: process.platform === "win32" }, async () => {
  const box = await blank();
  assert.equal((await add(box, "A_TOKEN", "Item A", "value-aaaa-1111")).code, 0);
  const refused = await runCli(box, ["unlock", "--stdin"], `${PASS}\n`);
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /--stdin is for a passphrase vault; this one opens with its keychain key/);
});

test("migrate --to local moves wired Vaultwarden items into the local vault and rewires their names", async () => {
  const box = await sandbox([
    item("id-1", "GitHub token", "gh-value-0001"),
    item("id-2", "Sentry", "sentry-pass-02", { fields: [{ type: 0, name: "dsn", value: "https://dsn-value-03" }] }),
    item("id-3", "Shared", "shared-value-04"),
  ]);
  await writeAuth(box, {
    GH_TOKEN: { type: "api_key", key: "!bw get password 'GitHub token'" },
    SENTRY_DSN: { type: "api_key", key: "bw://Sentry/fields/dsn" },
    A_TOKEN: { type: "api_key", key: "bw://Shared" },
    B_TOKEN: { type: "api_key", key: "bw://Shared" },
    GONE_TOKEN: { type: "api_key", key: "bw://Missing" },
  });
  const values = ["gh-value-0001", "sentry-pass-02", "dsn-value-03", "shared-value-04"];
  const dry = await runCli(box, ["migrate", "--to", "local"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /Sentry \(field dsn\)\s+copy\s+<- SENTRY_DSN/);
  assert.match(dry.stdout, /Shared\s+copy\s+<- A_TOKEN, B_TOKEN/);
  assert.match(dry.stdout, /Dry run: nothing copied/);
  assert.ok(!existsSync(vaultPath(box)));

  const moved = await runCli(box, ["migrate", "--to", "local", "--yes"]);
  assert.equal(moved.code, 4, moved.stderr);
  assert.match(moved.stdout, /moved 3 item\(s\) into the local vault and rewired 8 name\(s\)/);
  assert.match(moved.stderr, /Not moved: Missing \(unresolved in Vaultwarden\)/);
  for (const text of [dry.stdout, dry.stderr, moved.stdout, moved.stderr]) for (const value of values) assert.ok(!text.includes(value));
  assert.equal(await readFile(join(box.configDir, "backend"), "utf8"), "local\n");
  const backup = (await readdir(box.configDir)).find((name) => name.startsWith("migrate-local-"))!;
  assert.equal((await stat(join(box.configDir, backup))).mode & 0o777, 0o600);
  const saved = await readFile(join(box.configDir, backup), "utf8");
  assert.match(saved, /bw:\/\/Sentry\/fields\/dsn/);
  for (const value of values) assert.ok(!saved.includes(value));
  const auth = await readFile(join(box.env.HOME, ".pi", "agent", "auth.json"), "utf8");
  assert.match(auth, /keyshroud:\/\/Sentry \(field dsn\)/);
  assert.match(auth, /bw:\/\/Missing/);

  // Vaultwarden can go away: the moved names resolve from the local vault alone.
  await unlink(join(box.dir, "keychain", "vaultwarden-master-password"));
  const env = { KEYSHROUD_BACKEND: "local" };
  const run = await runCli(box, ["run", "--no-mask", "--only", "GH_TOKEN,SENTRY_DSN,A_TOKEN,B_TOKEN", "--", "sh", "-c", 'echo "$GH_TOKEN $SENTRY_DSN $A_TOKEN $B_TOKEN"'], undefined, env);
  assert.equal(run.stdout, "gh-value-0001 https://dsn-value-03 shared-value-04 shared-value-04\n", run.stderr);

  // A second run moves nothing new; the Missing one is still reported.
  const again = await runCli(box, ["migrate", "--to", "local", "--yes"], undefined, env);
  assert.match(again.stdout, /Missing\s+copy\s+<- GONE_TOKEN/);
  assert.doesNotMatch(again.stdout, /GitHub token/);
});

test("wiring is written to env.json, and to pi's or omp's auth.json only when installed or named", async () => {
  const box = await blank();
  const own = join(box.configDir, "env.json"), pi = join(box.env.HOME, ".pi", "agent", "auth.json"), omp = join(box.env.PI_CODING_AGENT_DIR, "auth.json");
  const names = async (path: string) => Object.keys(JSON.parse(await readFile(path, "utf8")));
  assert.equal((await add(box, "A_TOKEN", "A", "value-aaaa-1111")).code, 0);
  assert.equal((await runCli(box, ["wire", "--env", "B_TOKEN", "--item", "A", "--target", "pi"])).code, 0);
  assert.deepEqual(await names(own), ["A_TOKEN", "B_TOKEN"]);
  assert.deepEqual(await names(pi), ["B_TOKEN"]);
  assert.ok(!existsSync(omp));
  // pi is installed now, so a new name goes there without --target.
  assert.match((await runCli(box, ["wire", "--env", "C_TOKEN", "--item", "A"])).stdout, /targets=.*env\.json,.*\.pi.*auth\.json$/m);
  assert.equal((await runCli(box, ["env"])).stdout, "A_TOKEN\nB_TOKEN\nC_TOKEN\n");

  assert.match((await runCli(box, ["unwire", "--env", "B_TOKEN", "--target", "pi"])).stdout, /removed env=B_TOKEN targets=.*\.pi.*auth\.json$/m);
  assert.deepEqual(await names(own), ["A_TOKEN", "B_TOKEN", "C_TOKEN"]);
  assert.match((await runCli(box, ["unwire", "--env", "C_TOKEN"])).stdout, /removed env=C_TOKEN targets=.*env\.json,.*auth\.json$/m);
  assert.deepEqual(await names(own), ["A_TOKEN", "B_TOKEN"]);
  assert.deepEqual(await names(pi), []);
  assert.ok(!existsSync(omp), "unwire creates nothing");
  assert.equal((await runCli(box, ["run", "--", "sh", "-c", 'echo "${#A_TOKEN} ${#B_TOKEN} ${#C_TOKEN}"'])).stdout, "15 15 0\n");
});

test("list shows names and wiring; rm is a dry run until --yes, then deletes and unwires", { skip: process.platform === "win32" }, async () => {
  const box = await blank();
  // pi and omp are installed here, so their auth.json files are wired too.
  for (const dir of [join(box.env.HOME, ".pi", "agent"), box.env.PI_CODING_AGENT_DIR]) await mkdir(dir, { recursive: true });
  assert.equal((await add(box, "A_TOKEN", "A", "value-aaaa-1111")).code, 0);
  assert.equal((await add(box, "B_TOKEN", "B", "value-bbbb-2222")).code, 0);
  const list = await runCli(box, ["list"]);
  assert.equal(list.stdout, "keyshroud://A  wired=A_TOKEN\nkeyshroud://B  wired=B_TOKEN\n");
  assert.ok(!list.stdout.includes("value-"));

  const before = await readFile(vaultPath(box), "utf8");
  const dry = await runCli(box, ["rm", "--item", "A"]);
  assert.equal(dry.stdout, "would delete keyshroud://A permanently; unwire A_TOKEN\nDry run: nothing removed. Re-run with --yes.\n");
  assert.equal(await readFile(vaultPath(box), "utf8"), before);
  assert.equal((await runCli(box, ["rm", "--item", "missing"])).code, 4);

  await mkdir(join(box.env.HOME, ".claude"), { recursive: true });
  await writeFile(join(box.env.HOME, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "'node' '/x/cli.js' api-key --item 'B'" }));
  const helper = await runCli(box, ["rm", "--item", "B", "--yes"]);
  assert.equal(helper.code, 5);
  assert.match(helper.stderr, /apiKeyHelper uses keyshroud:\/\/B/);

  const agent = await runCli(box, ["rm", "--item", "A", "--yes"], undefined, { FAKE_DIALOG_CANCEL: "1" });
  if (process.platform === "darwin") { assert.equal(agent.code, 3); assert.match(agent.stderr, /Touch ID was not approved; nothing was removed/); }
  else assert.equal(agent.code, 2);
  assert.equal(await readFile(vaultPath(box), "utf8"), before);

  const removed = await runCliTtySteps(box, ["rm", "--item", "A", "--yes"], []);
  assert.equal(removed.code, 0, removed.stdout);
  assert.match(removed.stdout, /removed keyshroud:\/\/A unwired=A_TOKEN targets=.*env\.json,.*auth\.json,.*auth\.json/);
  assert.equal((await runCli(box, ["list"])).stdout, "keyshroud://B  wired=B_TOKEN\n");
  for (const path of [join(box.configDir, "env.json"), join(box.env.HOME, ".pi", "agent", "auth.json"), join(box.env.PI_CODING_AGENT_DIR, "auth.json")]) {
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path, "utf8"))), ["B_TOKEN"]);
  }
});

test("two different values under one label are both masked; the first wire makes a private config directory; a value with a NUL is not injected", async () => {
  const box = await blank();
  const wire = await runCli(box, ["wire", "--env", "A_TOKEN", "--item", "keyshroud://Item A"]);
  assert.equal(wire.code, 0, wire.stderr);
  assert.equal((await stat(box.configDir)).mode & 0o777, 0o700);
  assert.equal((await add(box, "X_TOKEN", "Item A", "value-aaaa-1111")).code, 0);
  // An item named like a wired variable, holding something else.
  assert.equal((await add(box, "B_TOKEN", "A_TOKEN", "value-bbbb-2222")).code, 0);
  assert.equal((await runCli(box, ["unwire", "--env", "B_TOKEN"])).code, 0);
  const run = await runCli(box, ["run", "--", "echo", "value-aaaa-1111", "value-bbbb-2222"]);
  assert.match(run.stdout, /^<redacted:[A-Z_]+> <redacted:A_TOKEN( \(2\))?>\n$/);
  await runCli(box, ["hook", "claude", "session-start"]);
  const post = await runCli(box, ["hook", "claude", "post-tool-use"], JSON.stringify({ tool_response: { stdout: "value-aaaa-1111 value-bbbb-2222" } }));
  assert.doesNotMatch(JSON.parse(post.stdout).hookSpecificOutput.updatedToolOutput.stdout, /value-/);

  // Any name an item can have is a label.
  assert.equal((await add(box, "P_TOKEN", "__proto__", "value-cccc-3333")).code, 0);
  assert.equal((await runCli(box, ["unwire", "--env", "P_TOKEN"])).code, 0);
  assert.equal((await runCli(box, ["run", "--", "echo", "value-cccc-3333"])).stdout, "<redacted:__proto__>\n");

  assert.equal((await add(box, "N_TOKEN", "Nul", "abc\0def-0123456789")).code, 0);
  const nul = await runCli(box, ["run", "--only", "N_TOKEN", "--", "sh", "-c", "echo \"[${N_TOKEN:-none}]\""]);
  assert.equal(nul.stdout, "[none]\n");
  assert.match(nul.stderr, /unresolved \(names only\): N_TOKEN/);
  assert.ok(!nul.stderr.includes("def-0123456789"));
});

test("neither vault's own password is stored as a secret in the other", { skip: process.platform === "win32" }, async () => {
  const box = await sandbox([]);
  const local = { KEYSHROUD_BACKEND: "local", KEYSHROUD_VAULT_KEY: "passphrase" };
  const created = await runCliTtySteps(box, ["unlock"], [["New passphrase", PASS], ["Repeat it", PASS]], local);
  assert.equal(created.code, 0, created.stdout);
  const master = await runCli(box, ["add", "--env", "P_TOKEN", "--item", "Phished", "--stdin"], "master", local);
  assert.notEqual(master.code, 0);
  assert.match(master.stderr, /Refusing to store the vault master password/);
  const passphrase = await runCli(box, ["add", "--env", "Q_TOKEN", "--item", "Phished too", "--stdin"], PASS);
  assert.notEqual(passphrase.code, 0);
  assert.match(passphrase.stderr, /passphrase of the local vault/);
  assert.equal((await box.vault()).items.length, 0);

  // A bw login that keyshroud never used (no session, no stored password, the local vault chosen):
  // its master password is tried too, and the login is left locked.
  const other = await blank();
  for (const dir of [join(other.env.HOME, "Library", "Application Support", "Bitwarden CLI"), join(other.env.HOME, ".config", "Bitwarden CLI"), join(other.env.HOME, "AppData", "Roaming", "Bitwarden CLI")]) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "data.json"), JSON.stringify({ global_account_activeAccountId: "user-1" }));
  }
  const env = { KEYSHROUD_BACKEND: "local" };
  assert.equal((await add(other, "A_TOKEN", "Item A", "value-aaaa-1111", env)).code, 0);
  const shared = await add(other, "P_TOKEN", "Phished", "master", env);
  assert.notEqual(shared.code, 0);
  assert.match(shared.stderr, /Refusing to store the vault master password/);
  assert.equal(((await other.vault()) as { status?: string }).status, "locked");
  assert.ok(!existsSync(join(other.configDir, "session")));

  // A vault that is there but cannot be asked is no leave to store the value: a bw that fails
  // for another reason than the password, a local vault file that cannot be read.
  const silent = await add(other, "S_TOKEN", "Unchecked", "some-value-123456", { ...env, FAKE_BW_UNLOCK_ERROR: "1" });
  assert.notEqual(silent.code, 0);
  assert.match(silent.stderr, /Could not check this value against the master password of the bw vault/);
  assert.ok(!silent.stderr.includes("some-value"));
  assert.equal((await runCli(other, ["run", "--", "sh", "-c", "echo ${S_TOKEN:-none}"], undefined, env)).stdout, "none\n");
  // A login that ran out says nothing about the value either; nobody logged in means no vault to open.
  const expired = await add(other, "S_TOKEN", "Unchecked", "some-value-123456", { ...env, FAKE_BW_UNLOCK_ERROR: "Refresh token has expired (401 Unauthorized); you are not logged in anymore" });
  assert.match(expired.stderr, /Could not check this value against the master password of the bw vault/);
  // "Not logged in" counts only when it is all bw says (what Node says about itself around it aside).
  const mixed = await add(other, "S_TOKEN", "Unchecked", "some-value-123456", { ...env, FAKE_BW_UNLOCK_ERROR: "Failed to refresh the access token\nYou are not logged in." });
  assert.match(mixed.stderr, /Could not check this value against the master password of the bw vault/);
  assert.equal((await add(other, "T_TOKEN", "Logged out", "some-value-123456", { ...env, FAKE_BW_UNLOCK_ERROR: "(node:123) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\n(Use `node --trace-deprecation ...` to show where the warning was created)\nYou are not logged in." })).code, 0);
  // bw's data that is there but cannot be read: whether somebody is logged in is not known.
  for (const dir of [join(other.env.HOME, "Library", "Application Support", "Bitwarden CLI"), join(other.env.HOME, ".config", "Bitwarden CLI"), join(other.env.HOME, "AppData", "Roaming", "Bitwarden CLI")]) await writeFile(join(dir, "data.json"), "{ not json");
  const garbled = await add(other, "U_TOKEN", "Unchecked", "some-value-123456", env);
  assert.notEqual(garbled.code, 0);
  assert.match(garbled.stderr, /Could not check this value against the master password of the bw vault \(bw's data cannot be read\)/);
  await writeFile(vaultPath(box), "{ not a vault");
  const unread = await runCli(box, ["add", "--env", "R_TOKEN", "--item", "Unchecked too", "--stdin"], "some-value-123456");
  assert.notEqual(unread.code, 0);
  assert.match(unread.stderr, /Could not check this value against the passphrase of the local vault/);
  assert.equal((await box.vault()).items.length, 0);
});

// "There is no bw" is said by the start of bw itself failing for want of a file, with no such
// file anywhere it is looked for. A bw that is there but cannot start has not answered.
test("the vault-password check: no bw program has nothing to ask, a bw that cannot start stops the save", { skip: process.platform === "win32" }, async () => {
  const box = await blank();
  for (const dir of [join(box.env.HOME, "Library", "Application Support", "Bitwarden CLI"), join(box.env.HOME, ".config", "Bitwarden CLI")]) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "data.json"), JSON.stringify({ global_account_activeAccountId: "user-1" }));
  }
  const bin = join(box.dir, "bin"), nodeBin = join(box.dir, "node-bin");
  await cp(new URL("./fixtures", import.meta.url), bin, { recursive: true });
  await unlink(join(bin, "bw"));
  await mkdir(nodeBin);
  await symlink(process.execPath, join(nodeBin, "node"));
  // The few tools the fakes call, and no system directory: one may hold a real bw.
  for (const tool of ["cat", "rm", "sh", "env", "mkdir"]) for (const dir of ["/bin", "/usr/bin"]) if (existsSync(join(dir, tool))) { await symlink(join(dir, tool), join(nodeBin, tool)); break; }
  const env = { KEYSHROUD_BACKEND: "local", PATH: `${bin}:${nodeBin}` };
  assert.equal((await add(box, "A_TOKEN", "Item A", "value-aaaa-1111", env)).code, 0);
  await writeFile(join(bin, "bw"), "#!/nonexistent/interpreter\n", { mode: 0o755 });
  const broken = await add(box, "B_TOKEN", "Item B", "value-bbbb-2222", env);
  assert.notEqual(broken.code, 0);
  assert.match(broken.stderr, /Could not check this value against the master password of the bw vault/);
});

// Claude Code's settings have no lock of their own: keyshroud's writers share one, and what a
// writer has waiting is inside it, private, so a writer that lost the lock replaces nothing.
test("claude-setup paused past its lock replaces nothing a later run wrote; what waits is private", { skip: process.platform === "win32" }, async () => {
  const box = await blank();
  assert.equal((await add(box, "A_TOKEN", "Item A", "value-aaaa-1111")).code, 0);
  const settings = join(box.env.HOME, ".claude", "settings.json");
  await mkdir(dirname(settings), { recursive: true });
  await writeFile(settings, JSON.stringify({ model: "x" }));
  await chmod(settings, 0o644);
  const out = await runScript(box, `${PATCH_FS}
    let stalled = false;
    patch("rename", async (real, from, to) => {
      if (!stalled && /settings\\.json\\.lock\\/pending\\./.test(String(from))) {
        stalled = true;
        console.log("waits as " + (fs.statSync(String(from)).mode & 0o777).toString(8));
        fs.rmSync(${JSON.stringify(`${settings}.lock`)}, { recursive: true });
        fs.writeFileSync(${JSON.stringify(settings)}, JSON.stringify({ apiKeyHelper: "another run's" }));
      }
      return real(from, to);
    });
    process.argv = [process.argv[0], "cli", "claude-setup", "--item", "Item A"];
    await import(${JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)});
  `);
  assert.equal(out, "waits as 600\n");
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), { apiKeyHelper: "another run's" });
  assert.deepEqual((await readdir(dirname(settings))).filter((name) => /\.lock$|\.tmp\.|pending/.test(name)), []);

  // Paused after its rename instead: the mode it remembered (0644) goes to the file it put in
  // place, not to the one a later run has put there since.
  await writeFile(settings, JSON.stringify({ model: "x" }));
  await chmod(settings, 0o644);
  await runScript(box, `${PATCH_FS}
    let stalled = false;
    patch("rename", async (real, from, to) => {
      await real(from, to);
      if (!stalled && /settings\\.json\\.lock\\/pending\\./.test(String(from))) {
        stalled = true;
        fs.rmSync(${JSON.stringify(settings)});
        fs.writeFileSync(${JSON.stringify(settings)}, JSON.stringify({ apiKeyHelper: "a later run's" }), { mode: 0o600 });
      }
    });
    process.argv = [process.argv[0], "cli", "claude-setup", "--item", "Item A"];
    await import(${JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)});
  `);
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), { apiKeyHelper: "a later run's" });
  assert.equal((await stat(settings)).mode & 0o777, 0o600);
});

test("migrate --to local leaves alone two references that would get one name, and a name rewired meanwhile", async () => {
  const box = await sandbox([
    item("id-1", "Sentry", "sentry-pass-02", { fields: [{ type: 0, name: "dsn", value: "https://dsn-value-03" }] }),
    item("id-2", "Sentry (field dsn)", "other-value-0005"),
    item("id-3", "Plain", "plain-value-0006"),
  ]);
  await writeAuth(box, {
    S1: { type: "api_key", key: "bw://Sentry/fields/dsn" },
    S2: { type: "api_key", key: "bw://Sentry (field dsn)" },
    P_TOKEN: { type: "api_key", key: "bw://Plain" },
  });
  const dry = await runCli(box, ["migrate", "--to", "local"]);
  assert.equal(dry.stdout.match(/Sentry \(field dsn\)\s+copy, if the references that get this name hold one value\s+<- S[12]$/gm)?.length, 2, dry.stdout);
  const moved = await runCli(box, ["migrate", "--to", "local", "--yes"]);
  assert.equal(moved.code, 4, moved.stderr);
  assert.match(moved.stderr, /two references with different values would get this name/);
  assert.match(moved.stdout, /moved 1 item\(s\) into the local vault and rewired 2 name\(s\)/);
  const auth = join(box.env.HOME, ".pi", "agent", "auth.json");
  const entries = JSON.parse(await readFile(auth, "utf8"));
  assert.deepEqual([entries.S1.key, entries.S2.key], ["bw://Sentry/fields/dsn", "bw://Sentry (field dsn)"]);
  assert.match(entries.P_TOKEN.key, /keyshroud:\/\/Plain/);

  const out = await runScript(box, `
    const core = await import(${CORE});
    const stale = await core.writeAuthEntry(${JSON.stringify(auth)}, "S1", "keyshroud://Sentry", { replaces: "bw://Something else" });
    const fresh = await core.writeAuthEntry(${JSON.stringify(auth)}, "S1", "keyshroud://Sentry", { replaces: "bw://Sentry/fields/dsn" });
    console.log(stale.ok, fresh.ok);
  `);
  assert.equal(out, "false true\n");
});

for (const unreadable of [false, true]) test(`rekey keeps the new key once the vault is sealed with it, whatever fails afterwards${unreadable ? " (the vault cannot even be read back)" : ""}`, { skip: process.platform === "win32" }, async () => {
  const box = await blank();
  assert.equal((await add(box, "A_TOKEN", "A", "value-aaaa-1111", { KEYSHROUD_VAULT_KEY: "keychain" })).code, 0);
  const firstId = JSON.parse(await readFile(vaultPath(box), "utf8")).id;
  const out = await runScript(box, `${PATCH_FS}
    process.stdin.isTTY = process.stderr.isTTY = true;
    let renamed = false, failed = false;
    patch("rename", async (real, from, to) => { const done = await real(from, to); if (String(to).endsWith("vault.json")) renamed = true; return done; });
    patch("rm", async (real, path, ...rest) => { if (renamed && String(path).endsWith("vault.json.lock")) { renamed = false; failed = true; throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); } return real(path, ...rest); });
    patch("readFile", async (real, path, ...rest) => { if (${unreadable} && failed && String(path).endsWith("vault.json")) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); return real(path, ...rest); });
    const core = await import(${CORE});
    await core.rekeyLocal().then(() => console.log("rekeyed"), (error) => console.log("failed: " + error.code));
  `);
  assert.equal(out, "failed: EIO\n");
  const id = JSON.parse(await readFile(vaultPath(box), "utf8")).id;
  assert.notEqual(id, firstId);
  assert.ok((await keyEntries(box)).includes(`keyshroud-vault-${id}`), "the key of the vault on disk is gone");
  assert.equal((await runCli(box, ["get", "A_TOKEN"])).stdout, "value-aaaa-1111");
});
