// Secret reference grammar. References are safe to commit; values never are.
//
//   bw://<item>                 -> login password
//   bw://<item>/<field>         -> password | username | notes | totp | uri | id
//   bw://<item>/fields/<name>   -> custom field
//
// Segments are percent-decoded, so an item named "a/b" is written bw://a%2Fb.
// The legacy shell forms `!bw get <field> '<item>'` and `!…/bw-get '<item>'`
// are recognized so existing auth.json entries keep resolving without a shell.

export type RefField = "password" | "username" | "notes" | "totp" | "uri" | "id";
export interface SecretRef { item: string; field: RefField | { custom: string } }

const FIELDS: ReadonlySet<string> = new Set(["password", "username", "notes", "totp", "uri", "id"]);
const LEGACY_RE = /^!\s*(?:bw\s+get\s+(password|username|notes|totp|uri)|(?:[^\s]*\/)?bw-get)\s+'([^']+)'\s*$/;

function decode(segment: string): string {
  try { return decodeURIComponent(segment); } catch { throw new Error("Invalid percent-encoding in secret reference"); }
}

export function isRef(raw: string): boolean {
  return raw.startsWith("bw://") || LEGACY_RE.test(raw);
}

export function parseRef(raw: string): SecretRef | null {
  const value = raw.trim();
  const legacy = LEGACY_RE.exec(value);
  if (legacy) return { item: legacy[2], field: (legacy[1] as RefField | undefined) ?? "password" };
  if (!value.startsWith("bw://")) return null;
  const [itemPart, ...rest] = value.slice("bw://".length).split("/");
  const item = decode(itemPart ?? "");
  if (!item) throw new Error("Secret reference has no item name");
  if (rest.length === 0 || (rest.length === 1 && rest[0] === "")) return { item, field: "password" };
  if (rest[0] === "fields" && rest.length >= 2) {
    const custom = decode(rest.slice(1).join("/"));
    if (!custom) throw new Error("Secret reference has an empty custom field name");
    return { item, field: { custom } };
  }
  if (rest.length === 1 && FIELDS.has(rest[0])) return { item, field: rest[0] as RefField };
  throw new Error(`Unsupported secret reference field: ${rest.join("/")}`);
}

export function formatRef(ref: SecretRef): string {
  const item = encodeURIComponent(ref.item);
  if (typeof ref.field === "object") return `bw://${item}/fields/${encodeURIComponent(ref.field.custom)}`;
  return ref.field === "password" ? `bw://${item}` : `bw://${item}/${ref.field}`;
}

// auth.json keeps the legacy shell form so pi/omp can still resolve the entry
// without this package loaded.
export function legacyRefFor(itemName: string): string {
  if (itemName.includes("'")) throw new Error("Vault item names used in auth.json references cannot contain single quotes");
  return `!bw get password '${itemName}'`;
}

export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

// Variables that change what a child process loads or runs. Env files can come
// from a cloned repo and agents can wire names, so neither may set these.
const LOADER_ENV_RE = /^(?:PATH|HOME|ZDOTDIR|XDG_CONFIG_HOME|IFS|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|EDITOR|VISUAL|PAGER|LESSOPEN|LESSCLOSE|BROWSER|SSH_ASKPASS|LD_\w*|DYLD_\w*|NPM_CONFIG_\w*|GIT_(?:SSH|SSH_COMMAND|EXEC_PATH|ASKPASS|EDITOR|PAGER|EXTERNAL_DIFF|PROXY_COMMAND|DIR|WORK_TREE|TEMPLATE_DIR|CONFIG\w*))$/i;
export function isLoaderEnvName(name: string): boolean { return LOADER_ENV_RE.test(name); }

// Item names appear in native dialogs and lookups: one line of printable text,
// no padding (lookups trim, so a padded name would shadow an existing item).
export function itemNameProblem(name: string): string | null {
  if (!name || name !== name.trim()) return "must not be empty or start or end with spaces";
  if (name.length > 120) return "must be at most 120 characters";
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(name)) return "must be one line of printable text";
  return null;
}

// Parses dotenv-style files whose values may be references:
//   GH_TOKEN=bw://GitHub CLI token
//   export SENTRY_DSN="bw://Sentry/fields/dsn"
//   LOG_LEVEL=debug            # literal values pass through
export function parseEnvFile(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) throw new Error(`Invalid env file line ${index + 1}`);
    let value = match[2];
    const quoted = /^(['"])(.*)\1(?:\s+#.*)?$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, "").trim();
    out.push({ name: match[1], value });
  });
  return out;
}

export interface DotenvEntry { line: number; name: string; value: string; exported: boolean }

// Stricter than parseEnvFile, for `import`: a misread value would be stored in
// the vault, so anything ambiguous is reported by line number (never by value)
// instead of guessed. Values must also read back unchanged through parseEnvFile.
export function parseDotenvStrict(text: string): { entries: DotenvEntry[]; errors: Array<{ line: number; reason: string }> } {
  const entries: DotenvEntry[] = [];
  const errors: Array<{ line: number; reason: string }> = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const match = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(trimmed);
    if (!match) { errors.push({ line, reason: "not a NAME=value line" }); return; }
    const rest = match[3].trim();
    let value: string;
    if (rest.startsWith("'") || rest.startsWith('"')) {
      const end = rest.indexOf(rest[0], 1);
      if (end < 0) { errors.push({ line, reason: "unterminated quote (multiline values are not supported)" }); return; }
      const after = rest.slice(end + 1).trim();
      if (after && !/^#/.test(after)) { errors.push({ line, reason: "text after the closing quote" }); return; }
      if (after && end + 1 === rest.indexOf("#", end)) { errors.push({ line, reason: "comment must be separated from the closing quote by a space" }); return; }
      value = rest.slice(1, end);
      if (rest[0] === '"' && /[\\$]/.test(value)) { errors.push({ line, reason: "escape sequence or $ expansion inside double quotes" }); return; }
    } else {
      value = rest.replace(/\s+#.*$/, "");
      if (value.includes("${")) { errors.push({ line, reason: "${} expansion" }); return; }
    }
    if (value.startsWith("!")) { errors.push({ line, reason: "value starts with '!' (env files cannot run commands)" }); return; }
    if (seen.has(match[2])) { errors.push({ line, reason: `duplicate key ${match[2]}` }); return; }
    seen.add(match[2]);
    entries.push({ line, name: match[2], value, exported: Boolean(match[1]) });
  });
  return { entries, errors };
}

const SECRET_NAME_RE = /(SECRET|TOKEN|PASSW(?:OR)?D|PASSPHRASE|(?:^|_)PASS(?:$|_)|PWD|(?:^|_)KEY(?:$|_)|APIKEY|PRIVATE|CREDENTIAL|(?:^|_)CREDS?(?:$|_)|AUTH|JWT|DSN|WEBHOOK|COOKIE|SIGNING|ENCRYPT|SALT)/i;
const SECRET_VALUE_RE = /^(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-|sk-|sk_(?:live|test)_|rk_(?:live|test)_|whsec_|AKIA|ASIA|AIza|npm_|hf_|ya29\.|eyJ)/;
const URL_PASSWORD_RE = /^[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:[^\s@/]+@/i;

// Local heuristic for `import`: never sends anything anywhere. A known secret
// format wins over the name; otherwise names with a PUBLIC segment
// (NEXT_PUBLIC_*, VITE_PUBLIC_*) are meant to ship to browsers.
export function looksSecret(name: string, value: string): boolean {
  if (!value || isRef(value)) return false;
  if (SECRET_VALUE_RE.test(value) || URL_PASSWORD_RE.test(value)) return true;
  if (/(?:^|_)PUBLIC(?:$|_)/i.test(name)) return false;
  if (SECRET_NAME_RE.test(name) || /^[0-9a-f]{32,}$/i.test(value)) return true;
  return value.length >= 24 && !/\s/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}
