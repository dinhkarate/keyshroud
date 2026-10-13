#!/usr/bin/env node
import { chmod, copyFile, mkdir, readdir, readFile, readlink, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { BRAND } from "./brand.ts";
import * as core from "./core.ts";
import { runClaudeHook } from "./hooks.ts";
import { serveMcp } from "./mcp.ts";
import { createRedactor, createRedactStream, redactWithIndex, type RedactIndex } from "./redact.ts";
import { ENV_NAME_RE, parseEnvFile, parseRef } from "./refs.ts";

const usage = `Usage: ${BRAND.bin} <command> [options]

Secrets
  get <ENV_NAME | bw://ref>        Print one resolved value to stdout
  run [--env-file F]... [--only A,B] [--no-auth] [--mask|--no-mask] -- <cmd> [args]
                                   Run a command with secrets injected (alias: exec)
  inject [-i template] [-o out]    Render {{ bw://ref }} placeholders
  redact                           Copy stdin to stdout with vault secrets masked
  scan [paths...]                  Find vault secret values in files (exit 1 on leaks)
  env [--shell]                    List wired names (or print shell exports)
  add --env NAME --item ITEM [--notes TEXT] [--target pi|omp|both] [--stdin]
  rotate --item ITEM [--stdin]
  wire --env NAME --item ITEM [--target pi|omp|both] [--force]
  unwire --env NAME [--target pi|omp|both]

Vault
  status | unlock | lock | doctor

Agents
  mcp                              Serve the MCP tools over stdio
  hook claude <event>              Claude Code hook entry point
  claude-setup --item ITEM [--settings PATH] [--ttl-ms N] [--force]
  api-key --item ITEM              Claude Code apiKeyHelper entry point
  link-cli [--dir DIR] [--force]`;

const targetPaths = core.getAuthTargets();
function fail(message: string, code: number): never { console.error(message); process.exit(code); }
function valueAfter(args: string[], flag: string): string | undefined { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }
function valuesAfter(args: string[], flag: string): string[] { return args.flatMap((arg, index) => (arg === flag && args[index + 1] !== undefined ? [args[index + 1]] : [])); }
function requireKnownFlags(args: string[], withValue: string[], bare: string[] = []): void {
  for (let i = 0; i < args.length; i++) {
    if (withValue.includes(args[i])) { if (args[i + 1] === undefined) fail(usage, 2); i++; continue; }
    if (!bare.includes(args[i])) fail(`Unknown argument: ${args[i]}\n\n${usage}`, 2);
  }
}
function targetList(value: string | undefined): string[] {
  if (!value || value === "both") return [targetPaths.omp, targetPaths.pi];
  if (value === "omp") return [targetPaths.omp];
  if (value === "pi") return [targetPaths.pi];
  fail("--target must be omp, pi, or both", 2);
}
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function failureCode(error: unknown): number {
  const text = error instanceof Error ? error.message : String(error);
  if (/already exists/.test(text)) return 5;
  if (/not found|Ambiguous|Empty secret|unresolved|No value|reference/i.test(text)) return 4;
  return 3;
}
async function authValue(name: string): Promise<string | null> {
  const merged = { ...(await core.readAuthEntries(targetPaths.pi)), ...(await core.readAuthEntries(targetPaths.omp)) };
  return core.resolveShellValue(core.authEntryRaw(merged[name]));
}
function timestamp(): string {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
async function readStdin(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

async function runCommand(args: string[]): Promise<void> {
  const separator = args.indexOf("--");
  if (separator < 0 || !args[separator + 1]) fail(usage, 2);
  const flags = args.slice(0, separator);
  const [command, ...commandArgs] = args.slice(separator + 1);
  requireKnownFlags(flags, ["--env-file", "--only"], ["--no-auth", "--mask", "--no-mask"]);

  const entries = flags.includes("--no-auth") ? [] : await core.authEnvEntries();
  for (const file of valuesAfter(flags, "--env-file")) {
    for (const { name, value } of parseEnvFile(await readFile(file, "utf8"))) entries.push({ name, raw: value });
  }
  const only = valueAfter(flags, "--only")?.split(",").map((name) => name.trim()).filter(Boolean);
  const selected = only ? entries.filter((entry) => only.includes(entry.name)) : entries;
  if (only) for (const name of only) if (!selected.some((entry) => entry.name === name)) fail(`Secret unresolved: ${name} is not wired`, 4);
  // Later sources win: env files override auth.json.
  const deduped = [...new Map(selected.map((entry) => [entry.name, entry])).values()];
  try { await core.ensureSession(); } catch {}
  const env = await core.resolveEntries(deduped);
  await core.audit("run", Object.keys(env.secrets), command);
  if (env.missing.length) console.error(`${BRAND.bin}: unresolved (names only): ${env.missing.join(", ")}`);

  // Mask by default whenever output is not a human terminal (agents, CI, pipes).
  const mask = flags.includes("--mask") || (!flags.includes("--no-mask") && !process.stdout.isTTY);
  const redactor = createRedactor(mask ? await core.redactionValues(env.secrets) : {});
  const child = spawn(command, commandArgs, { stdio: mask ? ["inherit", "pipe", "pipe"] : "inherit", env: { ...process.env, ...env.values } });
  if (mask) {
    child.stdout?.pipe(createRedactStream(redactor)).pipe(process.stdout);
    child.stderr?.pipe(createRedactStream(redactor)).pipe(process.stderr);
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  await new Promise<void>((done) => {
    child.on("close", (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); done(); });
    child.on("error", (error) => { console.error(error.message); process.exitCode = 127; done(); });
  });
}

async function inject(args: string[]): Promise<void> {
  requireKnownFlags(args, ["-i", "-o"], ["--force"]);
  const input = valueAfter(args, "-i");
  const output = valueAfter(args, "-o");
  const template = input ? await readFile(input, "utf8") : await readStdin();
  const pattern = /\{\{\s*(bw:\/\/[^\s}]+(?:\s+[^\s}]+)*?)\s*\}\}/g;
  const refs = [...new Set([...template.matchAll(pattern)].map((match) => match[1]))];
  const values = new Map<string, string>();
  await Promise.all(refs.map(async (raw) => {
    const ref = parseRef(raw);
    const value = ref ? await core.resolveRef(ref) : null;
    if (value === null) throw new Error(`Secret reference unresolved: ${raw}`);
    values.set(raw, value);
  }));
  await core.audit("inject", refs, output ?? "stdout");
  const rendered = template.replace(pattern, (_match, raw: string) => values.get(raw) ?? "");
  if (!output) { process.stdout.write(rendered); return; }
  try { await readFile(output); if (!args.includes("--force")) fail(`Refusing to overwrite ${output}; use --force`, 5); } catch {}
  await writeFile(output, rendered, { mode: 0o600 });
  await chmod(output, 0o600);
  console.error(`rendered ${refs.length} reference(s) into ${output} (mode 0600)`);
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next", ".venv"]);

async function* walk(path: string): AsyncGenerator<string> {
  const info = await stat(path);
  if (info.isFile()) { if (info.size <= 2 * 1024 * 1024) yield path; return; }
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path)) if (!SKIP_DIRS.has(entry)) yield* walk(join(path, entry));
}

async function scan(paths: string[]): Promise<void> {
  let index: RedactIndex | null = null;
  try {
    await core.ensureSession();
    const env = await core.resolveEntries(await core.authEnvEntries());
    index = await core.writeRedactIndex(await core.redactionValues(env.secrets));
  } catch { index = await core.readRedactIndex(); }
  if (!index) fail("No vault snapshot or redact index available; unlock first", 3);
  let leaks = 0;
  for (const root of paths.length ? paths : ["."]) {
    for await (const file of walk(root)) {
      const content = await readFile(file, "utf8").catch(() => "");
      if (content.includes("\u0000")) continue;
      content.split("\n").forEach((line, number) => {
        const redacted = redactWithIndex(line, index);
        if (redacted === line) return;
        const names = [...redacted.matchAll(/<redacted:([^>]+)>/g)].map((match) => match[1]);
        for (const name of names) { leaks++; console.log(`${file}:${number + 1} ${name}`); }
      });
    }
  }
  console.error(`${leaks} leaked secret value(s) found`);
  if (leaks) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2); const command = args.shift();
  if (!command || command === "--help" || command === "-h" || command === "help") { console.log(usage); if (!command) process.exitCode = 2; return; }
  if (command === "--version" || command === "-v") {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    console.log(pkg.version); return;
  }
  try {
    if (command === "status") {
      try { await core.ensureSession(); } catch {}
      const s = await core.getStatus();
      console.log(`server=${s.serverUrl ?? "unconfigured"} status=${s.status} items=${s.items ?? "unknown"} bw=${s.version ?? "missing"}`);
      if (s.status !== "unlocked") process.exitCode = 3;
      return;
    }
    if (command === "unlock") { await core.ensureSession(); console.log("unlocked"); return; }
    if (command === "lock") { requireKnownFlags(args, []); await core.lock(); console.log("locked"); return; }
    if (command === "scan") { await scan(args); return; }
    if (command === "env") {
      if (args.some((arg) => arg !== "--shell")) fail(usage, 2);
      const map = await core.buildEnvMap();
      if (args.includes("--shell")) for (const [name, value] of Object.entries(map)) console.log(`export ${name}=${shellQuote(value)}`);
      else for (const name of Object.keys(map)) console.log(name);
      return;
    }
    if (command === "get") {
      if (args.length !== 1) fail(usage, 2);
      const ref = parseRef(args[0]);
      const value = ref ? await core.resolveRef(ref) : await authValue(args[0]);
      if (value === null) fail(`Secret unresolved: ${args[0]}`, 4);
      await core.audit("get", [args[0]], "cli");
      process.stdout.write(value); return;
    }
    if (command === "run" || command === "exec") { await runCommand(args); return; }
    if (command === "inject") { await inject(args); return; }
    if (command === "redact") {
      requireKnownFlags(args, []);
      try { await core.ensureSession(); } catch {}
      const env = await core.resolveEntries(await core.authEnvEntries());
      const redactor = createRedactor(await core.redactionValues(env.secrets));
      process.stdin.pipe(createRedactStream(redactor)).pipe(process.stdout);
      return;
    }
    if (command === "mcp") { requireKnownFlags(args, []); await serveMcp(); return; }
    if (command === "hook") {
      if (args[0] !== "claude" || !args[1]) fail(usage, 2);
      process.stdout.write(await runClaudeHook(args[1], await readStdin()));
      return;
    }
    if (command === "api-key") {
      requireKnownFlags(args, ["--item"]);
      const item = valueAfter(args, "--item"); if (!item) fail(usage, 2);
      await core.ensureSession(); process.stdout.write(await core.getSecret(item)); return;
    }
    if (command === "add") {
      requireKnownFlags(args, ["--env", "--item", "--notes", "--target"], ["--stdin"]);
      const envName = valueAfter(args, "--env"); const itemName = valueAfter(args, "--item"); const notes = valueAfter(args, "--notes");
      if (!envName || !itemName || !ENV_NAME_RE.test(envName)) fail(usage, 2);
      const reference = core.referenceFor(itemName);
      const targets = targetList(valueAfter(args, "--target"));
      await core.ensureSession();
      const secret = await core.readSecretFromInput({ prompt: `Paste secret for ${envName}: `, stdin: args.includes("--stdin") });
      await core.createSecretItem({ itemName, secret, envName, notes });
      let conflict = false;
      for (const path of targets) { const result = await core.writeAuthEntry(path, envName, reference); if (!result.ok) conflict = true; }
      const verified = (await core.resolveShellValue(reference)) !== null;
      console.log(`created item=${itemName} env=${envName} targets=${targets.join(",")} verified=${verified ? "yes" : "no"}`);
      if (conflict) { console.error("Item created, but one or more auth targets already contained the environment name."); process.exitCode = 5; }
      return;
    }
    if (command === "rotate") {
      requireKnownFlags(args, ["--item"], ["--stdin"]);
      const itemName = valueAfter(args, "--item"); if (!itemName) fail(usage, 2);
      await core.ensureSession(); const secret = await core.readSecretFromInput({ prompt: "Paste replacement secret: ", stdin: args.includes("--stdin") });
      await core.rotateSecretItem({ itemName, secret }); console.log(`rotated item=${itemName}`); return;
    }
    if (command === "wire") {
      requireKnownFlags(args, ["--env", "--item", "--target"], ["--force"]);
      const envName = valueAfter(args, "--env"); const itemName = valueAfter(args, "--item");
      if (!envName || !itemName || !ENV_NAME_RE.test(envName)) fail(usage, 2);
      const reference = core.referenceFor(itemName);
      const targets = targetList(valueAfter(args, "--target"));
      for (const path of targets) { const result = await core.writeAuthEntry(path, envName, reference, { overwrite: args.includes("--force") }); if (!result.ok) fail(result.message, 5); }
      console.log(`wired env=${envName} item=${itemName} targets=${targets.join(",")}`); return;
    }
    if (command === "unwire") {
      requireKnownFlags(args, ["--env", "--target"]);
      const envName = valueAfter(args, "--env"); if (!envName) fail(usage, 2);
      const targets = targetList(valueAfter(args, "--target")); const names: string[] = [];
      for (const path of targets) if (await core.deleteAuthEntry(path, envName)) names.push(path);
      console.log(`removed env=${envName} targets=${names.join(",") || "none"}`); return;
    }
    if (command === "link-cli") {
      requireKnownFlags(args, ["--dir"], ["--force"]);
      const dir = resolve(valueAfter(args, "--dir") ?? join(homedir(), ".local", "bin")); const destination = join(dir, BRAND.bin);
      await mkdir(dir, { recursive: true }); const source = fileURLToPath(import.meta.url);
      try {
        const linked = await readlink(destination);
        if (resolve(dir, linked) !== source && !args.includes("--force")) fail(`Refusing existing different symlink: ${destination}`, 5);
        await unlink(destination);
      } catch (error) { if ((error as { code?: string }).code !== "ENOENT") { if (!args.includes("--force")) fail(`Refusing existing path: ${destination}`, 5); await unlink(destination).catch(() => {}); } }
      await symlink(source, destination); await chmod(source, 0o755); console.log(destination); return;
    }
    if (command === "claude-setup") {
      requireKnownFlags(args, ["--item", "--settings", "--ttl-ms"], ["--force"]);
      const itemName = valueAfter(args, "--item"); if (!itemName) fail(usage, 2);
      const settingsPath = resolve(valueAfter(args, "--settings") ?? join(homedir(), ".claude", "settings.json"));
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      if (settings.apiKeyHelper && !args.includes("--force")) fail("apiKeyHelper already set; use --force to replace it", 5);
      await copyFile(settingsPath, `${settingsPath}.bak-${timestamp()}`);
      const cliPath = fileURLToPath(import.meta.url); settings.apiKeyHelper = `${shellQuote(process.execPath)} ${shellQuote(cliPath)} api-key --item ${shellQuote(itemName)}`;
      const ttl = valueAfter(args, "--ttl-ms"); if (ttl) { if (!/^\d+$/.test(ttl)) fail(usage, 2); settings.env = { ...(settings.env as Record<string, unknown> ?? {}), CLAUDE_CODE_API_KEY_HELPER_TTL_MS: ttl }; }
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 }); console.log(`configured apiKeyHelper for item=${itemName}`); return;
    }
    if (command === "doctor") {
      requireKnownFlags(args, []);
      const s = await core.getStatus(); console.log(`bw version=${s.version ?? "missing (install @bitwarden/cli)"}`); console.log(`bw server=${s.serverUrl ?? "unconfigured (run: bw config server <url>)"}`); console.log(`session=${s.status}`);
      for (const [service, present] of Object.entries(await core.keychainPresence())) console.log(`keychain ${service}=${present ? "present" : "missing"}`);
      for (const path of [targetPaths.omp, targetPaths.pi]) for (const name of Object.keys(await core.readAuthEntries(path))) console.log(`${path} ${name} resolved=${(await authValue(name)) ? "yes" : "no"}`);
      console.log(`redact index=${(await core.readRedactIndex()) ? "present" : "missing"}`);
      const settings = JSON.parse(await readFile(join(homedir(), ".claude", "settings.json"), "utf8").catch(() => "{}")) as Record<string, unknown>;
      console.log(`apiKeyHelper wired=${settings.apiKeyHelper ? "yes" : "no"}`); if (s.status !== "unlocked") process.exitCode = 3; return;
    }
    fail(usage, 2);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = failureCode(error); }
}
void main();
