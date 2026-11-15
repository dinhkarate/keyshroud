#!/usr/bin/env node
// The shell Claude Code starts while `keyshroud claude-guard` is on, through a launcher that
// names the fingerprint index, the real shell and this file. The real shell runs with the same
// arguments; what it prints goes through a pump that masks it from the index as it arrives, so
// the output of a command that fails is masked like any other (a PostToolUse hook never sees
// that one). The pump is a process of its own: it goes on for whatever the command left
// running, while this one ends with the shell.
//
// Nothing here reads the vault: like the hook, it knows values by their fingerprints only.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, createReadStream, existsSync, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { constants as os, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { BRAND } from "./brand.ts";
import { createIndexFeed, type RedactIndex } from "./redact.ts";

// How long the shell's end waits for the pump to write the last of the output, when something
// the command started still holds the output open.
const LINGER_MS = 500;
// Output that stops this long lets its whole lines go (see createIndexFeed).
const IDLE_MS = 200;
// How long the pump may take to say it is reading, before the command is refused.
const READY_MS = 10000;
// How long a command whose pump stopped gets to end by itself before it is killed.
const STOP_MS = 2000;

// The index as it is now: `keyshroud get` adds what it is about to print while the command runs.
function liveIndex(file: string): () => RedactIndex {
  let stamp = "";
  let index: RedactIndex = { v: 1, key: "", entries: [] };
  return () => {
    try {
      const info = statSync(file);
      const now = `${info.ino}:${info.size}:${info.mtimeMs}`;
      if (now !== stamp) {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as RedactIndex;
        if (parsed?.v === 1 && Array.isArray(parsed.entries)) index = parsed;
        stamp = now;
      }
    } catch {}
    return index;
  };
}

// Input 0 is copied to stdout, input 3 (when stderr is another file) to stderr. Descriptor 4 is
// told once everything is in place: the shell is not started before that.
function pump(indexFile: string, inputs: number): void {
  const index = liveIndex(indexFile);
  // The signals that end the command do not end the pump: it ends once nothing can write any more.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});
  for (const output of [process.stdout, process.stderr]) output.on("error", () => {});
  // A pump that cannot go on ends at once, so that the guard stops the command: an exit would
  // first wait for the read it is blocked in, which ends only when the command does.
  process.on("uncaughtException", () => process.kill(process.pid, "SIGKILL"));
  for (let i = 0; i < inputs; i++) {
    // Read as a file: on macOS an event loop is not told when the last writer of a named pipe goes.
    const input = createReadStream("", { fd: i ? 3 : 0 });
    const output = i ? process.stderr : process.stdout;
    const decoder = new StringDecoder("utf8");
    const feed = createIndexFeed(index);
    let idle: ReturnType<typeof setTimeout> | undefined;
    const write = (text: string) => { if (text) output.write(text); };
    input.on("data", (chunk: Buffer) => {
      clearTimeout(idle);
      write(feed.push(decoder.write(chunk)));
      idle = setTimeout(() => write(feed.idle()), IDLE_MS);
    });
    const finish = () => { clearTimeout(idle); write(feed.push(decoder.end()) + feed.end()); };
    input.on("end", finish);
    input.on("error", finish);
  }
  try { writeSync(4, "ready\n"); closeSync(4); } catch {}
}

// Whether both descriptors are one file, as Claude Code's are for a command: then one pipe keeps
// the order of what was written to either. Sockets that cannot be told apart count as two.
function sameFile(a: number, b: number): boolean {
  try { const x = fstatSync(a, { bigint: true }), y = fstatSync(b, { bigint: true }); return x.ino !== 0n && x.ino === y.ino && x.dev === y.dev; } catch { return false; }
}

// The system's own tools, whatever PATH the command was given.
const tool = (name: string) => [`/bin/${name}`, `/usr/bin/${name}`].find((path) => existsSync(path));
// Every process with its parent: from /proc where there is one, else from ps.
const PROC = existsSync("/proc/self/stat");
function processes(): number[][] {
  if (!PROC) return execFileSync(tool("ps")!, ["-A", "-o", "pid=,ppid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).split("\n").map((row) => row.trim().split(/\s+/).map(Number));
  const rows: number[][] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    // "pid (name) state parent …": the name may hold anything, so count from its last bracket.
    try { const stat = readFileSync(`/proc/${name}/stat`, "utf8"); rows.push([Number(name), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])]); } catch {}
  }
  return rows;
}
// A process and everything it started that still has it as an ancestor, parents before children;
// null when the processes cannot be listed.
function tree(root: number): number[] | null {
  const found = [root];
  try {
    const rows = processes();
    for (let i = 0; i < found.length; i++) for (const [pid, parent] of rows) if (parent === found[i] && !found.includes(pid)) found.push(pid);
  } catch { return null; }
  return found;
}
function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of [...pids].reverse()) { try { process.kill(pid, signal); } catch {} }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

function guard(indexFile: string, shell: string, args: string[]): void {
  const refused = (why: string): never => {
    process.stderr.write(`${BRAND.bin} guard: ${why}, so nothing was run. \`${BRAND.bin} claude-guard --off\` turns the guard off.\n`);
    process.exit(126);
  };
  // Should the pump stop, the command is stopped with all it started: that needs the processes listed.
  if (!PROC && !tool("ps")) refused("there is neither /proc nor ps to list processes with");
  // Named pipes, not the sockets Node gives a child: a command can open /dev/stdout on a pipe.
  const names = sameFile(1, 2) ? ["out"] : ["out", "err"];
  const read: number[] = [], write: number[] = [];
  let dir = "";
  try {
    dir = mkdtempSync(join(tmpdir(), `${BRAND.bin}-guard-`));
    execFileSync(tool("mkfifo") ?? "mkfifo", ["-m", "600", ...names.map((name) => join(dir, name))], { stdio: "ignore" });
    for (const name of names) {
      // A reading end that does not wait for a writer, so the writing end opens at once; then the
      // one the pump gets, which waits in its reads as a file does.
      const first = openSync(join(dir, name), constants.O_RDONLY | constants.O_NONBLOCK);
      write.push(openSync(join(dir, name), constants.O_WRONLY));
      read.push(openSync(join(dir, name), constants.O_RDONLY));
      closeSync(first);
    }
  } catch (error) { refused(`its pipes could not be made (${(error as NodeJS.ErrnoException).code ?? "error"})`); }
  finally { if (dir) rmSync(dir, { recursive: true, force: true }); }

  const pumping = spawn(process.execPath, [fileURLToPath(import.meta.url), "--pump", indexFile, String(names.length)], {
    detached: true, stdio: [read[0], "inherit", "inherit", read[1] ?? "ignore", "pipe"],
  });
  for (const fd of read) closeSync(fd);
  pumping.on("error", () => {});
  if (!pumping.pid) { for (const fd of write) closeSync(fd); refused("the masking process could not be started"); }
  let child: ChildProcess | null = null;
  // The pump's end: before it said it was reading, nothing is run; with an error while the
  // command runs, the command is stopped, since nothing reads what it prints any more.
  let pumped = false, broken = false;
  pumping.on("exit", (code, signal) => {
    pumped = true;
    const running = child as ChildProcess | null;
    if (!running) { for (const fd of write) closeSync(fd); return refused("the masking process could not be started"); }
    if ((code || signal) && running.pid && running.exitCode === null && running.signalCode === null) {
      broken = true;
      // The shell and what it started, asked to end and then made to: as they are now, since
      // once the shell is gone nothing says any more what it had started.
      const listed = tree(running.pid);
      const started = listed ?? [running.pid];
      process.stderr.write(`${BRAND.bin} guard: the masking process stopped, so ${listed ? "the command was stopped" : "the shell was stopped (what it started could not be listed, and may still run)"}; what it printed after that is lost.\n`);
      signalAll(started, "SIGTERM");
      const end = () => process.exit(126);
      const killed = setTimeout(() => {
        const left = started.filter(alive);
        const since = left.map(tree);
        if (listed && since.includes(null)) process.stderr.write(`${BRAND.bin} guard: what the command started since could not be listed, and may still run.\n`);
        signalAll([...new Set([...left, ...since.flatMap((pids) => pids ?? [])])], "SIGKILL");
        setTimeout(end, LINGER_MS);
      }, STOP_MS);
      // Sooner, once none of them is left.
      const watch = setInterval(() => { if (!started.some(alive)) { clearTimeout(killed); clearInterval(watch); end(); } }, 100);
    }
  });
  const late = setTimeout(() => { pumping.kill("SIGKILL"); }, READY_MS);
  const leave = (code: number) => {
    if (pumped) process.exit(code);
    pumping.on("exit", () => process.exit(code));
    setTimeout(() => process.exit(code), LINGER_MS);
  };
  const ready = pumping.stdio[4] as Readable;
  ready.on("error", () => {});
  ready.once("data", () => {
    clearTimeout(late);
    ready.destroy();
    // Programs the command starts get the real shell, not the launcher Claude Code named.
    child = spawn(shell, args, { stdio: ["inherit", write[0], write[names.length - 1]], env: { ...process.env, SHELL: shell } });
    for (const fd of write) closeSync(fd);
    const running = child;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => running.kill(signal));
    child.on("error", (error: NodeJS.ErrnoException) => {
      process.stderr.write(`${BRAND.bin} guard: could not start ${shell} (${error.code ?? "error"})\n`);
      leave(127);
    });
    // With the pump gone, the end is the one of everything the shell started (above).
    child.on("exit", (code, signal) => { if (!broken) leave(code ?? 128 + (signal ? os.signals[signal] ?? 0 : 1)); });
  });
}

const [first, second, ...rest] = process.argv.slice(2);
if (first === "--pump" && second) pump(second, Number(rest[0]) === 2 ? 2 : 1);
else if (first && second) guard(first, second, rest);
else { process.stderr.write(`${BRAND.bin} guard: started by the launcher that \`${BRAND.bin} claude-guard\` writes\n`); process.exit(2); }
