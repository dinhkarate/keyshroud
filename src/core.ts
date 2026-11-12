// Runtime-neutral core: no pi/omp/Claude Code imports. Every caller (agent
// extensions, CLI, MCP server, hooks) goes through these functions.
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join, dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BRAND } from "./brand.ts";
import { buildRedactIndex, type RedactIndex } from "./redact.ts";
import { ENV_NAME_RE, isLoaderEnvName, isRef, isSelfCommand, itemNameProblem, legacyRefFor, localRefFor, parseEnvFile, parseRef, refFor, type SecretRef } from "./refs.ts";
import {
  derivePassphraseKey, findLocalItem, formatVersion, keychainService, newPassphraseKey, newVaultId, openSession, openVault, parseVaultFile, passphraseProblem,
  sealSession, sealVault, serializeVault, unwrapFromEnclave, VAULT_KIND, VaultFormatError, VaultVersionError, wrapForEnclave,
  type EnclaveKey, type VaultData, type VaultFile, type VaultHeader, type VaultKeySpec, type VaultKeyType,
} from "./vault.ts";

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
// The agent account's email and server: bw forgets both when it logs out.
export const ACCOUNT_FILE = join(CONFIG_DIR, "account.json");
// The local vault (format in vault.ts); a passphrase session keeps its secret
// in one file and the vault key, sealed under it, in the other.
export const VAULT_FILE = join(CONFIG_DIR, "vault.json");
// The default backend keyshroud picked on a machine with no bw setup ("local"),
// or "bw" after `setup`; write either to switch.
export const BACKEND_FILE = join(CONFIG_DIR, "backend");
const VAULT_TOKEN_FILE = join(CONFIG_DIR, "vault.token");
const VAULT_SESSION_FILE = join(CONFIG_DIR, "vault.session");

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
export interface AuthTargets { own: string; omp: string; pi: string }

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
  // cmd.exe ends a command at a line break whatever the escaping (BatBadBut).
  if (args.some((arg) => /[\r\n\0]/.test(arg))) throw Object.assign(new Error(`${command}: a .cmd/.bat argument cannot contain a line break`), { code: "EINVAL" });
  // As cross-spawn does: quote each argument for the C runtime, then escape every
  // cmd.exe metacharacter (`%` included) with ^, twice, because the batch file's
  // `%*` is parsed again; cmd then passes the text on as is.
  const meta = /([()\][%!^"`<>&|;, *?])/g;
  // Plain words go as they are, so a batch file that reads %1 sees them unchanged.
  const quote = (value: string) => /^[\w.\-\/\\:@+]+$/.test(value) ? value
    : `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`.replace(meta, "^$1").replace(meta, "^$1");
  return { command: process.env.ComSpec ?? join(SYSTEM32, "cmd.exe"), args: ["/d", "/s", "/c", `"${[found.file.replace(meta, "^$1"), ...args.map(quote)].join(" ")}"`], verbatim: true };
}

function bwCommand(args: string[]): [string, string[], boolean] {
  const { command, args: resolved, verbatim } = invocation("bw", args);
  return [command, resolved, Boolean(verbatim)];
}

// bw keeps one refresh token per login in data.json, and Vaultwarden replaces it
// on each refresh: two bw processes refreshing at once leave the slower one with
// a rejected token, and bw then drops the login for every agent. Commands that
// may talk to the server therefore run one at a time, across processes.
const BW_SERVER_COMMANDS = new Set(["sync", "login", "unlock", "create", "edit", "delete", "logout"]);
const BW_LOCK = join(CONFIG_DIR, "bw.lock");
// A newer bw migrates an older bw's data on the first unlock. When the
// migration's server call fails (bw 2026.9+ posts a user key id that
// Vaultwarden rejects), that unlock fails and the next one works.
const BW_MIGRATION_RE = /Encrypted Migrator|KeyIdBackfillError/;

async function withBwLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // bw calls time out after 20 s, so a lock older than a minute was left by a
  // process that died; past the wait, run anyway rather than hang an agent.
  const deadline = Date.now() + 60_000;
  let held = false;
  while (!held) {
    try { await mkdir(BW_LOCK); held = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(BW_LOCK).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > 60_000) { await rm(BW_LOCK, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 100));
    }
  }
  try { return await fn(); } finally { if (held) await rm(BW_LOCK, { recursive: true, force: true }).catch(() => {}); }
}

function runFile(command: string, args: string[], options: Record<string, unknown> = {}, input?: string): Promise<ExecResult> {
  if (command === "bw" && BW_SERVER_COMMANDS.has(args[0])) return withBwLock(() => execBw(args, options, input).catch((error: Error) => {
    if (args[0] !== "unlock" || !BW_MIGRATION_RE.test(error.message)) throw error;
    return execBw(args, options, input);
  }));
  return command === "bw" ? execBw(args, options, input) : execRun(command, args, options, input);
}

function execBw(args: string[], options: Record<string, unknown>, input?: string): Promise<ExecResult> {
  // Without it a locked bw waits on a hidden master-password prompt nobody can answer.
  const env = { ...((options.env as NodeJS.ProcessEnv | undefined) ?? process.env), BW_NOINTERACTION: "true" };
  let command: string, verbatim: boolean;
  try { [command, args, verbatim] = bwCommand(args); } catch (error) { return Promise.reject(error); }
  return execRun(command, args, { ...options, env, windowsVerbatimArguments: verbatim }, input);
}

function execRun(command: string, args: string[], options: Record<string, unknown>, input?: string): Promise<ExecResult> {
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

// Wiring (ENV_NAME -> reference) lives in keyshroud's own env.json. pi and omp
// read keys from their auth.json, so a name is also written there when that
// agent is installed (its directory exists) or `--target` names it.
export function getAuthTargets(): AuthTargets {
  return {
    own: join(CONFIG_DIR, "env.json"),
    omp: join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"), "auth.json"),
    pi: join(homedir(), ".pi", "agent", "auth.json"),
  };
}

// auth.json entries use a shell form so pi/omp resolve them even without this
// package loaded.
export function referenceFor(itemName: string, backend: BackendName = "bw"): string {
  return backend === "local" ? localRefFor(itemName) : legacyRefFor(itemName);
}

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
// The token in BW_SESSION is the one in keyshroud's session file, so that file ends it. One that
// only came with the caller's environment has no such file: bw is asked on every use.
let sessionFromFile = false;
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

// bw output holds secrets, and a JSON.parse error quotes part of its input.
async function bwJson(args: string[]): Promise<unknown> {
  const output = await bw(args);
  try { return JSON.parse(output); } catch { throw new Error(`bw ${args.slice(0, 2).join(" ")} returned output that is not JSON`); }
}

async function loadVault(): Promise<VaultIndex> {
  const index: VaultIndex = { byName: new Map(), byId: new Map() };
  const parsed = await bwJson(["list", "items"]);
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

// Why the last read of the vault failed, for "unresolved" messages.
let lastVaultError: string | null = null;
// " (reason)" for an unresolved-names message: the unlock error, else why the vault could not be read.
export function unresolvedReason(sessionError: string): string {
  const reason = sessionError || [lastVaultError, lastLocalError].filter(Boolean).join("; ");
  return reason ? ` (${reason})` : "";
}
function vaultErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return DEAD_LOGIN_RE.test(text) ? DEAD_LOGIN : `bw could not read the vault: ${text.split("\n")[0].slice(0, 200)}`;
}

// Items created outside this process are not in the batched snapshot. A miss
// falls back to one direct `bw get item` per TTL window, so new items
// self-heal while deleted or renamed references stop spawning doomed lookups.
async function lookupItem(itemName: string): Promise<VaultItem | null> {
  const key = normalizeItemName(itemName);
  let index: VaultIndex | null = null;
  try { index = await vaultIndex(); lastVaultError = null; } catch (error) { lastVaultError = vaultErrorText(error); }
  const hit = index?.byId.get(itemName) ?? index?.byName.get(key);
  if (hit === AMBIGUOUS) throw new Error(`Ambiguous vault item name: ${itemName}`);
  if (hit) return hit;
  const missedAt = vaultMisses?.get(key);
  if (missedAt !== undefined && Date.now() - missedAt < SECRET_CACHE_TTL_MS) return null;
  (vaultMisses ??= new Map()).set(key, Date.now());
  try {
    const item = toVaultItem(await bwJson(["get", "item", itemName]));
    if (item) vaultMisses.delete(key);
    return item;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes("More than one result")) throw new Error(`Ambiguous vault item name: ${itemName}`);
    return null;
  }
}

export async function resolveRef(ref: SecretRef): Promise<string | null> {
  if (ref.scheme === "local") return resolveLocalRef(ref);
  bwInUse = true;
  try { await ensureBwSession(); } catch {}
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
  // Windows has neither tool, and looks a bare name up in the current directory first.
  if (process.platform === "win32") return null;
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
  if (process.platform === "win32") return false;
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

// bw 2026.9+ logs in, then fails a follow-up call (POST
// /api/accounts/key-management/user-key-id) that Vaultwarden before 1.37.4
// answers with 404, and exits 1 although the login is saved. The vault works
// as usual after that, so a failed login counts when bw is no longer logged out.
async function loggedInAnyway(email?: string): Promise<boolean> {
  const after = await rawStatus();
  return (after.status === "locked" || after.status === "unlocked") && (!email || after.email?.toLowerCase() === email.toLowerCase());
}

export async function rememberAccount(email: string, server: string): Promise<void> {
  const next = JSON.stringify({ email, server });
  if ((await readFile(ACCOUNT_FILE, "utf8").catch(() => "")).trim() === next) return;
  await writePrivateFile(ACCOUNT_FILE, `${next}\n`);
}

export async function readAccount(): Promise<{ email: string; server: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(ACCOUNT_FILE, "utf8")) as { email?: unknown; server?: unknown };
    return typeof parsed.email === "string" && typeof parsed.server === "string" && /^https:\/\//.test(parsed.server) ? { email: parsed.email, server: parsed.server } : null;
  } catch { return null; }
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
  // Ask the person at the keyboard when no master password (or passphrase session) is stored.
  prompt?: boolean;
  // Always ask, and open a session without an end (hosts nobody sits at).
  unattended?: boolean;
  // The local vault's passphrase, read from stdin by `unlock --stdin` (CI, containers), instead of asking.
  passphrase?: string;
}

// Opens the default backend: bw's session (its token is returned), or the local vault ("").
export async function ensureSession(opts: SessionOptions = {}): Promise<string> {
  if ((await defaultBackend()) === "local") { await openLocal(opts); return ""; }
  return ensureBwSession(opts);
}

export async function openBackend(backend: BackendName, opts: SessionOptions = {}): Promise<void> {
  if (backend === "local") await openLocal(opts); else await ensureBwSession(opts);
}

// Opens what these values need, and the default backend (whose values are
// masked too), so a master password or passphrase is asked once, up front.
export async function ensureUnlocked(raws: string[], opts: SessionOptions = {}): Promise<void> {
  const wanted = new Set<BackendName>([await defaultBackend()]);
  for (const raw of raws) { const backend = backendOf(raw); if (backend) wanted.add(backend); }
  const errors: string[] = [];
  for (const backend of wanted) {
    try { await openBackend(backend, opts); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (errors.length) throw new Error(errors.join("; "));
}

function backendOf(raw: string): BackendName | null {
  try { const ref = parseRef(raw); if (ref) return ref.scheme === "local" ? "local" : "bw"; } catch { return null; }
  return isBwSource(raw) ? "bw" : null;
}

export function ensureBwSession(opts: SessionOptions = {}): Promise<string> {
  bwInUse = true;
  if (sessionPending) return opts.prompt || opts.unattended ? sessionPending.catch(() => ensureBwSession(opts)) : sessionPending;
  if (sessionExpiresAt !== null && Date.now() >= sessionExpiresAt) {
    delete process.env.BW_SESSION;
    invalidateSecretCache();
    sessionExpiresAt = null;
  }
  const existing = process.env.BW_SESSION?.trim();
  if (!opts.unattended && existing && sessionFromFile && Date.now() - sessionVerifiedAt < SECRET_CACHE_TTL_MS) {
    // `lock` in another process, or a newer unlock, ended the session this process holds: forget what it cached.
    return readSession().then((stored) => {
      if (stored?.token === existing) return existing;
      forgetBwSession();
      return ensureBwSession(opts);
    });
  }
  // No session, no cached items: a failed unlock leaves nothing behind to read.
  sessionPending = ensureSessionInner(existing, opts)
    .then((token) => { sessionVerifiedAt = Date.now(); return token; }, (error) => { invalidateSecretCache(); throw error; })
    .finally(() => { sessionPending = null; });
  return sessionPending;
}

function forgetBwSession(): void {
  delete process.env.BW_SESSION;
  sessionExpiresAt = null;
  sessionFromFile = false;
  invalidateSecretCache();
}

// The environment for another keyshroud process (the MCP server started after an update). A session
// keyshroud opened is left out: that process reads the session file, so `lock` and the session's
// end reach it as they reach this one.
export function ownProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (sessionFromFile) delete env.BW_SESSION;
  return env;
}

// `held` is the writer's lock: asked once the new text is on disk, as for the vault.
async function writePrivateFile(path: string, content: string, held?: () => Promise<boolean>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(tmp, 0o600);
  // Lock lost: the error a rename gives once the next holder has removed the temp file.
  if (held && !(await held())) { await rm(tmp, { force: true }); throw Object.assign(new Error(`${path}: lock lost`), { code: "ENOENT" }); }
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
  sessionFromFile = true;
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
        `    if (!/"status":\\s*"unlocked"/.test(String(out))) return;`,
        `    fs.rmSync(e.${vars.file}, { force: true }); execFile(e.${vars.bw}, JSON.parse(e.${vars.lock}), opts, () => {}); }); };`,
        `tick();`,
      ].join("\n")]]
    : ["/bin/sh", ["-c", `while now=$(date +%s); [ "$now" -lt "$1" ]; do left=$(($1 - now)); sleep $((left < 30 ? left : 30)); done; if BW_SESSION="$${vars.token}" bw status 2>/dev/null | grep -q '"status": *"unlocked"'; then rm -f "$2"; bw lock >/dev/null 2>&1; fi`, "sh", String(Math.ceil(expiresAt / 1000)), SESSION_FILE]];
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
  if (stored.expiresAt !== null && Date.now() >= stored.expiresAt) { await lockBw(); return null; }
  if ((await rawStatus(stored.token)).status !== "unlocked") return null;
  process.env.BW_SESSION = stored.token;
  sessionFromFile = true;
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
    // A token that is not the one in the session file: keyshroud's own was ended there (`lock`, a
    // newer unlock); one from the caller's environment counts for as long as bw opens with it.
    if (existing && existing !== (await readSession())?.token) {
      if (!sessionFromFile && (await rawStatus(existing)).status === "unlocked") return existing;
      forgetBwSession();
    }
    const stored = await useStoredSession();
    if (stored) return stored;
  }

  // Logged out: log in first (API key, else the stored master password once
  // Touch ID approves), so nobody types a password for nothing.
  const beforeLogin = await rawStatus();
  if (beforeLogin.status === "unauthenticated") {
    const loggedOut = `bw is logged out: run \`${BRAND.bin} setup --email EMAIL --server URL --registered\` (agent account) or \`bw login\` in a terminal; with the API key in the keychain keyshroud logs in by itself, and on a Mac with the master password in the keychain it asks for Touch ID first (see \`doctor\`)`;
    const clientId = await readKeychain(KEYCHAIN_CLIENT_ID_SERVICE);
    const clientSecret = await readKeychain(KEYCHAIN_CLIENT_SECRET_SERVICE);
    if (clientId && clientSecret) {
      await runFile("bw", ["login", "--apikey"], { env: { ...process.env, BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret }, timeout: 20000, maxBuffer: 4 * 1024 * 1024 })
        .catch(async (error: Error) => { if (!(await loggedInAnyway())) throw error; });
    } else {
      const account = OWN_BW_LOGIN && !opts.unattended ? await readAccount() : null;
      const master = account ? await readMasterPassword() : null;
      if (!account || !master) throw new Error(loggedOut);
      try { await approveWithTouchId(`log ${account.email} back in to the vault`); } catch (error) {
        if (!(error instanceof Error && error.message === DIALOG_BUSY)) throw new Error(`Touch ID was not approved; ${loggedOut}`);
        // Another process is asking already: use the login it makes.
        const token = await waitForSession();
        if (token) return token;
        throw new Error(loggedOut);
      }
      await runFile("bw", ["config", "server", account.server], { timeout: 20000, maxBuffer: 1024 * 1024 });
      await runFile("bw", ["login", account.email, "--passwordenv", "BW_PASSWORD", "--raw"], { env: { ...process.env, BW_PASSWORD: master }, timeout: 20000, maxBuffer: 4 * 1024 * 1024 })
        .catch(async (error: Error) => { if (!(await loggedInAnyway(account.email))) throw error; });
    }
  } else if (OWN_BW_LOGIN && beforeLogin.email && beforeLogin.serverUrl) {
    await rememberAccount(beforeLogin.email, beforeLogin.serverUrl).catch(() => {});
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

// bw drops its login when the server rejects the refresh token; every agent
// on this machine then needs a new login, so name it instead of "not found".
const DEAD_LOGIN_RE = /invalid_grant|refresh token|not logged in|logged out|unauthori[sz]ed|\b401\b|invalid_token/i;
const DEAD_LOGIN = `bw's login on this machine expired or was revoked by the server: run \`${BRAND.bin} setup --email EMAIL --server URL --registered\` (agent account) or \`bw login\` in a terminal`;

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
  // The session keeps its end, at most one session length away: the file is the agent's to write.
  await writeSession(token, false, Math.min(before?.expiresAt ?? Infinity, Date.now() + SESSION_TTL_MS));
  await writeMasterVerifier(secret);
  return true;
}

// Store a keychain entry by letting the OS tool prompt for the value on the
// user's terminal, so keyshroud never holds it in argv. `confirm` (macOS) trusts
// no app, so every later read asks the user first.
export async function storeKeychainInteractive(service: string, label: string, confirm: boolean): Promise<boolean> {
  if (process.platform === "win32") return false;
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
  const token = await withBwLock(() => new Promise<string>((resolve, reject) => {
    const [command, args, verbatim] = bwCommand(["login", email, "--passwordenv", "BW_PASSWORD", "--raw"]);
    const child = spawn(command, args, { env: { ...process.env, BW_PASSWORD: master }, stdio: ["inherit", "pipe", "inherit"], windowsVerbatimArguments: verbatim });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk; });
    child.on("error", reject);
    child.on("exit", (exit) => { if (exit === 0 && out.trim()) resolve(out.trim()); else { process.stderr.write("\n"); reject(new Error("bw login failed")); } });
  })).catch(async (error: Error) => {
    if (!(await loggedInAnyway(email))) throw error;
    process.stderr.write(`${BRAND.bin}: the login worked; the error above is bw 2026.9+ calling an endpoint that Vaultwarden added in 1.37.4\n`);
    return (await runFile("bw", ["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { env: { ...process.env, BW_PASSWORD: master }, timeout: 20000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  });
  if (!token) throw new Error("bw login returned no session");
  await writeSession(token, unattended);
  await writeMasterVerifier(master);
  try { await bw(["sync", "--quiet"], { session: token }); } catch {}
  invalidateSecretCache();
  return token;
}

// `migrate`: read the items of the bw login the user had before setup (the
// default bw data dir), then lock it again. The values stay in memory.
export async function readPersonalItems(): Promise<Array<Record<string, unknown>>> {
  let master = await readKeychain(PERSONAL_KEYCHAIN_MASTER_SERVICE);
  if (!master && process.stdin.isTTY && process.stderr.isTTY) master = await readMasked("Master password of your personal vault: ") || null;
  if (!master) throw new Error(`Run \`${BRAND.bin} migrate\` in a terminal: it asks for your personal master password (or reads the keychain entry ${PERSONAL_KEYCHAIN_MASTER_SERVICE})`);
  const env = (extra: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !VAULT_ENV_KEYS.includes(name)) out[name] = value;
    return { ...out, ...extra };
  };
  const token = (await runFile("bw", ["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { env: env({ BW_PASSWORD: master }), timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  if (!token) throw new Error("Personal vault unlock returned no session");
  try {
    const output = (await runFile("bw", ["list", "items"], { env: env({ BW_SESSION: token }), timeout: 120000, maxBuffer: 256 * 1024 * 1024 })).stdout;
    let parsed: unknown;
    try { parsed = JSON.parse(output); } catch { throw new Error("bw list items returned output that is not JSON"); }
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

// Forget the cached sessions: bw locks (when keyshroud uses it), and a
// passphrase vault needs its passphrase again. The next resolve unlocks again
// from the keychain, or asks.
export async function lock(): Promise<{ bw: boolean; local: boolean }> {
  const local = await lockLocal();
  const bwUsed = existsSync(SESSION_FILE) || await usesBw();
  if (bwUsed) await lockBw();
  return { bw: bwUsed, local };
}

async function lockBw(): Promise<void> {
  try { await unlink(SESSION_FILE); } catch {}
  try { await bw(["lock"]); } catch {}
  forgetBwSession();
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
  // Any other `!keyshroud …` would ask keyshroud again, without end.
  if (isSelfCommand(value)) return null;
  const command = value.slice(1).trim();
  if (command.startsWith("bw ")) { try { await ensureBwSession(); } catch {} }
  try {
    const result = await runFile("/bin/sh", ["-c", command], { env: process.env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    return result.stdout.trim() || null;
  } catch { return null; }
}

export function isSecretSource(raw: string): boolean {
  const value = raw.trim();
  return value.startsWith("!") || isRef(value);
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

// A lock: a directory holding its owner's token, so one holder at most finds its own there. It is
// held for milliseconds and broken after 30 s; a holder that lost it (a paused process) neither
// writes nor removes its successor's lock. Beside an auth.json it is the directory pi and omp
// lock too (proper-lockfile: `<file>.lock/`): they wait for it as for their own, and cannot break
// it, since they remove a stale lock with rmdir and this one is not empty. So no writer of theirs
// gets in while keyshroud holds it; they fail until the lock goes.
async function acquireLock(dir: string): Promise<{ held: () => Promise<boolean>; release: () => Promise<void> }> {
  const owner = join(dir, "owner");
  const token = randomBytes(8).toString("hex");
  const start = Date.now();
  for (;;) {
    try { await mkdir(dir); await writeFile(owner, token, { mode: 0o600 }); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockedAt = await stat(dir).then((info) => info.mtimeMs, () => 0);
      if (Date.now() - lockedAt > 30000) { await rm(dir, { recursive: true, force: true }); continue; }
      if (Date.now() - start > 60000) throw new Error(`Timed out waiting for the lock ${dir}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const held = async () => (await readFile(owner, "utf8").catch(() => "")) === token;
  return { held, release: async () => { if (await held()) await rm(dir, { recursive: true, force: true }); } };
}

// The lock of one file. Temp files found on taking it were left by a holder that lost it:
// removing them makes its late rename fail rather than replace the file (see writeVaultFile and
// writePrivateFile). A `.ref` among them names where such a holder's new text waits instead
// (updateFile): that goes too.
async function withFileLock<T>(file: string, dir: string, fn: (held: () => Promise<boolean>) => Promise<T>): Promise<T> {
  const lock = await acquireLock(dir);
  try {
    const temp = `${basename(file)}.tmp.`;
    for (const name of await readdir(dirname(file)).catch(() => [])) {
      if (!name.startsWith(temp)) continue;
      const left = join(dirname(file), name);
      const staged = name.endsWith(".ref") ? await readFile(left, "utf8").catch(() => "") : "";
      if (/^pending\.[0-9a-f]+$/.test(basename(staged)) && dirname(staged).endsWith(".lock")) await rm(staged, { force: true }).catch(() => {});
      await rm(left, { force: true }).catch(() => {});
    }
    return await fn(lock.held);
  } finally { await lock.release(); }
}

// A lock left by a keyshroud that was killed while it wrote: pi and omp cannot remove it (it is
// not empty), so it is taken over, which voids what that writer had pending, and let go.
async function clearAbandonedLock(path: string): Promise<void> {
  const dir = `${path}.lock`;
  const lockedAt = await stat(dir).then((info) => info.mtimeMs, () => null);
  if (lockedAt !== null && Date.now() - lockedAt > 30000 && (await readdir(dir).catch(() => [])).length) await updateFile(path, async () => {}).catch(() => {});
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

// One writer at a time for `path`: `fn` gets the file to read (a symlink's target, so the link is
// written through, not replaced) and a `write` that replaces it. Two locks are held: the one
// beside `path`, which pi and omp know, and the one of the target, which two links to one file
// share. A writer paused past their 30 s replaces nothing, whoever comes next and however its
// locks went, because of where its new text waits for the rename: inside the lock beside `path`.
// - pi's next writer takes only that lock, and can once the directory is gone, for whatever
//   reason; a directory goes only once it is empty, so the text went first.
// - keyshroud's next writer takes the target's lock, and finds beside the target a note of where
//   the text waits (it may have come by another link): it removes both before it reads.
// A link to a file on another filesystem cannot be renamed into from here: its text waits beside
// the target, as a temp file the next keyshroud writer removes (see README, Known limits).
async function updateFile<T>(path: string, fn: (target: string, write: (content: string) => Promise<void>) => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const outer = await acquireLock(`${path}.lock`);
  try {
    const target = await realpath(path).catch(async () => join(await realpath(dirname(path)), basename(path)));
    return await withFileLock(target, `${target}.${BRAND.bin}.lock`, (inner) => {
      const held = async () => (await inner()) && (await outer.held());
      const lost = new Error(`This process lost the lock of ${path} (it was paused for over 30 seconds); nothing was written`);
      return fn(target, async (content) => {
        const id = randomBytes(6).toString("hex");
        const staged = join(`${path}.lock`, `pending.${id}`);
        const note = `${target}.tmp.${id}.ref`;
        // Nothing is put into a directory that has become someone else's lock.
        if (!(await held())) throw lost;
        try {
          await writeFile(note, staged, { mode: 0o600, flag: "wx" });
          await writeFile(staged, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
          if (!(await held())) throw lost;
          await rename(staged, target);
        } catch (error) {
          await rm(staged, { force: true }).catch(() => {});
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EXDEV") throw code === "ENOENT" ? lost : error;
          await writePrivateFile(target, content, held).catch((failed: NodeJS.ErrnoException) => { throw failed.code === "ENOENT" ? lost : failed; });
        } finally { await rm(note, { force: true }).catch(() => {}); }
        await chmod(target, 0o600);
      });
    });
  } finally { await outer.release(); }
}

async function updateAuthFile(path: string, update: (current: Record<string, unknown>) => Record<string, unknown> | null): Promise<boolean> {
  return updateFile(path, async (target, write) => {
    const next = update(await readAuthForUpdate(target));
    if (!next) return false;
    await write(`${JSON.stringify(next, null, 2)}\n`);
    return true;
  });
}

export async function writeAuthEntry(path: string, name: string, key: string, opts: { overwrite?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
  // Two of the files can be links to one: the entry the first write made is the second one's too.
  let same = false;
  const ok = await updateAuthFile(path, (current) => {
    if (Object.hasOwn(current, name) && opts.overwrite !== true) { same = authEntryRaw(current[name]) === key; return null; }
    return { ...current, [name]: { type: "api_key", key } };
  });
  return ok || same ? { ok: true, message: "Entry saved." } : { ok: false, message: `${name} already exists in ${path}` };
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

export async function resolveEntries(entries: Array<{ name: string; raw: string }>, opts: { preferProcessEnv?: boolean; injected?: Record<string, string> } = {}): Promise<ResolvedEnv> {
  const result: ResolvedEnv = { values: {}, secrets: {}, missing: [] };
  // Resolvers share the session and the batched vault snapshot, so the whole
  // pass costs one `bw list items` however many entries there are.
  const resolved = await Promise.all(entries.map(async ({ name, raw }) => {
    const own = opts.injected?.[name] !== undefined && opts.injected[name] === process.env[name] && backendOf(raw) === "local";
    const inherited = opts.preferProcessEnv && !own ? process.env[name] : undefined;
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
    if (value.trim().startsWith("!")) throw new Error(`${path}: ${name} uses a shell command; env files accept only bw:// references, ${BRAND.refScheme}:// references and literals`);
    if (isLoaderEnvName(name)) throw new Error(`${path}: ${name} changes what programs load or run; env files cannot set it`);
    return { name, raw: value };
  });
}

// Every file that holds wiring; a later one wins when they disagree.
export function wiringFiles(): string[] {
  const targets = getAuthTargets();
  return [targets.own, targets.pi, targets.omp];
}

// Where a new name is written: env.json, plus the named agents' auth.json (default: the installed ones).
export function wiringTargets(only?: Array<"omp" | "pi">): string[] {
  const targets = getAuthTargets();
  return [targets.own, ...(["omp", "pi"] as const).filter((agent) => only ? only.includes(agent) : existsSync(dirname(targets[agent]))).map((agent) => targets[agent])];
}

export async function wiredEntries(): Promise<Record<string, unknown>> {
  let merged: Record<string, unknown> = {};
  for (const path of wiringFiles()) { await clearAbandonedLock(path); merged = { ...merged, ...(await readAuthEntries(path)) }; }
  return merged;
}

export async function authEnvEntries(): Promise<Array<{ name: string; raw: string }>> {
  const merged = await wiredEntries();
  const entries: Array<{ name: string; raw: string }> = [];
  for (const [name, entry] of Object.entries(merged)) {
    if (!ENV_NAME_RE.test(name) || PROVIDER_KEYS.has(name) || isLoaderEnvName(name)) continue;
    const raw = authEntryRaw(entry);
    if (raw !== undefined) entries.push({ name, raw });
  }
  return entries;
}

// Environment wired through pi/omp auth.json. Values already present in the
// process environment win, matching earlier releases, except local vault values
// this process set itself (`injected`): those are resolved again, so `lock` and
// the end of a passphrase session reach them.
export async function buildEnvMap(injected: Record<string, string> = {}): Promise<Record<string, string>> {
  try { return (await resolveEntries(await authEnvEntries(), { preferProcessEnv: true, injected })).values; } catch { return {}; }
}

// Values to redact in-process: wired secrets (labelled by variable name), the
// vault session token, a master password file, every other login password in
// the bw snapshot (when keyshroud uses bw), and every value in the local vault
// (when it opens without asking).
export async function redactionValues(wired: Record<string, string> = {}): Promise<Record<string, string>> {
  let local: LocalVault | null = null;
  try { local = await openLocal(); } catch {}
  const values = indexValues(wired);
  try { const master = (await readFile(MASTER_PASSWORD_FILE, "utf8")).trim(); if (master) values.MASTER_PASSWORD = master; } catch {}
  if (await usesBw()) {
    try {
      for (const item of (await vaultIndex()).byId.values()) if (item.password && !Object.hasOwn(values, item.name)) values[item.name] = item.password;
    } catch {}
  }
  for (const item of local?.data.items ?? []) if (item.value && !Object.hasOwn(values, item.name)) values[item.name] = item.value;
  return values;
}

// The on-disk index (for out-of-process hooks) covers only wired secrets and
// the session tokens, so it never fingerprints the user's personal passwords.
export function indexValues(wired: Record<string, string> = {}): Record<string, string> {
  const values: Record<string, string> = { ...wired };
  const session = process.env.BW_SESSION?.trim();
  if (session) values.BW_SESSION = session;
  if (localOpen) values.LOCAL_VAULT_KEY = localOpen.key.toString("hex");
  if (localSessionSecret) values.LOCAL_VAULT_SESSION = localSessionSecret;
  return values;
}

// Merges into the existing index so values added by one command (for example
// an env file passed to `run`) stay covered for later hook invocations. Every
// unlock brings a new session token, so only the newest few of those are kept
// (entries are newest first).
const SESSION_INDEX_NAMES = new Set(["BW_SESSION", "LOCAL_VAULT_KEY", "LOCAL_VAULT_SESSION"]);
export async function writeRedactIndex(values: Record<string, string>): Promise<RedactIndex> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Read, merge and write as one step, so two commands at once each keep the other's entries.
  return updateFile(REDACT_INDEX_FILE, (_target, write) => mergeRedactIndex(values, write));
}

async function mergeRedactIndex(values: Record<string, string>, write: (content: string) => Promise<void>): Promise<RedactIndex> {
  const previous = await readRedactIndex();
  const index = buildRedactIndex(values, previous ?? undefined);
  const kept = new Map<string, number>();
  index.entries = index.entries.filter(({ name }) => {
    if (!SESSION_INDEX_NAMES.has(name)) return true;
    kept.set(name, (kept.get(name) ?? 0) + 1);
    return kept.get(name)! <= 4;
  });
  // Nothing new (the usual case for `get` and `api-key`): the file is left alone.
  if (previous && previous.entries.length === index.entries.length && index.entries.every((entry) => previous.entries.some((old) => old.mac === entry.mac))) return previous;
  await write(`${JSON.stringify(index)}\n`);
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

export async function findItems(search: string, backend?: BackendName): Promise<Array<{ id: string; name: string }>> {
  if ((backend ?? await defaultBackend()) === "local") {
    const needle = search.toLowerCase();
    return ((await openLocal())?.data.items ?? []).filter((item) => item.name.toLowerCase().includes(needle)).map(({ id, name }) => ({ id, name }));
  }
  const parsed = await bwJson(["list", "items", "--search", search]);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => {
    const value = item as { id?: unknown; name?: unknown };
    return { id: String(value.id ?? ""), name: String(value.name ?? "") };
  }).filter((item) => item.id && item.name);
}

export async function getSecret(itemName: string, backend?: BackendName): Promise<string> {
  if ((backend ?? await defaultBackend()) === "local") {
    const item = findLocalItem((await openLocal())?.data ?? { items: [] }, itemName);
    if (!item) throw new Error(`Vault item not found: ${itemName}`);
    return item.value;
  }
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

// `created`: the notice to show when this item created the local vault.
export async function createSecretItem(opts: { itemName: string; secret: string; envName?: string; notes?: string; backend?: BackendName }): Promise<{ id: string; created?: string }> {
  const problem = itemNameProblem(opts.itemName);
  if (problem) throw new Error(`Vault item name ${problem}`);
  if ((opts.backend ?? await defaultBackend()) === "local") return createLocalItem(opts);
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

export async function rotateSecretItem(opts: { itemName: string; secret: string; backend?: BackendName }): Promise<{ id: string }> {
  if ((opts.backend ?? await defaultBackend()) === "local") return rotateLocalItem(opts);
  await refuseMasterPassword(opts.secret);
  let parsed: Record<string, unknown>;
  try { parsed = await bwJson(["get", "item", opts.itemName]) as Record<string, unknown>; } catch (error) { throw mapItemError(error, opts.itemName); }
  const login = parsed.login && typeof parsed.login === "object" ? parsed.login as Record<string, unknown> : {};
  parsed.login = { ...login, password: opts.secret };
  const id = String(parsed.id ?? "");
  if (!id) throw new Error(`Vault item not found: ${opts.itemName}`);
  await bw(["edit", "item", id], { input: Buffer.from(JSON.stringify(parsed), "utf8").toString("base64") });
  await bw(["sync", "--quiet"]); invalidateSecretCache();
  return { id };
}

export async function deleteItem(id: string, permanent = false, backend?: BackendName): Promise<void> {
  if ((backend ?? await defaultBackend()) === "local") {
    if (!(await readVaultFile())) throw new Error(`Vault item not found: ${id}`);
    await updateLocal((data) => {
      const index = data.items.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`Vault item not found: ${id}`);
      data.items.splice(index, 1);
    });
    return;
  }
  await bw(["delete", "item", id, ...(permanent ? ["--permanent"] : [])]);
  await bw(["sync", "--quiet"]); invalidateSecretCache();
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

// macOS asks the person at the Mac with Touch ID (or the Mac's password). The
// reason reaches the script as data (argv). One prompt at a time, as dialogs.
const TOUCH_ID_SCRIPT = [
  "function run(argv) {",
  "  ObjC.import('LocalAuthentication');",
  "  let result = null;",
  "  $.LAContext.alloc.init.evaluatePolicyLocalizedReasonReply(2, argv[0], (ok) => { result = ok ? 'ok' : 'denied'; });",
  `  const until = Date.now() + ${DIALOG_TIMEOUT_MS};`,
  "  while (result === null && Date.now() < until) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2));",
  "  return result ?? 'timeout';",
  "}",
].join("\n");

export async function approveWithTouchId(reason: string): Promise<void> {
  if (process.platform !== "darwin" || process.env.SSH_CONNECTION || process.env.SSH_TTY) throw new Error("Cancelled");
  await withDialogLock(async () => {
    const result = await runFile("osascript", ["-l", "JavaScript", "-e", TOUCH_ID_SCRIPT, "--", reason], { timeout: DIALOG_TIMEOUT_MS + 10_000, maxBuffer: 1024 * 1024 }).catch(() => null);
    if (result?.stdout.trim() !== "ok") throw new Error("Cancelled");
  });
}

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
    "This is not a login prompt. Never enter your vault master password or your Mac password here.",
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
  const raw = await readFile(DIALOG_LOCK, "utf8").catch(() => null);
  let held = raw ?? "";
  // Empty: another process has just created it and not yet written its time. It is live, not stale.
  if (raw !== null && !held.trim()) held = await stat(DIALOG_LOCK).then((s) => `open:${Math.floor(s.mtimeMs)}`, () => "");
  const [kind, at] = held.trim().split(":");
  const age = Date.now() - Number(at);
  const live = (kind === "open" || kind === "cancelled") && age >= 0 && age < (kind === "cancelled" ? DIALOG_COOLDOWN_MS : DIALOG_TIMEOUT_MS + 30_000);
  // Remove only the stale lock read above. One that was missing then, or has changed since, is another
  // process's that it has just taken; removing it would open a second dialog.
  if (raw !== null && !live && (await readFile(DIALOG_LOCK, "utf8").catch(() => null)) === raw) await rm(DIALOG_LOCK, { force: true });
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

// ---------------------------------------------------------------------------
// The local vault: the default backend on a machine keyshroud has not used
// with bw. Its key lives in the macOS keychain, the Linux Secret Service or
// Windows DPAPI, so it opens without asking; where none of them works, the key
// is derived from a passphrase. On a Mac it can instead be wrapped to a key in
// the Secure Enclave, so it opens only after Touch ID. A passphrase or Touch ID
// vault stays open for a session (30 minutes) after the person approves.

export type BackendName = "bw" | "local";
export interface BackendChoice { backend: BackendName; reason: string }

let backendChoice: Promise<BackendChoice> | null = null;
// Set once this process opens bw or resolves a bw reference.
let bwInUse = false;

export async function defaultBackend(): Promise<BackendName> { return (await backendInfo()).backend; }

// Where unqualified item names go, never asking bw itself: a machine set up
// by 0.7 (any trace of it) stays on bw; a new one gets the local vault, and
// that choice is written down so later traces (an index, an audit log) cannot
// flip it. A 0.7 setup that left no trace at all looks like a new machine.
export function backendInfo(): Promise<BackendChoice> { return backendChoice ??= detectBackend(); }

async function detectBackend(): Promise<BackendChoice> {
  const forced = setting("BACKEND");
  if (forced === "bw" || forced === "local") return { backend: forced, reason: `${P}_BACKEND` };
  const written = await readFile(BACKEND_FILE, "utf8").then((text) => text.trim(), () => "");
  if (written === "bw" || written === "local") return { backend: written, reason: `${BACKEND_FILE} says ${written}` };
  // Written down, so a signal that comes and goes (BW_SESSION, the session file) cannot flip it later.
  const choose = async (backend: BackendName, reason: string): Promise<BackendChoice> => {
    await writePrivateFile(BACKEND_FILE, `${backend}\n`).catch(() => {});
    return { backend, reason };
  };
  if (existsSync(join(OWN_BW_DIR, "data.json"))) return choose("bw", `${BRAND.name}'s own bw login`);
  if (existsSync(VAULT_FILE)) return choose("local", "the local vault exists");
  const traces = [SESSION_FILE, MASTER_PASSWORD_FILE, MASTER_VERIFIER_FILE, ACCOUNT_FILE, AUDIT_FILE, REDACT_INDEX_FILE].filter((path) => existsSync(path));
  if (traces.length) return choose("bw", `${BRAND.name} 0.7 files (${traces.map((path) => path.slice(CONFIG_DIR.length + 1)).join(", ")})`);
  if (process.env.BW_SESSION?.trim()) return choose("bw", "BW_SESSION is set");
  for (const path of wiringFiles()) {
    for (const entry of Object.values(await readAuthEntries(path))) if (isBwSource(authEntryRaw(entry) ?? "")) return choose("bw", `bw references in ${path}`);
  }
  if (await sharedBwLoggedIn()) return choose("bw", "bw is logged in");
  for (const service of [KEYCHAIN_MASTER_SERVICE, KEYCHAIN_CLIENT_ID_SERVICE]) if (await keychainHas(service)) return choose("bw", `the keychain entry ${service}`);
  return choose("local", "no bw setup found");
}

// bw's default login (the one 0.7 used before `setup`), read without spawning bw.
async function sharedBwLoggedIn(): Promise<boolean> {
  const configured = process.env.BITWARDENCLI_APPDATA_DIR;
  const dir = configured ? configured
    : process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "Bitwarden CLI")
    : process.platform === "win32" ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Bitwarden CLI")
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Bitwarden CLI");
  try {
    const data = JSON.parse(await readFile(join(dir, "data.json"), "utf8")) as Record<string, unknown>;
    return typeof data.global_account_activeAccountId === "string" || typeof data.activeUserId === "string";
  } catch { return false; }
}

// A path as people read it: ~ for the home directory (not on Windows, where cmd has no ~).
export function shownPath(path: string): string {
  const home = homedir();
  if (process.platform === "win32" || !home || !path.startsWith(`${home}/`)) return path;
  return `~${path.slice(home.length)}`;
}

// `setup`: new items go to the agent account from now on.
export async function rememberBackend(backend: BackendName): Promise<void> {
  await writePrivateFile(BACKEND_FILE, `${backend}\n`);
  backendChoice = Promise.resolve({ backend, reason: `${BACKEND_FILE} says ${backend}` });
}

// bw:// references and `!bw …` / `!…/bw-get …` commands.
function isBwSource(raw: string): boolean {
  const value = raw.trim();
  return value.startsWith("bw://") || /^!\s*(?:\S*[\\/])?bw(?:-get|\.cmd|\.exe)?(?:\s|$)/i.test(value);
}

// Whether an entry exists, without reading it: a macOS entry stored with
// `setup --confirm-unlock` would ask first.
async function keychainHas(service: string): Promise<boolean> {
  if (process.platform === "win32") return false;
  if (process.platform !== "darwin") return (await readKeychain(service)) !== null;
  const user = process.env.USER || process.env.LOGNAME || "";
  return runFile("security", ["find-generic-password", "-a", user, "-s", service], { timeout: 10000, maxBuffer: 1024 * 1024 }).then(() => true, () => false);
}

async function usesBw(): Promise<boolean> {
  return bwInUse || Boolean(process.env.BW_SESSION?.trim()) || (await defaultBackend()) === "bw";
}

// `keyshroud://Name` (or `local://Name`) or `bw://Name` picks the backend; a plain name uses the default one.
export async function parseItemArg(arg: string): Promise<{ backend: BackendName; name: string }> {
  for (const [prefix, backend] of [[`${BRAND.refScheme}://`, "local"], ["local://", "local"], ["bw://", "bw"]] as const) {
    if (!arg.startsWith(prefix)) continue;
    const ref = parseRef(arg);
    if (!ref || ref.field !== "password") throw new Error(`An item is a name, or ${prefix}NAME`);
    return { backend, name: ref.item };
  }
  return { backend: await defaultBackend(), name: arg };
}

interface LocalVault { file: VaultFile; key: Buffer; data: VaultData; stamp: string }
let localOpen: LocalVault | null = null;
// A vault prepared in memory: its file is written, and its key stored, with its first change.
let localPending: { header: VaultHeader; key: Buffer } | null = null;
let localSessionSecret: string | null = null;
let lastLocalError: string | null = null;

// A passphrase or Touch ID vault without a session, when nobody may be asked.
export class LocalLockedError extends Error {}
const LOCAL_LOCKED = `The local vault is locked: run \`${BRAND.bin} unlock\` in a terminal`;
const LOCAL_NEEDS_TERMINAL = `No local vault yet, and creating one here needs a passphrase: run \`${BRAND.bin} unlock\` in a terminal to create it`;
const LOCAL_LOCKED_TOUCH_ID = `The local vault is locked: it opens with Touch ID at the Mac when a command needs a secret (or run \`${BRAND.bin} unlock\` there)`;
const LOCAL_TOUCH_ID_NOT_HERE = `The local vault opens with Touch ID at the Mac, and nobody can be asked from here (SSH, a sandbox, a locked screen or no desktop session): run \`${BRAND.bin} unlock\` at the Mac; its session then serves every process`;
const LOCAL_NEEDS_TOUCH_ID = `No local vault yet, and creating one with Touch ID needs the person at the Mac: run \`${BRAND.bin} unlock\` there to create it`;
const NO_ENCLAVE = "A Touch ID vault needs a Mac with a Secure Enclave (Apple silicon or a T2 chip), and this machine has none";
const NO_TOOLS = "A Touch ID vault needs the Xcode Command Line Tools once: run `xcode-select --install`, then try again; nothing was changed";
const TOUCH_ID_SOURCE = fileURLToPath(new URL("../src/touchid.swift", import.meta.url)); // resolves from src/, dist/ and the pi extension
const TOUCH_ID_TIMEOUT_MS = 60_000;

// Key types whose vault opens for a session (after an approval), not silently.
export function keyHasSessions(type: VaultKeyType | null | undefined): boolean { return type === "passphrase" || type === "secure-enclave"; }

function localFileError(error: unknown): Error {
  if (error instanceof VaultVersionError) return new Error(`The local vault ${shownPath(VAULT_FILE)} was written by a newer ${BRAND.name}; update it (npm i -g ${BRAND.bin}@latest)`);
  if (error instanceof VaultFormatError) return new Error(`The local vault ${shownPath(VAULT_FILE)} failed its integrity check; nothing was changed`);
  return error instanceof Error ? error : new Error(String(error));
}

// The stamp is a digest of the text: a file given back its inode, size and mtime is still another file.
function vaultStamp(text: string): string { return createHash("sha256").update(text).digest("hex"); }
async function readVaultFile(): Promise<{ file: VaultFile; stamp: string } | null> {
  let text: string;
  try { text = await readFile(VAULT_FILE, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try { return { file: parseVaultFile(text), stamp: vaultStamp(text) }; } catch (error) { throw localFileError(error); }
}

// The key of an existing vault: from the keychain or DPAPI without asking; a
// passphrase or Touch ID vault from its session, else (opts.prompt) by asking.
async function localKey(file: VaultFile, opts: SessionOptions = {}): Promise<Buffer> {
  if (localOpen?.file.id === file.id && !keyHasSessions(file.key.type) && !keyHasSessions(localOpen.file.key.type)) return localOpen.key;
  const spec = file.key;
  if (spec.type === "keychain") {
    const hex = await readKeychain(spec.service);
    if (hex && /^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
    if (await keychainLocked()) throw new Error(KEYRING_LOCKED);
    throw new Error(`The key of the local vault (keychain entry ${spec.service}) is missing, so ${shownPath(VAULT_FILE)} cannot be opened; move that file aside to start a new vault`);
  }
  if (spec.type === "dpapi") {
    const hex = await dpapi("unprotect", spec.blob, file.id);
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Windows could not unprotect the key of the local vault ${shownPath(VAULT_FILE)} (DPAPI): it opens only for the Windows user who created it`);
    return Buffer.from(hex, "hex");
  }
  // Passphrase and Touch ID: from the session, else (opts.prompt) by asking once.
  if (!opts.unattended) { const key = await readLocalSession(file.id); if (key) return key; }
  if (!opts.prompt && !opts.unattended) throw new LocalLockedError(spec.type === "secure-enclave" ? LOCAL_LOCKED_TOUCH_ID : LOCAL_LOCKED);
  if (spec.type === "secure-enclave" && opts.unattended && !(process.stdin.isTTY && process.stderr.isTTY)) throw new Error("An unattended session needs a terminal: run this command in one");
  const span = opts.unattended ? "with no time limit" : `for ${Math.round(SESSION_TTL_MS / 60000)} minutes`;
  for (;;) {
    try {
      if (spec.type === "secure-enclave") return await enclaveKey(file, spec, `open the ${BRAND.name} vault ${span}`, {
        ready: async () => opts.unattended ? null : readLocalSession(file.id),
        keep: (key) => writeLocalSession(file.id, key, Boolean(opts.unattended)),
      });
      const key = await derivePassphraseKey(await askPassphrase(opts), spec);
      if (!openVault(file, key)) throw new Error("Wrong passphrase; nothing was unlocked");
      await writeLocalSession(file.id, key, Boolean(opts.unattended));
      return key;
    } catch (error) {
      if (opts.unattended || !(error instanceof Error && error.message === DIALOG_BUSY)) throw error;
      const waited = await waitForLocalSession(file.id);
      if (waited) return waited;
    }
  }
}

// Touch ID helper: built on first use from src/touchid.swift (see the header
// there), cached by source hash and arch. Never built or run by callers that
// cannot ask (hooks, status, doctor).
function touchIdTools(): Promise<"ok" | "no-mac" | "no-tools"> {
  return new Promise((resolve) => execFile("xcode-select", ["-p"], { timeout: 10_000, env: childEnv() }, (error) =>
    resolve(!error ? "ok" : (error as NodeJS.ErrnoException).code === "ENOENT" ? "no-mac" : "no-tools")));
}
async function touchIdHelperPath(): Promise<{ source: Buffer; helper: string }> {
  const source = await readFile(TOUCH_ID_SOURCE).catch(() => { throw new Error(`The Touch ID helper's source ${TOUCH_ID_SOURCE} is missing; reinstall ${BRAND.bin}`); });
  const dir = join(CONFIG_DIR, "touchid", `${createHash("sha256").update(source).digest("hex").slice(0, 16)}-${process.arch}`);
  return { source, helper: join(dir, `${BRAND.bin}-touchid`) };
}
// Built once per version of touchid.swift, from the exact bytes hashed. Called only inside
// withDialogLock (one builder at a time), and only on paths that may ask. Without the
// Command Line Tools xcrun would pop their installer, so it runs only after xcode-select -p.
async function touchIdHelper(): Promise<string> {
  const { source, helper } = await touchIdHelperPath();
  if (existsSync(helper)) return helper;
  const tools = await touchIdTools();
  if (tools !== "ok") throw new Error(tools === "no-mac" ? NO_ENCLAVE : NO_TOOLS);
  process.stderr.write(`${BRAND.name}: building the Touch ID helper (once per version; up to a minute)\n`);
  const parent = dirname(dirname(helper));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const tmp = await mkdtemp(join(parent, ".build-"));
  try {
    await writeFile(join(tmp, "touchid.swift"), source);
    await runFile("xcrun", ["swiftc", "-O", "-swift-version", "5", "-o", join(tmp, "helper"), join(tmp, "touchid.swift")], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env: childEnv() })
      .catch((error: Error) => { throw new Error(`Could not build the Touch ID helper (${error.message.split("\n")[0].slice(0, 200)}); nothing was changed`); });
    await chmod(join(tmp, "helper"), 0o700);
    await mkdir(dirname(helper), { recursive: true, mode: 0o700 });
    await rename(join(tmp, "helper"), helper);
  } finally { await rm(tmp, { recursive: true, force: true }); }
  return helper;
}
// doctor: never builds.
export async function touchIdHelperState(): Promise<string> {
  const path = await touchIdHelperPath().then((p) => p.helper, () => "");
  if (path && existsSync(path)) return "built";
  const tools = await touchIdTools();
  return tools === "ok" ? "not built yet (built on first use)" : tools === "no-tools" ? "cannot be built: run xcode-select --install" : "needs a Mac with a Secure Enclave";
}

// The request goes on stdin, the answer comes on stdout. stdout is never shown or
// logged: for `agree` it holds the shared secret.
async function touchId(op: "create" | "agree", request: Record<string, string>): Promise<Record<string, string>> {
  const helper = await touchIdHelper();
  const body = JSON.stringify(op === "agree" ? { ...request, timeoutMs: TOUCH_ID_TIMEOUT_MS } : request);
  const result = await new Promise<{ code: number | string | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(helper, [op], { timeout: TOUCH_ID_TIMEOUT_MS + 15_000, maxBuffer: 1024 * 1024, env: childEnv() }, (error, stdout, stderr) =>
      resolve({ code: error ? ((error as NodeJS.ErrnoException).code ?? null) : 0, stdout: String(stdout), stderr: String(stderr) }));
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdin?.end(body);
  });
  if (result.code === 0) {
    // JSON.parse errors quote their input: never let one carry z.
    try { return JSON.parse(result.stdout) as Record<string, string>; } catch { throw new Error("The Touch ID helper gave an unreadable answer"); }
  }
  if (result.code === 2) throw new Error(NO_ENCLAVE);
  if (result.code === 3 || result.code === null) throw new Error("Cancelled"); // declined, or killed when its time was up
  if (result.code === 4) throw new Error(`The Touch ID key of the local vault ${shownPath(VAULT_FILE)} does not work on this Mac (made on another Mac, or this Mac was erased or repaired); nothing can open it here`);
  if (result.code === 5) throw new LocalLockedError(LOCAL_TOUCH_ID_NOT_HERE);
  if (typeof result.code === "string") { await rm(helper, { force: true }); throw new Error(`The Touch ID helper could not start (${result.code}); it is built again on the next try`); }
  throw new Error(`The Touch ID helper failed (${result.stderr.split("\n")[0].slice(0, 120) || `exit ${result.code}`})`);
}

// Opens a Touch ID vault: the person at the Mac approves the enclave's half of the key agreement. One sheet at a time.
// `session` runs while that lock is held: `ready` takes a session another process opened just before, `keep`
// saves this one before the lock goes, so a caller arriving as the sheet closes never asks again.
async function enclaveKey(file: VaultFile, spec: EnclaveKey, reason: string, session?: { ready: () => Promise<Buffer | null>; keep: (key: Buffer) => Promise<void> }): Promise<Buffer> {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) throw new LocalLockedError(LOCAL_TOUCH_ID_NOT_HERE);
  return withDialogLock(async () => {
    const ready = await session?.ready();
    if (ready) return ready;
    const { z } = await touchId("agree", { handle: spec.handle, epk: spec.epk, reason });
    const key = typeof z === "string" ? unwrapFromEnclave(file.id, spec, Buffer.from(z, "base64")) : null;
    if (!key || !openVault(file, key)) throw localFileError(new VaultFormatError("not opened by its key"));
    await session?.keep(key);
    return key;
  });
}

// A new Touch ID key for vault `id`. The enclave makes it without asking, the vault key is wrapped to it,
// and one approval proves it opens before anything is written. `reuse` (rekey SE to SE): no sheet.
async function newEnclaveKey(id: string, key: Buffer, reuse?: EnclaveKey): Promise<EnclaveKey> {
  if (reuse) return wrapForEnclave(id, reuse.handle, reuse.pub, key);
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) throw new LocalLockedError(LOCAL_TOUCH_ID_NOT_HERE);
  return withDialogLock(async () => {
    const made = await touchId("create", {});
    const spec = wrapForEnclave(id, made.handle, made.pub, key);
    const { z } = await touchId("agree", { handle: spec.handle, epk: spec.epk, reason: `turn on Touch ID for the ${BRAND.name} vault` });
    if (!unwrapFromEnclave(id, spec, Buffer.from(z ?? "", "base64"))?.equals(key)) throw new Error("The new Touch ID key did not open the vault; nothing was changed");
    return spec;
  });
}

// Another process is asking already: use the session it opens. null once its sheet or dialog closed without one.
async function waitForLocalSession(vaultId: string): Promise<Buffer | null> {
  const deadline = Date.now() + DIALOG_TIMEOUT_MS + 30_000;
  let closedAt = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const key = await readLocalSession(vaultId);
    if (key) return key;
    const held = await readFile(DIALOG_LOCK, "utf8").catch(() => "");
    if (held.startsWith("cancelled:")) throw new Error("Cancelled");
    const open = held.startsWith("open:") && Date.now() - Number(held.slice(5)) < DIALOG_TIMEOUT_MS + 30_000;
    if (open) closedAt = 0;
    else if (!closedAt) closedAt = Date.now();
    else if (Date.now() - closedAt > 5_000) return null;
  }
  throw new Error(DIALOG_BUSY);
}

// The local vault, opened, or null when there is none yet. A passphrase or
// Touch ID vault is open only while its session lasts, checked on every call, so `lock` and
// the session's end also close it in long-lived processes (MCP, pi).
async function openLocal(opts: SessionOptions = {}): Promise<LocalVault | null> {
  const read = await readVaultFile();
  if (!read) return null;
  let key: Buffer | null = null;
  if (!opts.unattended) {
    // Whether a session is needed is said by the vault this process opened: the header just read
    // has not been checked against any key yet. Session files are anyone's to write, so only a
    // session that holds that vault's key keeps it open.
    const cached = localOpen;
    if (cached && keyHasSessions(cached.file.key.type) && !(await readLocalSession(cached.file.id))?.equals(cached.key)) localOpen = null;
    // The cached vault is returned for the very bytes it was opened from, and for nothing else.
    if (localOpen?.stamp === read.stamp) return localOpen;
    if (keyHasSessions(read.file.key.type)) key = await readLocalSession(read.file.id);
  }
  let data: VaultData | null = null;
  try {
    // A session whose key does not open the vault was not made with it: it is no session.
    if (key && !(data = openVault(read.file, key))) { await lockLocal(); key = null; }
    if (!key) data = openVault(read.file, key = await localKey(read.file, opts));
  } catch (error) { throw localFileError(error); }
  if (!data) throw localFileError(new VaultFormatError("not opened by its key"));
  localOpen = { file: read.file, key, data, stamp: read.stamp };
  return localOpen;
}

// With no local vault yet: decide how its key is kept, and (opts.prompt, in a
// terminal) ask for a new passphrase if one is needed, before any value is
// read. Nothing is written.
export async function prepareLocalVault(opts: { prompt?: boolean } = {}): Promise<void> {
  if (localPending || await readVaultFile()) return;
  const mode = await vaultKeyMode();
  if (mode === "passphrase" && !opts.prompt) throw new Error(LOCAL_NEEDS_TERMINAL);
  if (mode === "secure-enclave" && !opts.prompt) throw new Error(LOCAL_NEEDS_TOUCH_ID);
  localPending = await newVaultKey(mode, newVaultId());
}

// A new key of this type for vault `id`, not stored yet (commitVaultKey stores keychain/DPAPI keys).
async function newVaultKey(mode: VaultKeyType, id: string, reuse?: EnclaveKey): Promise<{ header: VaultHeader; key: Buffer }> {
  const header = (key: VaultKeySpec): VaultHeader => ({ v: formatVersion(key.type), kind: VAULT_KIND, id, key });
  if (mode === "passphrase") {
    const spec = newPassphraseKey();
    return { header: header(spec), key: await derivePassphraseKey(await askNewPassphrase(), spec) };
  }
  const key = randomBytes(32);
  if (mode === "secure-enclave") return { header: header(await newEnclaveKey(id, key, reuse)), key };
  // The DPAPI blob is made when the file is written.
  return { header: header(mode === "keychain" ? { type: "keychain", service: keychainService(id) } : { type: "dpapi", blob: "" }), key };
}

async function vaultKeyMode(): Promise<VaultKeyType> {
  const forced = setting("VAULT_KEY");
  if (forced === "keychain" && process.platform === "win32") throw new Error(`${P}_VAULT_KEY=keychain: Windows has no keychain here; use dpapi or passphrase`);
  if (forced === "keychain" || forced === "dpapi" || forced === "passphrase" || forced === "secure-enclave") return forced;
  if (forced) throw new Error(`${P}_VAULT_KEY=${forced}: use keychain, dpapi, passphrase or secure-enclave`);
  if (process.platform === "win32") return "dpapi";
  if (process.platform === "darwin") return "keychain";
  return await secretServiceReady() ? "keychain" : "passphrase";
}

// Linux: only a Secret Service that answers and is unlocked (not over SSH
// without a desktop login, not in a container).
async function secretServiceReady(): Promise<boolean> {
  const onPath = (name: string) => (process.env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
  if (!onPath("secret-tool")) return false;
  try {
    const result = await runFile("busctl", ["--user", "get-property", "org.freedesktop.secrets", "/org/freedesktop/secrets/aliases/default", "org.freedesktop.Secret.Collection", "Locked"], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim() === "b false";
  } catch { return false; }
}

// Read, change and write the vault under its lock, so concurrent writers each
// keep the other's items. With `create`, a missing vault is created here.
// Everything slow (asking, the OS key store, DPAPI) happens before the lock,
// which is held only to read, seal and write.
async function updateLocal(change: (data: VaultData) => void, opts: SessionOptions & { create?: boolean } = {}): Promise<{ created: string | null }> {
  for (let attempt = 1; ; attempt++) {
    const opened = await openLocal(opts);
    let fresh: { header: VaultHeader; key: Buffer } | null = null;
    if (!opened) {
      if (!opts.create) throw new Error(`There is no local vault yet (${shownPath(VAULT_FILE)})`);
      await prepareLocalVault(opts);
      fresh = await commitVaultKey(localPending!);
    }
    let outcome: { created: string | null } | null;
    try {
      await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
      outcome = await withVaultLock(async (held) => {
        const current = await readVaultFile();
        let header: VaultHeader, key: Buffer, data: VaultData | null;
        if (current) {
          // Created or replaced since it was opened: start over with that vault.
          if (!opened || opened.file.id !== current.file.id) return null;
          header = current.file;
          key = opened.key;
          try { data = openVault(current.file, key); } catch (error) { throw localFileError(error); }
          if (!data) throw localFileError(new VaultFormatError("not opened by its key"));
        } else {
          if (!fresh) return null;
          ({ header, key } = fresh);
          data = { items: [] };
        }
        change(data);
        const file = sealVault(header, data, key);
        const text = serializeVault(file);
        await writeVaultFile(text, held);
        localOpen = { file, key, data, stamp: vaultStamp(text) };
        return { created: current ? null : creationNotice(header) };
      });
    } catch (error) {
      // A vault that was not written leaves no key behind.
      if (fresh && (await readVaultFile().catch(() => null))?.file.id !== fresh.header.id) {
        localPending = null;
        if (fresh.header.key.type === "keychain") await forgetVaultKey(fresh.header.key.service);
      }
      throw error;
    }
    if (fresh) localPending = null;
    if (outcome) {
      if (outcome.created && fresh && keyHasSessions(fresh.header.key.type)) await writeLocalSession(fresh.header.id, fresh.key, false);
      return outcome;
    }
    // Another process created the vault first: its key is the one to use.
    if (fresh?.header.key.type === "keychain") await forgetVaultKey(fresh.header.key.service);
    if (attempt >= 3) throw new Error("The local vault kept changing while this command ran; nothing was written");
  }
}

// Store a prepared vault's key: in the keychain, or protected by DPAPI (the blob goes in the header).
async function commitVaultKey(pending: { header: VaultHeader; key: Buffer }): Promise<{ header: VaultHeader; key: Buffer }> {
  const { header, key } = pending;
  if (header.key.type === "keychain") await storeVaultKey(header.key.service, key);
  if (header.key.type === "dpapi") return { header: { ...header, key: { type: "dpapi", blob: await dpapi("protect", key.toString("hex"), header.id) } }, key };
  return pending;
}

async function forgetVaultKey(service: string): Promise<void> {
  const user = process.env.USER || process.env.LOGNAME || "";
  const [command, args]: [string, string[]] = process.platform === "darwin"
    ? ["security", ["delete-generic-password", "-a", user, "-s", service]]
    : ["secret-tool", ["clear", "service", service, "account", user]];
  await runFile(command, args, { timeout: 10000, maxBuffer: 1024 * 1024 }).catch(() => {});
}

// The vault's lock. Exported for tests.
export function withVaultLock<T>(fn: (held: () => Promise<boolean>) => Promise<T>): Promise<T> { return withFileLock(VAULT_FILE, `${VAULT_FILE}.lock`, fn); }

// The lock must still be held once the new text is on disk. A successor that
// broke it after that removed the temp file, so the rename either lands before
// the successor reads the vault or fails.
async function writeVaultFile(text: string, held: () => Promise<boolean>): Promise<void> {
  const tmp = `${VAULT_FILE}.tmp.${randomBytes(6).toString("hex")}`;
  const handle = await open(tmp, "wx", 0o600);
  try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await chmod(tmp, 0o600);
  const lost = new Error("This process lost the lock of the local vault (it was paused for over 30 seconds); nothing was written");
  if (!(await held())) { await rm(tmp, { force: true }); throw lost; }
  // Windows: a reader holding the file open makes the rename fail for a moment.
  for (let attempt = 1; ; attempt++) {
    try { await rename(tmp, VAULT_FILE); break; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (code === "ENOENT") throw lost;
      if (process.platform !== "win32" || attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(code)) { await rm(tmp, { force: true }); throw error; }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
  await chmod(VAULT_FILE, 0o600);
  // The rename itself reaches the disk with its directory (not on Windows, which cannot open one).
  if (process.platform !== "win32") {
    const dir = await open(CONFIG_DIR, "r").catch(() => null);
    if (dir) { try { await dir.sync(); } catch {} finally { await dir.close(); } }
  }
}

function creationNotice(header: VaultHeader): string {
  return `${BRAND.bin}: created the local vault ${shownPath(VAULT_FILE)}; ${keyDescription(header)}.`;
}

function keyDescription(header: VaultHeader): string {
  return header.key.type === "keychain"
    ? `its key is in the ${process.platform === "darwin" ? "macOS keychain" : "Secret Service keyring"} (${header.key.service}), so programs running as you can open it without asking`
    : header.key.type === "dpapi" ? "its key is protected by Windows DPAPI for your account, so programs running as you can open it without asking"
    : header.key.type === "secure-enclave" ? `it opens with Touch ID (or your Mac's password) on this Mac only; sessions end after ${Math.round(SESSION_TTL_MS / 60000)} minutes; nothing recovers it on another Mac (run \`${BRAND.bin} rekey --to passphrase\` before moving)`
    : `it opens with your passphrase; sessions end after ${Math.round(SESSION_TTL_MS / 60000)} minutes`;
}

// The key goes to the keychain tool on stdin, never in argv; its output (which
// could echo the line) never reaches an error.
async function storeVaultKey(service: string, key: Buffer): Promise<void> {
  const user = process.env.USER || process.env.LOGNAME || "";
  const hex = key.toString("hex");
  const failed = new Error(`Could not store the key of the local vault in the ${process.platform === "darwin" ? "macOS keychain" : "Secret Service keyring"} (locked, or none in this session); nothing was created. Unlock it, or use a passphrase instead: ${P}_VAULT_KEY=passphrase ${BRAND.bin} unlock`);
  if (/["\\\r\n]/.test(user)) throw failed;
  if (process.platform === "darwin") {
    await runFile("security", ["-i"], { timeout: 20000, maxBuffer: 1024 * 1024 }, `add-generic-password -U -a "${user}" -s "${service}" -l "${BRAND.name} vault" -w ${hex}\n`).catch(() => { throw failed; });
  } else {
    if (await keychainLocked()) throw new Error(KEYRING_LOCKED);
    await runFile("secret-tool", ["store", `--label=${BRAND.name} vault`, "service", service, "account", user], { timeout: 20000, maxBuffer: 1024 * 1024 }, hex).catch(() => { throw failed; });
  }
  if ((await readKeychain(service)) !== hex) { await forgetVaultKey(service); throw failed; }
}

// Windows DPAPI through PowerShell 5.1 (on every Windows 10/11). The key or
// blob goes on stdin and comes back on stdout; the vault id (the entropy) in
// the environment. "" when it fails; an error when PowerShell does not answer in time.
const DPAPI_TIMEOUT_MS = 120_000;
function dpapi(op: "protect" | "unprotect", input: string, id: string): Promise<string> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Security",
    "$in = [Console]::In.ReadToEnd().Trim()",
    `$e = [Text.Encoding]::UTF8.GetBytes($env:${P}_VAULT_ID)`,
    op === "protect"
      ? "$b = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::ASCII.GetBytes($in), $e, 'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($b))"
      : "$b = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $e, 'CurrentUser'); [Console]::Out.Write([Text.Encoding]::ASCII.GetString($b))",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = execFile(POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      // PowerShell can take a minute to start on a slow or busy machine (seen on a fresh Windows 11 VM).
      { windowsHide: true, timeout: DPAPI_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: childEnv({ [`${P}_VAULT_ID`]: id }) }, (error, stdout, stderr) => {
        const out = String(stdout ?? "").trim();
        // A key-based SSH login has no Windows password, so DPAPI may not reach the account's key; seen on Windows 10,
        // where it came and went while the same user was signed in over RDP.
        if (error && (process.env.SSH_CONNECTION || process.env.SSH_TTY) && /access is denied|key not valid for use in specified state/i.test(String(stderr ?? ""))) reject(new Error(`Windows refused DPAPI to this SSH session: an SSH login with a key carries no Windows password, so DPAPI cannot reach your account's key. Run the command in your Windows desktop or RDP session; for a machine used only over SSH, give the vault a passphrase there with \`${BRAND.bin} rekey --to passphrase\``));
        else if (error?.killed) reject(new Error(`Windows PowerShell, which keyshroud uses for DPAPI, did not answer within ${DPAPI_TIMEOUT_MS / 1000} seconds; ${op === "protect" ? "nothing was created" : "the vault is unchanged"}. Try again once the machine is less busy`));
        else if (op === "protect" && (error || !out)) reject(new Error("Windows DPAPI could not protect the key of the local vault; nothing was created"));
        else resolve(error ? "" : out);
      });
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

// Terminal only: a new passphrase is never typed into a dialog an agent opened.
async function askNewPassphrase(): Promise<string> {
  if (!(process.stdin.isTTY && process.stderr.isTTY)) throw new Error(LOCAL_NEEDS_TERMINAL);
  process.stderr.write(`${BRAND.name}: a passphrase protects the new local vault ${shownPath(VAULT_FILE)}. Nothing can recover it.\n`);
  const passphrase = await readMasked("New passphrase for the local vault: ");
  const problem = passphraseProblem(passphrase);
  if (problem) throw new Error(`The passphrase ${problem}; nothing was created`);
  if ((await readMasked("Repeat it: ")) !== passphrase) throw new Error("The passphrases differ; nothing was created");
  return passphrase;
}

async function askPassphrase(opts: SessionOptions): Promise<string> {
  if (opts.passphrase !== undefined) return opts.passphrase;
  const span = opts.unattended ? "with no time limit (unattended)" : `for ${Math.round(SESSION_TTL_MS / 60000)} minutes`;
  const tty = process.stdin.isTTY && process.stderr.isTTY;
  if (opts.unattended && !tty) throw new Error("An unattended session needs a terminal: run this command in one");
  if (tty) {
    process.stderr.write(`${BRAND.name}: unlocking the local vault ${span}.\n`);
    const value = await readMasked("Passphrase of the local vault: ");
    if (!value) throw new Error("Cancelled");
    return value;
  }
  const value = await nativePasswordDialog([
    "A program on this computer, usually an AI agent, needs a secret and the local vault is locked.",
    "",
    `Unlock it ${span}?`,
    "",
    "Enter the passphrase of the local vault.",
  ].join("\n"), "Unlock");
  if (value === null) throw new LocalLockedError(LOCAL_LOCKED);
  if (value === "") throw new Error("Cancelled");
  return value;
}

// vault.token holds "<session id> <secret>"; vault.session the key sealed under
// that secret, with its end. A pair caught mid-write (ids differ) is left alone.
async function readLocalSession(vaultId: string): Promise<Buffer | null> {
  let token: string, wrap: string;
  try { [token, wrap] = await Promise.all([readFile(VAULT_TOKEN_FILE, "utf8"), readFile(VAULT_SESSION_FILE, "utf8")]); } catch { return null; }
  const [id = "", secret = ""] = token.trim().split(" ");
  if (!/^[0-9a-f]{64}$/.test(secret)) return null;
  let wrapId: unknown;
  try { wrapId = (JSON.parse(wrap) as { id?: unknown }).id; } catch {}
  if (wrapId !== id) return null;
  const opened = openSession(wrap, Buffer.from(secret, "hex"), vaultId, Date.now());
  if (!opened) { await lockLocal(id); return null; }
  localSessionSecret = secret;
  return opened.key;
}

async function writeLocalSession(vaultId: string, key: Buffer, unattended: boolean): Promise<void> {
  const secret = randomBytes(32);
  const expires = unattended ? null : Date.now() + SESSION_TTL_MS;
  const wrap = sealSession(vaultId, expires, secret, key);
  await writePrivateFile(VAULT_SESSION_FILE, `${JSON.stringify(wrap)}\n`);
  await writePrivateFile(VAULT_TOKEN_FILE, `${wrap.id} ${secret.toString("hex")}\n`);
  localSessionSecret = secret.toString("hex");
  if (expires !== null) armLocalLockTimer(wrap.id, expires);
}

// Deletes the sealed key when the session ends, even if nothing calls
// keyshroud then, so a copied token stops working. A newer session is left alone.
function armLocalLockTimer(id: string, expiresAt: number): void {
  if (setting("LOCK_TIMER") === "0") return;
  const script = [
    `const fs = require("fs"), e = process.env;`,
    `const tick = () => { const left = Number(e.${P}_LOCK_AT) - Date.now(); if (left > 0) return setTimeout(tick, Math.min(left, 30000));`,
    `  try { if (JSON.parse(fs.readFileSync(e.${P}_LOCK_FILE, "utf8")).id === e.${P}_LOCK_ID) fs.rmSync(e.${P}_LOCK_FILE, { force: true }); } catch {} };`,
    `tick();`,
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script], {
    detached: true, stdio: "ignore", windowsHide: true,
    env: childEnv({ [`${P}_LOCK_AT`]: String(expiresAt), [`${P}_LOCK_FILE`]: VAULT_SESSION_FILE, [`${P}_LOCK_ID`]: id }),
  });
  child.on("error", () => {});
  child.unref();
}

// true when a passphrase or Touch ID session was ended. With `id`, only that session: one
// another process wrote meanwhile is left alone.
async function lockLocal(id?: string): Promise<boolean> {
  const idOf = { [VAULT_SESSION_FILE]: (text: string) => (JSON.parse(text) as { id?: unknown }).id, [VAULT_TOKEN_FILE]: (text: string) => text.trim().split(" ")[0] };
  let ended = false;
  for (const path of [VAULT_SESSION_FILE, VAULT_TOKEN_FILE]) {
    if (id !== undefined && await readFile(path, "utf8").then(idOf[path]).catch(() => null) !== id) continue;
    try { await unlink(path); ended = true; } catch {}
  }
  if (keyHasSessions(localOpen?.file.key.type)) localOpen = null;
  localSessionSecret = null;
  return ended;
}

export interface LocalStatus { path: string; key: VaultKeyType | null; status: "none" | "unlocked" | "locked" | "error"; items: number | null; error: string | null; expiresAt?: number | null }

// Never asks.
export async function localStatus(): Promise<LocalStatus> {
  const base = { path: shownPath(VAULT_FILE), key: null, items: null, error: null };
  let read;
  try { read = await readVaultFile(); } catch (error) { return { ...base, status: "error", error: error instanceof Error ? error.message : String(error) }; }
  if (!read) return { ...base, status: "none" };
  const key = read.file.key.type;
  let expiresAt: number | null | undefined;
  if (keyHasSessions(key)) { try { expiresAt = (JSON.parse(await readFile(VAULT_SESSION_FILE, "utf8")) as { expires?: number | null }).expires; } catch {} }
  try {
    const opened = await openLocal();
    return { ...base, key, status: "unlocked", items: opened?.data.items.length ?? 0, expiresAt };
  } catch (error) {
    if (error instanceof LocalLockedError) return { ...base, key, status: "locked" };
    return { ...base, key, status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

// `unlock` with the local vault as the default: a passphrase or Touch ID vault asks
// (and is created here when there is none yet); a keychain or DPAPI vault has nothing to unlock.
export async function unlockLocal(opts: { unattended?: boolean; passphrase?: string } = {}): Promise<{ key: VaultKeyType; created: string | null; expiresAt: number | null }> {
  const read = await readVaultFile();
  // --stdin only opens an existing passphrase vault; a new passphrase is chosen in a terminal.
  if (opts.passphrase !== undefined && !read) throw new Error(`No local vault here: --stdin opens an existing one. Create it with \`${BRAND.bin} unlock\` in a terminal, or copy its ${shownPath(VAULT_FILE)} here`);
  if (opts.passphrase !== undefined && read!.file.key.type !== "passphrase") throw new Error(`--stdin is for a passphrase vault; this one opens with its ${read!.file.key.type} key`);
  if (!read) {
    const mode = await vaultKeyMode();
    if (!keyHasSessions(mode)) return { key: mode, created: null, expiresAt: null };
    if (opts.unattended && !(process.stdin.isTTY && process.stderr.isTTY)) throw new Error("An unattended session needs a terminal: run this command in one");
    await prepareLocalVault({ prompt: true });
    const { created } = await updateLocal(() => {}, { create: true });
    if (opts.unattended) await writeLocalSession(localOpen!.file.id, localOpen!.key, true);
    return { key: mode, created, expiresAt: opts.unattended ? null : (await localStatus()).expiresAt ?? null };
  }
  await openLocal({ prompt: true, unattended: opts.unattended, passphrase: opts.passphrase });
  return { key: read.file.key.type, created: null, expiresAt: opts.unattended ? null : (await localStatus()).expiresAt ?? null };
}

async function resolveLocalRef(ref: SecretRef): Promise<string | null> {
  let opened: LocalVault | null;
  try { opened = await openLocal(); lastLocalError = null; } catch (error) { lastLocalError = error instanceof Error ? error.message : String(error); return null; }
  const item = opened ? findLocalItem(opened.data, ref.item) : null;
  if (!item) return null;
  const field = ref.field;
  if (typeof field === "object") return item.fields?.[field.custom] ?? null;
  switch (field) {
    case "password": return item.value;
    case "username": return item.username ?? null;
    case "notes": return item.notes ?? null;
    case "uri": return item.uris?.[0] ?? null;
    case "id": return item.id;
    case "totp": return null;
  }
}

// An agent can start add/rotate, so a dialog could be used to phish the
// passphrase into an item it can then read; refuse it outright.
async function refuseLocalSecrets(secret: string): Promise<void> {
  if (!secret) return;
  if (await usesBw()) await refuseMasterPassword(secret);
  const read = await readVaultFile().catch(() => null);
  const target = read ? (read.file.key.type === "passphrase" && localOpen?.file.id === read.file.id ? { spec: read.file.key, key: localOpen.key } : null)
    : localPending?.header.key.type === "passphrase" ? { spec: localPending.header.key, key: localPending.key } : null;
  if (target && timingSafeEqual(await derivePassphraseKey(secret, target.spec), target.key)) throw new Error("Refusing to store the passphrase of the local vault as a secret");
}

async function createLocalItem(opts: { itemName: string; secret: string; envName?: string; notes?: string }): Promise<{ id: string; created?: string }> {
  await refuseLocalSecrets(opts.secret);
  const id = randomUUID();
  const now = new Date().toISOString();
  const { created } = await updateLocal((data) => {
    if (findLocalItem(data, opts.itemName)) throw new Error(`Vault item already exists: ${opts.itemName}`);
    data.items.push({ id, name: opts.itemName, value: opts.secret, ...(opts.envName ? { env: opts.envName } : {}), ...(opts.notes ? { notes: opts.notes } : {}), created: now, updated: now });
  }, { create: true });
  return created ? { id, created } : { id };
}

async function rotateLocalItem(opts: { itemName: string; secret: string }): Promise<{ id: string }> {
  if (!(await readVaultFile())) throw new Error(`Vault item not found: ${opts.itemName}`);
  await refuseLocalSecrets(opts.secret);
  let id = "";
  await updateLocal((data) => {
    const item = findLocalItem(data, opts.itemName);
    if (!item) throw new Error(`Vault item not found: ${opts.itemName}`);
    item.value = opts.secret;
    item.updated = new Date().toISOString();
    id = item.id;
  });
  return { id };
}

// `rekey`: the current key, proven now (never from a session), since rekey can turn Touch ID off.
async function currentKey(file: VaultFile, target: VaultKeyType): Promise<Buffer> {
  const spec = file.key;
  if (spec.type === "secure-enclave") return enclaveKey(file, spec, target === "secure-enclave" ? `give the ${BRAND.name} vault a new key`
    : target === "passphrase" ? `move the ${BRAND.name} vault from Touch ID to a passphrase` : `turn off Touch ID for the ${BRAND.name} vault`);
  if (spec.type === "passphrase") {
    const key = await derivePassphraseKey(await readMasked("Passphrase of the local vault: "), spec);
    if (!openVault(file, key)) throw new Error("Wrong passphrase; nothing was changed");
    return key;
  }
  return localKey(file); // keychain / DPAPI: readable without asking anyway
}

// A new vault key and a new vault id, so old sessions, the old keychain entry
// and old copies of the file stop opening it. Terminal only.
export async function rekeyLocal(to?: VaultKeyType): Promise<{ from: VaultKeyType; to: VaultKeyType; items: number; notice: string }> {
  if (!(process.stdin.isTTY && process.stderr.isTTY)) throw new Error(`${BRAND.bin} rekey asks for the vault's current key: run it in a terminal`);
  const read = await readVaultFile();
  if (!read) throw new Error(`There is no local vault yet (${shownPath(VAULT_FILE)})`);
  const from = read.file.key.type, target = to ?? from;
  if (target === "keychain" && process.platform === "win32") throw new Error("Windows has no keychain here; use dpapi or passphrase");
  if (target === "dpapi" && process.platform !== "win32") throw new Error("dpapi keeps keys on Windows only; use keychain, secure-enclave or passphrase");
  process.stderr.write(`${BRAND.name}: giving the local vault ${shownPath(VAULT_FILE)} a new key (${target}); first it needs its current key (${from}).\n`);
  const oldKey = await currentKey(read.file, target);
  const fresh = await commitVaultKey(await newVaultKey(target, newVaultId(), read.file.key.type === "secure-enclave" && target === "secure-enclave" ? read.file.key : undefined));
  let items = 0;
  try {
    await withVaultLock(async (held) => {
      const current = await readVaultFile();
      if (current?.file.id !== read.file.id) throw new Error("The local vault changed while this command ran; nothing was changed");
      let data: VaultData | null;
      try { data = openVault(current.file, oldKey); } catch (error) { throw localFileError(error); }
      if (!data) throw localFileError(new VaultFormatError("not opened by its key"));
      await writeVaultFile(serializeVault(sealVault(fresh.header, data, fresh.key)), held);
      items = data.items.length;
    });
  } catch (error) {
    if (fresh.header.key.type === "keychain") await forgetVaultKey(fresh.header.key.service);
    throw error;
  }
  localOpen = null;
  await lockLocal();
  if (keyHasSessions(target)) await writeLocalSession(fresh.header.id, fresh.key, false);
  let notice = `${BRAND.bin}: the local vault ${shownPath(VAULT_FILE)} has a new key; ${keyDescription(fresh.header)}.`;
  if (read.file.key.type === "keychain") {
    await forgetVaultKey(read.file.key.service);
    if (await keychainHas(read.file.key.service)) notice += ` The old key is still in the keychain (${read.file.key.service}): delete that entry.`;
  }
  await audit("rekey", [], "cli");
  return { from, to: target, items, notice };
}

// `list` and `rm`: names, ids and the auth.json entries wired to them; never a value.
export interface ItemRow { backend: BackendName; id: string; name: string; ref: string; duplicate: boolean; wired: string[] }

async function allItems(backend: BackendName): Promise<Array<{ id: string; name: string }>> {
  if (backend === "local") return ((await openLocal())?.data.items ?? []).map(({ id, name }) => ({ id, name }));
  const parsed = await bwJson(["list", "items"]);
  return (Array.isArray(parsed) ? parsed : []).map((item) => ({ id: String((item as { id?: unknown }).id ?? ""), name: String((item as { name?: unknown }).name ?? "") })).filter((item) => item.id);
}

async function authReferences(): Promise<Array<{ path: string; name: string; ref: SecretRef }>> {
  const out: Array<{ path: string; name: string; ref: SecretRef }> = [];
  for (const path of wiringFiles()) for (const [name, entry] of Object.entries(await readAuthEntries(path))) {
    try { const ref = parseRef(authEntryRaw(entry) ?? ""); if (ref) out.push({ path, name, ref }); } catch {}
  }
  return out;
}

// By id, or by name when the name is unique (as lookups resolve). Any field of the item counts.
function refersTo(ref: SecretRef, row: Pick<ItemRow, "backend" | "id" | "name" | "duplicate">): boolean {
  if ((ref.scheme === "local" ? "local" : "bw") !== row.backend) return false;
  return ref.item === row.id || (!row.duplicate && normalizeItemName(ref.item) === normalizeItemName(row.name));
}

export async function listItems(backend: BackendName): Promise<ItemRow[]> {
  const items = await allItems(backend);
  const count = new Map<string, number>();
  for (const { name } of items) count.set(normalizeItemName(name), (count.get(normalizeItemName(name)) ?? 0) + 1);
  const refs = await authReferences();
  return items.map(({ id, name }) => {
    const duplicate = (count.get(normalizeItemName(name)) ?? 0) > 1;
    const row = { backend, id, name, duplicate, ref: refFor(duplicate ? id : name, backend), wired: [] as string[] };
    row.wired = [...new Set(refs.filter((r) => refersTo(r.ref, row)).map((r) => r.name))];
    return row;
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export async function findItemToRemove(nameOrId: string, backend: BackendName): Promise<ItemRow> {
  const rows = await listItems(backend);
  const byId = rows.filter((r) => r.id === nameOrId);
  if (byId.length === 1) return byId[0];
  const byName = rows.filter((r) => normalizeItemName(r.name) === normalizeItemName(nameOrId));
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`Ambiguous vault item name: ${nameOrId} (remove one by id: ${byName.map((r) => r.id).join(", ")})`);
  throw new Error(`Vault item not found: ${nameOrId}`);
}

// Deletes the item, then unwires every auth.json entry that refers to it. Matches are recomputed under each file's lock.
export async function removeItem(row: ItemRow): Promise<{ unwired: string[]; targets: string[]; failed: Array<{ path: string; error: string }> }> {
  await deleteItem(row.id, false, row.backend);
  const unwired = new Set<string>(), targets: string[] = [], failed: Array<{ path: string; error: string }> = [];
  for (const path of wiringFiles()) {
    if (!existsSync(path)) continue;
    try {
      const changed = await updateAuthFile(path, (current) => {
        const next = { ...current };
        let hit = false;
        for (const [name, entry] of Object.entries(current)) {
          let ref: SecretRef | null = null;
          try { ref = parseRef(authEntryRaw(entry) ?? ""); } catch {}
          if (ref && refersTo(ref, row)) { delete next[name]; unwired.add(name); hit = true; }
        }
        return hit ? next : null;
      });
      if (changed) targets.push(path);
    } catch (error) { failed.push({ path, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { unwired: [...unwired], targets, failed };
}
