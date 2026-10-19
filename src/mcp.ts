// Minimal MCP stdio server (newline-delimited JSON-RPC 2.0). It gives any MCP
// client the same contract as the pi extension: names in, masked output out.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import process from "node:process";
import { BRAND } from "./brand.ts";
import * as core from "./core.ts";
import { createRedactor } from "./redact.ts";
import { ENV_NAME_RE, isLoaderEnvName, itemNameProblem } from "./refs.ts";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const OUTPUT_LIMIT = 256 * 1024;

const TOOLS = [
  {
    name: "secrets_list",
    description: "List the names of secrets wired for this machine. Never returns values.",
    inputSchema: { type: "object", properties: { env_file: { type: "string", description: "Optional dotenv file of bw:// references to include" } } },
  },
  {
    name: "secrets_run",
    description: "Run a shell command with vault secrets injected as environment variables. Secret values in stdout/stderr are replaced with <redacted:NAME>. Reference secrets as $NAME inside the command; never echo them.",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", description: "Shell command run with /bin/sh -c" },
        cwd: { type: "string", description: "Working directory" },
        only: { type: "array", items: { type: "string" }, description: "Inject only these names" },
        env_file: { type: "string", description: "Dotenv file of bw:// references to add" },
        timeout_ms: { type: "number", description: "Kill the command after this many milliseconds (default 120000)" },
      },
    },
  },
  {
    name: "secrets_request",
    description: "Ask the human to store a new secret. Opens a native hidden-input dialog on the user's desktop and stores the value in the vault; where no dialog can be shown, returns a terminal command for the user to run instead. The value never passes through the conversation.",
    inputSchema: {
      type: "object",
      required: ["env_name", "item_name"],
      properties: {
        env_name: { type: "string", description: "UPPER_SNAKE_CASE variable name" },
        item_name: { type: "string", description: "Vault item name to create" },
        purpose: { type: "string", description: "Short note stored with the item" },
      },
    },
  },
  {
    name: "vault_status",
    description: "Report vault lock state, server, and item count. Never returns values.",
    inputSchema: { type: "object", properties: {} },
  },
];

type Json = Record<string, unknown>;
function text(value: string, isError = false): Json { return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) }; }
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

async function collectEntries(envFile: unknown): Promise<Array<{ name: string; raw: string }>> {
  const entries = await core.authEnvEntries();
  if (typeof envFile === "string" && envFile) entries.push(...await core.envFileEntries(envFile));
  return [...new Map(entries.map((entry) => [entry.name, entry])).values()];
}

async function runTool(args: Json): Promise<Json> {
  if (typeof args.command !== "string" || !args.command.trim()) return text("command is required", true);
  let entries = await collectEntries(args.env_file);
  if (Array.isArray(args.only)) {
    const only = args.only.filter((name): name is string => typeof name === "string");
    const unknown = only.filter((name) => !entries.some((entry) => entry.name === name));
    if (unknown.length) return text(`Not wired: ${unknown.join(", ")}`, true);
    entries = entries.filter((entry) => only.includes(entry.name));
  }
  let vaultError = "";
  try { await core.ensureSession({ prompt: true }); } catch (error) { vaultError = error instanceof Error ? error.message : String(error); }
  const env = await core.resolveEntries(entries);
  await core.audit("run", Object.keys(env.secrets), "mcp");
  const redactor = createRedactor(await core.redactionValues(env.secrets));
  const timeout = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : 120000;
  // Own process group so a timeout kills everything the command started
  // (Windows: cmd.exe, and taskkill for the tree).
  const windows = process.platform === "win32";
  const child = spawn(windows ? process.env.ComSpec ?? join(core.SYSTEM32, "cmd.exe") : "/bin/sh", windows ? ["/d", "/s", "/c", `"${args.command}"`] : ["-c", args.command], {
    cwd: typeof args.cwd === "string" && args.cwd ? args.cwd : process.cwd(),
    env: core.childEnv(env.values),
    stdio: ["ignore", "pipe", "pipe"],
    detached: !windows,
    windowsVerbatimArguments: windows,
  });
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  // Collect generously per stream, mask, then truncate. If collection stopped
  // early, the tail may end inside a secret, so it is dropped before masking.
  const sizes = { stdout: 0, stderr: 0 };
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream].on("data", (chunk: Buffer) => {
      if (sizes[stream] >= OUTPUT_LIMIT * 2) return;
      sizes[stream] += chunk.length;
      chunks[stream].push(chunk);
    });
  }
  const timer = setTimeout(() => {
    if (windows) spawn(join(core.SYSTEM32, "taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }).on("error", () => {});
    else { try { process.kill(-child.pid!, "SIGTERM"); } catch {} }
  }, timeout);
  const code = await new Promise<string>((done) => {
    child.on("close", (exit, signal) => done(signal ? `signal ${signal}` : String(exit)));
    child.on("error", (error) => done(`spawn error: ${error.message}`));
  });
  clearTimeout(timer);
  let truncated = false;
  const out = (stream: "stdout" | "stderr") => {
    let raw = Buffer.concat(chunks[stream]).toString("utf8");
    if (sizes[stream] >= OUTPUT_LIMIT * 2) { truncated = true; raw = raw.slice(0, redactor.safeCut(raw)); }
    const masked = redactor.redact(raw);
    if (masked.length <= OUTPUT_LIMIT / 2) return masked;
    truncated = true;
    return masked.slice(0, OUTPUT_LIMIT / 2);
  };
  const stdout = out("stdout");
  const stderr = out("stderr");
  const lines = [
    `exit: ${code}`,
    env.missing.length ? `unresolved: ${env.missing.join(", ")}${vaultError ? ` (${vaultError})` : ""}` : null,
    `--- stdout ---\n${stdout}`,
    `--- stderr ---\n${stderr}`,
    truncated ? `[output truncated to ${OUTPUT_LIMIT / 2} characters per stream]` : null,
  ].filter((line): line is string => line !== null);
  return text(lines.join("\n"), code !== "0");
}

async function callTool(name: string, args: Json): Promise<Json> {
  if (name === "secrets_list") {
    let vaultError = "";
    try { await core.ensureSession(); } catch (error) { vaultError = error instanceof Error ? error.message : String(error); }
    const env = await core.resolveEntries(await collectEntries(args.env_file));
    const resolved = Object.keys(env.values);
    return text(`resolved: ${resolved.join(", ") || "none"}\nunresolved: ${env.missing.join(", ") || "none"}${env.missing.length && vaultError ? ` (${vaultError})` : ""}`);
  }
  if (name === "secrets_run") return runTool(args);
  if (name === "secrets_request") {
    const envName = String(args.env_name ?? "");
    const itemName = String(args.item_name ?? "");
    if (!ENV_NAME_RE.test(envName) || !itemName) return text("env_name must be UPPER_SNAKE_CASE and item_name is required", true);
    if (isLoaderEnvName(envName)) return text(`${envName} changes what programs load or run; it cannot be wired to a secret`, true);
    const problem = itemNameProblem(itemName);
    if (problem) return text(`item_name ${problem}`, true);
    const notes = typeof args.purpose === "string" && args.purpose ? args.purpose.slice(0, 500) : undefined;
    try {
      const reference = core.referenceFor(itemName);
      await core.ensureSession({ prompt: true });
      if ((await core.findItems(itemName)).some((item) => item.name.toLowerCase() === itemName.toLowerCase())) return text(`Vault item already exists: ${itemName}`, true);
      const secret = await core.readSecretFromDialog({ itemName, envName });
      if (secret === "") return text("The user saved an empty value; nothing was stored.", true);
      if (secret !== null) {
        await core.createSecretItem({ itemName, secret, envName, notes });
        await core.audit("request", [envName], "mcp");
        const conflicts: string[] = [];
        for (const path of Object.values(core.getAuthTargets())) if (!(await core.writeAuthEntry(path, envName, reference)).ok) conflicts.push(path);
        await core.refreshRedactIndex();
        if (conflicts.length) return text(`created item=${itemName}, but ${envName} is already wired to another secret in ${conflicts.join(", ")} and was left unchanged. Ask the user before running \`${BRAND.bin} wire --env ${envName} --item ${shellQuote(itemName)} --force\`.`, true);
        const verified = (await core.resolveShellValue(reference)) !== null;
        return text(`The user entered the value in a ${BRAND.name} dialog. created item=${itemName} env=${envName} verified=${verified ? "yes" : "no"}. Use secrets_run with $${envName}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return text(message === "Cancelled" ? "The user cancelled the dialog; nothing was stored." : message, true);
    }
    const purpose = notes ? ` --notes ${shellQuote(notes)}` : "";
    return text(`No dialog can be shown here. Ask the user to run this in their own terminal (the value is entered in a masked prompt; it must never be pasted into the chat):\n\n  ${BRAND.bin} add --env ${envName} --item ${shellQuote(itemName)}${purpose}\n\nAfter it reports verified=yes, use secrets_run with $${envName}.`);
  }
  if (name === "vault_status") {
    try { await core.ensureSession(); } catch {}
    const s = await core.getStatus();
    return text(`status=${s.status} server=${s.serverUrl ?? "unconfigured"} items=${s.items ?? "unknown"} bw=${s.version ?? "missing"} ${BRAND.bin}=${runningVersion ?? "unknown"}`);
  }
  return text(`Unknown tool: ${name}`, true);
}

async function handle(message: Json): Promise<Json | null> {
  const id = message.id;
  const method = message.method;
  const params = (message.params ?? {}) as Json;
  if (id === undefined || id === null) return null; // notification
  const reply = (result: Json) => ({ jsonrpc: "2.0", id, result });
  if (method === "initialize") {
    const requested = String(params.protocolVersion ?? "");
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    return reply({
      protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: BRAND.name, version: pkg.version },
      instructions: `Secrets live in the user's Vaultwarden. Use secrets_run to run commands that need them; values are masked as <redacted:NAME>. Never ask the user to paste a secret into the chat; use secrets_request.`,
    });
  }
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: TOOLS });
  if (method === "tools/call") {
    try { return reply(await callTool(String(params.name ?? ""), (params.arguments ?? {}) as Json)); } catch (error) {
      return reply(text(error instanceof Error ? error.message : String(error), true));
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(method)}` } };
}

// `npm i -g keyshroud@…` replaces the package under a running server. Once the
// version on disk differs from the code in memory, requests go to a server
// started from the new files (kept until the next update), so clients need no
// restart. That server keeps its own session and caches.
const PACKAGE_JSON = new URL("../package.json", import.meta.url);
const CLI_FILE = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url));
const DELEGATE_INIT_ID = `${BRAND.bin}-reload`;
let runningVersion: string | null = null;

async function diskVersion(): Promise<string | null> {
  try { return (JSON.parse(await readFile(PACKAGE_JSON, "utf8")) as { version?: string }).version ?? null; } catch { return null; }
}

interface Delegate { version: string; child: ChildProcessByStdio<Writable, Readable, null>; ready: Promise<boolean>; waiting: Set<unknown> }

function startDelegate(version: string, initParams: Json | undefined): Delegate {
  const child = spawn(process.execPath, [CLI_FILE, "mcp"], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  const waiting = new Set<unknown>();
  let settle: (ok: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => { settle = resolve; });
  child.stdin.on("error", () => {});
  child.on("error", () => settle(false));
  child.on("exit", () => {
    settle(false);
    // Requests it took but never answered.
    for (const id of waiting) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: `The updated ${BRAND.name} server stopped; restart the MCP client` } })}\n`);
    waiting.clear();
  });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    let message: Json;
    try { message = JSON.parse(line) as Json; } catch { return; }
    if (message.id === DELEGATE_INIT_ID) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      settle(true);
      return;
    }
    waiting.delete(message.id);
    process.stdout.write(`${line}\n`);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: DELEGATE_INIT_ID, method: "initialize", params: initParams ?? { protocolVersion: SUPPORTED_VERSIONS[0], capabilities: {}, clientInfo: { name: BRAND.name, version } } })}\n`);
  return { version, child, ready, waiting };
}

export async function serveMcp(): Promise<void> {
  const running = runningVersion = await diskVersion();
  let delegate: Delegate | null = null;
  let initParams: Json | undefined;
  // true when a server from newer files took the request.
  const forward = async (line: string, message: Json): Promise<boolean> => {
    const version = await diskVersion();
    if (!running || !version || version === running) return false;
    if (delegate?.version !== version) { delegate?.child.kill(); delegate = startDelegate(version, initParams); }
    const current = delegate;
    if (!(await current.ready)) return false;
    current.waiting.add(message.id);
    current.child.stdin.write(`${line}\n`);
    return true;
  };
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let message: Json;
    try { message = JSON.parse(line) as Json; } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
      continue;
    }
    if (message.method === "initialize") initParams = (message.params ?? undefined) as Json | undefined;
    const isRequest = message.id !== undefined && message.id !== null && message.method !== "initialize";
    const task = (isRequest ? forward(line, message) : Promise.resolve(false))
      .then(async (forwarded) => { if (forwarded) return; const response = await handle(message); if (response) process.stdout.write(`${JSON.stringify(response)}\n`); });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
  // Let the newer server answer what it has, then stop it.
  const last = delegate as Delegate | null;
  if (last) await new Promise((resolve) => { last.child.once("exit", resolve); last.child.stdin.end(); });
}
