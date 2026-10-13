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
