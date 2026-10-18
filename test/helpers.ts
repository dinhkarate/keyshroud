import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "../src/brand.ts";

export const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

export interface Sandbox {
  dir: string;
  env: Record<string, string>;
  vaultFile: string;
  logFile: string;
  configDir: string;
  bwCalls(): Promise<string[]>;
  vault(): Promise<{ items: Array<Record<string, unknown>> }>;
}

export function item(id: string, name: string, password: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name, type: 1, notes: null, login: { username: "agent", password, uris: [] }, fields: [], ...extra };
}

export async function sandbox(items: Array<Record<string, unknown>>, opts: { locked?: boolean } = {}): Promise<Sandbox> {
  const dir = await mkdtemp(join(tmpdir(), "vault-test-"));
  const home = join(dir, "home");
  const configDir = join(dir, "config");
  const keychain = join(dir, "keychain");
  await mkdir(home, { recursive: true });
  await mkdir(keychain, { recursive: true });
  await writeFile(join(keychain, "vaultwarden-master-password"), "master\n");
  const vaultFile = join(dir, "vault.json");
  const logFile = join(dir, "bw.log");
  await writeFile(vaultFile, JSON.stringify({ status: opts.locked === false ? "unlocked" : "locked", items }));
  await writeFile(logFile, "");
  const env: Record<string, string> = {
    PATH: `${FIXTURES}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    USER: "tester",
    FAKE_BW_VAULT: vaultFile,
    FAKE_BW_LOG: logFile,
    FAKE_KEYCHAIN_DIR: keychain,
    FAKE_OPENED: join(dir, "opened"),
    [`${BRAND.envPrefix}_CONFIG_DIR`]: configDir,
    // No background lock timers outliving the test run; one test turns it back on.
    [`${BRAND.envPrefix}_LOCK_TIMER`]: "0",
    PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
  };
  return {
    dir, env, vaultFile, logFile, configDir,
    async bwCalls() { return (await readFile(logFile, "utf8")).split("\n").filter(Boolean); },
    async vault() { return JSON.parse(await readFile(vaultFile, "utf8")); },
  };
}

export interface RunResult { code: number | null; stdout: string; stderr: string }

export function runCli(box: Sandbox, args: string[], input?: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...box.env, ...extraEnv }, cwd: box.dir });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

// Runs the CLI on a pseudo-terminal (python3 pty) and types `typed` plus Enter
// once `waitFor` appears. Output is merged, as on a terminal.
const PTY_SCRIPT = `
import os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[3], sys.argv[3:])
out, typed, deadline = b"", False, time.time() + 30
while True:
    if not select.select([fd], [], [], max(0, deadline - time.time()))[0]:
        os.kill(pid, signal.SIGKILL)
        break
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    if not typed and sys.argv[1].encode() in out:
        os.write(fd, sys.argv[2].encode() + b"\\r")
        typed = True
sys.stdout.write(out.decode(errors="replace"))
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
`;

export function runCliTty(box: Sandbox, args: string[], waitFor: string, typed: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", PTY_SCRIPT, waitFor, typed, process.execPath, CLI, ...args], { env: { ...box.env, ...extraEnv }, cwd: box.dir });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", () => resolve({ code: null, stdout, stderr: "python3 missing" }));
  });
}

export async function writeAuth(box: Sandbox, entries: Record<string, unknown>): Promise<void> {
  for (const path of [join(box.env.HOME, ".pi", "agent"), box.env.PI_CODING_AGENT_DIR]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "auth.json"), JSON.stringify(entries));
  }
}
