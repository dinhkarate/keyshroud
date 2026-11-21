#!/usr/bin/env node
import { appendFileSync, constants as fsConstants, existsSync } from "node:fs";
import { access, chmod, mkdir, lstat, readdir, readFile, readlink, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { constants, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import process from "node:process";
import { BRAND } from "./brand.ts";
import * as core from "./core.ts";
import { runClaudeHook } from "./hooks.ts";
import { serveMcp } from "./mcp.ts";
import { buildRedactIndex, compileIndexSearch, createRedactor, createRedactStream, type RedactIndex } from "./redact.ts";
import { ENV_NAME_RE, SOURCE_SCHEMES, formatRef, isLoaderEnvName, isRef, isSourceRef, itemNameProblem, looksSecret, parseDotenvStrict, parseRef, refFor, type DotenvEntry, type SecretRef } from "./refs.ts";
import { sourceAddress, type InfisicalSource, type VaultSource } from "./sources.ts";
import type { VaultKeyType } from "./vault.ts";

const usage = `Usage: ${BRAND.bin} <command> [options]

Secrets
  get <ENV_NAME | ${BRAND.refScheme}://ref | bw://ref | source ref>
                                   Print one resolved value to stdout
  run [--refs F]... [--only A,B] [--no-auth] [--no-mask] -- <cmd> [args]
                                   Run a command with secrets injected and its output masked (alias: exec)
                                   (--no-mask: the command gets the terminal, for an interactive program)
  inject [-i template] [-o out] [--force]
                                   Render {{ ${BRAND.refScheme}://ref }}, {{ bw://ref }} and {{ source ref }} placeholders
  redact                           Copy stdin to stdout with vault secrets masked
  scan [paths...]                  Find vault secret values in files (exit 1 on leaks)
  env [--shell]                    List wired names (or print shell exports)
  scope [--only A,B_* | --clear]   Show which wired names this project may use, or write
                                   ./${core.SCOPE_FILE} (run, env and the agents then use only those)
  add --env NAME --item ITEM [--notes TEXT] [--target pi|omp|both] [--stdin|--dialog]
                                   ITEM is a name (default backend), ${BRAND.refScheme}://NAME or bw://NAME
  import [--from F|-] [--out F] [--prefix P] [--only A,B] [--skip A,B] [--yes] [--replace] [--force]
                                   Move secrets from a .env into the vault and write .env.refs
                                   (dry run unless --yes; prints names only)
  rotate --item ITEM [--stdin|--dialog]
  list                             List vault items and the variables wired to them (names only)
  rm --item ITEM [--yes]           Delete an item and unwire its variables (dry run unless --yes;
                                   --yes needs a terminal or Touch ID; bw: own agent account only)
  wire --env NAME --item ITEM [--target pi|omp|both] [--force]
                                   ITEM may be a source reference (vault://secret/app#password)
  unwire --env NAME [--target pi|omp|both]

Sources (read-only: the secret managers a team runs)
  vault://<mount>/<path>[#<field>]            HashiCorp Vault or OpenBao (KV v1 and v2)
  infisical://<project id>/<env>/[<folder>/]<NAME>
  op://<vault>/<item>/<field>                 1Password, through its \`op\` CLI
  awssecrets://<name>[#<key>], awsssm://<parameter>            AWS, through \`aws\`
  gcpsecrets://<project>/<secret>[#<key>]                      Google Cloud, through \`gcloud\`
  azurekeyvault://<vault>/<secret>[#<key>]                     Azure, through \`az\`
  source                           List the sources that are set up, and the CLIs found
  source add vault [--addr URL] [--namespace NS] [--ca-file PEM] [--token | --role-id ID] [--stdin|--dialog]
                                   Reads with the token of \`vault login\` (~/.vault-token), or asks
                                   for a token (--token) or an AppRole secret id (--role-id) and
                                   keeps it in the ${BRAND.name} vault. Without the flags: VAULT_ADDR,
                                   VAULT_NAMESPACE and VAULT_CACERT (or BAO_…) as they are set now
  source add infisical --client-id ID [--addr URL] [--ca-file PEM] [--stdin|--dialog]
                                   A machine identity (Universal Auth); asks for its client secret
  source rm vault|infisical

Vault (the local vault by default; bw/Vaultwarden once set up)
  setup --email EMAIL [--server URL] [--confirm-unlock | --unattended] [--registered]
                                   Give ${BRAND.name} its own bw login on a dedicated agent account
  migrate [--item NAME]... [--refs F]... [--yes]
                                   Copy the wired items from your personal vault to that account
                                   (dry run unless --yes; prints names only)
  migrate --to local [--yes]       Move every wired Vaultwarden item into the local vault and rewire
                                   its names (dry run unless --yes; Vaultwarden keeps the originals)
  unlock [--unattended | --stdin]  Unlock now (asks unless the key or master password is stored);
                                   the session ends after 30 minutes
                                   (--unattended: no end, for hosts nobody sits at; in a terminal)
                                   (--stdin: a passphrase vault's passphrase from stdin, e.g. in CI)
  rekey [--to keychain|secure-enclave|passphrase|dpapi]
                                   Give the local vault a new key, kept that way (in a terminal)
  backup [--out FILE]              Copy the local vault into one file under a passphrase of its own
                                   (in a terminal); it opens on any machine
  restore FILE [--replace] [--yes] Bring back what a backup holds and the local vault lacks, and wire
                                   the names again (dry run unless --yes; --replace: also the items
                                   that have another value here)
  dialog [on|off|terminal]         off: never ask in a window on the desktop; a command an agent starts
                                   then says what to run in a terminal instead
                                   terminal: ask in a terminal window that runs the command itself
  status | lock | doctor

Agents
  mcp                              Serve the MCP tools over stdio
  hook claude <event>              Claude Code hook entry point
  claude-setup --item ITEM [--settings PATH] [--ttl-ms N] [--force]
  claude-guard [--off] [--shell PATH] [--settings PATH]
                                   Mask what every Bash command of Claude Code prints, also when it
                                   fails: Claude Code starts its shell through ${BRAND.name} (macOS, Linux)
  api-key --item ITEM              Claude Code apiKeyHelper entry point
  link-cli [--dir DIR] [--force]`;

const targetPaths = core.getAuthTargets();
function fail(message: string, code: number): never { console.error(message); process.exit(code); }
function valueAfter(args: string[], flag: string): string | undefined { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }
function valuesAfter(args: string[], flag: string): string[] { return args.flatMap((arg, index) => (arg === flag && args[index + 1] !== undefined ? [args[index + 1]] : [])); }
// The files of references a command names. --env-file is the spelling before 0.12.3, kept for scripts
// that use it: Node.js 20.6+ reads a file named that way itself, before any of this code runs.
function refsFiles(args: string[]): string[] { return args.flatMap((arg, index) => ((arg === "--refs" || arg === "--env-file") && args[index + 1] !== undefined ? [args[index + 1]] : [])); }
function requireKnownFlags(args: string[], withValue: string[], bare: string[] = []): void {
  for (let i = 0; i < args.length; i++) {
    if (withValue.includes(args[i])) { if (args[i + 1] === undefined) fail(usage, 2); i++; continue; }
    if (!bare.includes(args[i])) fail(`Unknown argument: ${args[i]}\n\n${usage}`, 2);
  }
}
// Where add/wire write: env.json always, plus pi's and omp's auth.json when installed or named by --target.
function targetList(value: string | undefined): string[] {
  if (!value) return core.wiringTargets();
  if (value === "both") return core.wiringTargets(["omp", "pi"]);
  if (value === "omp" || value === "pi") return core.wiringTargets([value]);
  fail("--target must be omp, pi, or both", 2);
}
// What unwire clears: every wiring file, or only the named agent's auth.json.
function unwireList(value: string | undefined): string[] {
  if (!value) return core.wiringFiles();
  if (value === "both") return [targetPaths.omp, targetPaths.pi];
  if (value === "omp" || value === "pi") return [targetPaths[value]];
  fail("--target must be omp, pi, or both", 2);
}
// `dialog terminal`: a command that has no terminal is handed, whole, to a terminal window, and this
// process ends as that one did. Returns when no terminal window is in use here.
async function inTerminalWindow(argv: string[]): Promise<void> {
  if (process.stdin.isTTY || argv.includes("--stdin") || argv.includes("--dialog")) return;
  const window = await core.runInTerminal(argv);
  if (!window) return;
  (window.code === 0 ? process.stdout : process.stderr).write(window.output);
  if (window.code === 0) console.log("(entered in a terminal window)");
  process.exit(window.code);
}
// The other end: what the terminal window runs. It shows who asked and the command, runs it for the
// person to answer, and leaves how it ended, and what it printed, for the process that waits.
async function terminalWindow(file: string | undefined): Promise<void> {
  if (!file || !/^terminal-[0-9a-f]{16}\.json$/.test(basename(file))) fail(usage, 2);
  const base = file.slice(0, -5);
  const request = JSON.parse(await readFile(file, "utf8")) as { argv: string[]; from: string; cwd: string; env: Record<string, string> };
  await rm(file, { force: true });
  if (!core.TERMINAL_COMMANDS.includes(request.argv[0])) fail(`Not a command for a terminal window: ${shown(String(request.argv[0]))}`, 2);
  await writeFile(`${base}.pid`, `${process.pid}\n`, { mode: 0o600 });
  const words = request.argv.filter((arg, index, all) => arg !== "--notes" && all[index - 1] !== "--notes").map((arg) => /^[\w@%+=:,./-]+$/.test(arg) ? arg : shellQuote(arg));
  console.log(`${BRAND.name}: asked from ${shown(request.from)}\nThis window runs the command below; what you type here goes to ${BRAND.name} only.\n\n$ ${shown([BRAND.bin, ...words].join(" "))}\n`);
  const code = await new Promise<number>((done) => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...request.argv], {
      stdio: "inherit", cwd: existsSync(request.cwd) ? request.cwd : undefined,
      env: { ...process.env, ...request.env, [`${BRAND.envPrefix}_DIALOG`]: "on", [`${BRAND.envPrefix}_TERMINAL_OUTPUT`]: `${base}.out` },
    });
    child.on("error", () => done(1));
    child.on("close", (status) => done(status ?? 1));
  });
  await writeFile(`${base}.code`, `${code}\n`, { mode: 0o600 });
  console.log(code === 0 ? "\nDone. You can close this window." : `\nNot done (exit ${code}). You can close this window.`);
  process.exitCode = code;
}
const NO_DIALOG = `No terminal and no dialog here (SSH, no display, or \`${BRAND.bin} dialog off\`).`;
// --stdin: piped value. Terminal: masked prompt. Otherwise (an agent's shell):
// a native dialog, so the agent can start the command and the user only pastes.
async function readSecret(args: string[], prompt: string, itemName: string, envName?: string): Promise<string> {
  if (args.includes("--stdin")) return core.readSecretFromInput({ prompt, stdin: true });
  if (process.stdin.isTTY && !args.includes("--dialog")) return core.readSecretFromInput({ prompt, stdin: false });
  await inTerminalWindow(process.argv.slice(2));
  // The command as it was given, for the person to run in a terminal instead.
  // Without --notes: its text is the caller's own words, and would be shown in the window.
  const given = process.argv.slice(2).filter((arg, index, all) => arg !== "--dialog" && arg !== "--notes" && all[index - 1] !== "--notes");
  const command = [BRAND.bin, ...given.map((arg) => /^[\w@%+=:,./-]+$/.test(arg) ? arg : shellQuote(arg))].join(" ");
  const value = await core.readSecretFromDialog({ itemName, envName, command });
  if (value) return value;
  if (value === "") throw new Error("Empty secret");
  fail(`${NO_DIALOG} Run the command in a terminal, or pipe the value with --stdin.`, 2);
}
function checkNames(envName: string, itemName: string): void {
  if (isLoaderEnvName(envName)) fail(`${envName} changes what programs load or run; it cannot be wired to a secret`, 2);
  const problem = itemNameProblem(itemName);
  if (problem) fail(`Vault item name ${problem}`, 2);
}
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function failureCode(error: unknown): number {
  const text = error instanceof Error ? error.message : String(error);
  if (/already exists/.test(text)) return 5;
  if (/not found|Ambiguous|Empty secret|unresolved|No value|reference/i.test(text)) return 4;
  return 3;
}
function outsideScope(scope: core.Scope): string { return `is outside this project's scope (${core.shownPath(scope.path)})`; }
// After add and wire: a name the project's scope leaves out is not there for `run` until the scope lists it.
async function scopeNote(envName: string): Promise<void> {
  const scope = await core.projectScope().catch(() => null);
  if (!core.inScope(scope, envName)) console.error(`${envName} ${outsideScope(scope!)}: add it there to use it in this project`);
}
async function authRaw(name: string): Promise<string | undefined> {
  return core.authEntryRaw((await core.wiredEntries())[name]);
}
async function authValue(name: string): Promise<string | null> {
  return core.resolveShellValue(await authRaw(name));
}
// A value printed on purpose (get, api-key, inject) joins the hook index first, so a Claude Code
// hook masks it in the tool result even when no name is wired to it.
async function coverPrinted(values: Record<string, string>): Promise<void> {
  try { await core.writeRedactIndex(values); } catch (error) {
    console.error(`${BRAND.bin}: the redaction index could not be updated (${error instanceof Error ? error.message.split("\n")[0] : String(error)}), so a Claude Code hook will not mask this value`);
  }
}
// ~/.claude/settings.json can hold keys, and a JSON.parse error quotes its input.
async function readSettings(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch {}
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a valid JSON object`);
  return parsed as Record<string, unknown>;
}
// Read, checked and replaced under the lock keyshroud's own writers share, as a write that
// cannot land once that lock is gone (Claude Code has no lock to share). The backup and the
// text that waits are private (settings can hold keys); the file gets its old mode back
// once the new text is in place. `change` says whether there is anything to write.
async function changeSettings(settingsPath: string, change: (settings: Record<string, unknown>, target: string) => boolean | Promise<boolean>): Promise<boolean> {
  return core.updateFile(settingsPath, async (target, write) => {
    const settings = await readSettings(target);
    if (!(await change(settings, target))) return false;
    const existing = await stat(target).catch(() => null);
    if (existing) await writeFile(`${settingsPath}.bak-${timestamp()}-${randomBytes(3).toString("hex")}`, await readFile(target), { mode: 0o600, flag: "wx" });
    await write(`${JSON.stringify(settings, null, 2)}\n`, existing ? existing.mode & 0o777 : 0o600);
    return true;
  });
}
async function parseItem(arg: string): Promise<{ backend: core.BackendName; name: string }> {
  try { return await core.parseItemArg(arg); } catch (error) { fail(error instanceof Error ? error.message : String(error), 2); }
}
function localLine(s: core.LocalStatus): string {
  if (s.status === "none") return "vault=none";
  return `vault=${s.path} key=${s.key ?? "unknown"} status=${s.status} items=${s.items ?? "unknown"}${s.error ? ` (${s.error})` : ""}`;
}
function keySource(key: string | null): string { return key === "dpapi" ? "Windows DPAPI" : "the keychain"; }
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
  // Windows PowerShell drops `--` when it calls npm's keyshroud.ps1, so without one the command
  // starts at the first argument that is not one of run's own options.
  let separator = args.indexOf("--");
  let start = separator + 1;
  if (separator < 0) {
    separator = 0;
    while (separator < args.length && args[separator].startsWith("-")) separator += ["--refs", "--env-file", "--only"].includes(args[separator]) ? 2 : 1;
    start = separator;
  }
  if (!args[start]) fail(usage, 2);
  const flags = args.slice(0, separator);
  const [command, ...commandArgs] = args.slice(start);
  requireKnownFlags(flags, ["--refs", "--env-file", "--only"], ["--no-auth", "--mask", "--no-mask"]);

  // A project's scope narrows the wired names; what an env file names is asked for by name.
  const wired = flags.includes("--no-auth") ? { entries: [], outside: [], scope: null } : await core.scopedEnvEntries();
  const entries = wired.entries;
  for (const file of refsFiles(flags)) entries.push(...await core.envFileEntries(file));
  const only = valueAfter(flags, "--only")?.split(",").map((name) => name.trim()).filter(Boolean);
  const selected = only ? entries.filter((entry) => only.includes(entry.name)) : entries;
  if (only) for (const name of only) if (!selected.some((entry) => entry.name === name)) fail(`Secret unresolved: ${name} ${wired.outside.includes(name) ? outsideScope(wired.scope!) : "is not wired"}`, 4);
  // With --only, the other wired names do not reach the command from this process's own environment
  // either; nor do the names outside the scope.
  const dropped = [...wired.outside, ...(only ? entries.filter((entry) => !only.includes(entry.name)).map((entry) => entry.name) : [])];
  // Later sources win: env files override auth.json.
  const deduped = [...new Map(selected.map((entry) => [entry.name, entry])).values()];
  let vaultError = "";
  try { await core.ensureUnlocked(deduped.map((entry) => entry.raw), { prompt: true }); } catch (error) { vaultError = error instanceof Error ? error.message : String(error); }
  const env = await core.resolveEntries(deduped);
  // A name asked for with --only is one the command needs: without it the command is not run.
  if (only && env.missing.length) fail(`Secret unresolved: ${env.missing.join(", ")}${core.unresolvedReason(vaultError)}`, vaultError ? 3 : 4);
  await core.audit("run", Object.keys(env.secrets), command);
  if (env.missing.length) console.error(`${BRAND.bin}: unresolved (names only): ${env.missing.join(", ")}${core.unresolvedReason(vaultError)}`);

  // Masked unless --no-mask asks otherwise, on a terminal too: several agents run their commands on
  // a pseudo-terminal (Gemini CLI, Cline, Antigravity), and what is shown there is what the agent reads.
  const mask = flags.includes("--mask") || !flags.includes("--no-mask");
  const redactor = createRedactor(mask ? await core.redactionValues(env.secrets) : {});
  // Agents started through `run` (e.g. `keyshroud run -- claude`) rely on the
  // hook index, so it must cover env-file values too.
  try { await core.writeRedactIndex(await core.indexedValues(env.secrets)); } catch {}
  let target: core.Invocation;
  try { target = core.invocation(command, commandArgs); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 127; return; }
  let child: ReturnType<typeof spawn>;
  // An error about the environment or the arguments could quote one of them.
  try { child = spawn(target.command, target.args, { stdio: mask ? ["inherit", "pipe", "pipe"] : "inherit", env: core.childEnv(env.values, dropped), windowsVerbatimArguments: target.verbatim }); }
  catch (error) { console.error(`${BRAND.bin}: could not start ${command} (${(error as NodeJS.ErrnoException).code ?? "error"})`); process.exitCode = 126; return; }
  if (mask) {
    child.stdout?.pipe(createRedactStream(redactor)).pipe(process.stdout);
    child.stderr?.pipe(createRedactStream(redactor)).pipe(process.stderr);
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  await new Promise<void>((done) => {
    let failed = false;
    child.on("close", (code, signal) => { if (!failed) process.exitCode = code ?? 128 + (signal ? constants.signals[signal] ?? 0 : 1); done(); });
    // As a shell answers: 126 for a file that is there and cannot be run, 127 for one that is not found.
    child.on("error", (error) => { failed = true; const code = (error as NodeJS.ErrnoException).code; console.error(`${BRAND.bin}: could not start ${command} (${code ?? "error"})`); process.exitCode = code === "EACCES" ? 126 : 127; done(); });
  });
}

async function inject(args: string[]): Promise<void> {
  requireKnownFlags(args, ["-i", "-o"], ["--force"]);
  const input = valueAfter(args, "-i");
  const output = valueAfter(args, "-o");
  const template = input ? await readFile(input, "utf8") : await readStdin();
  const pattern = new RegExp(`\\{\\{\\s*((?:${["bw", BRAND.refScheme, "local", ...SOURCE_SCHEMES].join("|")})://[^\\s}]+(?:\\s+[^\\s}]+)*?)\\s*\\}\\}`, "g");
  const refs = [...new Set([...template.matchAll(pattern)].map((match) => match[1]))];
  let vaultError = "";
  try { await core.ensureUnlocked(refs, { prompt: true }); } catch (error) { vaultError = error instanceof Error ? error.message : String(error); }
  const values = new Map<string, string>();
  await Promise.all(refs.map(async (raw) => {
    const ref = parseRef(raw);
    const value = ref ? await core.resolveRef(ref) : null;
    if (value === null) throw new Error(`Secret reference unresolved: ${raw}${core.unresolvedReason(vaultError)}`);
    values.set(raw, value);
  }));
  await core.audit("inject", refs, output ?? "stdout");
  await coverPrinted(Object.fromEntries(values));
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
  const find = compileIndexSearch(index);
  let leaks = 0;
  for (const root of paths.length ? paths : ["."]) {
    for await (const file of walk(root)) {
      const content = await readFile(file, "utf8").catch(() => "");
      if (content.includes("\u0000")) continue;
      // The whole file at once, so a value of several lines is found; each is reported at its first line.
      const hits = find(content).sort((a, b) => a.start - b.start);
      let line = 1, at = 0;
      const seen = new Set<string>();
      for (const hit of hits) {
        for (; at < hit.start; at++) if (content.charCodeAt(at) === 10) line++;
        if (seen.has(`${line} ${hit.name}`)) continue;
        seen.add(`${line} ${hit.name}`);
        leaks++; console.log(`${file}:${line} ${hit.name}`);
      }
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
    if (!master) fail(`${NO_DIALOG} Run the command in a terminal.`, 2);
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
  await core.rememberAccount(email, server);
  console.log(`${BRAND.name} now keeps its own bw login in ${core.OWN_BW_DIR}; your personal bw login is untouched.`);
  await core.rememberBackend("bw");
  if (existsSync(core.VAULT_FILE)) console.log(`New items now go to the agent account; ${BRAND.refScheme}:// items keep resolving.`);
  await core.audit("setup", [], "cli");
  const minutes = Math.round(core.SESSION_TTL_MS / 60000);
  console.log(`ready: bw login=${email} (own). ${unattended ? "The session stays open (unattended)." : `Sessions end after ${minutes} minutes; then ${kept ? "keyshroud unlocks again from the keychain" : "keyshroud asks for the master password again"}.`}`);
  console.log(`Next: \`${BRAND.bin} migrate\` copies the wired secrets from your personal vault.`);
}

// migrate: copy the items that wired names (and env files) reference from the
// personal vault into the agent account. Same names, so references keep working.
// migrate --to local: copies every Vaultwarden item a wired name points at into the local vault and
// rewires those names to it. Vaultwarden keeps the originals; the old references are saved to a file.
async function migrateLocalCommand(args: string[]): Promise<void> {
  requireKnownFlags(args, ["--to"], ["--yes"]);
  if (valueAfter(args, "--to") !== "local") fail("--to must be local", 2);
  type Wire = { path: string; name: string; raw: string };
  type Group = { ref: SecretRef; local: string; wires: Wire[]; shared?: boolean };
  // One group per reference exactly as it is written, not per name it gets in the local vault.
  const groups = new Map<string, Group>();
  for (const path of core.wiringFiles()) for (const [name, entry] of Object.entries(await core.readAuthEntries(path))) {
    const raw = core.authEntryRaw(entry);
    let ref: SecretRef | null = null;
    try { ref = raw === undefined ? null : parseRef(raw); } catch {}
    if (!ref || ref.scheme) continue;
    // A field other than the password becomes an item of its own: "Item (username)", "Item (field dsn)".
    const local = ref.field === "password" ? ref.item : `${ref.item} (${typeof ref.field === "object" ? `field ${ref.field.custom}` : ref.field})`;
    const key = formatRef(ref);
    const group = groups.get(key) ?? { ref, local, wires: [] };
    group.wires.push({ path, name, raw: raw! });
    groups.set(key, group);
  }
  const rows = [...groups.values()].sort((a, b) => a.local.localeCompare(b.local));
  // Two references that would get one name there (`Shared` and `shared`; a field "dsn" of "Sentry"
  // and an item called "Sentry (field dsn)") become one item only if they hold one value: else
  // both are left where they are.
  for (const row of rows) row.shared = rows.some((other) => other !== row && other.local.toLowerCase() === row.local.toLowerCase());
  if (!rows.length) {
    console.log("Nothing to migrate: no wired name points at Vaultwarden.");
    // Nothing left there to move: with --yes the local vault is where new items go from now on.
    if (args.includes("--yes") && (await core.defaultBackend()) !== "local") { await core.rememberBackend("local"); console.log("New items go to the local vault."); }
    return;
  }
  const existing = new Set((await core.findItems("", "local").catch(() => [])).map((item) => item.name.toLowerCase()));
  const width = Math.max(4, ...rows.map((row) => row.local.length));
  console.log("migrate plan (Vaultwarden -> local vault):");
  for (const row of rows) {
    const problem = itemNameProblem(row.local);
    console.log(`  ${row.local.padEnd(width)}  ${problem ? `refused: the name ${problem}` : row.shared ? "copy, if the references that get this name hold one value" : existing.has(row.local.toLowerCase()) ? "in the local vault already (kept if the value is the same)" : "copy"}  <- ${[...new Set(row.wires.map((wire) => wire.name))].join(", ")}`);
  }
  console.log(`${rows.length} item(s) for ${rows.reduce((n, row) => n + row.wires.length, 0)} wired name(s); Vaultwarden keeps the originals.`);
  if (!args.includes("--yes")) { console.log("Dry run: nothing copied. Re-run with --yes."); return; }

  await core.openBackend("bw", { prompt: true });
  await core.prepareLocalVault({ prompt: true });
  const moved: Group[] = [], failed: string[] = [];
  const resolved = new Map<Group, string | null>();
  for (const row of rows) resolved.set(row, await core.resolveRef(row.ref).catch(() => null));
  for (const row of rows) {
    if (itemNameProblem(row.local)) { failed.push(`${row.local} (name)`); continue; }
    const value = resolved.get(row) ?? null;
    if (row.shared && rows.some((other) => other.local.toLowerCase() === row.local.toLowerCase() && resolved.get(other) !== value)) { failed.push(`${row.local} (two references with different values would get this name)`); continue; }
    if (value === null) { failed.push(`${row.local} (unresolved in Vaultwarden)`); continue; }
    const localRef: SecretRef = { item: row.local, field: "password", scheme: "local" };
    try {
      if (existing.has(row.local.toLowerCase())) {
        if ((await core.resolveRef(localRef)) !== value) { failed.push(`${row.local} (a different value is already in the local vault)`); continue; }
      } else { await core.createSecretItem({ itemName: row.local, secret: value, envName: row.wires[0].name, backend: "local" }); existing.add(row.local.toLowerCase()); }
      if ((await core.resolveRef(localRef)) !== value) { failed.push(`${row.local} (not read back)`); continue; }
      moved.push(row);
    } catch (error) { failed.push(`${row.local} (${error instanceof Error ? error.message : String(error)})`); }
  }
  // References only, never values: enough to rewire by hand.
  const backup = join(core.CONFIG_DIR, `migrate-local-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const wires = moved.flatMap((row) => row.wires);
  await writeFile(backup, `${JSON.stringify(wires, null, 2)}\n`, { mode: 0o600 });
  // Only an entry that still holds the reference the plan was made from is rewired.
  let rewired = 0;
  for (const row of moved) for (const wire of row.wires) {
    const result = await core.writeAuthEntry(wire.path, wire.name, core.referenceFor(row.local, "local"), { replaces: wire.raw });
    if (result.ok) rewired++; else failed.push(`${wire.name} in ${wire.path} (changed meanwhile; not rewired)`);
  }
  if (moved.length) await core.rememberBackend("local");
  await core.audit("migrate", moved.map((row) => row.local), "cli");
  await core.refreshRedactIndex();
  console.log(`moved ${new Set(moved.map((row) => row.local.toLowerCase())).size} item(s) into the local vault and rewired ${rewired} name(s); new items go to the local vault.`);
  console.log(`Vaultwarden still holds the originals. The previous references are in ${core.shownPath(backup)}; .env.refs files with bw:// references still use Vaultwarden.`);
  if (failed.length) fail(`Not moved: ${failed.join("; ")}`, 4);
}

async function migrateCommand(args: string[]): Promise<void> {
  if (args.includes("--to")) return migrateLocalCommand(args);
  requireKnownFlags(args, ["--item", "--refs", "--env-file"], ["--yes"]);
  if (!core.OWN_BW_LOGIN) fail(`Run \`${BRAND.bin} setup\` first: migrate copies items into ${BRAND.name}'s own agent account`, 2);
  const entries = [...await core.authEnvEntries()];
  for (const file of refsFiles(args)) entries.push(...await core.envFileEntries(file));
  const names = new Map<string, string>();
  for (const entry of entries) { try { const ref = parseRef(entry.raw); if (ref && !ref.scheme) names.set(ref.item.toLowerCase(), ref.item); } catch {} }
  for (const name of valuesAfter(args, "--item")) names.set(name.toLowerCase(), name);
  await core.ensureSession({ prompt: true });
  const own = await core.findItems("");
  // An item that holds the personal master password would hand the agent account the whole vault.
  const { items: personal, holdsMaster, stored: masterStored } = await core.readPersonalItems();
  type Row = { name: string; state: "copy" | "present" | "missing" | "ambiguous" | "refused"; item?: Record<string, unknown> };
  const rows: Row[] = [...names.values()].sort().map((name) => {
    if (own.some((item) => item.name.toLowerCase() === name.toLowerCase() || item.id === name)) return { name, state: "present" };
    const matches = personal.filter((item) => String(item.name ?? "").toLowerCase() === name.toLowerCase() || item.id === name);
    if (matches.length === 1 && holdsMaster.has(matches[0].id)) return { name, state: "refused" };
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
  if (masterStored) console.log(`Your personal master password is still in the keychain, where any program running as you can read it. Once you no longer need it there: ${cut}`);
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

  const backend = await core.defaultBackend();
  const ref = (item: string) => backend === "local" ? { item, field: "password" as const, scheme: "local" as const } : { item, field: "password" as const };
  await core.openBackend(backend, { prompt: true });
  const existing = await core.findItems(prefix, backend);
  const rows: ImportRow[] = [];
  for (const entry of entries) {
    if (isRef(entry.value)) { rows.push({ entry, kind: "ref" }); continue; }
    const secret = (only.length ? only.includes(entry.name) : looksSecret(entry.name, entry.value)) && !skip.includes(entry.name);
    if (!secret) { rows.push({ entry, kind: "literal" }); continue; }
    const item = `${prefix} ${entry.name}`;
    const matches = existing.filter((candidate) => candidate.name.toLowerCase() === item.toLowerCase());
    if (matches.length > 1) { rows.push({ entry, item, kind: "conflict", note: "more than one vault item has this name" }); continue; }
    if (matches.length === 0) { rows.push({ entry, item, kind: "new" }); continue; }
    const current = await core.resolveRef(ref(matches[0].id));
    rows.push(current === entry.value
      ? { entry, item, kind: "reuse", note: "same value already in the vault" }
      : { entry, item, kind: "conflict", note: "vault item exists with a different value" });
  }

  const width = Math.max(4, ...rows.map((row) => row.entry.name.length));
  console.log(`import plan for ${from} (item prefix "${prefix}")`);
  for (const row of rows) {
    const label = row.kind === "literal" ? "literal   kept" : row.kind === "ref" ? "reference kept"
      : row.kind === "conflict" ? `secret    conflict: ${row.note} ("${row.item}")`
      : `secret    ${row.kind.padEnd(8)} -> ${refFor(row.item!, backend)}${row.note ? `  (${row.note})` : ""}`;
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

  if (backend === "local") await core.prepareLocalVault({ prompt: true });
  const created: string[] = [];
  for (const row of rows) {
    if (row.kind !== "new") continue;
    try {
      const result = await core.createSecretItem({ itemName: row.item!, secret: row.entry.value, envName: row.entry.name, notes: `Imported by ${BRAND.bin} from ${basename(from === "-" ? "stdin" : from)}`, backend });
      if (result.created) console.error(result.created);
    } catch { if (created.length) console.error(`Created before the failure: ${created.join(", ")}`); fail(`Failed to create the vault item for ${row.entry.name}; nothing was written to ${out}`, 3); }
    created.push(row.entry.name);
  }
  for (const row of toStore) {
    let value: string | null = null;
    try { value = await core.resolveRef(ref(row.item!)); } catch {}
    if (value !== row.entry.value) fail(`Verification failed for ${row.entry.name}: the vault does not return the imported value; nothing was written to ${out}`, 4);
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  for (const row of toStore) lines[row.entry.line - 1] = `${row.entry.exported ? "export " : ""}${row.entry.name}=${refFor(row.item!, backend)}`;
  const mode = replace ? (await stat(out)).mode & 0o777 : 0o600;
  const tmp = `${out}.tmp.${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, lines.join(eol), { mode, flag: "wx" });
  await rename(tmp, out);
  await core.audit("import", toStore.map((row) => row.entry.name), "cli");
  console.log(`imported ${toStore.length} secret(s) (${created.length} new); wrote ${out}`);
  if (!replace && from !== "-") console.log(`${from} still holds the plaintext values. Check with \`${BRAND.bin} run --refs ${relative(process.cwd(), out) || out} -- <cmd>\`, then delete it or re-run with --replace.`);
}

// Control and format characters in names are shown as "?".
function shown(text: string): string { return text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "?"); }

async function listCommand(args: string[]): Promise<void> {
  requireKnownFlags(args, []);
  const backends: core.BackendName[] = [];
  if (existsSync(core.VAULT_FILE)) backends.push("local");
  if (core.OWN_BW_LOGIN) backends.push("bw");
  else if ((await core.defaultBackend()) === "bw") console.error(`bw items are not listed: ${BRAND.bin} shares your personal bw login (run \`${BRAND.bin} setup\` to give it its own account)`);
  let any = false;
  for (const backend of backends) {
    let rows: core.ItemRow[];
    try { await core.openBackend(backend, { prompt: true }); rows = await core.listItems(backend); } catch (error) {
      console.error(`${backend}: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 3; continue;
    }
    for (const row of rows) {
      any = true;
      console.log(`${shown(row.ref)}  wired=${row.wired.join(",") || "none"}${row.duplicate ? `  name=${shown(row.name)} (not unique)` : ""}`);
    }
  }
  if (!any && !process.exitCode) console.error("no items");
}

// The item Claude Code's apiKeyHelper reads, if any (written by claude-setup).
async function apiKeyHelperItem(): Promise<{ backend: core.BackendName; name: string } | null> {
  try {
    const settings = JSON.parse(await readFile(join(homedir(), ".claude", "settings.json"), "utf8")) as Record<string, unknown>;
    const match = typeof settings.apiKeyHelper === "string" ? / api-key --item '((?:[^']|'\\'')*)'$/.exec(settings.apiKeyHelper) : null;
    return match ? await core.parseItemArg(match[1].replaceAll("'\\''", "'")) : null;
  } catch { return null; }
}

async function rmCommand(args: string[]): Promise<void> {
  requireKnownFlags(args, ["--item"], ["--yes"]);
  const itemArg = valueAfter(args, "--item"); if (!itemArg) fail(usage, 2);
  const { backend, name } = await parseItem(itemArg);
  if (backend === "bw" && !core.OWN_BW_LOGIN) fail(`${BRAND.bin} rm removes bw items only from its own agent account (${BRAND.bin} setup); remove this one in your Bitwarden app`, 2);
  await core.openBackend(backend, { prompt: true });
  const row = await core.findItemToRemove(name, backend);
  const helper = await apiKeyHelperItem();
  if (helper && helper.backend === backend && (helper.name === row.id || helper.name.trim().toLowerCase() === row.name.trim().toLowerCase())) {
    fail(`Claude Code's apiKeyHelper uses ${shown(row.ref)}: point it at another item first (${BRAND.bin} claude-setup --item NEW --force)`, 5);
  }
  const wired = row.wired.join(",") || "none";
  if (!args.includes("--yes")) {
    console.log(`would ${backend === "local" ? `delete ${shown(row.ref)} permanently` : `move ${shown(row.ref)} to the bw trash`}; unwire ${wired}`);
    console.log("Dry run: nothing removed. Re-run with --yes.");
    return;
  }
  if (!(process.stdin.isTTY && process.stderr.isTTY)) {
    if (process.platform !== "darwin" || process.env.SSH_CONNECTION || process.env.SSH_TTY) fail("rm --yes outside a terminal needs Touch ID on a Mac: run it in a terminal", 2);
    try { await core.approveWithTouchId(`remove "${shown(row.name)}" from the ${BRAND.name} vault`); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(message === "Cancelled" ? "Touch ID was not approved; nothing was removed" : `${message}; nothing was removed`, 3);
    }
  }
  const result = await core.removeItem(row);
  await core.audit("rm", [row.name], "cli");
  console.log(`removed ${shown(row.ref)} unwired=${result.unwired.join(",") || "none"} targets=${result.targets.map(core.shownPath).join(",") || "none"}`);
  for (const failed of result.failed) { console.error(`removed ${shown(row.ref)}, but could not unwire it from ${failed.path} (${failed.error}): remove the entries for it there by hand`); process.exitCode = 3; }
}

// A source's credential goes into the default vault as an item of its own (a second `source add`
// replaces it), and the source keeps only the reference to it.
async function keepCredential(args: string[], itemName: string): Promise<string> {
  const backend = await core.defaultBackend();
  await core.openBackend(backend, { prompt: true });
  if (backend === "local") await core.prepareLocalVault({ prompt: true });
  const secret = await readSecret(args, `Paste the ${itemName.toLowerCase()}: `, itemName);
  if ((await core.findItems(itemName, backend)).some((item) => item.name.toLowerCase() === itemName.toLowerCase())) await core.rotateSecretItem({ itemName, secret, backend });
  else { const { created } = await core.createSecretItem({ itemName, secret, backend }); if (created) console.error(created); }
  return refFor(itemName, backend);
}

async function sourceCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "list";
  if (action === "list") {
    requireKnownFlags(args, []);
    const { vault, infisical } = await core.readSources();
    if (vault) console.log(`vault addr=${vault.addr}${vault.namespace ? ` namespace=${vault.namespace}` : ""} auth=${vault.roleId ? `approle role-id=${vault.roleId} secret-id=${vault.secretId}` : vault.token ? `token ${vault.token}` : "token of `vault login` (~/.vault-token)"}${vault.caFile ? ` ca=${vault.caFile}` : ""}`);
    if (infisical) console.log(`infisical addr=${infisical.addr} auth=universal client-id=${infisical.clientId} client-secret=${infisical.clientSecret}${infisical.caFile ? ` ca=${infisical.caFile}` : ""}`);
    if (!vault && !infisical) console.log(`no source is set up (${BRAND.bin} source add vault --addr URL)`);
    console.log(`CLIs: ${(["op", "aws", "gcloud", "az"] as const).map((name) => `${name}=${core.nowhereOnPath(name) ? "missing" : "found"}`).join(" ")}`);
    return;
  }
  const name = args.shift();
  if ((action !== "add" && action !== "rm") || (name !== "vault" && name !== "infisical")) fail(usage, 2);
  if (action === "rm") {
    requireKnownFlags(args, []);
    await core.writeSource(name, null);
    await core.audit("source", [name], "cli");
    console.log(`removed source=${name} (its credential, if one was kept, is still in the vault: ${BRAND.bin} list)`);
    return;
  }
  requireKnownFlags(args, name === "vault" ? ["--addr", "--namespace", "--ca-file", "--role-id"] : ["--addr", "--ca-file", "--client-id"], name === "vault" ? ["--token", "--stdin", "--dialog"] : ["--stdin", "--dialog"]);
  // Without the flags, what the vault and bao commands themselves go by; the result line says which.
  const fromEnv = (suffix: string) => name === "vault" ? process.env[`BAO_${suffix}`]?.trim() || process.env[`VAULT_${suffix}`]?.trim() || undefined : undefined;
  const given = valueAfter(args, "--addr") ?? fromEnv("ADDR") ?? (name === "infisical" ? "https://app.infisical.com" : undefined);
  if (!given) fail("source add vault needs --addr https://… (or VAULT_ADDR)", 2);
  let addr: string;
  try { addr = sourceAddress(given); } catch (error) { fail(error instanceof Error ? error.message : String(error), 2); }
  const ca = valueAfter(args, "--ca-file") ?? fromEnv("CACERT");
  const caFile = ca ? resolve(ca) : undefined;
  if (caFile && !(await readFile(caFile, "utf8").catch(() => "")).includes("-----BEGIN CERTIFICATE-----")) fail(`${caFile} is not a PEM certificate file`, 2);
  if (name === "vault") {
    const roleId = valueAfter(args, "--role-id"); const namespace = valueAfter(args, "--namespace") ?? fromEnv("NAMESPACE");
    if (roleId && args.includes("--token")) fail("--token and --role-id are two ways to sign in: pick one", 2);
    const source: VaultSource = { addr, ...(namespace ? { namespace } : {}), ...(caFile ? { caFile } : {}) };
    if (roleId) { source.roleId = roleId; source.secretId = await keepCredential(args, "Source vault secret id"); }
    else if (args.includes("--token")) source.token = await keepCredential(args, "Source vault token");
    await core.writeSource("vault", source);
  } else {
    const clientId = valueAfter(args, "--client-id");
    if (!clientId) fail("source add infisical needs --client-id (a machine identity with Universal Auth)", 2);
    const source: InfisicalSource = { addr, ...(caFile ? { caFile } : {}), clientId, clientSecret: await keepCredential(args, "Source infisical client secret") };
    await core.writeSource("infisical", source);
  }
  await core.audit("source", [name], "cli");
  const verified = await core.checkSource(name).then(() => "yes", (error: Error) => `no (${error.message})`);
  // So a Claude Code hook masks the credential from now on.
  try { await core.refreshRedactIndex(); } catch {}
  const source = (await core.readSources())[name] as VaultSource | undefined;
  console.log(`source=${name} addr=${addr}${source?.namespace ? ` namespace=${source.namespace}` : ""}${caFile ? ` ca=${caFile}` : ""} verified=${verified}`);
  if (verified !== "yes") process.exitCode = 3;
}

// scope: what the project's scope file lets through, or (--only) a new one in this directory.
async function scopeCommand(args: string[]): Promise<void> {
  requireKnownFlags(args, ["--only"], ["--clear"]);
  const here = join(process.cwd(), core.SCOPE_FILE);
  const only = valueAfter(args, "--only");
  if (args.includes("--clear")) {
    if (only !== undefined) fail("--only writes a scope and --clear removes one: pick one", 2);
    const removed = await unlink(here).then(() => true, () => false);
    console.log(removed ? `removed ${core.shownPath(here)}` : `no ${core.SCOPE_FILE} in this directory`);
  } else if (only !== undefined) {
    const patterns = only.split(",").map((pattern) => pattern.trim()).filter(Boolean);
    const bad = patterns.find((pattern) => !core.scopePatternOk(pattern));
    if (bad !== undefined) fail(`${bad} is not a variable name (UPPER_SNAKE_CASE, with * for any run of characters)`, 2);
    await writeFile(here, `${JSON.stringify({ only: patterns }, null, 2)}\n`);
  }
  const { entries, outside, scope } = await core.scopedEnvEntries();
  const names = [...new Set(entries.map((entry) => entry.name))];
  if (!scope) { console.log(`scope=none: every wired name can be used here (${names.length}). \`${BRAND.bin} scope --only NAME,PREFIX_*\` writes ./${core.SCOPE_FILE}`); return; }
  console.log(`scope=${core.shownPath(scope.path)} only=${scope.only.join(",") || "nothing"}`);
  console.log(`in scope (${names.length}): ${names.join(", ") || "none"}`);
  console.log(`outside: ${outside.length} wired name(s)`);
  const idle = scope.only.filter((pattern) => !names.some((name) => core.inScope({ path: scope.path, only: [pattern] }, name)));
  if (idle.length) console.error(`no wired name matches: ${idle.join(", ")}`);
}

// claude-guard: Claude Code starts its shell through a launcher that is named like the real shell
// (Claude Code takes a path with bash or zsh in it), and guard.ts masks what each command prints.
// Whether the guard is on is said by one file alone, Claude Code's settings: it is on while they
// name a launcher. A launcher looks there too, and only starts the shell once they no longer do
// (a session that is running keeps the launcher it was started with). Each settings file has a
// directory of its own in CONFIG_DIR/guard for its launchers and for guard.json, which keeps the
// shell the newest launcher stands in for and what the setting was before.
const GUARD_DIR = join(core.CONFIG_DIR, "guard");
interface GuardState { shell?: string; previous?: string }
const guardLauncher = (value: unknown): value is string => typeof value === "string" && dirname(dirname(value)) === GUARD_DIR && ["bash", "zsh"].includes(basename(value));
const guardDir = (settingsFile: string) => join(GUARD_DIR, createHash("sha256").update(settingsFile).digest("hex").slice(0, 16));
async function guardState(dir: string): Promise<GuardState> {
  try { const state = JSON.parse(await readFile(join(dir, "guard.json"), "utf8")) as GuardState; return state && typeof state === "object" ? state : {}; } catch { return {}; }
}
// In place by a rename: a session may be starting its shell through the launcher.
async function writeGuardFile(path: string, text: string, mode: number): Promise<void> {
  const tmp = `${path}.tmp.${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, text, { mode, flag: "wx" });
  await chmod(tmp, mode);
  await rename(tmp, path);
}
async function usableShell(path: string | undefined): Promise<boolean> {
  if (!path || !path.startsWith("/") || !["bash", "zsh"].includes(basename(path)) || path.startsWith(`${GUARD_DIR}/`)) return false;
  return access(path, fsConstants.X_OK).then(() => true, () => false);
}
// On and off are each one write of the settings, made under their lock as a write that cannot
// land once that lock is gone: a run that was paused past it changes nothing.
async function guardCommand(args: string[]): Promise<void> {
  requireKnownFlags(args, ["--settings", "--shell"], ["--off"]);
  if (process.platform === "win32") fail("claude-guard stands in for a POSIX shell: not on Windows, where the hook masks the commands that succeed", 2);
  const settingsPath = resolve(valueAfter(args, "--settings") ?? join(homedir(), ".claude", "settings.json"));
  if (args.includes("--off")) {
    const changed = await changeSettings(settingsPath, async (settings, target) => {
      const env = settings.env as Record<string, unknown> | undefined;
      if (!env || !guardLauncher(env.CLAUDE_CODE_SHELL)) return false;
      // What the setting was before is this file's own record; a launcher of another file has none here.
      const previous = dirname(env.CLAUDE_CODE_SHELL) === guardDir(target) ? (await guardState(guardDir(target))).previous : undefined;
      if (previous) env.CLAUDE_CODE_SHELL = previous; else delete env.CLAUDE_CODE_SHELL;
      if (!Object.keys(env).length) delete settings.env;
      return true;
    });
    console.log(changed ? "guard=off (sessions that are running keep their launcher, which now only starts the shell)" : "guard=off (it was not on)");
    return;
  }
  const asked = valueAfter(args, "--shell");
  if (asked && !(await usableShell(resolve(asked)))) fail(`--shell must be a bash or a zsh that can be run (Claude Code takes no other shell): ${asked}`, 2);
  const guard = shellQuote(fileURLToPath(import.meta.url).replace(/cli(\.[cm]?[jt]s)$/, "guard$1"));
  let done: { shell: string; launcher: string } | null = null;
  await changeSettings(settingsPath, async (settings, target) => {
    const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env) ? settings.env as Record<string, unknown> : {};
    const current = env.CLAUDE_CODE_SHELL;
    const dir = guardDir(target);
    const on = guardLauncher(current) && dirname(current) === dir;
    const kept = on ? await guardState(dir) : {};
    // The shell Claude Code was told to use before, if any, is the one to stand in for, and to give
    // back; never a launcher (one of another settings file, copied here).
    const previous = on ? kept.previous : typeof current === "string" && current && !guardLauncher(current) ? current : undefined;
    let shell: string | undefined;
    for (const candidate of [asked && resolve(asked), kept.shell, previous, process.env.SHELL, "/bin/zsh", "/bin/bash", "/usr/bin/zsh", "/usr/bin/bash", "/usr/local/bin/zsh", "/usr/local/bin/bash", "/opt/homebrew/bin/zsh", "/opt/homebrew/bin/bash"]) {
      if (await usableShell(candidate || undefined)) { shell = candidate as string; break; }
    }
    if (!shell) return false;
    const launcher = join(dir, basename(shell));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const path of [GUARD_DIR, dir]) await chmod(path, 0o700);
    const unread = `${BRAND.bin} guard: ${settingsPath} cannot be read, so whether the guard is still on is not known and nothing was run. Start a new Claude Code session, or run \`${BRAND.bin} claude-guard\` again.`;
    const gone = `${BRAND.bin} guard: node or the ${BRAND.bin} it was set up with is gone, so nothing was run. Run \`${BRAND.bin} claude-guard\` again or \`${BRAND.bin} claude-guard --off\`, or take CLAUDE_CODE_SHELL out of ${settingsPath}.`;
    await writeGuardFile(launcher, [
      "#!/bin/sh",
      `# ${BRAND.bin} guard: Claude Code starts its shell through this file (CLAUDE_CODE_SHELL in its settings),`,
      "# so that what a command prints is masked as it is written, whether the command fails or not.",
      `# \`${BRAND.bin} claude-guard --off\` turns it off; \`${BRAND.bin} claude-guard\` writes this file again.`,
      // Still on? The settings say, read whole (cat fails where a read does): unread is not off.
      `cat=/bin/cat; [ -x "$cat" ] || cat=cat`,
      `settings=$("$cat" ${shellQuote(settingsPath)} 2>/dev/null) || { echo ${shellQuote(unread)} >&2; exit 126; }`,
      // Off, no launcher of theirs named any more: the shell alone, for the sessions started through this file.
      `case "$settings" in *${shellQuote(`${JSON.stringify(dir).slice(0, -1)}/`)}*) ;; *) exec ${shellQuote(shell)} "$@" ;; esac`,
      // The node this was set up with, or after an upgrade moved it, the one on PATH.
      `node=${shellQuote(process.execPath)}; [ -x "$node" ] || node=$(command -v node)`,
      `[ -x "$node" ] && [ -f ${guard} ] || { echo ${shellQuote(gone)} >&2; exit 126; }`,
      `exec "$node" ${guard} ${shellQuote(core.REDACT_INDEX_FILE)} ${shellQuote(shell)} "$@"`,
      "",
    ].join("\n"), 0o755);
    await writeGuardFile(join(dir, "guard.json"), `${JSON.stringify({ shell, ...(previous ? { previous } : {}) })}\n`, 0o600);
    done = { shell, launcher };
    if (current === launcher) return false;
    settings.env = { ...env, CLAUDE_CODE_SHELL: launcher };
    return true;
  });
  const on = done as { shell: string; launcher: string } | null;
  if (!on) fail("No bash or zsh found to stand in for; name one with --shell", 2);
  // Which vault this machine uses is settled first: on one with none yet, the audit line alone
  // would look like the trace of an old Vaultwarden setup.
  await core.defaultBackend();
  await core.audit("claude-guard", [], "cli");
  console.log(`guard=on shell=${on.shell} launcher=${core.shownPath(on.launcher)} settings=${core.shownPath(settingsPath)}`);
  console.error(`Claude Code sessions started from now on run their Bash commands through it (about 0.2 s more each); ${BRAND.bin} claude-guard --off undoes it.`);
}
async function guardLine(): Promise<string> {
  const settings = await readSettings(join(homedir(), ".claude", "settings.json")).catch(() => ({} as Record<string, unknown>));
  const launcher = (settings.env as Record<string, unknown> | undefined)?.CLAUDE_CODE_SHELL;
  if (!guardLauncher(launcher)) return "claude guard=off";
  if (!existsSync(launcher)) return `claude guard=broken (${core.shownPath(launcher)} is missing: run ${BRAND.bin} claude-guard again)`;
  const { shell } = await guardState(dirname(launcher));
  return `claude guard=on${shell && basename(shell) === basename(launcher) ? ` (shell ${shell})` : ""}`;
}

const KEY_TYPES: readonly VaultKeyType[] = ["keychain", "secure-enclave", "passphrase", "dpapi"];
async function rekeyCommand(args: string[]): Promise<void> {
  requireKnownFlags(args, ["--to"]);
  const to = valueAfter(args, "--to");
  if (to !== undefined && !KEY_TYPES.includes(to as VaultKeyType)) fail("--to must be keychain, secure-enclave, passphrase or dpapi", 2);
  if (!(process.stdin.isTTY && process.stderr.isTTY)) fail(`${BRAND.bin} rekey asks for the vault's current key: run it in a terminal`, 2);
  const result = await core.rekeyLocal(to as VaultKeyType | undefined);
  console.error(result.notice);
  console.log(`rekeyed vault=${core.shownPath(core.VAULT_FILE)} key=${result.from} -> key=${result.to} items=${result.items}`);
}

async function backupCommand(args: string[]): Promise<void> {
  requireKnownFlags(args, ["--out"]);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const out = resolve(valueAfter(args, "--out") ?? `${BRAND.bin}-backup-${stamp}.json`);
  if (!(process.stdin.isTTY && process.stderr.isTTY)) fail(`${BRAND.bin} backup asks for the vault's current key and a passphrase for the backup: run it in a terminal`, 2);
  const { items } = await core.backupLocal(out);
  console.log(`backup=${core.shownPath(out)} items=${items}`);
  console.error(`Keep it somewhere that is not this machine. \`${BRAND.bin} restore ${core.shownPath(out)}\` brings the items back and wires their names again.`);
}

async function restoreCommand(args: string[]): Promise<void> {
  const [file, ...flags] = args;
  if (!file || file.startsWith("--")) fail(usage, 2);
  requireKnownFlags(flags, [], ["--yes", "--replace"]);
  if (!(process.stdin.isTTY && process.stderr.isTTY)) fail(`${BRAND.bin} restore asks for the passphrase of the backup: run it in a terminal`, 2);
  const apply = flags.includes("--yes"), replace = flags.includes("--replace");
  const plan = await core.restoreLocal(resolve(file), { apply, replace });
  const line = (label: string, names: string[]) => { if (names.length) console.log(`  ${label} (${names.length}): ${names.join(", ")}`); };
  console.log(apply ? `restored from ${core.shownPath(resolve(file))}:` : `restore plan (${core.shownPath(resolve(file))} -> local vault):`);
  line(apply ? "added" : "add", plan.add);
  line("already here", plan.same);
  line(replace ? (apply ? "replaced" : "replace") : "another value here, kept (--replace takes the backup's)", plan.differ);
  line(apply ? "wired" : "wire", plan.wire);
  if (!plan.add.length && !plan.same.length && !plan.differ.length) console.log("  the backup holds no item");
  if (!apply) console.log("Dry run: nothing changed. Re-run with --yes.");
}

// doctor with the local vault as the default backend: no bw lines, no bw call
// (unless auth.json wires a bw reference).
async function localDoctor(reason: string): Promise<void> {
  const l = await core.localStatus();
  console.log(`backend=local (${reason})`);
  console.log(`local ${localLine(l)}`);
  if (core.keyHasSessions(l.key) && l.status === "unlocked" && l.expiresAt !== undefined) console.log(`session expires=${l.expiresAt === null ? "never (unattended)" : new Date(l.expiresAt).toISOString()}`);
  for (const path of core.wiringFiles()) for (const name of Object.keys(await core.readAuthEntries(path))) console.log(`${path} ${name} resolved=${(await authValue(name)) ? "yes" : "no"}`);
  console.log(`redact index=${(await core.readRedactIndex()) ? "present" : "missing"}`);
  const settings = await readSettings(join(homedir(), ".claude", "settings.json")).catch(() => ({} as Record<string, unknown>));
  console.log(`apiKeyHelper wired=${settings.apiKeyHelper ? "yes" : "no"}`);
  console.log(await guardLine());
  // Never builds the helper and never asks.
  if (l.key === "secure-enclave" || process.env[`${BRAND.envPrefix}_VAULT_KEY`]?.trim() === "secure-enclave") console.log(`touchid helper=${await core.touchIdHelperState()}`);
  if (l.status === "locked" || l.status === "error") process.exitCode = 3;
}

async function main(): Promise<void> {
  // `keyshroud doctor | head -1`: a closed pipe ends the output, not with a stack trace.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => { if (error.code === "EPIPE") process.exit(); throw error; });
  const args = process.argv.slice(2); const command = args.shift();
  // Run by a terminal window for a process that waits (see terminalWindow): what this command
  // prints (names, never values) is kept for it as well.
  const kept = process.env[`${BRAND.envPrefix}_TERMINAL_OUTPUT`];
  if (kept && /terminal-[0-9a-f]{16}\.out$/.test(kept)) for (const name of ["log", "error"] as const) {
    const write = console[name];
    console[name] = (...parts: unknown[]) => { try { appendFileSync(kept, `${parts.join(" ")}\n`, { mode: 0o600 }); } catch {} write(...parts); };
  }
  if (command === "_terminal") { await terminalWindow(args[0]); return; }
  if (!command || command === "--help" || command === "-h" || command === "help") { console.log(usage); if (!command) process.exitCode = 2; return; }
  if (command === "--version" || command === "-v") {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    console.log(pkg.version); return;
  }
  try {
    if (command === "status") {
      if ((await core.defaultBackend()) === "local") {
        const l = await core.localStatus();
        console.log(l.status === "none" ? `backend=local vault=none: no secrets yet (${BRAND.bin} add --env NAME --item ITEM)` : `backend=local ${localLine(l)}`);
        if (l.status === "locked" || l.status === "error") process.exitCode = 3;
        return;
      }
      try { await core.ensureSession(); } catch {}
      const s = await core.getStatus();
      console.log(`server=${s.serverUrl ?? "unconfigured"} status=${s.status} items=${s.items ?? "unknown"} bw=${s.version ?? "missing"}`);
      const l = await core.localStatus();
      if (l.status !== "none") console.log(`local ${localLine(l)}`);
      if (s.status !== "unlocked") process.exitCode = 3;
      return;
    }
    if (command === "unlock") {
      requireKnownFlags(args, [], ["--unattended", "--stdin"]);
      let passphrase: string | undefined;
      if (args.includes("--stdin")) {
        if (args.includes("--unattended")) fail("--unattended needs a terminal; --stdin opens a session that ends after 30 minutes", 2);
        if ((await core.defaultBackend()) !== "local") fail("--stdin unlocks a local passphrase vault only", 2);
        passphrase = (await readStdin()).replace(/\r?\n$/, "");
        if (!passphrase) fail("No passphrase on stdin", 2);
      }
      if ((await core.defaultBackend()) === "local") {
        const result = await core.unlockLocal({ unattended: args.includes("--unattended"), passphrase });
        if (result.created) console.error(result.created);
        if (!core.keyHasSessions(result.key)) console.log(`the local vault opens with its key from ${keySource(result.key)}; nothing to unlock`);
        else console.log(result.expiresAt ? `unlocked until ${new Date(result.expiresAt).toLocaleTimeString()}` : "unlocked (no time limit)");
        return;
      }
      await core.ensureSession({ prompt: true, unattended: args.includes("--unattended") });
      const stored = await core.readSession();
      console.log(!stored ? "unlocked" : stored.expiresAt ? `unlocked until ${new Date(stored.expiresAt).toLocaleTimeString()}` : "unlocked (no time limit)");
      return;
    }
    if (command === "lock") {
      requireKnownFlags(args, []);
      const result = await core.lock();
      const local = result.bw || result.local ? null : await core.localStatus();
      console.log(local?.key === "keychain" || local?.key === "dpapi" ? `nothing to lock: the local vault opens with its key from ${keySource(local.key)}` : local?.status === "none" ? "nothing to lock: no local vault yet" : "locked");
      return;
    }
    if (command === "dialog") {
      const mode = args[0];
      if (args.length > 1 || (mode !== undefined && mode !== "on" && mode !== "off" && mode !== "terminal")) fail(usage, 2);
      if (mode) await core.setDialogs(mode);
      console.log({
        on: "dialog=on (a command without a terminal asks in a window on the desktop)",
        off: "dialog=off (a value or a passphrase is asked in a terminal only)",
        terminal: "dialog=terminal (a command without a terminal opens a terminal window that runs it, and you answer there)",
      }[await core.dialogMode()]);
      return;
    }
    if (command === "scan") { await scan(args); return; }
    if (command === "env") {
      if (args.some((arg) => arg !== "--shell")) fail(usage, 2);
      // Names need no unlock, so they list even while the vault is locked.
      // A scope file that is not one is said, not answered with nothing.
      if (args.includes("--shell")) { await core.projectScope(); for (const [name, value] of Object.entries(await core.buildEnvMap())) console.log(`export ${name}=${shellQuote(value)}`); }
      else for (const name of new Set((await core.scopedEnvEntries()).entries.map((entry) => entry.name))) console.log(name);
      return;
    }
    if (command === "scope") { await scopeCommand(args); return; }
    if (command === "get") {
      if (args.length !== 1) fail(usage, 2);
      const ref = parseRef(args[0]);
      const scope = ref ? null : await core.projectScope();
      if (!core.inScope(scope, args[0])) fail(`Secret unresolved: ${args[0]} ${outsideScope(scope!)}`, 4);
      const raw = ref ? args[0] : await authRaw(args[0]);
      let vaultError = "";
      try { await core.ensureUnlocked(raw ? [raw] : [], { prompt: true }); } catch (error) { vaultError = error instanceof Error ? error.message : String(error); }
      const value = ref ? await core.resolveRef(ref) : await authValue(args[0]);
      if (value === null) fail(`Secret unresolved: ${args[0]}${core.unresolvedReason(vaultError)}`, 4);
      await core.audit("get", [args[0]], "cli");
      if (ref || core.isSecretSource(raw ?? "")) await coverPrinted({ [ref ? ref.item : args[0]]: value });
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
      const { backend, name } = await parseItem(item);
      await core.openBackend(backend, { prompt: true });
      const value = await core.getSecret(name, backend);
      await core.audit("api-key", [name], "cli");
      await coverPrinted({ [name]: value });
      process.stdout.write(value); return;
    }
    if (command === "add") {
      requireKnownFlags(args, ["--env", "--item", "--notes", "--target"], ["--stdin", "--dialog"]);
      const envName = valueAfter(args, "--env"); const itemArg = valueAfter(args, "--item"); const notes = valueAfter(args, "--notes");
      if (!envName || !itemArg || !ENV_NAME_RE.test(envName)) fail(usage, 2);
      const { backend, name: itemName } = await parseItem(itemArg);
      checkNames(envName, itemName);
      await inTerminalWindow([command, ...args]);
      const reference = core.referenceFor(itemName, backend);
      const targets = targetList(valueAfter(args, "--target"));
      await core.openBackend(backend, { prompt: true });
      // A passphrase for a new local vault is asked before the value; nothing is written until both are in hand.
      if (backend === "local") await core.prepareLocalVault({ prompt: true });
      if ((await core.findItems(itemName, backend)).some((item) => item.name.toLowerCase() === itemName.toLowerCase())) fail(`Vault item already exists: ${itemName}`, 5);
      // Before the value is asked for: a name that is wired elsewhere would leave the new item unused.
      for (const path of targets) {
        const entries = await core.readAuthEntries(path);
        const now = Object.hasOwn(entries, envName) ? core.authEntryRaw(entries[envName]) : undefined;
        if (now === undefined || now === reference) continue;
        let to = now; try { const ref = parseRef(now); if (ref) to = formatRef(ref); } catch {}
        fail(`${envName} is already wired to ${shown(to)}: \`${BRAND.bin} rotate --item\` gives that item a new value; to point ${envName} at a new item, \`${BRAND.bin} unwire --env ${envName}\` first`, 5);
      }
      const secret = await readSecret(args, `Paste secret for ${envName}: `, itemName, envName);
      const { created } = await core.createSecretItem({ itemName, secret, envName, notes, backend });
      if (created) console.error(created);
      await core.audit("add", [envName], "cli");
      let conflict = false;
      for (const path of targets) { const result = await core.writeAuthEntry(path, envName, reference); if (!result.ok) conflict = true; }
      const verified = (await core.resolveShellValue(reference)) !== null;
      await core.refreshRedactIndex();
      console.log(`created item=${itemName} env=${envName} targets=${targets.map(core.shownPath).join(",")} verified=${verified ? "yes" : "no"}`);
      await scopeNote(envName);
      if (conflict) { console.error("Item created, but one or more auth targets already contained the environment name."); process.exitCode = 5; }
      return;
    }
    if (command === "import") { await importCommand(args); return; }
    if (command === "list") { await listCommand(args); return; }
    if (command === "rm") { await rmCommand(args); return; }
    if (command === "rekey") { await rekeyCommand(args); return; }
    if (command === "backup") { await backupCommand(args); return; }
    if (command === "restore") { await restoreCommand(args); return; }
    if (command === "source") { await sourceCommand(args); return; }
    if (command === "setup") { await setupCommand(args); return; }
    if (command === "migrate") { await migrateCommand(args); return; }
    if (command === "rotate") {
      requireKnownFlags(args, ["--item"], ["--stdin", "--dialog"]);
      const itemArg = valueAfter(args, "--item"); if (!itemArg) fail(usage, 2);
      const { backend, name: itemName } = await parseItem(itemArg);
      await inTerminalWindow([command, ...args]);
      await core.openBackend(backend, { prompt: true }); const secret = await readSecret(args, "Paste replacement secret: ", itemName);
      await core.rotateSecretItem({ itemName, secret, backend }); await core.audit("rotate", [itemName], "cli"); await core.refreshRedactIndex();
      console.log(`rotated item=${itemName}`); return;
    }
    if (command === "wire") {
      requireKnownFlags(args, ["--env", "--item", "--target"], ["--force"]);
      const envName = valueAfter(args, "--env"); const itemArg = valueAfter(args, "--item");
      if (!envName || !itemArg || !ENV_NAME_RE.test(envName)) fail(usage, 2);
      if (isLoaderEnvName(envName)) fail(`${envName} changes what programs load or run; it cannot be wired to a secret`, 2);
      // A source reference is wired as it is written; an item by its name in one of the vaults.
      const item = isSourceRef(itemArg) ? null : await parseItem(itemArg);
      const itemName = item?.name ?? itemArg;
      let reference: string;
      if (item) reference = core.referenceFor(item.name, item.backend);
      else { try { reference = core.sourceReferenceFor(itemArg); } catch (error) { fail(error instanceof Error ? error.message : String(error), 2); } }
      const targets = targetList(valueAfter(args, "--target"));
      for (const path of targets) { const result = await core.writeAuthEntry(path, envName, reference, { overwrite: args.includes("--force") }); if (!result.ok) fail(result.message, 5); }
      // So a Claude Code hook masks the value from now on (when the vault is open: wire itself never asks).
      try { await core.ensureUnlocked([reference]); await core.refreshRedactIndex(); } catch {}
      console.log(`wired env=${envName} item=${itemName} targets=${targets.map(core.shownPath).join(",")}`); await scopeNote(envName); return;
    }
    if (command === "unwire") {
      requireKnownFlags(args, ["--env", "--target"]);
      const envName = valueAfter(args, "--env"); if (!envName) fail(usage, 2);
      // Variable names only: the other entries of an auth.json are the agent's own provider logins.
      if (!ENV_NAME_RE.test(envName)) fail(`${envName} is not a variable name (UPPER_SNAKE_CASE); ${BRAND.bin} unwire removes only names it wired`, 2);
      const targets = unwireList(valueAfter(args, "--target")); const names: string[] = [];
      for (const path of targets) if (existsSync(path) && await core.deleteAuthEntry(path, envName)) names.push(path);
      console.log(`removed env=${envName} targets=${names.map(core.shownPath).join(",") || "none"}`); return;
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
      const ttl = valueAfter(args, "--ttl-ms"); if (ttl && !/^\d+$/.test(ttl)) fail(usage, 2);
      const changed = await changeSettings(settingsPath, (settings) => {
        if (settings.apiKeyHelper && !args.includes("--force")) return false;
        const cliPath = fileURLToPath(import.meta.url); settings.apiKeyHelper = `${shellQuote(process.execPath)} ${shellQuote(cliPath)} api-key --item ${shellQuote(itemName)}`;
        if (ttl) settings.env = { ...(settings.env as Record<string, unknown> ?? {}), CLAUDE_CODE_API_KEY_HELPER_TTL_MS: ttl };
        return true;
      });
      if (!changed) fail("apiKeyHelper already set; use --force to replace it", 5);
      console.log(`configured apiKeyHelper for item=${itemName}`); return;
    }
    if (command === "claude-guard") { await guardCommand(args); return; }
    if (command === "doctor") {
      requireKnownFlags(args, []);
      const choice = await core.backendInfo();
      if (choice.backend === "local") { await localDoctor(choice.reason); return; }
      try { await core.ensureSession(); } catch {}
      const s = await core.getStatus(); console.log(`bw login=${core.OWN_BW_LOGIN ? `own agent account (${core.OWN_BW_DIR})` : `shared with your personal bw (run: ${BRAND.bin} setup)`}`); console.log(`bw version=${s.version ?? "missing (install @bitwarden/cli)"}`); console.log(`bw server=${s.serverUrl ?? "unconfigured (run: bw config server <url>)"}`); console.log(`session=${s.status}`);
      const session = await core.readSession();
      if (session) console.log(`session expires=${session.expiresAt === null ? "never (unattended)" : new Date(session.expiresAt).toISOString()}`);
      const source = await core.storedMasterSource();
      console.log(`master password=${source === "keychain" ? `stored in the keychain (${core.KEYCHAIN_MASTER_SERVICE}): unlocks without asking` : source === "file" ? `stored in ${core.MASTER_PASSWORD_FILE}: any program running as you can read it` : `not stored (${BRAND.bin} asks for it)`}`);
      const account = await core.readAccount();
      console.log(`relogin after a logout=${account ? `${account.email} at ${account.server}${process.platform === "darwin" && source === "keychain" ? " (asks for Touch ID)" : " (needs the API key in the keychain)"}` : `account unknown (run: ${BRAND.bin} setup)`}`);
      const presence = Object.entries(await core.keychainPresence());
      const locked = presence.some(([, present]) => !present) && await core.keychainLocked();
      for (const [service, present] of presence) console.log(`keychain ${service}=${present ? "present" : locked ? "unknown (keyring locked)" : "missing"}`);
      if (locked) console.log(`keyring=locked: ${core.KEYRING_LOCKED}`);
      // Logged out, every name would spawn a get that fails slowly: say why once instead.
      const loggedOut = s.status === "unauthenticated" || s.status === "unavailable";
      for (const path of core.wiringFiles()) for (const name of Object.keys(await core.readAuthEntries(path))) console.log(`${path} ${name} resolved=${loggedOut ? `unknown (bw is ${s.status})` : (await authValue(name)) ? "yes" : "no"}`);
      console.log(`redact index=${(await core.readRedactIndex()) ? "present" : "missing"}`);
      const settings = await readSettings(join(homedir(), ".claude", "settings.json")).catch(() => ({} as Record<string, unknown>));
      console.log(`apiKeyHelper wired=${settings.apiKeyHelper ? "yes" : "no"}`);
      console.log(await guardLine());
      console.log(`local ${localLine(await core.localStatus())}`);
      if (s.status !== "unlocked") process.exitCode = 3; return;
    }
    fail(usage, 2);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = failureCode(error); }
}
void main();
