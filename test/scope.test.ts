// A project's scope (.keyshroud.json): which wired names the work in a directory gets.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { inScope } from "../src/core.ts";
import { CLI, NODE, runCli, sandbox, type RunResult, type Sandbox } from "./helpers.ts";

const A = "ghp_SCOPEA0123456789abcdefXYZ";
const B = "sk-SCOPEB0123456789abcdefghij";
const scopeFile = (box: Sandbox) => join(box.dir, ".keyshroud.json");

async function wired(): Promise<Sandbox> {
  const box = await sandbox([], { blank: true });
  for (const [env, item, value] of [["APP_TOKEN", "App token", A], ["APP_URL_KEY", "App url key", "url-key-0123456789"], ["OTHER_KEY", "Other key", B]]) {
    assert.equal((await runCli(box, ["add", "--env", env, "--item", item, "--stdin"], value)).code, 0);
  }
  return box;
}

function runIn(box: Sandbox, cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(NODE, [CLI, ...args], { env: box.env, cwd });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

const SHOW = ["run", "--", "sh", "-c", 'echo "app=${APP_TOKEN:-none} url=${APP_URL_KEY:+set} other=${OTHER_KEY:-none}"'];

test("a scope narrows what run, env and get give in that directory and below it", async () => {
  const box = await wired();
  assert.equal((await runCli(box, SHOW)).stdout, "app=<redacted:APP_TOKEN> url=set other=<redacted:OTHER_KEY>\n");

  await writeFile(scopeFile(box), JSON.stringify({ only: ["APP_*"] }));
  assert.equal((await runCli(box, ["env"])).stdout, "APP_TOKEN\nAPP_URL_KEY\n");
  assert.equal((await runCli(box, SHOW)).stdout, "app=<redacted:APP_TOKEN> url=set other=none\n");
  const nested = join(box.dir, "packages", "api");
  await mkdir(nested, { recursive: true });
  assert.equal((await runIn(box, nested, SHOW)).stdout, "app=<redacted:APP_TOKEN> url=set other=none\n");

  // By name it is refused, not handed over; a value the agent itself was started with stays out too.
  const only = await runCli(box, ["run", "--only", "OTHER_KEY", "--", "true"]);
  assert.equal(only.code, 4);
  assert.match(only.stderr, /^Secret unresolved: OTHER_KEY is outside this project's scope \(.*\.keyshroud\.json\)\n$/);
  assert.equal((await runCli(box, SHOW, undefined, { OTHER_KEY: B })).stdout, "app=<redacted:APP_TOKEN> url=set other=none\n");
  const got = await runCli(box, ["get", "OTHER_KEY"]);
  assert.equal(got.code, 4);
  assert.match(got.stderr, /OTHER_KEY is outside this project's scope/);
  assert.equal(got.stdout, "");
  assert.equal((await runCli(box, ["run", "--only", "NOPE", "--", "true"])).stderr, "Secret unresolved: NOPE is not wired\n");

  // What is asked for by reference is not a wired name: an env file and `get` still reach it.
  await writeFile(join(box.dir, ".env.refs"), "OTHER_KEY=keyshroud://Other key\n");
  assert.equal((await runCli(box, ["run", "--env-file", ".env.refs", "--", "sh", "-c", 'echo "other=$OTHER_KEY"'])).stdout, "other=<redacted:OTHER_KEY>\n");
  assert.equal((await runCli(box, ["get", "keyshroud://Other key"])).stdout, B);

  // Masking is not narrowed: a value outside the scope is masked wherever it turns up.
  assert.equal((await runCli(box, ["run", "--", "sh", "-c", 'echo "leak=$LEAK"'], undefined, { LEAK: B })).stdout, "leak=<redacted:OTHER_KEY>\n");
});

test("the agents get the names in scope, and the hook index every value", async () => {
  const box = await wired();
  await writeFile(scopeFile(box), JSON.stringify({ only: ["APP_TOKEN"] }));
  const start = await runCli(box, ["hook", "claude", "session-start"], "{}");
  const context = (JSON.parse(start.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  assert.match(context, /available by name only: APP_TOKEN\. Only the names in this project's scope are listed \(.*\.keyshroud\.json\)\./);
  assert.ok(!context.includes("OTHER_KEY") && !context.includes("APP_URL_KEY"));
  const post = await runCli(box, ["hook", "claude", "post-tool-use"], JSON.stringify({ tool_response: { stdout: `other=${B}` } }));
  assert.equal((JSON.parse(post.stdout) as { hookSpecificOutput: { updatedToolOutput: { stdout: string } } }).hookSpecificOutput.updatedToolOutput.stdout, "other=<redacted:OTHER_KEY>");

  const calls = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "secrets_list", arguments: {} } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "secrets_run", arguments: { command: "true", only: ["OTHER_KEY"] } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "secrets_run", arguments: { command: 'echo "app=$APP_TOKEN other=${OTHER_KEY:-none}"' } } },
  ];
  const mcp = await runCli(box, ["mcp"], calls.map((call) => `${JSON.stringify(call)}\n`).join(""), { OTHER_KEY: B });
  const answers = mcp.stdout.trim().split("\n").map((line) => JSON.parse(line) as { id: number; result: { content: Array<{ text: string }> } });
  const answer = (id: number) => answers.find((entry) => entry.id === id)!.result.content[0].text;
  assert.equal(answer(1), "resolved: APP_TOKEN\nunresolved: none");
  assert.equal(answer(2), "Outside this project's scope (.keyshroud.json): OTHER_KEY");
  assert.match(answer(3), /^exit: 0\n--- stdout ---\napp=<redacted:APP_TOKEN> other=none\n/);

  // The scope is the one of the directory the command runs in, not of the server's.
  const inner = join(box.dir, "inner"), outer = join(box.dir, "..", `outer-${Date.now()}`);
  await mkdir(inner);
  await mkdir(outer);
  await writeFile(join(inner, ".keyshroud.json"), JSON.stringify({ only: ["OTHER_KEY"] }));
  const show = 'echo "app=${APP_TOKEN:-none} other=${OTHER_KEY:-none}"';
  const elsewhere = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "secrets_run", arguments: { command: show, cwd: inner } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "secrets_run", arguments: { command: "true", cwd: inner, only: ["APP_TOKEN"] } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "secrets_run", arguments: { command: show, cwd: outer } } },
    // A link into the project is the project: the scope above where it leads applies.
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "secrets_run", arguments: { command: show, cwd: join(outer, "alias") } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "secrets_run", arguments: { command: show, cwd: join(outer, "nowhere") } } },
  ];
  await mkdir(join(inner, "pkg"));
  if (process.platform !== "win32") await symlink(join(inner, "pkg"), join(outer, "alias"));
  const moved = await runCli(box, ["mcp"], elsewhere.map((call) => `${JSON.stringify(call)}\n`).join(""));
  const there = moved.stdout.trim().split("\n").map((line) => JSON.parse(line) as { id: number; result: { content: Array<{ text: string }> } });
  const said = (id: number) => there.find((entry) => entry.id === id)!.result.content[0].text;
  assert.match(said(1), /^exit: 0\n--- stdout ---\napp=none other=<redacted:OTHER_KEY>\n/);
  assert.equal(said(2), "Outside this project's scope (.keyshroud.json): APP_TOKEN");
  assert.match(said(3), /^exit: 0\n--- stdout ---\napp=<redacted:APP_TOKEN> other=<redacted:OTHER_KEY>\n/);
  if (process.platform !== "win32") assert.match(said(4), /^exit: 0\n--- stdout ---\napp=none other=<redacted:OTHER_KEY>\n/);
  assert.equal(said(5), "cwd cannot be opened (ENOENT)");
  await rm(outer, { recursive: true });

  await writeFile(scopeFile(box), JSON.stringify({ only: [] }));
  const none = (JSON.parse((await runCli(box, ["hook", "claude", "session-start"], "{}")).stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  assert.match(none, /^keyshroud: no wired secret is in this project's scope \(.*\.keyshroud\.json\)\.$/);
});

test("a scope file that is not one puts nothing in scope", async () => {
  const box = await wired();
  for (const text of ["{", "[]", '{"only":"APP_TOKEN"}', '{"only":["app_token"]}', '{"only":["APP_TOKEN"],"also":1}']) {
    await writeFile(scopeFile(box), text);
    const run = await runCli(box, SHOW);
    assert.equal(run.code, 3, text);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /\.keyshroud\.json is not a scope file \(\{ "only": \["NAME", "PREFIX_\*"\] \}\): no secret is in scope here\n$/);
    assert.equal((await runCli(box, ["env"])).stdout, "");
    const shell = await runCli(box, ["env", "--shell"]);
    assert.equal(shell.code, 3);
    assert.equal(shell.stdout, "");
    assert.match(shell.stderr, /is not a scope file/);
  }
  // A link to a file that is gone is a scope that cannot be read, not no scope: the one above is not used.
  if (process.platform !== "win32") {
    const nested = join(box.dir, "app");
    await mkdir(nested);
    await writeFile(scopeFile(box), JSON.stringify({ only: ["APP_TOKEN"] }));
    await symlink(join(box.dir, "shared", "scope.json"), join(nested, ".keyshroud.json"));
    const linked = await runIn(box, nested, SHOW);
    assert.equal(linked.code, 3);
    assert.equal(linked.stdout, "");
    assert.match(linked.stderr, /app\/\.keyshroud\.json cannot be read \(ENOENT\): no secret is in scope here\n$/);
    await rm(join(nested, ".keyshroud.json"));
    assert.equal((await runIn(box, nested, SHOW)).stdout, "app=<redacted:APP_TOKEN> url= other=none\n");
    await writeFile(scopeFile(box), "{");
  }
  const start = await runCli(box, ["hook", "claude", "session-start"], "{}");
  assert.match((JSON.parse(start.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext, /is not a scope file .*Ask the user to correct that file or remove it\.$/);
  // The index is written all the same.
  const post = await runCli(box, ["hook", "claude", "post-tool-use"], JSON.stringify({ tool_response: { stdout: A } }));
  assert.match(post.stdout, /<redacted:APP_TOKEN>/);
});

test("scope shows, writes and removes the file of the directory it is run in", async () => {
  const box = await wired();
  assert.match((await runCli(box, ["scope"])).stdout, /^scope=none: every wired name can be used here \(3\)\./);

  const set = await runCli(box, ["scope", "--only", "APP_*, NOPE"]);
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /^scope=.*\.keyshroud\.json only=APP_\*,NOPE\nin scope \(2\): APP_TOKEN, APP_URL_KEY\noutside: 1 wired name\(s\)\n$/);
  assert.equal(set.stderr, "no wired name matches: NOPE\n");
  assert.deepEqual(JSON.parse(await readFile(scopeFile(box), "utf8")), { only: ["APP_*", "NOPE"] });

  // A name stored from inside the project is not in its scope by itself.
  const added = await runCli(box, ["add", "--env", "NEW_KEY", "--item", "New key", "--stdin"], "new-key-0123456789");
  assert.equal(added.code, 0);
  assert.match(added.stderr, /NEW_KEY is outside this project's scope \(.*\): add it there to use it in this project\n$/);

  const bad = await runCli(box, ["scope", "--only", "app-token"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /^app-token is not a variable name/);
  assert.equal((await runCli(box, ["scope", "--clear"])).stdout.startsWith("removed "), true);
  assert.equal(existsSync(scopeFile(box)), false);
  assert.match((await runCli(box, ["scope", "--clear"])).stdout, /^no \.keyshroud\.json in this directory\n/);
});

test("a pattern matches whole names, with * for any run of characters", () => {
  const matches = (pattern: string, name: string) => inScope({ path: "", only: [pattern] }, name);
  for (const [pattern, name] of [["GH_TOKEN", "GH_TOKEN"], ["*", "ANY_NAME"], ["APP_*", "APP_"], ["APP_*", "APP_TOKEN"], ["*_KEY", "API_KEY"], ["A*B*C", "A1B2C"], ["A**C", "AC"], ["*A*", "XAY"], ["AB*BA", "ABBA"], ["AB*AB*AB", "ABABAB"]]) assert.ok(matches(pattern, name), `${pattern} ~ ${name}`);
  for (const [pattern, name] of [["GH_TOKEN", "GH_TOKEN2"], ["GH_TOKEN", "A_GH_TOKEN"], ["APP_*", "MY_APP_TOKEN"], ["*_KEY", "API_KEY_ID"], ["A*B*C", "A1C2B"], ["AB*BA", "ABA"], ["AB*AB*AB", "ABAB"], ["*A*", "XYZ"]]) assert.ok(!matches(pattern, name), `${pattern} !~ ${name}`);
  assert.ok(inScope(null, "ANYTHING"));
  assert.ok(!inScope({ path: "", only: [] }, "ANYTHING"));
  // A long pattern from a cloned repository is matched in no time.
  const started = Date.now();
  assert.ok(!matches(`${"*A".repeat(40)}*X`, "A".repeat(200)));
  assert.ok(Date.now() - started < 500);
});
