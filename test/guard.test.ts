// claude-guard: the shell Claude Code starts, with what it prints masked as it is written.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import { test } from "node:test";
import { buildRedactIndex, createIndexFeed, redactWithIndex } from "../src/redact.ts";
import { runCli, sandbox, type Sandbox } from "./helpers.ts";

const TOKEN = "ghp_GUARD0123456789abcdefXYZ";
const posix = { skip: process.platform === "win32" };

const blank = () => sandbox([], { blank: true });
const settingsFile = (box: Sandbox) => join(box.env.HOME, ".claude", "settings.json");
const settings = async (box: Sandbox) => JSON.parse(await readFile(settingsFile(box), "utf8")) as { env?: Record<string, string> };

// A sandbox with one wired secret (so the index knows it) and the guard on, for bash.
async function guarded(): Promise<{ box: Sandbox; launcher: string }> {
  const box = await blank();
  assert.equal((await runCli(box, ["add", "--env", "GH_TOKEN", "--item", "GitHub", "--stdin"], TOKEN)).code, 0);
  const on = await runCli(box, ["claude-guard", "--shell", "/bin/bash"]);
  assert.equal(on.code, 0, on.stderr);
  return { box, launcher: (await settings(box)).env!.CLAUDE_CODE_SHELL };
}

// Runs the launcher as Claude Code runs its shell: stdout and stderr are one file (or two).
function shell(box: Sandbox, launcher: string, script: string, opts: { split?: boolean; env?: Record<string, string> } = {}): Promise<{ code: number | null; out: () => Promise<string>; err: () => Promise<string> }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const outFile = join(box.dir, `out-${stamp}`), errFile = join(box.dir, `err-${stamp}`);
  const out = openSync(outFile, "w"), err = opts.split ? openSync(errFile, "w") : out;
  return new Promise((resolve) => {
    const child = spawn(launcher, ["-c", script], { env: { ...box.env, SECRET_FOR_TEST: TOKEN, ...opts.env }, cwd: box.dir, stdio: ["ignore", out, err] });
    child.on("exit", (code) => {
      closeSync(out); if (opts.split) closeSync(err);
      resolve({ code, out: () => readFile(outFile, "utf8"), err: () => readFile(errFile, "utf8") });
    });
  });
}

async function until(read: () => Promise<string>, wanted: string): Promise<string> {
  for (const deadline = Date.now() + 15000; ;) {
    const text = await read();
    if (text.includes(wanted) || Date.now() > deadline) return text;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("claude-guard points Claude Code at a launcher named like the shell, and --off gives the setting back", posix, async () => {
  const box = await blank();
  await mkdir(join(box.env.HOME, ".claude"), { recursive: true });
  await writeFile(settingsFile(box), JSON.stringify({ model: "x", env: { FOO: "1", CLAUDE_CODE_SHELL: "/bin/bash" } }));

  const on = await runCli(box, ["claude-guard"]);
  assert.equal(on.code, 0, on.stderr);
  const launcher = (await settings(box)).env!.CLAUDE_CODE_SHELL;
  // A directory of its own for each settings file, and in it a name Claude Code takes for a shell.
  assert.ok(dirname(dirname(launcher)) === join(box.configDir, "guard") && launcher.endsWith("/bash"));
  assert.match(on.stdout, /^guard=on shell=\/bin\/bash launcher=/);
  assert.deepEqual(await settings(box), { model: "x", env: { FOO: "1", CLAUDE_CODE_SHELL: launcher } });
  assert.match((await runCli(box, ["doctor"])).stdout, /^claude guard=on \(shell \/bin\/bash\)$/m);
  // A second run keeps the shell it stands in for, and what the setting was before.
  assert.equal((await runCli(box, ["claude-guard"])).code, 0);
  assert.equal((await settings(box)).env?.CLAUDE_CODE_SHELL, launcher);

  const off = await runCli(box, ["claude-guard", "--off"]);
  assert.match(off.stdout, /^guard=off \(sessions that are running/);
  assert.deepEqual(await settings(box), { model: "x", env: { FOO: "1", CLAUDE_CODE_SHELL: "/bin/bash" } });
  assert.match((await runCli(box, ["doctor"])).stdout, /^claude guard=off$/m);
  // A session that is running still finds a shell there.
  const after = await shell(box, launcher, "echo still-here; exit 4");
  assert.equal(after.code, 4);
  assert.equal(await after.out(), "still-here\n");
  assert.match((await runCli(box, ["claude-guard", "--off"])).stdout, /it was not on/);
  for (const dir of [join(box.configDir, "guard"), dirname(launcher)]) assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dirname(launcher), "guard.json"))).mode & 0o777, 0o600);

  // Turning the guard on first leaves a new machine on the local vault.
  assert.equal((await runCli(box, ["add", "--env", "GH_TOKEN", "--item", "GitHub", "--stdin"], TOKEN)).code, 0);
  assert.equal(await readFile(join(box.configDir, "backend"), "utf8"), "local\n");
  // Off is off for every launcher there is, whichever shell was the last one.
  if (existsSync("/bin/zsh")) {
    assert.equal((await runCli(box, ["claude-guard", "--shell", "/bin/bash"])).code, 0);
    assert.match((await runCli(box, ["claude-guard", "--shell", "/bin/zsh"])).stdout, /^guard=on shell=\/bin\/zsh /);
    const masked = await shell(box, launcher, 'echo "t=$SECRET_FOR_TEST"');
    assert.equal(await masked.out(), "t=<redacted:GH_TOKEN>\n");
    assert.equal((await runCli(box, ["claude-guard", "--off"])).code, 0);
    for (const name of ["bash", "zsh"]) {
      const plain = await shell(box, join(dirname(launcher), name), 'echo "t=$SECRET_FOR_TEST"');
      assert.equal(await plain.out(), `t=${TOKEN}\n`, name);
    }
  }
  // The settings alone say whether it is on: a launcher they name masks, whatever else is there or not.
  await writeFile(settingsFile(box), JSON.stringify({ env: { CLAUDE_CODE_SHELL: launcher } }));
  await rm(join(dirname(launcher), "guard.json"));
  assert.match((await runCli(box, ["doctor"])).stdout, /^claude guard=on$/m);
  assert.equal(await (await shell(box, launcher, 'echo "t=$SECRET_FOR_TEST"')).out(), "t=<redacted:GH_TOKEN>\n");
  // Settings that cannot be read do not say it is off: nothing is run.
  for (const lose of [() => chmod(settingsFile(box), 0o000), () => rm(settingsFile(box), { force: true }), () => mkdir(settingsFile(box))]) {
    await lose();
    const unread = await shell(box, launcher, `echo ran > "${join(box.dir, "ran")}"; echo "t=$SECRET_FOR_TEST"`, { split: true });
    assert.equal(unread.code, 126);
    assert.equal(await unread.out(), "");
    assert.match(await unread.err(), /settings\.json cannot be read, so whether the guard is still on is not known and nothing was run\./);
    assert.ok(!existsSync(join(box.dir, "ran")));
  }
  await rm(settingsFile(box), { recursive: true });
  await writeFile(settingsFile(box), JSON.stringify({ env: { CLAUDE_CODE_SHELL: launcher } }));
  await rm(launcher);
  assert.match((await runCli(box, ["doctor"])).stdout, /^claude guard=broken \(.*\/bash is missing: run keyshroud claude-guard again\)$/m);

  // Two settings files: each has its own launcher and its own record of what was there before.
  const other = join(box.dir, "other-settings.json");
  await writeFile(other, JSON.stringify({ env: { CLAUDE_CODE_SHELL: "/bin/bash" } }));
  await writeFile(settingsFile(box), JSON.stringify({ model: "x" }));
  assert.equal((await runCli(box, ["claude-guard", "--shell", "/bin/bash"])).code, 0);
  assert.equal((await runCli(box, ["claude-guard", "--shell", "/bin/bash", "--settings", other])).code, 0);
  const theirs = (JSON.parse(await readFile(other, "utf8")) as { env: Record<string, string> }).env.CLAUDE_CODE_SHELL;
  assert.notEqual(theirs, launcher);
  assert.equal((await runCli(box, ["claude-guard", "--off", "--settings", other])).code, 0);
  assert.deepEqual(JSON.parse(await readFile(other, "utf8")), { env: { CLAUDE_CODE_SHELL: "/bin/bash" } });
  assert.equal(await (await shell(box, theirs, 'echo "t=$SECRET_FOR_TEST"')).out(), `t=${TOKEN}\n`);
  assert.equal(await (await shell(box, launcher, 'echo "t=$SECRET_FOR_TEST"')).out(), "t=<redacted:GH_TOKEN>\n");
  assert.equal((await runCli(box, ["claude-guard", "--off"])).code, 0);
  assert.deepEqual(await settings(box), { model: "x" });

  // No setting before: none is left behind.
  await writeFile(settingsFile(box), JSON.stringify({ model: "x" }));
  assert.equal((await runCli(box, ["claude-guard", "--shell", "/bin/bash"])).code, 0);
  assert.equal((await runCli(box, ["claude-guard", "--off"])).code, 0);
  assert.deepEqual(await settings(box), { model: "x" });
  const refused = await runCli(box, ["claude-guard", "--shell", "/bin/sh"]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /must be a bash or a zsh/);
});

test("a command that fails is masked as it prints, and keeps its exit status", posix, async () => {
  const { box, launcher } = await guarded();
  const failed = await shell(box, launcher, 'echo "token=$SECRET_FOR_TEST"; echo "error: $SECRET_FOR_TEST was refused" >&2; echo "shell=$SHELL"; echo again > /dev/stdout; exit 3');
  assert.equal(failed.code, 3);
  // One file for both, as Claude Code gives a command: in the order they were written.
  assert.equal(await failed.out(), "token=<redacted:GH_TOKEN>\nerror: <redacted:GH_TOKEN> was refused\nshell=/bin/bash\nagain\n");

  const split = await shell(box, launcher, 'echo "out $SECRET_FOR_TEST"; echo "err $SECRET_FOR_TEST" >&2; kill -TERM $$', { split: true });
  assert.equal(split.code, 143);
  assert.equal(await split.out(), "out <redacted:GH_TOKEN>\n");
  assert.equal(await split.err(), "err <redacted:GH_TOKEN>\n");

  // A value written in two parts, and one that is the last thing printed, with no line end.
  const parts = await shell(box, launcher, 'printf "a %s" "${SECRET_FOR_TEST%????????}"; sleep 0.05; printf "%s b\\n%s" "${SECRET_FOR_TEST#????????????????????}" "$SECRET_FOR_TEST"; exit 1');
  assert.equal(parts.code, 1);
  assert.equal(await parts.out(), "a <redacted:GH_TOKEN> b\n<redacted:GH_TOKEN>");
});

test("without a masking process that reads, the command is not run; one that stops takes the command with it", posix, async () => {
  const { box, launcher } = await guarded();
  const marker = join(box.dir, "ran");
  // Loaded by every node the launcher starts; only the masking process ends early.
  const stop = async (when: string) => { await writeFile(join(box.dir, "stop.cjs"), `if (process.argv.includes("--pump")) ${when};\n`); return { NODE_OPTIONS: `--require ${join(box.dir, "stop.cjs")}` }; };
  const never = await shell(box, launcher, `echo ran > "${marker}"; echo "t=$SECRET_FOR_TEST"`, { split: true, env: await stop("process.exit(7)") });
  assert.equal(never.code, 126);
  assert.equal(await never.out(), "");
  assert.match(await never.err(), /^keyshroud guard: the masking process could not be started, so nothing was run\./);
  assert.ok(!existsSync(marker));

  // What the shell started goes with it, also a child that does not end when asked to.
  const stubborn = `sh -c 'trap "" TERM; sleep 8; echo stubborn > "${marker}"'`;
  const started = Date.now();
  const cut = await shell(box, launcher, `echo "t=$SECRET_FOR_TEST"; (sleep 8; echo child > "${marker}") & ${stubborn}; echo ran > "${marker}"`, { split: true, env: await stop('setTimeout(() => { throw new Error("stopped"); }, 1500)') });
  assert.equal(cut.code, 126);
  assert.ok(Date.now() - started < 7000);
  assert.equal(await cut.out(), "t=<redacted:GH_TOKEN>\n");
  assert.match(await cut.err(), /the masking process stopped, so the command was stopped/);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  assert.ok(!existsSync(marker));
});

test("what a command leaves running does not keep it waiting, and is masked too", posix, async () => {
  const { box, launcher } = await guarded();
  const run = await shell(box, launcher, '(sleep 3; echo "late $SECRET_FOR_TEST") & echo first');
  assert.equal(run.code, 0);
  assert.equal(await run.out(), "first\n");
  assert.equal(await until(run.out, "late"), "first\nlate <redacted:GH_TOKEN>\n");
});

test("a value that joins the index while the command runs is masked; with no index the output passes", posix, async () => {
  const { box, launcher } = await guarded();
  assert.equal((await runCli(box, ["unwire", "--env", "GH_TOKEN"])).code, 0);
  await rm(join(box.configDir, "redact-index.json"));
  const plain = await shell(box, launcher, 'echo "nothing knows $SECRET_FOR_TEST"; exit 2');
  assert.equal(plain.code, 2);
  assert.equal(await plain.out(), `nothing knows ${TOKEN}\n`);

  // `get` adds what it is about to print: the pump was started before that.
  const cli = process.env.KEYSHROUD_TEST_CLI ? join(process.cwd(), process.env.KEYSHROUD_TEST_CLI) : new URL("../src/cli.ts", import.meta.url).pathname;
  const got = await shell(box, launcher, `sleep 0.3; "${process.env.KEYSHROUD_TEST_NODE || process.execPath}" "${cli}" get keyshroud://GitHub; echo; exit 1`);
  assert.equal(got.code, 1);
  assert.equal(await got.out(), "<redacted:GitHub>\n");
});

test("the index feed masks the same whatever the pieces, and holds back what could still become a value", () => {
  const multi = "-----BEGIN KEY-----\nAAAABBBBCCCCDDDDEEEEFFFFGGGG\nHHHHIIIIJJJJKKKKLLLLMMMMNNNN\n-----END KEY-----";
  const index = buildRedactIndex({ TOKEN, KEY: multi, SHORT: "abc123" });
  const text = `start ${TOKEN} middle ${TOKEN}${TOKEN} abc123\n${multi}\ntail ${TOKEN}`;
  const whole = redactWithIndex(text, index);
  assert.ok(!whole.includes(TOKEN) && whole.includes("<redacted:KEY>"));
  for (let at = 0; at <= text.length; at++) {
    const feed = createIndexFeed(() => index);
    assert.equal(feed.push(text.slice(0, at)) + feed.push(text.slice(at)) + feed.end(), whole, `cut at ${at}`);
  }
  // One character at a time.
  const feed = createIndexFeed(() => index);
  assert.equal([...text].map((ch) => feed.push(ch)).join("") + feed.end(), whole);

  // Nothing of a line that could still grow into a value goes, also when the output stops.
  const slow = createIndexFeed(() => index);
  assert.equal(slow.push(`done\nhalf ${TOKEN.slice(0, 10)}`) + slow.idle(), "done\n");
  assert.equal(slow.push(`${TOKEN.slice(10)}\n`) + slow.idle(), "half <redacted:TOKEN>\n");
  // A value of several lines that stops between two of them is masked by its long runs.
  const lines = multi.split("\n");
  const paused = createIndexFeed(() => index);
  const first = paused.push(`${lines[0]}\n${lines[1]}\n`) + paused.idle();
  assert.equal(first, `${lines[0]}\n<redacted:KEY>\n`);
  assert.ok(!(first + paused.push(`${lines[2]}\n${lines[3]}\n`) + paused.end()).includes(lines[2]));

  // An index that grows is the one that masks what comes after.
  let live = buildRedactIndex({ TOKEN });
  const growing = createIndexFeed(() => live);
  assert.equal(growing.push("x abc123-secret-later y\n") + growing.idle(), "x abc123-secret-later y\n");
  live = buildRedactIndex({ LATER: "abc123-secret-later" }, live);
  assert.equal(growing.push("x abc123-secret-later y\n") + growing.end(), "x <redacted:LATER> y\n");
});
