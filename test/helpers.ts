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
    FAKE_CLIPBOARD: join(dir, "clipboard"),
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

export async function writeAuth(box: Sandbox, entries: Record<string, unknown>): Promise<void> {
  for (const path of [join(box.env.HOME, ".pi", "agent"), box.env.PI_CODING_AGENT_DIR]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "auth.json"), JSON.stringify(entries));
  }
}
