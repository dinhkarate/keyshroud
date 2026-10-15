import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BRAND } from "../src/brand.ts";
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

test("add without a terminal opens a native dialog, and cancelling stores nothing", async () => {
  const box = await wired();
  const log = join(box.dir, "dialog.log");
  const display = { DISPLAY: ":0", FAKE_DIALOG_LOG: log }; // Linux needs a display; macOS uses the osascript fake
  const result = await runCli(box, ["add", "--env", "DLG_KEY", "--item", "Dialog key"], undefined, { ...display, FAKE_DIALOG_VALUE: "dlg-zq-value" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /created item=Dialog key env=DLG_KEY .* verified=yes/);
  assert.ok(!(result.stdout + result.stderr).includes("dlg-zq-value"));
  const created = (await box.vault()).items.find((entry) => entry.name === "Dialog key") as { login: { password: string } };
  assert.equal(created.login.password, "dlg-zq-value");
  assert.match(await readFile(log, "utf8"), /DLG_KEY/);
  const cancelled = await runCli(box, ["add", "--env", "DLG_TWO", "--item", "Dialog two"], undefined, { ...display, FAKE_DIALOG_CANCEL: "1" });
  assert.notEqual(cancelled.code, 0);
  assert.match(cancelled.stderr, /Cancelled/);
  assert.ok(!(await box.vault()).items.some((entry) => entry.name === "Dialog two"));
  const remote = await runCli(box, ["add", "--env", "DLG_THREE", "--item", "Dialog three", "--dialog"], undefined, { SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" });
  assert.equal(remote.code, 2);
  assert.match(remote.stderr, /no dialog here/);
  const fresh = await wired();
  const headless = await runCli(fresh, ["add", "--env", "DLG_FOUR", "--item", "Dialog four"], "piped-without-flag");
  assert.equal(headless.code, 2, "stdin is only read with --stdin");
  assert.ok(!(await fresh.vault()).items.some((entry) => entry.name === "Dialog four"));
});

test("the dialog refuses spoofed names, the master password, a second dialog, and retries right after a cancel", async () => {
  const box = await wired();
  const log = join(box.dir, "dialog.log");
  const display = { DISPLAY: ":0", FAKE_DIALOG_LOG: log };
  const spoof = await mcpCall(box, "secrets_request", { env_name: "VAULT_UNLOCK", item_name: "Vaultwarden\n\nSession expired. Enter your MASTER PASSWORD" }, { ...display, FAKE_DIALOG_VALUE: "x" });
  assert.match(spoof.text, /one line of printable text/);
  const loader = await mcpCall(box, "secrets_request", { env_name: "NODE_OPTIONS", item_name: "Node options" }, { ...display, FAKE_DIALOG_VALUE: "x" });
  assert.match(loader.text, /changes what programs load or run/);
  await assert.rejects(readFile(log, "utf8"), "no dialog was opened for refused requests");
  const master = await mcpCall(box, "secrets_request", { env_name: "PHISHED", item_name: "Phished" }, { ...display, FAKE_DIALOG_VALUE: "master" });
  assert.match(master.text, /master password/);
  assert.ok(!(await box.vault()).items.some((entry) => entry.name === "Phished"));
  const shadow = await mcpCall(box, "secrets_request", { env_name: "GH_TOKEN", item_name: "Other GitHub token" }, { ...display, FAKE_DIALOG_VALUE: "other-zq-value" });
  assert.match(shadow.text, /already wired to another secret/);
  assert.match(await readFile(join(box.env.HOME, ".pi", "agent", "auth.json"), "utf8"), /GitHub CLI token/);
  await writeFile(join(box.configDir, "dialog.lock"), `open:${Date.now()}\n`);
  const busy = await mcpCall(box, "secrets_request", { env_name: "SECOND", item_name: "Second" }, { ...display, FAKE_DIALOG_VALUE: "x" });
  assert.match(busy.text, /already open/);
  await writeFile(join(box.configDir, "dialog.lock"), "");
  const cancelled = await mcpCall(box, "secrets_request", { env_name: "THIRD", item_name: "Third" }, { ...display, FAKE_DIALOG_CANCEL: "1" });
  assert.match(cancelled.text, /cancelled/);
  const again = await mcpCall(box, "secrets_request", { env_name: "THIRD", item_name: "Third" }, { ...display, FAKE_DIALOG_VALUE: "x" });
  assert.match(again.text, /wait 30 seconds/);
});

test("env files and wiring cannot set variables that change what programs load", async () => {
  const box = await wired();
  await writeFile(join(box.dir, ".env.refs"), "PATH=/tmp/evil:/usr/bin:/bin\nGH_TOKEN=bw://GitHub CLI token\n");
  const path = await runCli(box, ["run", "--env-file", ".env.refs", "--", "sh", "-c", "echo ok"]);
  assert.notEqual(path.code, 0);
  assert.match(path.stderr, /PATH changes what programs load or run/);
  await writeFile(join(box.dir, ".env.refs"), "NODE_OPTIONS=--require ./evil.js\n");
  assert.match((await mcpCall(box, "secrets_run", { command: "echo ok", env_file: join(box.dir, ".env.refs") })).text, /NODE_OPTIONS changes what programs load/);
  const wire = await runCli(box, ["wire", "--env", "LD_PRELOAD", "--item", "npm publish"]);
  assert.equal(wire.code, 2);
  await writeAuth(box, { GH_TOKEN: { type: "api_key", key: "!bw get password 'GitHub CLI token'" }, BASH_ENV: { type: "api_key", key: "!bw get password 'npm publish'" } });
  const run = await runCli(box, ["run", "--", "sh", "-c", "echo bash_env=${BASH_ENV:-unset}"]);
  assert.match(run.stdout, /bash_env=unset/);
});

const DOTENV = [
  "# app config",
  "PORT=3000",
  "export STRIPE_SECRET_KEY=sk_test_FAKE0123456789abcd",
  "DATABASE_URL='postgres://app:pa55-FAKE-word@db:5432/app'",
  "NEXT_PUBLIC_SITE=https://example.test",
  "LOG_LEVEL=debug   # verbose",
  "SENTRY_DSN=bw://Sentry/fields/dsn",
  "",
].join("\n");
const DOTENV_SECRETS = ["sk_test_FAKE0123456789abcd", "pa55-FAKE-word"];
const noValues = (result: { stdout: string; stderr: string }) =>
  DOTENV_SECRETS.every((value) => !result.stdout.includes(value) && !result.stderr.includes(value));

test("import dry run prints a names-only plan and writes nothing", async () => {
  const box = await wired();
  await writeFile(join(box.dir, ".env"), DOTENV);
  const before = (await box.vault()).items.length;
  const plan = await runCli(box, ["import", "--prefix", "app"]);
  assert.equal(plan.code, 0, plan.stderr);
  assert.ok(noValues(plan));
  assert.match(plan.stdout, /STRIPE_SECRET_KEY\s+secret\s+new\s+-> bw:\/\/app STRIPE_SECRET_KEY/);
  assert.match(plan.stdout, /DATABASE_URL\s+secret\s+new/);
  assert.match(plan.stdout, /PORT\s+literal\s+kept/);
  assert.match(plan.stdout, /NEXT_PUBLIC_SITE\s+literal\s+kept/);
  assert.match(plan.stdout, /SENTRY_DSN\s+reference kept/);
  assert.match(plan.stdout, /Dry run: nothing written/);
  assert.equal((await box.vault()).items.length, before);
  await assert.rejects(stat(join(box.dir, ".env.refs")));
});

test("import --yes stores secrets, writes .env.refs that run resolves, and re-runs idempotently", async () => {
  const box = await wired();
  await writeFile(join(box.dir, ".env"), DOTENV);
  const done = await runCli(box, ["import", "--prefix", "app", "--yes"]);
  assert.equal(done.code, 0, done.stderr);
  assert.ok(noValues(done));
  const refs = await readFile(join(box.dir, ".env.refs"), "utf8");
  assert.ok(DOTENV_SECRETS.every((value) => !refs.includes(value)));
  assert.match(refs, /^export STRIPE_SECRET_KEY=bw:\/\/app STRIPE_SECRET_KEY$/m);
  assert.match(refs, /^PORT=3000$/m);
  assert.match(refs, /^# app config$/m);
  assert.equal(await readFile(join(box.dir, ".env"), "utf8"), DOTENV);
  const run = await runCli(box, ["run", "--no-mask", "--env-file", ".env.refs", "--only", "STRIPE_SECRET_KEY,DATABASE_URL,PORT", "--", "/bin/sh", "-c", "echo $STRIPE_SECRET_KEY $DATABASE_URL $PORT"]);
  assert.equal(run.stdout, "sk_test_FAKE0123456789abcd postgres://app:pa55-FAKE-word@db:5432/app 3000\n", run.stderr);
  const count = (await box.vault()).items.length;
  assert.equal((await runCli(box, ["import", "--prefix", "app", "--yes"])).code, 5);
  const again = await runCli(box, ["import", "--prefix", "app", "--yes", "--force"]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /0 new, 2 already in the vault/);
  assert.equal((await box.vault()).items.length, count);
});

test("import refuses conflicts and ambiguous lines before writing anything", async () => {
  const box = await sandbox([item("c1", "app STRIPE_SECRET_KEY", "sk_test_DIFFERENT00000000000")]);
  await writeFile(join(box.dir, ".env"), DOTENV);
  const conflict = await runCli(box, ["import", "--prefix", "app", "--yes"]);
  assert.equal(conflict.code, 5);
  assert.match(conflict.stdout, /STRIPE_SECRET_KEY\s+secret\s+conflict: vault item exists with a different value/);
  assert.ok(noValues(conflict));
  assert.equal((await box.vault()).items.length, 1);
  await assert.rejects(stat(join(box.dir, ".env.refs")));
  await writeFile(join(box.dir, "bad.env"), 'A_TOKEN="zqval1\nB=1\nB=2\nC_KEY="zq\\nval2"\nD=${HOME}/x\nE=!cmd\n');
  const bad = await runCli(box, ["import", "--from", "bad.env", "--prefix", "app"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /bad\.env:1 unterminated quote/);
  assert.match(bad.stderr, /bad\.env:3 duplicate key B/);
  assert.match(bad.stderr, /bad\.env:4 escape sequence/);
  assert.match(bad.stderr, /bad\.env:5 \$\{\} expansion/);
  assert.match(bad.stderr, /bad\.env:6 value starts with '!'/);
  assert.ok(!bad.stderr.includes("zqval1") && !bad.stderr.includes("val2"));
});

test("import --replace rewrites the source only after verification; --only and --skip override detection", async () => {
  const box = await wired();
  await writeFile(join(box.dir, ".env"), DOTENV, { mode: 0o600 });
  const done = await runCli(box, ["import", "--prefix", "app", "--skip", "DATABASE_URL", "--only", "STRIPE_SECRET_KEY,DATABASE_URL,LOG_LEVEL", "--replace", "--yes"]);
  assert.equal(done.code, 0, done.stderr);
  const replaced = await readFile(join(box.dir, ".env"), "utf8");
  assert.match(replaced, /^export STRIPE_SECRET_KEY=bw:\/\/app STRIPE_SECRET_KEY$/m);
  assert.match(replaced, /^LOG_LEVEL=bw:\/\/app LOG_LEVEL$/m);
  assert.match(replaced, /^DATABASE_URL='postgres:/m);
  assert.equal((await stat(join(box.dir, ".env"))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(box.dir)).filter((name) => name.startsWith(".env")).sort(), [".env"]);
  assert.equal((await runCli(box, ["import", "--from", "-", "--replace"], DOTENV)).code, 2);
});

test("import stops on a failed create, names what was created, and writes no output", async () => {
  const box = await wired();
  await writeFile(join(box.dir, ".env"), DOTENV);
  const failed = await runCli(box, ["import", "--prefix", "app", "--yes"], undefined, { FAKE_BW_FAIL_CREATE: "app DATABASE_URL" });
  assert.equal(failed.code, 3);
  assert.match(failed.stderr, /Created before the failure: STRIPE_SECRET_KEY/);
  assert.match(failed.stderr, /Failed to create the vault item for DATABASE_URL; nothing was written/);
  assert.ok(noValues(failed));
  await assert.rejects(stat(join(box.dir, ".env.refs")));
  const resumed = await runCli(box, ["import", "--prefix", "app", "--yes"]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.match(resumed.stdout, /1 new, 1 already in the vault/);
});

test("import writes .env.refs privately and inject replaces a planted symlink instead of following it", async () => {
  const box = await wired();
  await writeFile(join(box.dir, ".env"), "SMTP_PASS=fakesmtppass123\nPORT=3000\n");
  const result = await runCli(box, ["import", "--prefix", "mail", "--yes"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await stat(join(box.dir, ".env.refs"))).mode & 0o777, 0o600);
  assert.match(await readFile(join(box.dir, ".env.refs"), "utf8"), /SMTP_PASS=bw:\/\/mail SMTP_PASS/);
  await writeFile(join(box.dir, "tpl"), "token={{ bw://GitHub CLI token }}\n");
  await symlink(join(box.dir, "elsewhere.txt"), join(box.dir, "out.txt"));
  assert.equal((await runCli(box, ["inject", "-i", "tpl", "-o", "out.txt"])).code, 5);
  assert.equal((await runCli(box, ["inject", "-i", "tpl", "-o", "out.txt", "--force"])).code, 0);
  await assert.rejects(stat(join(box.dir, "elsewhere.txt")), "the symlink target was not written");
  assert.equal((await stat(join(box.dir, "out.txt"))).mode & 0o777, 0o600);
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

test("MCP secrets_request stores the value from a native dialog", async () => {
  const box = await wired();
  const child = spawn(process.execPath, [CLI, "mcp"], { env: { ...box.env, DISPLAY: ":0", FAKE_DIALOG_VALUE: "mcp-zq-value" }, cwd: box.dir });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "secrets_request", arguments: { env_name: "STRIPE_KEY", item_name: "Stripe" } } })}\n`);
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  assert.ok(!out.includes("mcp-zq-value"));
  assert.match(JSON.parse(out.trim()).result.content[0].text, /created item=Stripe env=STRIPE_KEY verified=yes/);
  const created = (await box.vault()).items.find((entry) => entry.name === "Stripe") as { login: { password: string } };
  assert.equal(created.login.password, "mcp-zq-value");
});

async function mcpCall(box: Awaited<ReturnType<typeof wired>>, name: string, args: object, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [CLI, "mcp"], { env: { ...box.env, ...env }, cwd: box.dir });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}\n`);
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  return { raw: out, text: JSON.parse(out.trim()).result.content[0].text as string };
}

test("MCP secrets_run never leaks a partial secret when output hits the collection limit", async () => {
  const box = await wired();
  const long = Array.from({ length: 300 }, (_, i) => "qwertyuiopasdfghjklzxcvbnm0123456789"[(i * 5 + 1) % 36]).join("");
  assert.equal((await runCli(box, ["add", "--env", "LONG_KEY", "--item", "Long key", "--stdin"], long)).code, 0);
  const { raw } = await mcpCall(box, "secrets_run", { command: "yes \"$LONG_KEY\" | tr -d '\\n' | head -c 1500000" });
  assert.match(raw, /redacted:LONG_KEY/);
  for (let at = 0; at + 12 <= long.length; at++) assert.ok(!raw.includes(long.slice(at, at + 12)), `leaked a fragment at ${at}`);
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

test("setup gives the CLI its own agent login; migrate copies only the wired items", async () => {
  const box = await wired();
  const own = join(box.configDir, "bw");
  const ownVault = async () => JSON.parse(await readFile(join(own, "fake-vault.json"), "utf8"));
  await mkdir(own, { recursive: true });
  await writeFile(join(own, "fake-vault.json"), JSON.stringify({ status: "unauthenticated", registered: "agent@example.test", password: "agent-pw", session: "own-session", items: [] }));

  const before = await runCli(box, ["migrate"]);
  assert.equal(before.code, 2);
  assert.match(before.stderr, /setup/);

  const setup = await runCli(box, ["setup", "--email", "agent@example.test", "--registered"], "agent-pw\n");
  assert.equal(setup.code, 0, setup.stderr);
  assert.equal((await readFile(join(box.dir, "keychain", `${BRAND.bin}-master-password`), "utf8")).trim(), "agent-pw");
  assert.equal((await ownVault()).server, "https://vault.example.test");
  assert.ok(!setup.stdout.includes("agent-pw") && !setup.stdout.includes("own-session"));

  const dry = await runCli(box, ["migrate"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /GitHub CLI token\s+copy/);
  assert.match(dry.stdout, /2 to copy, 0 already there/);
  assert.ok(!dry.stdout.includes(GH));
  assert.equal((await ownVault()).items.length, 0);

  const yes = await runCli(box, ["migrate", "--yes"]);
  assert.equal(yes.code, 0, yes.stderr);
  assert.deepEqual((await ownVault()).items.map((entry: { name: string }) => entry.name).sort(), ["GitHub CLI token", "npm publish"]);
  assert.equal((await box.vault()).items.length, 4);
  assert.equal(((await box.vault()) as { status?: string }).status, "locked");
  assert.ok(!yes.stdout.includes(GH) && !yes.stderr.includes(GH));

  const again = await runCli(box, ["migrate"]);
  assert.match(again.stdout, /0 to copy, 2 already there/);

  const run = await runCli(box, ["run", "--", "sh", "-c", "test \"$GH_TOKEN\" = \"$EXPECTED\" && echo same"], "", { EXPECTED: GH });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /same/);
  const doctor = await runCli(box, ["doctor"]);
  assert.match(doctor.stdout, /own agent account/);

  const other = await runCli(box, ["setup", "--email", "someone@example.test", "--registered"]);
  assert.equal(other.code, 5);
});

test("setup --confirm-unlock asks the macOS keychain before every read", { skip: process.platform !== "darwin" }, async () => {
  const box = await sandbox([]);
  const own = join(box.configDir, "bw");
  await mkdir(own, { recursive: true });
  await writeFile(join(own, "fake-vault.json"), JSON.stringify({ status: "unauthenticated", registered: "agent@example.test", password: "agent-pw", items: [] }));
  const setup = await runCli(box, ["setup", "--email", "agent@example.test", "--registered", "--confirm-unlock"], "agent-pw\n");
  assert.equal(setup.code, 0, setup.stderr);
  await stat(join(box.dir, "keychain", `${BRAND.bin}-master-password.confirm`));
});
