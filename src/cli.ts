#!/usr/bin/env node
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, lstat, readdir, readFile, readlink, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { constants, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { BRAND } from "./brand.ts";
import * as core from "./core.ts";
import { runClaudeHook } from "./hooks.ts";
import { serveMcp } from "./mcp.ts";
import { buildRedactIndex, compileRedactIndex, createRedactor, createRedactStream, type RedactIndex } from "./redact.ts";
import { ENV_NAME_RE, isLoaderEnvName, isRef, itemNameProblem, looksSecret, parseDotenvStrict, parseRef, type DotenvEntry } from "./refs.ts";

const usage = `Usage: ${BRAND.bin} <command> [options]

Secrets
  get <ENV_NAME | bw://ref>        Print one resolved value to stdout
  run [--env-file F]... [--only A,B] [--no-auth] [--mask|--no-mask] -- <cmd> [args]
                                   Run a command with secrets injected (alias: exec)
  inject [-i template] [-o out] [--force]
                                   Render {{ bw://ref }} placeholders
  redact                           Copy stdin to stdout with vault secrets masked
  scan [paths...]                  Find vault secret values in files (exit 1 on leaks)
  env [--shell]                    List wired names (or print shell exports)
  add --env NAME --item ITEM [--notes TEXT] [--target pi|omp|both] [--stdin|--dialog]
  import [--from F|-] [--out F] [--prefix P] [--only A,B] [--skip A,B] [--yes] [--replace] [--force]
                                   Move secrets from a .env into the vault and write .env.refs
                                   (dry run unless --yes; prints names only)
  rotate --item ITEM [--stdin|--dialog]
  wire --env NAME --item ITEM [--target pi|omp|both] [--force]
  unwire --env NAME [--target pi|omp|both]

Vault
  setup --email EMAIL [--server URL] [--confirm-unlock | --unattended] [--registered]
                                   Give ${BRAND.name} its own bw login on a dedicated agent account
  migrate [--item NAME]... [--env-file F]... [--yes]
                                   Copy the wired items from your personal vault to that account
                                   (dry run unless --yes; prints names only)
  unlock [--unattended]            Unlock now (asks unless a master password is stored);
                                   the session ends after 30 minutes
                                   (--unattended: no end, for hosts nobody sits at; in a terminal)
  status | lock | doctor

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
// --stdin: piped value. Terminal: masked prompt. Otherwise (an agent's shell):
// a native dialog, so the agent can start the command and the user only pastes.
async function readSecret(args: string[], prompt: string, itemName: string, envName?: string): Promise<string> {
  if (args.includes("--stdin")) return core.readSecretFromInput({ prompt, stdin: true });
  if (process.stdin.isTTY && !args.includes("--dialog")) return core.readSecretFromInput({ prompt, stdin: false });
  const value = await core.readSecretFromDialog({ itemName, envName });
  if (value) return value;
  if (value === "") throw new Error("Empty secret");
  fail("No terminal and no dialog here (SSH or no display). Run the command in a terminal, or pipe the value with --stdin.", 2);
}
function checkNames(envName: string, itemName: string): void {
  if (isLoaderEnvName(envName)) fail(`${envName} changes what programs load or run; it cannot be wired to a secret`, 2);
  const problem = itemNameProblem(itemName);
  if (problem) fail(`Vault item name ${problem}`, 2);
}
// bw 2026.9+ posts the user key id to an endpoint Vaultwarden lacks (vaultwarden#7750).
function vaultwardenTooNew(version: string | null, server: string | null): boolean {
  const [year, month] = (version ?? "").split(".").map(Number);
  const selfHosted = Boolean(server) && !/^https:\/\/([^/]+\.)?bitwarden\.(com|eu)(\/|$)/.test(server!);
  return selfHosted && (year > 2026 || (year === 2026 && month >= 9));
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
  for (const file of valuesAfter(flags, "--env-file")) entries.push(...await core.envFileEntries(file));
  const only = valueAfter(flags, "--only")?.split(",").map((name) => name.trim()).filter(Boolean);
  const selected = only ? entries.filter((entry) => only.includes(entry.name)) : entries;
  if (only) for (const name of only) if (!selected.some((entry) => entry.name === name)) fail(`Secret unresolved: ${name} is not wired`, 4);
  // Later sources win: env files override auth.json.
  const deduped = [...new Map(selected.map((entry) => [entry.name, entry])).values()];
  let vaultError = "";
  try { await core.ensureSession({ prompt: true }); } catch (error) { vaultError = error instanceof Error ? error.message : String(error); }
  const env = await core.resolveEntries(deduped);
  await core.audit("run", Object.keys(env.secrets), command);
  if (env.missing.length) console.error(`${BRAND.bin}: unresolved (names only): ${env.missing.join(", ")}${vaultError ? ` (${vaultError})` : ""}`);

  // Mask by default whenever output is not a human terminal (agents, CI, pipes).
  const mask = flags.includes("--mask") || (!flags.includes("--no-mask") && !process.stdout.isTTY);
  const redactor = createRedactor(mask ? await core.redactionValues(env.secrets) : {});
  // Agents started through `run` (e.g. `keyshroud run -- claude`) rely on the
  // hook index, so it must cover env-file values too.
  if (Object.keys(env.secrets).length) { try { await core.writeRedactIndex(core.indexValues(env.secrets)); } catch {} }
  let target: core.Invocation;
  try { target = core.invocation(command, commandArgs); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 127; return; }
  const child = spawn(target.command, target.args, { stdio: mask ? ["inherit", "pipe", "pipe"] : "inherit", env: core.childEnv(env.values), windowsVerbatimArguments: target.verbatim });
  if (mask) {
    child.stdout?.pipe(createRedactStream(redactor)).pipe(process.stdout);
    child.stderr?.pipe(createRedactStream(redactor)).pipe(process.stderr);
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  await new Promise<void>((done) => {
    let failed = false;
    child.on("close", (code, signal) => { if (!failed) process.exitCode = code ?? 128 + (signal ? constants.signals[signal] ?? 0 : 1); done(); });
    child.on("error", (error) => { failed = true; console.error(error.message); process.exitCode = 127; done(); });
  });
}

async function inject(args: string[]): Promise<void> {
  requireKnownFlags(args, ["-i", "-o"], ["--force"]);
  const input = valueAfter(args, "-i");
  const output = valueAfter(args, "-o");
  const template = input ? await readFile(input, "utf8") : await readStdin();
  let vaultError = "";
  try { await core.ensureSession({ prompt: true }); } catch (error) { vaultError = error instanceof Error ? error.message : String(error); }
  const pattern = /\{\{\s*(bw:\/\/[^\s}]+(?:\s+[^\s}]+)*?)\s*\}\}/g;
  const refs = [...new Set([...template.matchAll(pattern)].map((match) => match[1]))];
  const values = new Map<string, string>();
  await Promise.all(refs.map(async (raw) => {
    const ref = parseRef(raw);
    const value = ref ? await core.resolveRef(ref) : null;
    if (value === null) throw new Error(`Secret reference unresolved: ${raw}${vaultError ? ` (${vaultError})` : ""}`);
    values.set(raw, value);
  }));
  await core.audit("inject", refs, output ?? "stdout");
  const rendered = template.replace(pattern, (_match, raw: string) => values.get(raw) ?? "");
  if (!output) { process.stdout.write(rendered); return; }
  // lstat, and a private temp file renamed over the target, so a planted
  // symlink (even a dangling one) is replaced instead of followed.
  const exists = await lstat(output).then(() => true, () => false);
  if (exists && !args.includes("--force")) fail(`Refusing to overwrite ${output}; use --force`, 5);
  const tmp = join(dirname(resolve(output)), `.${basename(output)}.tmp.${randomBytes(6).toString("hex")}`);
  await writeFile(tmp, rendered, { mode: 0o600, flag: "wx" });
  await rename(tmp, output);
  console.error(`rendered ${refs.length} reference(s) into ${output} (mode 0600)`);
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next", ".venv"]);

async function* walk(path: string): AsyncGenerator<string> {
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  if (info.isFile()) { if (info.size <= 2 * 1024 * 1024) yield path; return; }
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path)) if (!SKIP_DIRS.has(entry)) yield* walk(join(path, entry));
}

async function scan(paths: string[]): Promise<void> {
  // Scan against every vault password, kept in memory only.
  let index: RedactIndex | null = null;
  try {
    await core.ensureSession();
    const env = await core.resolveEntries(await core.authEnvEntries());
    index = buildRedactIndex(await core.redactionValues(env.secrets));
  } catch { index = await core.readRedactIndex(); }
  if (!index) fail("No vault snapshot or redact index available; unlock first", 3);
  const redact = compileRedactIndex(index);
  let leaks = 0;
  for (const root of paths.length ? paths : ["."]) {
    for await (const file of walk(root)) {
      const content = await readFile(file, "utf8").catch(() => "");
      if (content.includes("\u0000")) continue;
      content.split("\n").forEach((line, number) => {
        const redacted = redact(line);
        if (redacted === line) return;
        const names = [...redacted.matchAll(/<redacted:([^>]+)>/g)].map((match) => match[1]);
        for (const name of names) { leaks++; console.log(`${file}:${number + 1} ${name}`); }
      });
    }
  }
  console.error(`${leaks} leaked secret value(s) found`);
  if (leaks) process.exitCode = 1;
}

interface ImportRow { entry: DotenvEntry; kind: "new" | "reuse" | "conflict" | "literal" | "ref"; item?: string; note?: string }

// setup: keyshroud gets its own bw login (CONFIG_DIR/bw) on a separate agent
// account, so agents never get a session for the user's personal vault.
async function setupCommand(args: string[]): Promise<void> {
  requireKnownFlags(args, ["--email", "--server"], ["--confirm-unlock", "--unattended", "--registered"]);
  const email = valueAfter(args, "--email");
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) fail("setup needs --email for a separate agent account (not your personal one)", 2);
  let server = valueAfter(args, "--server");
  // bw reports no server for the default Bitwarden cloud, and also after a logout,
  // so the cloud is assumed only for a first setup.
  const firstSetup = !existsSync(join(core.OWN_BW_DIR, "data.json"));
  if (!server) { try { server = (JSON.parse(await core.bw(["status"])) as { serverUrl?: string | null }).serverUrl ?? (firstSetup ? "https://vault.bitwarden.com" : undefined); } catch {} }
  if (!server || !/^https:\/\//.test(server)) fail("setup needs --server https://… (no bw server is configured)", 2);
  const confirm = args.includes("--confirm-unlock");
  const unattended = args.includes("--unattended");
  if (confirm && unattended) fail("--confirm-unlock keeps the password for later unlocks; --unattended keeps one session open instead. Pick one.", 2);
  if (confirm && process.platform !== "darwin") fail("--confirm-unlock needs the macOS keychain; Linux secret-tool cannot ask before each read", 2);
  core.useOwnBwLogin();
  // bw writes data.json on its first call there, and that file switches every
  // later keyshroud run to this login, so OWN_BW_DIR stays untouched until the
  // agent account can actually log in.
  const ownData = join(core.OWN_BW_DIR, "data.json");
  const fresh = !existsSync(ownData);
  const status = fresh ? {} : JSON.parse(await core.bw(["status"]).catch(() => "{}")) as { status?: string; userEmail?: string };
  if (status.userEmail && status.userEmail.toLowerCase() !== email.toLowerCase()) fail(`${BRAND.name}'s bw login already belongs to ${status.userEmail}; remove ${core.OWN_BW_DIR} to start over`, 5);
  const loggedOut = !status.status || status.status === "unauthenticated";
  const signupUrl = `${server.replace(/\/$/, "")}/#/signup?email=${encodeURIComponent(email)}`;
  // Only --confirm-unlock (or an entry from an earlier release) keeps the master
  // password in the keychain; otherwise keyshroud asks for it when a session ends.
  let master = await core.readKeychain(core.KEYCHAIN_MASTER_SERVICE);
  if (!process.stdin.isTTY) {
    if (unattended) fail("--unattended opens a session without an end: run setup in a terminal", 2);
    if (confirm) fail("--confirm-unlock asks for the password in a terminal: run setup there", 2);
    // An agent's shell: the user picks the password on the signup page, so it
    // never passes through anything the agent can read (output, clipboard).
    if (loggedOut && !args.includes("--registered")) {
      spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? join(dirname(core.SYSTEM32), "explorer.exe") : "xdg-open", [signupUrl], { stdio: "ignore" }).on("error", () => {});
      console.log(`Create the agent account at ${signupUrl} and pick its master password there: a new one, not your personal one. Save it in your password manager.`);
      console.log(`Then: ${BRAND.bin} setup --email ${email} --registered (it asks for that password in a dialog)`);
      return;
    }
  }
  if (loggedOut && !args.includes("--registered")) {
    const url = signupUrl;
    console.log(`1. Create the agent account ${email}: ${url}`);
    console.log("   Pick a new master password, not your personal one.");
    spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? join(dirname(core.SYSTEM32), "explorer.exe") : "xdg-open", [url], { stdio: "ignore" }).on("error", () => {});
    process.stdout.write("   Press Enter once the account exists. ");
    await new Promise((resolve) => process.stdin.once("data", resolve)); process.stdin.pause();
  }
  if (confirm) {
    console.log(`2. Type the agent account's master password for the keychain entry ${core.KEYCHAIN_MASTER_SERVICE} (macOS will ask before every unlock):`);
    if (!(await core.storeKeychainInteractive(core.KEYCHAIN_MASTER_SERVICE, `${BRAND.name} agent account`, confirm))) fail("Could not store it (needs macOS security or Linux secret-tool)", 3);
    master = await core.readKeychain(core.KEYCHAIN_MASTER_SERVICE);
    if (!master) fail(`The keychain entry ${core.KEYCHAIN_MASTER_SERVICE} is missing or access was denied`, 3);
  }
  const kept = Boolean(master);
  if (loggedOut && !master) {
    if (process.stdin.isTTY) console.log(`2. Log in to the agent account. ${BRAND.name} does not store its master password; it asks again when a session ends.`);
    master = await core.askMasterPassword({ email, unattended });
    if (!master) fail("No terminal and no dialog here (SSH or no display). Run the command in a terminal.", 2);
  }
  if (loggedOut) {
    await mkdir(core.OWN_BW_DIR, { recursive: true, mode: 0o700 });
    await core.bw(["config", "server", server]);
  }
  // A session of this login stays usable when setup runs again.
  if (loggedOut) await unlink(core.SESSION_FILE).catch(() => {});
  try {
    if (loggedOut) await core.loginOwnAccount(email, master!, unattended); else await core.ensureSession({ prompt: true, unattended });
  } catch (error) {
    // A failed first login must not leave keyshroud switched to a logged-out account.
    if (fresh) await unlink(ownData).catch(() => {});
    throw error;
  }
  console.log(`${BRAND.name} now keeps its own bw login in ${core.OWN_BW_DIR}; your personal bw login is untouched.`);
  await core.audit("setup", [], "cli");
  const minutes = Math.round(core.SESSION_TTL_MS / 60000);
  console.log(`ready: bw login=${email} (own). ${unattended ? "The session stays open (unattended)." : `Sessions end after ${minutes} minutes; then ${kept ? "keyshroud unlocks again from the keychain" : "keyshroud asks for the master password again"}.`}`);
  console.log(`Next: \`${BRAND.bin} migrate\` copies the wired secrets from your personal vault.`);
}

// migrate: copy the items that wired names (and env files) reference from the
// personal vault into the agent account. Same names, so references keep working.
async function migrateCommand(args: string[]): Promise<void> {
  requireKnownFlags(args, ["--item", "--env-file"], ["--yes"]);
  if (!core.OWN_BW_LOGIN) fail(`Run \`${BRAND.bin} setup\` first: migrate copies items into ${BRAND.name}'s own agent account`, 2);
  const entries = [...await core.authEnvEntries()];
  for (const file of valuesAfter(args, "--env-file")) entries.push(...await core.envFileEntries(file));
  const names = new Map<string, string>();
  for (const entry of entries) { try { const ref = parseRef(entry.raw); if (ref) names.set(ref.item.toLowerCase(), ref.item); } catch {} }
  for (const name of valuesAfter(args, "--item")) names.set(name.toLowerCase(), name);
  await core.ensureSession({ prompt: true });
  const own = await core.findItems("");
  const personal = await core.readPersonalItems();
  const personalMaster = await core.readKeychain(core.PERSONAL_KEYCHAIN_MASTER_SERVICE);
  // An item that holds the personal master password would hand the agent account the whole vault.
  const holdsMaster = (item: Record<string, unknown>) => {
    const login = (item.login ?? {}) as { password?: unknown };
    const values = [login.password, item.notes, ...((item.fields ?? []) as Array<{ value?: unknown }>).map((field) => field.value)];
    return Boolean(personalMaster) && values.some((value) => typeof value === "string" && value.includes(personalMaster!));
  };
  type Row = { name: string; state: "copy" | "present" | "missing" | "ambiguous" | "refused"; item?: Record<string, unknown> };
  const rows: Row[] = [...names.values()].sort().map((name) => {
    if (own.some((item) => item.name.toLowerCase() === name.toLowerCase() || item.id === name)) return { name, state: "present" };
    const matches = personal.filter((item) => String(item.name ?? "").toLowerCase() === name.toLowerCase() || item.id === name);
    if (matches.length === 1 && holdsMaster(matches[0])) return { name, state: "refused" };
    return matches.length === 1 ? { name, state: "copy", item: matches[0] } : { name, state: matches.length ? "ambiguous" : "missing" };
  });
  const width = Math.max(4, ...rows.map((row) => row.name.length));
  console.log("migrate plan (personal vault -> agent account):");
  const label = { present: "already in the agent account", refused: "refused: holds your personal master password" } as Record<string, string>;
  for (const row of rows) console.log(`  ${row.name.padEnd(width)}  ${label[row.state] ?? row.state}`);
  const count = (state: Row["state"]) => rows.filter((row) => row.state === state).length;
  console.log(`${count("copy")} to copy, ${count("present")} already there, ${count("missing")} missing, ${count("ambiguous")} ambiguous${count("refused") ? `, ${count("refused")} refused` : ""}`);
  if (!args.includes("--yes")) { console.log("Dry run: nothing copied. Re-run with --yes."); return; }
  const copied: string[] = [];
  for (const row of rows.filter((entry) => entry.state === "copy")) {
    try { await core.copyItemToOwnVault(row.item!); copied.push(row.name); }
    catch { if (copied.length) console.error(`Copied before the failure: ${copied.join(", ")}`); fail(`Failed to copy ${row.name}`, 3); }
  }
  await core.syncOwnVault();
  const after = await core.findItems("");
  const unverified = copied.filter((name) => !after.some((item) => item.name.toLowerCase() === name.toLowerCase()));
  await core.audit("migrate", copied, "cli");
  await core.refreshRedactIndex();
  console.log(`copied ${copied.length} item(s) into the agent account; references are unchanged.`);
  const cut = process.platform === "darwin" ? `security delete-generic-password -s ${core.PERSONAL_KEYCHAIN_MASTER_SERVICE}` : `secret-tool clear service ${core.PERSONAL_KEYCHAIN_MASTER_SERVICE} account "$USER"`;
  console.log(`Your personal master password is still in the keychain, where any program running as you can read it. Once you no longer need it there: ${cut}`);
  if (unverified.length) fail(`Not found after copying: ${unverified.join(", ")}`, 4);
  if (count("missing") || count("ambiguous") || count("refused")) process.exitCode = 4;
}

async function importCommand(args: string[]): Promise<void> {
  requireKnownFlags(args, ["--from", "--out", "--prefix", "--only", "--skip"], ["--yes", "--replace", "--force"]);
  const from = valueAfter(args, "--from") ?? ".env";
  const yes = args.includes("--yes"); const replace = args.includes("--replace");
  if (replace && (from === "-" || valueAfter(args, "--out"))) fail("--replace rewrites the --from file; it cannot be combined with stdin or --out", 2);
  if (from === "-" && process.stdin.isTTY) fail("--from - needs the .env piped on stdin", 2);
  const baseDir = from === "-" ? process.cwd() : dirname(resolve(from));
  const out = replace ? resolve(from) : resolve(valueAfter(args, "--out") ?? join(baseDir, ".env.refs"));
  const prefix = valueAfter(args, "--prefix") ?? basename(baseDir);
  if (!/^[A-Za-z0-9._-]+$/.test(prefix)) fail("--prefix may contain only letters, digits, '.', '_' and '-' (set it with --prefix)", 2);
  const list = (flag: string) => (valueAfter(args, flag) ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  const only = list("--only"); const skip = list("--skip");

  let text: string;
  try { text = from === "-" ? await readStdin() : await readFile(from, "utf8"); } catch { fail(`Cannot read ${from}`, 2); }
  const { entries, errors } = parseDotenvStrict(text);
  if (errors.length) {
    for (const error of errors) console.error(`${from}:${error.line} ${error.reason}`);
    fail(`${errors.length} line(s) cannot be imported safely; fix them or move them out of the file`, 2);
  }
  for (const name of [...only, ...skip]) if (!entries.some((entry) => entry.name === name)) fail(`--only/--skip name not in ${from}: ${name}`, 2);

  await core.ensureSession({ prompt: true });
  const existing = await core.findItems(prefix);
  const rows: ImportRow[] = [];
  for (const entry of entries) {
    if (isRef(entry.value)) { rows.push({ entry, kind: "ref" }); continue; }
    const secret = (only.length ? only.includes(entry.name) : looksSecret(entry.name, entry.value)) && !skip.includes(entry.name);
    if (!secret) { rows.push({ entry, kind: "literal" }); continue; }
    const item = `${prefix} ${entry.name}`;
    const matches = existing.filter((candidate) => candidate.name.toLowerCase() === item.toLowerCase());
    if (matches.length > 1) { rows.push({ entry, item, kind: "conflict", note: "more than one vault item has this name" }); continue; }
    if (matches.length === 0) { rows.push({ entry, item, kind: "new" }); continue; }
    const current = await core.resolveRef({ item: matches[0].id, field: "password" });
    rows.push(current === entry.value
      ? { entry, item, kind: "reuse", note: "same value already in the vault" }
      : { entry, item, kind: "conflict", note: "vault item exists with a different value" });
  }

  const width = Math.max(4, ...rows.map((row) => row.entry.name.length));
  console.log(`import plan for ${from} (item prefix "${prefix}")`);
  for (const row of rows) {
    const label = row.kind === "literal" ? "literal   kept" : row.kind === "ref" ? "reference kept"
      : row.kind === "conflict" ? `secret    conflict: ${row.note} ("${row.item}")`
      : `secret    ${row.kind.padEnd(8)} -> bw://${row.item}${row.note ? `  (${row.note})` : ""}`;
    const short = row.item && row.entry.value.length < 6 ? "  [under 6 characters: stored, but too short to be masked]" : "";
    console.log(`  ${row.entry.name.padEnd(width)}  ${label}${short}`);
  }
  const count = (kind: ImportRow["kind"]) => rows.filter((row) => row.kind === kind).length;
  const toStore = rows.filter((row) => row.kind === "new" || row.kind === "reuse");
  console.log(`${toStore.length + count("conflict")} secret(s): ${count("new")} new, ${count("reuse")} already in the vault, ${count("conflict")} conflict(s); ${count("literal")} literal(s), ${count("ref")} reference(s)`);
  if (count("conflict")) fail("Resolve the conflicts (choose another --prefix, or rename the vault items) before importing", 5);
  if (!toStore.length) { console.log("Nothing to import."); return; }
  const outExists = await stat(out).then(() => true, () => false);
  if (outExists && !replace && !args.includes("--force")) fail(`${out} already exists; use --force to overwrite it`, 5);
  if (!yes) { console.log(`Dry run: nothing written. Re-run with --yes to create ${count("new")} item(s) and write ${out}`); return; }

  const created: string[] = [];
  for (const row of rows) {
    if (row.kind !== "new") continue;
    try { await core.createSecretItem({ itemName: row.item!, secret: row.entry.value, envName: row.entry.name, notes: `Imported by ${BRAND.bin} from ${basename(from === "-" ? "stdin" : from)}` }); }
    catch { if (created.length) console.error(`Created before the failure: ${created.join(", ")}`); fail(`Failed to create the vault item for ${row.entry.name}; nothing was written to ${out}`, 3); }
    created.push(row.entry.name);
  }
  for (const row of toStore) {
    let value: string | null = null;
    try { value = await core.resolveRef({ item: row.item!, field: "password" }); } catch {}
    if (value !== row.entry.value) fail(`Verification failed for ${row.entry.name}: the vault does not return the imported value; nothing was written to ${out}`, 4);
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  for (const row of toStore) lines[row.entry.line - 1] = `${row.entry.exported ? "export " : ""}${row.entry.name}=bw://${row.item}`;
  const mode = replace ? (await stat(out)).mode & 0o777 : 0o600;
  const tmp = `${out}.tmp.${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, lines.join(eol), { mode, flag: "wx" });
  await rename(tmp, out);
  await core.audit("import", toStore.map((row) => row.entry.name), "cli");
  console.log(`imported ${toStore.length} secret(s) (${created.length} new); wrote ${out}`);
  if (!replace && from !== "-") console.log(`${from} still holds the plaintext values. Check with \`${BRAND.bin} run --env-file ${relative(process.cwd(), out) || out} -- <cmd>\`, then delete it or re-run with --replace.`);
}

async function main(): Promise<void> {
  // `keyshroud doctor | head -1`: a closed pipe ends the output, not with a stack trace.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => { if (error.code === "EPIPE") process.exit(); throw error; });
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
    if (command === "unlock") {
      requireKnownFlags(args, [], ["--unattended"]);
      await core.ensureSession({ prompt: true, unattended: args.includes("--unattended") });
      const stored = await core.readSession();
      console.log(!stored ? "unlocked" : stored.expiresAt ? `unlocked until ${new Date(stored.expiresAt).toLocaleTimeString()}` : "unlocked (no time limit)");
      return;
    }
    if (command === "lock") { requireKnownFlags(args, []); await core.lock(); console.log("locked"); return; }
    if (command === "scan") { await scan(args); return; }
    if (command === "env") {
      if (args.some((arg) => arg !== "--shell")) fail(usage, 2);
      // Names need no unlock, so they list even while the vault is locked.
      if (args.includes("--shell")) for (const [name, value] of Object.entries(await core.buildEnvMap())) console.log(`export ${name}=${shellQuote(value)}`);
      else for (const name of new Set((await core.authEnvEntries()).map((entry) => entry.name))) console.log(name);
      return;
    }
    if (command === "get") {
      if (args.length !== 1) fail(usage, 2);
      const ref = parseRef(args[0]);
      let vaultError = "";
      try { await core.ensureSession({ prompt: true }); } catch (error) { vaultError = error instanceof Error ? error.message : String(error); }
      const value = ref ? await core.resolveRef(ref) : await authValue(args[0]);
      if (value === null) fail(`Secret unresolved: ${args[0]}${vaultError ? ` (${vaultError})` : ""}`, 4);
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
      await core.ensureSession({ prompt: true }); process.stdout.write(await core.getSecret(item)); return;
    }
    if (command === "add") {
      requireKnownFlags(args, ["--env", "--item", "--notes", "--target"], ["--stdin", "--dialog"]);
      const envName = valueAfter(args, "--env"); const itemName = valueAfter(args, "--item"); const notes = valueAfter(args, "--notes");
      if (!envName || !itemName || !ENV_NAME_RE.test(envName)) fail(usage, 2);
      checkNames(envName, itemName);
      const reference = core.referenceFor(itemName);
      const targets = targetList(valueAfter(args, "--target"));
      await core.ensureSession({ prompt: true });
      if ((await core.findItems(itemName)).some((item) => item.name.toLowerCase() === itemName.toLowerCase())) fail(`Vault item already exists: ${itemName}`, 5);
      const secret = await readSecret(args, `Paste secret for ${envName}: `, itemName, envName);
      await core.createSecretItem({ itemName, secret, envName, notes });
      await core.audit("add", [envName], "cli");
      let conflict = false;
      for (const path of targets) { const result = await core.writeAuthEntry(path, envName, reference); if (!result.ok) conflict = true; }
      const verified = (await core.resolveShellValue(reference)) !== null;
      await core.refreshRedactIndex();
      console.log(`created item=${itemName} env=${envName} targets=${targets.join(",")} verified=${verified ? "yes" : "no"}`);
      if (conflict) { console.error("Item created, but one or more auth targets already contained the environment name."); process.exitCode = 5; }
      return;
    }
    if (command === "import") { await importCommand(args); return; }
    if (command === "setup") { await setupCommand(args); return; }
    if (command === "migrate") { await migrateCommand(args); return; }
    if (command === "rotate") {
      requireKnownFlags(args, ["--item"], ["--stdin", "--dialog"]);
      const itemName = valueAfter(args, "--item"); if (!itemName) fail(usage, 2);
      await core.ensureSession({ prompt: true }); const secret = await readSecret(args, "Paste replacement secret: ", itemName);
      await core.rotateSecretItem({ itemName, secret }); await core.audit("rotate", [itemName], "cli"); await core.refreshRedactIndex();
      console.log(`rotated item=${itemName}`); return;
    }
    if (command === "wire") {
      requireKnownFlags(args, ["--env", "--item", "--target"], ["--force"]);
      const envName = valueAfter(args, "--env"); const itemName = valueAfter(args, "--item");
      if (!envName || !itemName || !ENV_NAME_RE.test(envName)) fail(usage, 2);
      if (isLoaderEnvName(envName)) fail(`${envName} changes what programs load or run; it cannot be wired to a secret`, 2);
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
      try { await core.ensureSession(); } catch {}
      const s = await core.getStatus(); console.log(`bw login=${core.OWN_BW_LOGIN ? `own agent account (${core.OWN_BW_DIR})` : `shared with your personal bw (run: ${BRAND.bin} setup)`}`); console.log(`bw version=${s.version ?? "missing (install @bitwarden/cli)"}${vaultwardenTooNew(s.version, s.serverUrl) ? " (bw 2026.9 and later cannot log in to Vaultwarden yet: npm i -g @bitwarden/cli@2026.8.0)" : ""}`); console.log(`bw server=${s.serverUrl ?? "unconfigured (run: bw config server <url>)"}`); console.log(`session=${s.status}`);
      const session = await core.readSession();
      if (session) console.log(`session expires=${session.expiresAt === null ? "never (unattended)" : new Date(session.expiresAt).toISOString()}`);
      const source = await core.storedMasterSource();
      console.log(`master password=${source === "keychain" ? `stored in the keychain (${core.KEYCHAIN_MASTER_SERVICE}): unlocks without asking` : source === "file" ? `stored in ${core.MASTER_PASSWORD_FILE}: any program running as you can read it` : `not stored (${BRAND.bin} asks for it)`}`);
      const presence = Object.entries(await core.keychainPresence());
      const locked = presence.some(([, present]) => !present) && await core.keychainLocked();
      for (const [service, present] of presence) console.log(`keychain ${service}=${present ? "present" : locked ? "unknown (keyring locked)" : "missing"}`);
      if (locked) console.log(`keyring=locked: ${core.KEYRING_LOCKED}`);
      for (const path of [targetPaths.omp, targetPaths.pi]) for (const name of Object.keys(await core.readAuthEntries(path))) console.log(`${path} ${name} resolved=${(await authValue(name)) ? "yes" : "no"}`);
      console.log(`redact index=${(await core.readRedactIndex()) ? "present" : "missing"}`);
      const settings = JSON.parse(await readFile(join(homedir(), ".claude", "settings.json"), "utf8").catch(() => "{}")) as Record<string, unknown>;
      console.log(`apiKeyHelper wired=${settings.apiKeyHelper ? "yes" : "no"}`); if (s.status !== "unlocked") process.exitCode = 3; return;
    }
    fail(usage, 2);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = failureCode(error); }
}
void main();
