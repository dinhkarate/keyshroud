// Runtime-neutral core: no pi/omp/Claude Code imports. Every caller (agent
// extensions, CLI, MCP server, hooks) goes through these functions.
import { execFile, spawn } from "node:child_process";
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { BRAND } from "./brand.ts";
import { buildRedactIndex, type RedactIndex } from "./redact.ts";
import { ENV_NAME_RE, isLoaderEnvName, itemNameProblem, legacyRefFor, parseEnvFile, parseRef, type SecretRef } from "./refs.ts";

const P = BRAND.envPrefix;
function setting(name: string): string | undefined {
  const value = process.env[`${P}_${name}`]?.trim();
  return value ? value : undefined;
}

export const CONFIG_DIR = setting("CONFIG_DIR") ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), BRAND.configDirName);
export const SESSION_FILE = join(CONFIG_DIR, "session");
export const MASTER_PASSWORD_FILE = join(CONFIG_DIR, "master-password");
export const MASTER_VERIFIER_FILE = join(CONFIG_DIR, "master-password.scrypt");
export const REDACT_INDEX_FILE = join(CONFIG_DIR, "redact-index.json");
export const AUDIT_FILE = join(CONFIG_DIR, "audit.jsonl");

// After `setup`, keyshroud keeps its own bw login (a dedicated agent account) in
// CONFIG_DIR/bw, with its own keychain entries, so the user's personal bw login
// and vault are never unlocked. Without it, keyshroud shares the default bw login.
export const OWN_BW_DIR = join(CONFIG_DIR, "bw");
export const PERSONAL_KEYCHAIN_MASTER_SERVICE = setting("PERSONAL_KEYCHAIN_MASTER") ?? "vaultwarden-master-password";
export let OWN_BW_LOGIN = false;
export let KEYCHAIN_MASTER_SERVICE = setting("KEYCHAIN_MASTER") ?? PERSONAL_KEYCHAIN_MASTER_SERVICE;
export let KEYCHAIN_CLIENT_ID_SERVICE = setting("KEYCHAIN_CLIENT_ID") ?? "vaultwarden-api-client-id";
export let KEYCHAIN_CLIENT_SECRET_SERVICE = setting("KEYCHAIN_CLIENT_SECRET") ?? "vaultwarden-api-client-secret";

export function useOwnBwLogin(): void {
  OWN_BW_LOGIN = true;
  process.env.BITWARDENCLI_APPDATA_DIR = OWN_BW_DIR;
  KEYCHAIN_MASTER_SERVICE = setting("KEYCHAIN_MASTER") ?? `${BRAND.bin}-master-password`;
  KEYCHAIN_CLIENT_ID_SERVICE = setting("KEYCHAIN_CLIENT_ID") ?? `${BRAND.bin}-api-client-id`;
  KEYCHAIN_CLIENT_SECRET_SERVICE = setting("KEYCHAIN_CLIENT_SECRET") ?? `${BRAND.bin}-api-client-secret`;
}
if (!process.env.BITWARDENCLI_APPDATA_DIR && existsSync(join(OWN_BW_DIR, "data.json"))) useOwnBwLogin();

export const PROVIDER_KEYS: ReadonlySet<string> = new Set([
  "anthropic", "openai", "azure-openai-responses", "deepseek", "google", "mistral",
  "groq", "cerebras", "cloudflare-ai-gateway", "cloudflare-workers-ai", "xai",
  "openrouter", "vercel-ai-gateway", "zai", "opencode", "opencode-go", "huggingface",
  "fireworks", "together", "kimi-coding", "minimax", "minimax-cn", "xiaomi",
  "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp",
]);

export interface VaultStatus { status: string; serverUrl: string | null; version: string | null; items: number | null }
export interface AuthTargets { omp: string; pi: string }

interface ExecResult { stdout: string; stderr: string }

// Windows: execFile and spawn run only .exe/.com files. npm puts CLIs (bw, npm,
// npx, ...) on PATH as .cmd shims: run the shim's script with this Node. Other
// .cmd/.bat files go through cmd.exe, each argument quoted.
export interface Invocation { command: string; args: string[]; verbatim?: boolean }
const windowsResolved = new Map<string, { file: string; script?: string } | null>();
// Windows system tools by absolute path: a bare name is looked up in the current directory first.
export const SYSTEM32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const POWERSHELL = join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe");

export function invocation(command: string, args: string[]): Invocation {
  if (process.platform !== "win32") return { command, args };
  if (!windowsResolved.has(command)) {
    const pathext = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    // `python3.12` still needs `.exe`; `npm.cmd` does not.
    const exts = pathext.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase())) ? [""] : pathext;
    const dirs = /[\\/]/.test(command) ? [""] : (process.env.PATH ?? "").split(";").map((dir) => dir.replace(/^"(.*)"$/, "$1")).filter(Boolean);
    let found: { file: string; script?: string } | null = null;
    search: for (const dir of dirs) for (const ext of exts) {
      const file = dir ? join(dir, command + ext) : command + ext;
      if (!existsSync(file)) continue;
      const script = /\.cmd$/i.test(file) ? /"%~?dp0%?\\([^"]+\.[cm]?js)"/i.exec(readFileSync(file, "utf8"))?.[1] : undefined;
      found = { file, script: script && join(dirname(file), script) };
      break search;
    }
    windowsResolved.set(command, found);
  }
  const found = windowsResolved.get(command);
  // Not on PATH: fail instead of letting spawn find a file in the current directory.
  if (!found) {
    if (/[\\/]/.test(command)) return { command, args };
    throw Object.assign(new Error(`${command}: not found on PATH`), { code: "ENOENT" });
  }
  if (found.script) return { command: process.execPath, args: [found.script, ...args] };
  if (!/\.(cmd|bat)$/i.test(found.file)) return { command: found.file, args };
  // As cross-spawn does: quote each argument for the C runtime, then escape every
  // cmd.exe metacharacter (`%` included) with ^, twice, because the batch file's
  // `%*` is parsed again; cmd then passes the text on as is.
  const meta = /([()\][%!^"`<>&|;, *?])/g;
  const quote = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`.replace(meta, "^$1").replace(meta, "^$1");
  return { command: process.env.ComSpec ?? join(SYSTEM32, "cmd.exe"), args: ["/d", "/s", "/c", `"${[found.file.replace(meta, "^$1"), ...args.map(quote)].join(" ")}"`], verbatim: true };
}

function bwCommand(args: string[]): [string, string[], boolean] {
  const { command, args: resolved, verbatim } = invocation("bw", args);
  return [command, resolved, Boolean(verbatim)];
}

function runFile(command: string, args: string[], options: Record<string, unknown> = {}, input?: string): Promise<ExecResult> {
  // Without it a locked bw waits on a hidden master-password prompt nobody can answer.
  if (command === "bw") {
    options = { ...options, env: { ...((options.env as NodeJS.ProcessEnv | undefined) ?? process.env), BW_NOINTERACTION: "true" } };
    try {
      let verbatim: boolean;
      [command, args, verbatim] = bwCommand(args);
      options = { ...options, windowsVerbatimArguments: verbatim };
    } catch (error) { return Promise.reject(error); }
  }
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, options as never, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message || "Command failed").trim();
        reject(new Error(message));
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    if (input !== undefined && child.stdin) {
      // A child that exits before reading its stdin must not crash us with EPIPE.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

export function getAuthTargets(): AuthTargets {
  return {
    omp: join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"), "auth.json"),
    pi: join(homedir(), ".pi", "agent", "auth.json"),
  };
}

// auth.json entries use the legacy shell form so pi/omp resolve them even
// without this package loaded.
export const referenceFor = legacyRefFor;

// Vault credentials never reach commands run on the agent's behalf: with the
// session token a child could dump the whole vault, defeating `--only`.
export const VAULT_ENV_KEYS: readonly string[] = ["BW_SESSION", "BW_PASSWORD", "BW_CLIENTID", "BW_CLIENTSECRET", "BITWARDENCLI_APPDATA_DIR"];

export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !VAULT_ENV_KEYS.includes(name)) env[name] = value;
  for (const [name, value] of Object.entries(extra)) if (!isLoaderEnvName(name)) env[name] = value;
  return env;
}

export async function bw(args: string[], opts: { input?: string; session?: string } = {}): Promise<string> {
  const session = opts.session ?? process.env.BW_SESSION;
  const env = { ...process.env, ...(session ? { BW_SESSION: session } : {}) };
  const result = await runFile("bw", args, { env, timeout: 20000, maxBuffer: 16 * 1024 * 1024 }, opts.input);
  return result.stdout;
}

// Secrets are resolved from one batched `bw list items` call instead of one
// ~3s `bw get` process per reference. The decrypted items live only in this
// process's memory and share one TTL with the unlocked-session check.
export const SECRET_CACHE_TTL_MS = (() => {
  const raw = setting("CACHE_TTL_MS");
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60 * 60 * 1000;
})();

// A session keyshroud opens ends after this long: a timer locks bw, so a copied
// token stops working too. `unlock --unattended` opens one without an end.
export const SESSION_TTL_MS = (() => {
  const raw = setting("SESSION_TTL_MS");
  const parsed = raw === undefined ? NaN : Number(raw);
  // At most a day; a session without an end is `unlock --unattended` in a terminal.
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 24 * 60 * 60 * 1000) : 30 * 60 * 1000;
})();

export interface VaultItem {
  id: string;
  name: string;
  password: string | null;
  username: string | null;
  notes: string | null;
  uris: string[];
  fields: Record<string, string>;
}

const AMBIGUOUS = Symbol("ambiguous");
interface VaultIndex { byName: Map<string, VaultItem | typeof AMBIGUOUS>; byId: Map<string, VaultItem> }

let vaultCache: { at: number; index: VaultIndex } | null = null;
let vaultPending: Promise<VaultIndex> | null = null;
let vaultMisses: Map<string, number> | null = null;
let sessionPending: Promise<string> | null = null;
let sessionVerifiedAt = 0;
let sessionExpiresAt: number | null = null;

function normalizeItemName(name: string): string { return name.trim().toLowerCase(); }

export function invalidateSecretCache(): void {
  vaultCache = null;
  vaultPending = null;
  vaultMisses = null;
  sessionVerifiedAt = 0;
}

function toVaultItem(raw: unknown): VaultItem | null {
  const item = raw as {
    id?: unknown; name?: unknown; notes?: unknown;
    login?: { password?: unknown; username?: unknown; uris?: Array<{ uri?: unknown }> | null } | null;
    fields?: Array<{ name?: unknown; value?: unknown }> | null;
  };
  if (typeof item?.id !== "string" || typeof item.name !== "string") return null;
  const str = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  const fields: Record<string, string> = {};
  for (const field of item.fields ?? []) if (typeof field?.name === "string" && typeof field.value === "string") fields[field.name] = field.value;
  return {
    id: item.id,
    name: item.name,
    password: str(item.login?.password),
    username: str(item.login?.username),
    notes: str(item.notes),
    uris: (item.login?.uris ?? []).map((entry) => str(entry?.uri)).filter((uri): uri is string => uri !== null),
    fields,
  };
}

async function loadVault(): Promise<VaultIndex> {
  const index: VaultIndex = { byName: new Map(), byId: new Map() };
  const parsed = JSON.parse(await bw(["list", "items"])) as unknown;
  if (!Array.isArray(parsed)) return index;
  for (const raw of parsed) {
    const item = toVaultItem(raw);
    if (!item) continue;
    index.byId.set(item.id, item);
    const key = normalizeItemName(item.name);
    index.byName.set(key, index.byName.has(key) ? AMBIGUOUS : item);
  }
  return index;
}

function vaultIndex(): Promise<VaultIndex> {
  if (vaultCache && Date.now() - vaultCache.at < SECRET_CACHE_TTL_MS) return Promise.resolve(vaultCache.index);
  if (!vaultPending) {
    vaultPending = loadVault()
      .then((index) => { vaultCache = { at: Date.now(), index }; return index; })
      .finally(() => { vaultPending = null; });
  }
  return vaultPending;
}

// Items created outside this process are not in the batched snapshot. A miss
// falls back to one direct `bw get item` per TTL window, so new items
// self-heal while deleted or renamed references stop spawning doomed lookups.
async function lookupItem(itemName: string): Promise<VaultItem | null> {
  const key = normalizeItemName(itemName);
  let index: VaultIndex | null = null;
  try { index = await vaultIndex(); } catch {}
  const hit = index?.byId.get(itemName) ?? index?.byName.get(key);
  if (hit === AMBIGUOUS) throw new Error(`Ambiguous vault item name: ${itemName}`);
  if (hit) return hit;
  const missedAt = vaultMisses?.get(key);
  if (missedAt !== undefined && Date.now() - missedAt < SECRET_CACHE_TTL_MS) return null;
  (vaultMisses ??= new Map()).set(key, Date.now());
  try {
    const item = toVaultItem(JSON.parse(await bw(["get", "item", itemName])));
    if (item) vaultMisses.delete(key);
    return item;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes("More than one result")) throw new Error(`Ambiguous vault item name: ${itemName}`);
    return null;
  }
}

export async function resolveRef(ref: SecretRef): Promise<string | null> {
  try { await ensureSession(); } catch {}
  const item = await lookupItem(ref.item);
  if (!item) return null;
  const field = ref.field;
  if (typeof field === "object") return item.fields[field.custom] ?? null;
  switch (field) {
    case "password": return item.password;
    case "username": return item.username;
    case "notes": return item.notes;
    case "uri": return item.uris[0] ?? null;
    case "id": return item.id;
    case "totp": return (await bw(["get", "totp", item.id])).trim() || null;
  }
}

// The timeout leaves room for a macOS "allow access" prompt when the entry was
// stored with `setup --confirm-unlock`; a missing entry still fails at once.
export async function readKeychain(service: string): Promise<string | null> {
  const user = process.env.USER || process.env.LOGNAME || "";
  try {
    const result = await runFile("security", ["find-generic-password", "-a", user, "-s", service, "-w"], { timeout: 120000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim() || null;
  } catch {}
  try {
    const result = await runFile("secret-tool", ["lookup", "service", service, "account", user], { timeout: 10000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim() || null;
  } catch {}
  return null;
}

// Linux: a locked Secret Service keyring (no desktop login, e.g. over SSH)
// answers every lookup with nothing and makes `secret-tool store` wait forever
// for an unlock prompt, so callers check this to say why instead.
export const KEYRING_LOCKED = "The Linux keyring is locked (log in to the desktop session, or unlock it with your keyring app)";
export async function keychainLocked(): Promise<boolean> {
  try {
    const result = await runFile("busctl", ["--user", "get-property", "org.freedesktop.secrets", "/org/freedesktop/secrets/aliases/default", "org.freedesktop.Secret.Collection", "Locked"], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim() === "b true";
  } catch { return false; }
}

async function readMasterPassword(): Promise<string | null> {
  const keychain = await readKeychain(KEYCHAIN_MASTER_SERVICE);
  if (keychain) return keychain;
  try {
    return (await readFile(MASTER_PASSWORD_FILE, "utf8")).trim() || null;
  } catch { return null; }
}

// Where a master password that unlocks without asking is kept, if anywhere.
export async function storedMasterSource(): Promise<"keychain" | "file" | null> {
  if (await readKeychain(KEYCHAIN_MASTER_SERVICE)) return "keychain";
  try { if ((await readFile(MASTER_PASSWORD_FILE, "utf8")).trim()) return "file"; } catch {}
  return null;
}

export async function keychainPresence(): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const service of [KEYCHAIN_MASTER_SERVICE, KEYCHAIN_CLIENT_ID_SERVICE, KEYCHAIN_CLIENT_SECRET_SERVICE]) out[service] = (await readKeychain(service)) !== null;
  return out;
}

async function rawStatus(session?: string): Promise<{ status: string; serverUrl: string | null; email: string | null }> {
  try {
    const parsed = JSON.parse(await bw(["status"], { session })) as { status?: unknown; serverUrl?: unknown; userEmail?: unknown };
    return { status: typeof parsed.status === "string" ? parsed.status : "unknown", serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl : null, email: typeof parsed.userEmail === "string" ? parsed.userEmail : null };
  } catch {
    return { status: "unavailable", serverUrl: null, email: null };
  }
}

export interface SessionOptions {
  // Ask the person at the keyboard when no master password is stored.
  prompt?: boolean;
  // Always ask, and open a session without an end (hosts nobody sits at).
  unattended?: boolean;
}

export function ensureSession(opts: SessionOptions = {}): Promise<string> {
  if (sessionPending) return opts.prompt || opts.unattended ? sessionPending.catch(() => ensureSession(opts)) : sessionPending;
  if (sessionExpiresAt !== null && Date.now() >= sessionExpiresAt) {
    delete process.env.BW_SESSION;
    invalidateSecretCache();
    sessionExpiresAt = null;
  }
  const existing = process.env.BW_SESSION?.trim();
  if (!opts.unattended && existing && Date.now() - sessionVerifiedAt < SECRET_CACHE_TTL_MS) return Promise.resolve(existing);
  sessionPending = ensureSessionInner(existing, opts)
    .then((token) => { sessionVerifiedAt = Date.now(); return token; })
    .finally(() => { sessionPending = null; });
  return sessionPending;
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  await chmod(path, 0o600);
}

// The session file holds the token, then `expires=<epoch ms>` or `expires=never`.
// A file written before sessions could end counts from its mtime.
export async function readSession(): Promise<{ token: string; expiresAt: number | null } | null> {
  try {
    const [token = "", meta = ""] = (await readFile(SESSION_FILE, "utf8")).split("\n").map((line) => line.trim());
    if (!token) return null;
    if (meta === "expires=never") return { token, expiresAt: null };
    const at = Number(meta.slice("expires=".length));
    return { token, expiresAt: meta.startsWith("expires=") && Number.isFinite(at) ? at : (await stat(SESSION_FILE)).mtimeMs + SESSION_TTL_MS };
  } catch { return null; }
}

async function writeSession(token: string, unattended: boolean, expiresAt: number | null = unattended ? null : Date.now() + SESSION_TTL_MS): Promise<void> {
  await writePrivateFile(SESSION_FILE, `${token}\nexpires=${expiresAt ?? "never"}\n`);
  process.env.BW_SESSION = token;
  sessionExpiresAt = expiresAt;
  if (expiresAt !== null) armLockTimer(token, expiresAt);
}

// Locks bw when the session ends, even if nothing calls keyshroud then. A
// session that a later unlock replaced is left alone. The token reaches the
// timer through its environment, never argv.
function armLockTimer(token: string, expiresAt: number): void {
  if (setting("LOCK_TIMER") === "0") return;
  // bw lock needs only its data directory, not the session or API key.
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && (name === "BITWARDENCLI_APPDATA_DIR" || !VAULT_ENV_KEYS.includes(name))) env[name] = value;
  const vars = { token: `${P}_LOCK_TOKEN`, file: `${P}_LOCK_FILE`, bw: `${P}_LOCK_BW`, status: `${P}_LOCK_BW_STATUS`, lock: `${P}_LOCK_BW_LOCK`, verbatim: `${P}_LOCK_BW_VERBATIM` };
  let bwPath: string, statusArgs: string[], lockArgs: string[], verbatim: boolean;
  try { [bwPath, statusArgs, verbatim] = bwCommand(["status"]); [, lockArgs] = bwCommand(["lock"]); } catch { return; }
  // The wait checks the wall clock, so time asleep (a closed laptop) counts.
  // At the end it asks bw whether its own token still works rather than
  // trusting the session file, which an agent can rewrite: a later unlock
  // replaced the token, a live one is this session.
  // Windows: a detached Node, since powershell does not start without a console
  // and children that are not detached die with this process.
  const timer: [string, string[]] = process.platform === "win32"
    ? [process.execPath, ["-e", [
        `const fs = require("fs"), { execFile } = require("child_process"), e = process.env;`,
        `const opts = { windowsHide: true, windowsVerbatimArguments: e.${vars.verbatim} === "1" };`,
        `const tick = () => { const left = ${expiresAt} - Date.now(); if (left > 0) return setTimeout(tick, Math.min(left, 30000));`,
        `  execFile(e.${vars.bw}, JSON.parse(e.${vars.status}), { ...opts, env: { ...e, BW_SESSION: e.${vars.token} } }, (error, out) => {`,
        `    if (!/"status":"unlocked"/.test(String(out))) return;`,
        `    fs.rmSync(e.${vars.file}, { force: true }); execFile(e.${vars.bw}, JSON.parse(e.${vars.lock}), opts, () => {}); }); };`,
        `tick();`,
      ].join("\n")]]
    : ["/bin/sh", ["-c", `while now=$(date +%s); [ "$now" -lt "$1" ]; do left=$(($1 - now)); sleep $((left < 30 ? left : 30)); done; if BW_SESSION="$${vars.token}" bw status 2>/dev/null | grep -q '"status":"unlocked"'; then rm -f "$2"; bw lock >/dev/null 2>&1; fi`, "sh", String(Math.ceil(expiresAt / 1000)), SESSION_FILE]];
  const child = spawn(timer[0], timer[1], {
    detached: true, stdio: "ignore", windowsHide: true,
    env: { ...env, [vars.token]: token, [vars.file]: SESSION_FILE, [vars.bw]: bwPath, [vars.status]: JSON.stringify(statusArgs), [vars.lock]: JSON.stringify(lockArgs), [vars.verbatim]: verbatim ? "1" : "0", BW_NOINTERACTION: "true" },
  });
  child.on("error", () => {});
  child.unref();
}

async function lockedError(): Promise<Error> {
  const keyring = await keychainLocked() ? " (the Linux keyring is locked, so a stored one could not be read)" : "";
  return new Error(`The vault is locked and no master password is stored: run \`${BRAND.bin} unlock\` in a terminal${keyring}`);
}

async function useStoredSession(): Promise<string | null> {
  const stored = await readSession();
  if (!stored) return null;
  if (stored.expiresAt !== null && Date.now() >= stored.expiresAt) { await lock(); return null; }
  if ((await rawStatus(stored.token)).status !== "unlocked") return null;
  process.env.BW_SESSION = stored.token;
  sessionExpiresAt = stored.expiresAt;
  return stored.token;
}

// Another process is already asking: use the session it opens. null when that
// dialog closed without one (a wrong password, or a Save dialog), so ask again.
async function waitForSession(): Promise<string | null> {
  const deadline = Date.now() + DIALOG_TIMEOUT_MS + 30_000;
  let closedAt = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const token = await useStoredSession();
    if (token) return token;
    const held = await readFile(DIALOG_LOCK, "utf8").catch(() => "");
    if (held.startsWith("cancelled:")) throw new Error("Cancelled");
    // The dialog closes before its bw login and unlock (20 s each at most) write the session.
    const open = held.startsWith("open:") && Date.now() - Number(held.slice(5)) < DIALOG_TIMEOUT_MS + 30_000;
    if (open) closedAt = 0;
    else if (!closedAt) closedAt = Date.now();
    else if (Date.now() - closedAt > 45_000) return null;
  }
  throw new Error(DIALOG_BUSY);
}

async function ensureSessionInner(existing: string | undefined, opts: SessionOptions): Promise<string> {
  if (!opts.unattended) {
    if (existing && (await rawStatus(existing)).status === "unlocked") return existing;
    const stored = await useStoredSession();
    if (stored) return stored;
  }

  // A stored master password unlocks without asking; --unattended always asks.
  let master = opts.unattended ? null : await readMasterPassword();
  const asked = !master;
  if (!master) {
    if (!opts.prompt && !opts.unattended) throw await lockedError();
    for (;;) {
      try { master = await askMasterPassword({ unattended: opts.unattended }); break; } catch (error) {
        if (!(error instanceof Error && error.message === DIALOG_BUSY)) throw error;
        const token = await waitForSession();
        if (token) return token;
      }
    }
    if (master === null) throw await lockedError();
  }
  // bw unlock replaces the token, so copies of the old one stop working; a
  // wrong password leaves the open session alone.

  const beforeLogin = await rawStatus();
  if (beforeLogin.status === "unauthenticated") {
    const clientId = await readKeychain(KEYCHAIN_CLIENT_ID_SERVICE);
    const clientSecret = await readKeychain(KEYCHAIN_CLIENT_SECRET_SERVICE);
    if (!clientId || !clientSecret) throw new Error("bw is logged out and API key credentials are not in the keychain (see `doctor`)");
    await runFile("bw", ["login", "--apikey"], { env: { ...process.env, BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret }, timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  }

  const unlocked = await runFile("bw", ["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], {
    env: { ...process.env, BW_PASSWORD: master }, timeout: 20000, maxBuffer: 4 * 1024 * 1024,
  }).catch((error: Error) => {
    // bw reports a wrong password as a decryption failure on several stderr lines.
    throw /Invalid master password|decryption operation failed/i.test(error.message) ? new Error("Wrong master password; nothing was unlocked") : error;
  });
  const token = unlocked.stdout.trim();
  if (!token) throw new Error("Vaultwarden unlock returned no session");
  await writeSession(token, Boolean(opts.unattended));
  if (asked) await writeMasterVerifier(master);
  try { await bw(["sync", "--quiet"], { session: token }); } catch {}
  invalidateSecretCache();
  return token;
}

// Ask the person at the keyboard: a masked prompt on a terminal, else a native
// dialog. null when nobody can be asked (SSH without a terminal, no display).
export async function askMasterPassword(opts: { email?: string; unattended?: boolean } = {}): Promise<string | null> {
  const account = opts.email ?? (await rawStatus()).email ?? "the vault account";
  const span = opts.unattended ? "with no time limit (unattended)" : `for ${Math.round(SESSION_TTL_MS / 60000)} minutes`;
  const tty = process.stdin.isTTY && process.stderr.isTTY;
  // A session without an end is opened by the person at a terminal, never from a dialog an agent opened.
  if (opts.unattended && !tty) throw new Error("An unattended session needs a terminal: run this command in one");
  if (tty) {
    process.stderr.write(`${BRAND.name}: unlocking ${account} ${span}.\n`);
    const value = await readMasked(`Master password of ${account}: `);
    if (!value) throw new Error("Cancelled");
    return value;
  }
  const value = await nativePasswordDialog([
    "A program on this computer, usually an AI agent, needs a secret and the vault is locked.",
    "",
    `Unlock ${account} ${span}?`,
    "",
    `Enter the master password of ${account}.`,
  ].join("\n"), "Unlock");
  if (value === "") throw new Error("Cancelled");
  return value;
}

// A scrypt hash of a master password that was typed, so add/rotate can refuse
// it when it is not stored. No easier to guess from than bw's own data.json.
const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: ScryptOptions) => Promise<Buffer>;

async function writeMasterVerifier(master: string): Promise<void> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(master, salt, 32, { ...SCRYPT_PARAMS, maxmem: SCRYPT_MAXMEM });
  await writePrivateFile(MASTER_VERIFIER_FILE, `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString("base64")}$${hash.toString("base64")}\n`);
}

// null when there is no verifier in the form keyshroud writes.
async function matchesMasterVerifier(secret: string): Promise<boolean | null> {
  let parts: string[];
  try { parts = (await readFile(MASTER_VERIFIER_FILE, "utf8")).trim().split("$"); } catch { return null; }
  const [kind, N, r, p, salt = "", hash = ""] = parts;
  const expected = Buffer.from(hash, "base64");
  if (parts.length !== 6 || kind !== "scrypt" || `${N}$${r}$${p}` !== `${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}` || expected.length !== 32 || Buffer.from(salt, "base64").length !== 16) return null;
  const actual = await scryptAsync(secret, Buffer.from(salt, "base64"), 32, { ...SCRYPT_PARAMS, maxmem: SCRYPT_MAXMEM });
  return timingSafeEqual(actual, expected);
}

// Without a verifier (an agent can delete the file) try the value itself: bw
// unlock is local, and a match replaces the session token, so keep the new one.
async function unlocksVault(secret: string): Promise<boolean> {
  const before = await readSession();
  let token: string;
  try {
    token = (await runFile("bw", ["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { env: { ...process.env, BW_PASSWORD: secret }, timeout: 20000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  } catch { return false; }
  if (!token) return false;
  // The session keeps its end, but never becomes one without an end here.
  await writeSession(token, false, before?.expiresAt ?? undefined);
  await writeMasterVerifier(secret);
  return true;
}

// Store a keychain entry by letting the OS tool prompt for the value on the
// user's terminal, so keyshroud never holds it in argv. `confirm` (macOS) trusts
// no app, so every later read asks the user first.
export async function storeKeychainInteractive(service: string, label: string, confirm: boolean): Promise<boolean> {
  const user = process.env.USER || process.env.LOGNAME || "";
  const attempts: Array<[string, string[]]> = process.platform === "darwin"
    ? [["security", ["add-generic-password", "-U", "-a", user, "-s", service, "-l", label, ...(confirm ? ["-T", ""] : []), "-w"]]]
    : [["secret-tool", ["store", `--label=${label}`, "service", service, "account", user]]];
  // -U keeps an existing entry's access list, so an ask-every-time entry is recreated.
  if (process.platform !== "darwin" && await keychainLocked()) throw new Error(KEYRING_LOCKED);
  if (process.platform === "darwin" && confirm) await runFile("security", ["delete-generic-password", "-a", user, "-s", service], { timeout: 10000, maxBuffer: 1024 * 1024 }).catch(() => {});
  for (const [command, args] of attempts) {
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(command, args, { stdio: "inherit" });
      child.on("error", () => resolve(null));
      child.on("exit", (exit) => resolve(exit));
    });
    if (code === 0) return true;
  }
  return false;
}

// `setup`: log keyshroud's own bw login in to the agent account. stdin and
// stderr stay on the terminal so bw can ask for a two-step login code.
export async function loginOwnAccount(email: string, master: string, unattended = false): Promise<string> {
  const token = await new Promise<string>((resolve, reject) => {
    const [command, args, verbatim] = bwCommand(["login", email, "--passwordenv", "BW_PASSWORD", "--raw"]);
    const child = spawn(command, args, { env: { ...process.env, BW_PASSWORD: master }, stdio: ["inherit", "pipe", "inherit"], windowsVerbatimArguments: verbatim });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk; });
    child.on("error", reject);
    child.on("exit", (exit) => (exit === 0 && out.trim() ? resolve(out.trim()) : reject(new Error("bw login failed"))));
  });
  await writeSession(token, unattended);
  await writeMasterVerifier(master);
  try { await bw(["sync", "--quiet"], { session: token }); } catch {}
  invalidateSecretCache();
  return token;
}

// `migrate`: read the items of the bw login the user had before setup (the
// default bw data dir), then lock it again. The values stay in memory.
export async function readPersonalItems(): Promise<Array<Record<string, unknown>>> {
  const master = await readKeychain(PERSONAL_KEYCHAIN_MASTER_SERVICE);
  if (!master) throw new Error(`Personal master password not in the keychain (${PERSONAL_KEYCHAIN_MASTER_SERVICE})`);
  const env = (extra: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !VAULT_ENV_KEYS.includes(name)) out[name] = value;
    return { ...out, ...extra };
  };
  const token = (await runFile("bw", ["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { env: env({ BW_PASSWORD: master }), timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  if (!token) throw new Error("Personal vault unlock returned no session");
  try {
    const parsed = JSON.parse((await runFile("bw", ["list", "items"], { env: env({ BW_SESSION: token }), timeout: 120000, maxBuffer: 256 * 1024 * 1024 })).stdout) as unknown;
    return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
  } finally {
    try { await runFile("bw", ["lock"], { env: env({}), timeout: 20000, maxBuffer: 1024 * 1024 }); } catch {}
  }
}

// A personal item as a new item for the agent account: no ids, folders,
// organizations, history, attachments or per-item key (encrypted to the personal account).
export async function copyItemToOwnVault(item: Record<string, unknown>): Promise<void> {
  const copy: Record<string, unknown> = { ...item, favorite: false };
  for (const key of ["id", "key", "object", "organizationId", "folderId", "collectionIds", "revisionDate", "creationDate", "deletedDate", "passwordHistory", "attachments"]) delete copy[key];
  await bw(["create", "item"], { input: Buffer.from(JSON.stringify(copy), "utf8").toString("base64") });
}

export async function syncOwnVault(): Promise<void> { await bw(["sync", "--quiet"]); invalidateSecretCache(); }

// Forget the cached session and lock the bw CLI. The next resolve unlocks
// again from the keychain, or asks.
export async function lock(): Promise<void> {
  try { await unlink(SESSION_FILE); } catch {}
  try { await bw(["lock"]); } catch {}
  delete process.env.BW_SESSION;
  sessionExpiresAt = null;
  invalidateSecretCache();
}

// Append-only record of which names were used, by whom. Never values.
export async function audit(action: string, names: string[], consumer: string): Promise<void> {
  if (setting("AUDIT") === "0") return;
  try {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    await appendFile(AUDIT_FILE, `${JSON.stringify({ ts: new Date().toISOString(), action, names, consumer, cwd: process.cwd() })}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {}
}

export async function getStatus(): Promise<VaultStatus> {
  let status = "unavailable";
  let serverUrl: string | null = null;
  let version: string | null = null;
  let items: number | null = null;
  try {
    const parsed = JSON.parse(await bw(["status"])) as { status?: unknown; serverUrl?: unknown };
    status = typeof parsed.status === "string" ? parsed.status : status;
    serverUrl = typeof parsed.serverUrl === "string" ? parsed.serverUrl : null;
  } catch {}
  try { version = (await bw(["--version"])).trim() || null; } catch {}
  if (status === "unlocked") {
    try { items = (await vaultIndex()).byId.size; } catch {}
  }
  return { status, serverUrl, version, items };
}

// Resolves an auth.json / env-file value: references through the vault cache,
// other `!command` values through the shell (pi's auth.json convention), and
// anything else as a literal.
export async function resolveShellValue(raw: unknown): Promise<string | null> {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  const ref = parseRef(value);
  if (ref) return resolveRef(ref);
  if (!value.startsWith("!")) return value;
  const command = value.slice(1).trim();
  if (command.startsWith("bw ")) { try { await ensureSession(); } catch {} }
  try {
    const result = await runFile("/bin/sh", ["-c", command], { env: process.env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    return result.stdout.trim() || null;
  } catch { return null; }
}

export function isSecretSource(raw: string): boolean {
  const value = raw.trim();
  return value.startsWith("!") || value.startsWith("bw://");
}

export async function readAuthEntries(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

export function authEntryRaw(entry: unknown): string | undefined {
  const raw = typeof entry === "string" ? entry : entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as { key?: unknown }).key : undefined;
  return typeof raw === "string" ? raw : undefined;
}

// Directory lock compatible with pi/omp (proper-lockfile: `<file>.lock/`,
// stale after 30 s without an mtime refresh, matching pi's auth storage).
async function acquireLock(path: string): Promise<() => Promise<void>> {
  const start = Date.now();
  for (;;) {
    try {
      await mkdir(path);
      return async () => { await rm(path, { recursive: true, force: true }); };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      const lockedAt = await stat(path).then((info) => info.mtimeMs, () => 0);
      if (Date.now() - lockedAt > 30000) { await rm(path, { recursive: true, force: true }); continue; }
      if (Date.now() - start > 60000) throw new Error(`Timed out waiting for lock ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

// Unlike readAuthEntries, a write must never start from an empty object just
// because the file was unreadable: that would wipe every provider login.
async function readAuthForUpdate(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try { parsed = text.trim() ? JSON.parse(text) : {}; } catch { parsed = null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a valid JSON object; refusing to overwrite it`);
  return parsed as Record<string, unknown>;
}

async function updateAuthFile(path: string, update: (current: Record<string, unknown>) => Record<string, unknown> | null): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const release = await acquireLock(`${path}.lock`);
  try {
    // Write through a symlinked auth.json instead of replacing the link.
    const target = await realpath(path).catch(() => path);
    const next = update(await readAuthForUpdate(target));
    if (!next) return false;
    await writePrivateFile(target, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } finally { await release(); }
}

export async function writeAuthEntry(path: string, name: string, key: string, opts: { overwrite?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
  const ok = await updateAuthFile(path, (current) => {
    if (Object.hasOwn(current, name) && opts.overwrite !== true) return null;
    return { ...current, [name]: { type: "api_key", key } };
  });
  return ok ? { ok: true, message: "Entry saved." } : { ok: false, message: `${name} already exists in ${path}` };
}

export async function deleteAuthEntry(path: string, name: string): Promise<boolean> {
  return updateAuthFile(path, (current) => {
    if (!Object.hasOwn(current, name)) return null;
    const next = { ...current };
    delete next[name];
    return next;
  });
}

export interface ResolvedEnv {
  // Every resolved variable, literals included.
  values: Record<string, string>;
  // The subset that came from the vault or a shell command; these are redacted.
  secrets: Record<string, string>;
  // Names whose reference did not resolve.
  missing: string[];
}

export async function resolveEntries(entries: Array<{ name: string; raw: string }>, opts: { preferProcessEnv?: boolean } = {}): Promise<ResolvedEnv> {
  const result: ResolvedEnv = { values: {}, secrets: {}, missing: [] };
  // Resolvers share the session and the batched vault snapshot, so the whole
  // pass costs one `bw list items` however many entries there are.
  const resolved = await Promise.all(entries.map(async ({ name, raw }) => {
    const inherited = opts.preferProcessEnv ? process.env[name] : undefined;
    if (inherited) return { name, value: inherited, secret: isSecretSource(raw) };
    if (!raw.trim()) return { name, value: "", secret: false };
    try { return { name, value: await resolveShellValue(raw), secret: isSecretSource(raw) }; } catch { return { name, value: null, secret: true }; }
  }));
  for (const { name, value, secret } of resolved) {
    // An empty literal (`NAME=`) is a value; only an empty secret is unresolved.
    if (value === null || (value === "" && secret)) { result.missing.push(name); continue; }
    result.values[name] = value;
    if (secret) result.secrets[name] = value;
  }
  return result;
}

// Env files are data that may come from a cloned repo or an agent, so only
// references and literals are allowed; `!command` values would be code execution.
export async function envFileEntries(path: string): Promise<Array<{ name: string; raw: string }>> {
  return parseEnvFile(await readFile(path, "utf8")).map(({ name, value }) => {
    if (value.trim().startsWith("!")) throw new Error(`${path}: ${name} uses a shell command; env files accept only bw:// references and literals`);
    if (isLoaderEnvName(name)) throw new Error(`${path}: ${name} changes what programs load or run; env files cannot set it`);
    return { name, raw: value };
  });
}

export async function authEnvEntries(): Promise<Array<{ name: string; raw: string }>> {
  const targets = getAuthTargets();
  const merged = { ...(await readAuthEntries(targets.pi)), ...(await readAuthEntries(targets.omp)) };
  const entries: Array<{ name: string; raw: string }> = [];
  for (const [name, entry] of Object.entries(merged)) {
    if (!ENV_NAME_RE.test(name) || PROVIDER_KEYS.has(name)) continue;
    const raw = authEntryRaw(entry);
    if (raw !== undefined) entries.push({ name, raw });
  }
  return entries;
}

// Environment wired through pi/omp auth.json. Values already present in the
// process environment win, matching earlier releases.
export async function buildEnvMap(): Promise<Record<string, string>> {
  try { return (await resolveEntries(await authEnvEntries(), { preferProcessEnv: true })).values; } catch { return {}; }
}

// Values to redact in-process: wired secrets (labelled by variable name), the
// vault session token, a master password file, and every other login password
// in the snapshot.
export async function redactionValues(wired: Record<string, string> = {}): Promise<Record<string, string>> {
  const values = indexValues(wired);
  try { const master = (await readFile(MASTER_PASSWORD_FILE, "utf8")).trim(); if (master) values.MASTER_PASSWORD = master; } catch {}
  try {
    for (const item of (await vaultIndex()).byId.values()) if (item.password && !Object.hasOwn(values, item.name)) values[item.name] = item.password;
  } catch {}
  return values;
}

// The on-disk index (for out-of-process hooks) covers only wired secrets and
// the session token, so it never fingerprints the user's personal passwords.
export function indexValues(wired: Record<string, string> = {}): Record<string, string> {
  const values: Record<string, string> = { ...wired };
  const session = process.env.BW_SESSION?.trim();
  if (session) values.BW_SESSION = session;
  return values;
}

// Merges into the existing index so values added by one command (for example
// an env file passed to `run`) stay covered for later hook invocations.
export async function writeRedactIndex(values: Record<string, string>): Promise<RedactIndex> {
  const index = buildRedactIndex(values, (await readRedactIndex()) ?? undefined);
  await writePrivateFile(REDACT_INDEX_FILE, `${JSON.stringify(index)}\n`);
  return index;
}

// Re-index after the wired set changes so hooks mask a new value right away.
export async function refreshRedactIndex(): Promise<void> {
  const env = await resolveEntries(await authEnvEntries());
  await writeRedactIndex(indexValues(env.secrets));
}

export async function readRedactIndex(): Promise<RedactIndex | null> {
  try {
    const parsed = JSON.parse(await readFile(REDACT_INDEX_FILE, "utf8")) as RedactIndex;
    return parsed?.v === 1 && Array.isArray(parsed.entries) ? parsed : null;
  } catch { return null; }
}

function mapItemError(error: unknown, name: string): Error {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("More than one result was found")) return new Error(`Ambiguous vault item name: ${name}`);
  if (text.includes("Not found.")) return new Error(`Vault item not found: ${name}`);
  return error instanceof Error ? error : new Error(text);
}

export async function findItems(search: string): Promise<Array<{ id: string; name: string }>> {
  const parsed = JSON.parse(await bw(["list", "items", "--search", search])) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => {
    const value = item as { id?: unknown; name?: unknown };
    return { id: String(value.id ?? ""), name: String(value.name ?? "") };
  }).filter((item) => item.id && item.name);
}

export async function getSecret(itemName: string): Promise<string> {
  try { return await bw(["get", "password", itemName]); } catch (error) { throw mapItemError(error, itemName); }
}

// An agent can start add/rotate, so a dialog could be used to phish the master
// password into an item it can then read; refuse it outright.
async function refuseMasterPassword(secret: string): Promise<void> {
  if (!secret) return;
  // The stored value and the verifier only short-cut a match: an agent can replace either.
  const stored = await readMasterPassword();
  if (secret === stored || await matchesMasterVerifier(secret) || await unlocksVault(secret)) throw new Error("Refusing to store the vault master password as a secret");
}

export async function createSecretItem(opts: { itemName: string; secret: string; envName?: string; notes?: string }): Promise<{ id: string }> {
  const problem = itemNameProblem(opts.itemName);
  if (problem) throw new Error(`Vault item name ${problem}`);
  await refuseMasterPassword(opts.secret);
  const existing = await findItems(opts.itemName);
  if (existing.some((item) => item.name.toLowerCase() === opts.itemName.toLowerCase())) throw new Error(`Vault item already exists: ${opts.itemName}`);
  const item: Record<string, unknown> = {
    type: 1, name: opts.itemName, notes: opts.notes ?? null, favorite: false, reprompt: 0,
    login: { uris: [], username: "agent", password: opts.secret, totp: null },
  };
  if (opts.envName) item.fields = [{ type: 0, name: "env", value: opts.envName }];
  const output = await bw(["create", "item"], { input: Buffer.from(JSON.stringify(item), "utf8").toString("base64") });
  let created: { id?: unknown };
  try { created = JSON.parse(output) as { id?: unknown }; } catch { throw new Error("Vaultwarden create returned invalid JSON"); }
  if (!created.id) throw new Error("Vaultwarden create returned no item id");
  await bw(["sync", "--quiet"]); invalidateSecretCache();
  return { id: String(created.id) };
}

export async function rotateSecretItem(opts: { itemName: string; secret: string }): Promise<{ id: string }> {
  await refuseMasterPassword(opts.secret);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(await bw(["get", "item", opts.itemName])) as Record<string, unknown>; } catch (error) { throw mapItemError(error, opts.itemName); }
  const login = parsed.login && typeof parsed.login === "object" ? parsed.login as Record<string, unknown> : {};
  parsed.login = { ...login, password: opts.secret };
  const id = String(parsed.id ?? "");
  if (!id) throw new Error(`Vault item not found: ${opts.itemName}`);
  await bw(["edit", "item", id], { input: Buffer.from(JSON.stringify(parsed), "utf8").toString("base64") });
  await bw(["sync", "--quiet"]); invalidateSecretCache();
  return { id };
}

export async function deleteItem(id: string, permanent = false): Promise<void> {
  await bw(["delete", "item", id, ...(permanent ? ["--permanent"] : [])]);
  invalidateSecretCache();
}

export async function readSecretFromInput(opts: { prompt: string; stdin: boolean }): Promise<string> {
  if (opts.stdin) {
    let input = "";
    for await (const chunk of process.stdin) input += String(chunk);
    input = input.replace(/\r?\n$/, "");
    if (!input) throw new Error("Empty secret");
    return input;
  }
  if (!process.stdin.isTTY) throw new Error("No terminal to prompt on; pipe the value with --stdin");
  const value = await readMasked(opts.prompt);
  if (!value) throw new Error("Empty secret");
  return value;
}

// Native hidden-input dialog for callers without a terminal (agent shells, MCP).
// An agent can open it, so the wording is fixed, says who asked, and warns
// against the master password; names are validated and passed as data (argv),
// never as script. One dialog at a time, with a pause after a cancel. Resolves
// null when no dialog can be shown (SSH, headless Linux, missing tools).
const DIALOG_LOCK = join(CONFIG_DIR, "dialog.lock");
const DIALOG_COOLDOWN_MS = 30_000;
const DIALOG_TIMEOUT_MS = 300_000;
const DIALOG_BUSY = "Another keyshroud dialog is already open";

export async function readSecretFromDialog(opts: { itemName: string; envName?: string }): Promise<string | null> {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return null;
  const problem = itemNameProblem(opts.itemName);
  if (problem) throw new Error(`Vault item name ${problem}`);
  if (opts.envName !== undefined && !ENV_NAME_RE.test(opts.envName)) throw new Error("Variable names must be UPPER_SNAKE_CASE");
  const text = [
    opts.envName ? "A program on this computer, usually an AI agent, asked to store a NEW secret." : "A program on this computer, usually an AI agent, asked to REPLACE the value of a secret.",
    "",
    ...(opts.envName ? [`Variable: ${opts.envName}`] : []),
    `Vault item: ${opts.itemName}`,
    "",
    "This is not a login prompt. Never enter your vault master password here.",
  ].join("\n");
  return nativePasswordDialog(text, "Save");
}

async function nativePasswordDialog(text: string, button: "Save" | "Unlock"): Promise<string | null> {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return null;
  const candidates: Array<[string, string[]]> = process.platform === "darwin"
    ? [["osascript", ["-e", "on run argv", "-e", 'activate', "-e",
        `text returned of (display dialog (item 1 of argv) default answer "" with hidden answer with title "keyshroud" buttons {"Cancel", "${button}"} default button "${button}" cancel button "Cancel" with icon caution)`,
        "-e", "end run", "--", text]]]
    : process.platform === "win32"
    ? [[POWERSHELL, ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(windowsDialogScript(button), "utf16le").toString("base64")]]]
    : process.env.DISPLAY || process.env.WAYLAND_DISPLAY
      ? [["zenity", ["--entry", "--hide-text", "--no-markup", "--title=keyshroud", `--text=${text}`]], ["kdialog", ["--title", "keyshroud", "--password", text.replace(/[<>]/g, "")]]]
      : [];
  if (!candidates.length) return null;
  return withDialogLock(async () => {
    for (const [command, args] of candidates) {
      const result = await new Promise<{ code: number | string | null; stdout: string; stderr: string }>((resolve) => {
        // Windows: the text reaches the dialog script as data, through the environment.
        execFile(command, args, { timeout: DIALOG_TIMEOUT_MS, env: childEnv({ [`${P}_DIALOG_TEXT`]: text }) }, (error, stdout, stderr) => resolve({ code: error ? ((error as NodeJS.ErrnoException).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
      });
      if (result.code === "ENOENT") continue;
      if (result.code === 0) return result.stdout.replace(/\r?\n$/, "");
      // powershell exits 2 on Cancel; other failures (no desktop session) mean no dialog.
      if (command === POWERSHELL ? result.code === 2 : command !== "osascript" || /-128/.test(result.stderr)) throw new Error("Cancelled");
      return null;
    }
    return null;
  });
}

// A small Windows Forms password dialog. The value goes to stdout as UTF-8.
function windowsDialogScript(button: "Save" | "Unlock"): string {
  return [
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
    "[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false",
    "[Windows.Forms.Application]::EnableVisualStyles()",
    "$f = New-Object Windows.Forms.Form",
    "$f.Text = 'keyshroud'; $f.TopMost = $true; $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false",
    "$f.StartPosition = 'CenterScreen'; $f.AutoSize = $true; $f.AutoSizeMode = 'GrowAndShrink'; $f.Padding = New-Object Windows.Forms.Padding 12",
    "$p = New-Object Windows.Forms.FlowLayoutPanel; $p.FlowDirection = 'TopDown'; $p.AutoSize = $true",
    `$l = New-Object Windows.Forms.Label; $l.Text = $env:${P}_DIALOG_TEXT; $l.AutoSize = $true; $l.MaximumSize = New-Object Drawing.Size 440, 0`,
    "$t = New-Object Windows.Forms.TextBox; $t.UseSystemPasswordChar = $true; $t.Width = 440",
    "$r = New-Object Windows.Forms.FlowLayoutPanel; $r.AutoSize = $true",
    `$ok = New-Object Windows.Forms.Button; $ok.Text = '${button}'; $ok.DialogResult = 'OK'`,
    "$no = New-Object Windows.Forms.Button; $no.Text = 'Cancel'; $no.DialogResult = 'Cancel'",
    "$r.Controls.AddRange(@($ok, $no)); $p.Controls.AddRange(@($l, $t, $r)); $f.Controls.Add($p)",
    "$f.AcceptButton = $ok; $f.CancelButton = $no",
    "$f.Add_Shown({ $f.Activate(); $t.Focus() })",
    "if ($f.ShowDialog() -ne 'OK') { exit 2 }",
    "[Console]::Out.Write($t.Text)",
  ].join("\n");
}

async function withDialogLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let held = "";
  try { held = await readFile(DIALOG_LOCK, "utf8"); } catch {}
  const [kind, at] = held.trim().split(":");
  const age = Date.now() - Number(at);
  const live = (kind === "open" || kind === "cancelled") && age >= 0 && age < (kind === "cancelled" ? DIALOG_COOLDOWN_MS : DIALOG_TIMEOUT_MS + 30_000);
  if (!live) await rm(DIALOG_LOCK, { force: true });
  try { await writeFile(DIALOG_LOCK, `open:${Date.now()}\n`, { flag: "wx", mode: 0o600 }); }
  catch { throw new Error(kind === "cancelled" ? "The last dialog was cancelled; wait 30 seconds before asking again" : DIALOG_BUSY); }
  try {
    const value = await fn();
    await rm(DIALOG_LOCK, { force: true });
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === "Cancelled") await writeFile(DIALOG_LOCK, `cancelled:${Date.now()}\n`, { mode: 0o600 });
    else await rm(DIALOG_LOCK, { force: true });
    throw error;
  }
}

// Raw-mode prompt that echoes one "*" per character (capped, then a count), so
// the user sees typing and pastes land without the value ever reaching the screen.
function readMasked(prompt: string): Promise<string> {
  const stdin = process.stdin;
  const chars: string[] = [];
  const draw = () => {
    const shown = "*".repeat(Math.min(chars.length, 24)) + (chars.length > 24 ? ` (${chars.length} chars)` : "");
    process.stderr.write(`\r\x1b[2K${prompt}${shown}`);
  };
  return new Promise((resolve, reject) => {
    // After Enter, keep reading briefly: the rest of a multi-line paste must be
    // consumed here (or it would reach the parent shell) and is then refused.
    let ending: ReturnType<typeof setTimeout> | undefined;
    let multiline = false;
    const settle = () => {
      clearTimeout(ending);
      ending = setTimeout(() => finish(multiline ? new Error("Multi-line values are not supported in the prompt; pipe them with --stdin") : undefined), 100);
    };
    const finish = (error?: Error) => {
      clearTimeout(ending);
      stdin.off("data", onData); stdin.setRawMode(false); stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error); else resolve(chars.join(""));
    };
    const onData = (chunk: string) => {
      if (ending) { if (/[^\r\n]/.test(chunk)) multiline = true; return settle(); }
      const clean = [...chunk.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b./g, "")];
      for (const [index, ch] of clean.entries()) {
        if (ch === "\r" || ch === "\n") { if (/[^\r\n]/.test(clean.slice(index + 1).join(""))) multiline = true; return settle(); }
        if (ch === "\x03") return finish(new Error("Cancelled"));
        if (ch === "\x04") return chars.length ? finish() : finish(new Error("Cancelled"));
        if (ch === "\x7f" || ch === "\b") chars.pop();
        else if (ch === "\x15") chars.length = 0;
        else if (ch >= " ") chars.push(ch);
      }
      draw();
    };
    stdin.setRawMode(true); stdin.setEncoding("utf8"); stdin.resume(); stdin.on("data", onData);
    draw();
  });
}
