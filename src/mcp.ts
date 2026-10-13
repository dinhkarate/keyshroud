// Minimal MCP stdio server (newline-delimited JSON-RPC 2.0). It gives any MCP
// client the same contract as the pi extension: names in, masked output out.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import process from "node:process";
import { BRAND } from "./brand.ts";
import * as core from "./core.ts";
import { createRedactor } from "./redact.ts";
import { ENV_NAME_RE } from "./refs.ts";

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
    description: "Ask the human to store a new secret. Returns a terminal command for the user to run; the value is typed into a masked prompt and never passes through the conversation.",
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
  try { await core.ensureSession(); } catch {}
  const env = await core.resolveEntries(entries);
  await core.audit("run", Object.keys(env.secrets), "mcp");
  const redactor = createRedactor(await core.redactionValues(env.secrets));
  const timeout = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : 120000;
  // Own process group so a timeout kills everything the command started.
  const child = spawn("/bin/sh", ["-c", args.command], {
    cwd: typeof args.cwd === "string" && args.cwd ? args.cwd : process.cwd(),
    env: core.childEnv(env.values),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  // Collect generously, mask, then truncate, so a cut never splits a secret
  // before redaction.
  let size = 0;
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream].on("data", (chunk: Buffer) => {
      if (size >= OUTPUT_LIMIT * 4) return;
      size += chunk.length;
      chunks[stream].push(chunk);
    });
  }
  const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGTERM"); } catch {} }, timeout);
  const code = await new Promise<string>((done) => {
    child.on("close", (exit, signal) => done(signal ? `signal ${signal}` : String(exit)));
    child.on("error", (error) => done(`spawn error: ${error.message}`));
  });
  clearTimeout(timer);
  let truncated = size >= OUTPUT_LIMIT * 4;
  const out = (stream: "stdout" | "stderr") => {
    const masked = redactor.redact(Buffer.concat(chunks[stream]).toString("utf8"));
    if (masked.length <= OUTPUT_LIMIT / 2) return masked;
    truncated = true;
    return masked.slice(0, OUTPUT_LIMIT / 2);
  };
  const stdout = out("stdout");
  const stderr = out("stderr");
  const lines = [
    `exit: ${code}`,
    env.missing.length ? `unresolved: ${env.missing.join(", ")}` : null,
    `--- stdout ---\n${stdout}`,
    `--- stderr ---\n${stderr}`,
    truncated ? `[output truncated to ${OUTPUT_LIMIT / 2} characters per stream]` : null,
  ].filter((line): line is string => line !== null);
  return text(lines.join("\n"), code !== "0");
}

async function callTool(name: string, args: Json): Promise<Json> {
  if (name === "secrets_list") {
    try { await core.ensureSession(); } catch {}
    const env = await core.resolveEntries(await collectEntries(args.env_file));
    const resolved = Object.keys(env.values);
    return text(`resolved: ${resolved.join(", ") || "none"}\nunresolved: ${env.missing.join(", ") || "none"}`);
  }
  if (name === "secrets_run") return runTool(args);
  if (name === "secrets_request") {
    const envName = String(args.env_name ?? "");
    const itemName = String(args.item_name ?? "");
    if (!ENV_NAME_RE.test(envName) || !itemName) return text("env_name must be UPPER_SNAKE_CASE and item_name is required", true);
    const purpose = typeof args.purpose === "string" && args.purpose ? ` --notes ${shellQuote(args.purpose)}` : "";
    return text(`Ask the user to run this in their own terminal (the value is entered in a masked prompt; it must never be pasted into the chat):\n\n  ${BRAND.bin} add --env ${envName} --item ${shellQuote(itemName)}${purpose}\n\nAfter it reports verified=yes, use secrets_run with $${envName}.`);
  }
  if (name === "vault_status") {
    try { await core.ensureSession(); } catch {}
    const s = await core.getStatus();
    return text(`status=${s.status} server=${s.serverUrl ?? "unconfigured"} items=${s.items ?? "unknown"} bw=${s.version ?? "missing"}`);
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

export async function serveMcp(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let message: Json;
    try { message = JSON.parse(line) as Json; } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
      continue;
    }
    const task = handle(message).then((response) => { if (response) process.stdout.write(`${JSON.stringify(response)}\n`); });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
}
