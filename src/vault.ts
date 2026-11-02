// The local vault file: one JSON file, its items sealed with AES-256-GCM under
// one random 256-bit key (or, without a usable keychain, a key derived from a
// passphrase). Pure: no file, keychain or process I/O, so the format is tested
// directly; core.ts reads and writes the file and keeps the key.
//
//   { "v": 1, "kind": "keyshroud-vault", "id": "<16 hex>",
//     "key": { "type": "keychain", "service": "keyshroud-vault-<id>" }
//          | { "type": "dpapi", "blob": "<base64>" }
//          | { "type": "passphrase", "kdf": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<base64>" },
//     "nonce": "<base64, 12 bytes>", "data": "<base64 ciphertext || 16-byte tag>" }
//
// The header is authenticated (it is the AAD), so editing any of it fails the
// check. Anything unexpected is refused rather than guessed.
import { createCipheriv, createDecipheriv, randomBytes, scrypt, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";
import { BRAND } from "./brand.ts";

export const VAULT_KIND = `${BRAND.bin}-vault`;

export type KeychainKey = { type: "keychain"; service: string };
export type DpapiKey = { type: "dpapi"; blob: string };
export type PassphraseKey = { type: "passphrase"; kdf: "scrypt"; N: number; r: number; p: number; salt: string };
export type VaultKeySpec = KeychainKey | DpapiKey | PassphraseKey;
export type VaultKeyType = VaultKeySpec["type"];

export interface VaultHeader { v: 1; kind: string; id: string; key: VaultKeySpec }
export interface VaultFile extends VaultHeader { nonce: string; data: string }

export interface LocalItem {
  id: string;
  name: string;
  // What a reference without a field resolves to (`password` is an alias).
  value: string;
  env?: string;
  notes?: string;
  username?: string;
  uris?: string[];
  fields?: Record<string, string>;
  created: string;
  updated: string;
}
// Fields this version does not know are kept as they are when it rewrites the file.
export interface VaultData { items: LocalItem[] }

// Format constants of v1: a vault written with other parameters is refused, so
// a copied file cannot lower the cost of guessing its passphrase.
export const PASSPHRASE_KDF = { N: 2 ** 17, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
export const MIN_PASSPHRASE_LENGTH = 12;
const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: ScryptOptions) => Promise<Buffer>;

// Thrown for every malformed or modified file, with a fixed reason (never file content).
export class VaultFormatError extends Error {}
// A file written by a newer version: refused, never rewritten.
export class VaultVersionError extends Error {}

const bad = (reason: string) => new VaultFormatError(reason);

export function newVaultId(): string { return randomBytes(8).toString("hex"); }
export function keychainService(id: string): string { return `${BRAND.bin}-vault-${id}`; }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  const present = Object.keys(value);
  if (present.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) throw bad(`unexpected fields in the ${what}`);
}

// Canonical base64 only, so one file has exactly one encoding.
function base64(value: unknown, what: string, length?: { exact?: number; min?: number; max?: number }): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw bad(`${what} is not base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw bad(`${what} is not base64`);
  if (length?.exact !== undefined && bytes.length !== length.exact) throw bad(`${what} has the wrong length`);
  if ((length?.min !== undefined && bytes.length < length.min) || (length?.max !== undefined && bytes.length > length.max)) throw bad(`${what} has the wrong length`);
  return bytes;
}

// The key object in its one field order, for the AAD and for writing.
export function canonicalKey(key: VaultKeySpec): VaultKeySpec {
  switch (key.type) {
    case "keychain": return { type: key.type, service: key.service };
    case "dpapi": return { type: key.type, blob: key.blob };
    case "passphrase": return { type: key.type, kdf: key.kdf, N: key.N, r: key.r, p: key.p, salt: key.salt };
  }
}

function parseKeySpec(raw: unknown, id: string): VaultKeySpec {
  if (!isObject(raw)) throw bad("key is not an object");
  switch (raw.type) {
    case "keychain":
      exactKeys(raw, ["type", "service"], "key");
      if (raw.service !== keychainService(id)) throw bad("key names another vault's keychain entry");
      return { type: "keychain", service: raw.service };
    case "dpapi":
      exactKeys(raw, ["type", "blob"], "key");
      base64(raw.blob, "key blob", { min: 32, max: 4096 });
      return { type: "dpapi", blob: raw.blob as string };
    case "passphrase":
      exactKeys(raw, ["type", "kdf", "N", "r", "p", "salt"], "key");
      if (raw.kdf !== "scrypt" || raw.N !== PASSPHRASE_KDF.N || raw.r !== PASSPHRASE_KDF.r || raw.p !== PASSPHRASE_KDF.p) throw bad("unsupported key derivation parameters");
      base64(raw.salt, "salt", { exact: 16 });
      return { type: "passphrase", kdf: "scrypt", N: PASSPHRASE_KDF.N, r: PASSPHRASE_KDF.r, p: PASSPHRASE_KDF.p, salt: raw.salt as string };
    default:
      throw bad("unknown key type");
  }
}

export function parseVaultFile(text: string): VaultFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw bad("not JSON"); }
  if (!isObject(raw)) throw bad("not a JSON object");
  if (typeof raw.v === "number" && Number.isInteger(raw.v) && raw.v > 1) throw new VaultVersionError(`format version ${raw.v}`);
  exactKeys(raw, ["v", "kind", "id", "key", "nonce", "data"], "file");
  if (raw.v !== 1 || raw.kind !== VAULT_KIND) throw bad("not a vault file");
  if (typeof raw.id !== "string" || !/^[0-9a-f]{16}$/.test(raw.id)) throw bad("bad vault id");
  const key = parseKeySpec(raw.key, raw.id);
  base64(raw.nonce, "nonce", { exact: 12 });
  base64(raw.data, "data", { min: 16 });
  return { v: 1, kind: VAULT_KIND, id: raw.id, key, nonce: raw.nonce as string, data: raw.data as string };
}

export function serializeVault(file: VaultFile): string {
  const { v, kind, id, key, nonce, data } = file;
  return `${JSON.stringify({ v, kind, id, key: canonicalKey(key), nonce, data }, null, 2)}\n`;
}

function vaultAad(header: VaultHeader): Buffer {
  return Buffer.from(JSON.stringify([header.v, header.kind, header.id, canonicalKey(header.key)]), "utf8");
}

function seal(key: Buffer, plain: Buffer, aad: Buffer): { nonce: string; data: string } {
  if (key.length !== 32) throw new Error("A vault key is 32 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { nonce: nonce.toString("base64"), data: data.toString("base64") };
}

// null when the key is wrong or anything sealed was changed.
function unseal(key: Buffer, nonce: string, data: string, aad: Buffer): Buffer | null {
  if (key.length !== 32) return null;
  const body = Buffer.from(data, "base64");
  if (body.length < 16) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"), { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  } catch { return null; }
}

// A fresh nonce on every write.
export function sealVault(header: VaultHeader, data: VaultData, key: Buffer): VaultFile {
  const head: VaultHeader = { v: 1, kind: header.kind, id: header.id, key: canonicalKey(header.key) };
  return { ...head, ...seal(key, Buffer.from(JSON.stringify(data), "utf8"), vaultAad(head)) };
}

// null when the key does not open this file (a wrong passphrase, or a changed file).
export function openVault(file: VaultFile, key: Buffer): VaultData | null {
  const plain = unseal(key, file.nonce, file.data, vaultAad(file));
  return plain ? parsePayload(plain.toString("utf8")) : null;
}

function parsePayload(text: string): VaultData {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw bad("sealed data is not JSON"); }
  if (!isObject(raw) || !Array.isArray(raw.items)) throw bad("sealed data has no items");
  const optional = (value: unknown, check: (v: unknown) => boolean) => value === undefined || check(value);
  const isString = (v: unknown) => typeof v === "string";
  for (const item of raw.items as unknown[]) {
    if (!isObject(item) || !["id", "name", "value", "created", "updated"].every((key) => typeof item[key] === "string")) throw bad("an item is malformed");
    if (!optional(item.env, isString) || !optional(item.notes, isString) || !optional(item.username, isString)
      || !optional(item.uris, (v) => Array.isArray(v) && v.every(isString))
      || !optional(item.fields, (v) => isObject(v) && Object.values(v).every(isString))) throw bad("an item is malformed");
  }
  return raw as unknown as VaultData;
}

function normalizeName(name: string): string { return name.trim().toLowerCase(); }

// By id, else by name (case-insensitive, as bw lookups are). Names are unique.
export function findLocalItem(data: VaultData, nameOrId: string): LocalItem | null {
  const key = normalizeName(nameOrId);
  return data.items.find((item) => item.id === nameOrId) ?? data.items.find((item) => normalizeName(item.name) === key) ?? null;
}

export function passphraseProblem(passphrase: string): string | null {
  return [...passphrase.normalize("NFC")].length < MIN_PASSPHRASE_LENGTH ? `must be at least ${MIN_PASSPHRASE_LENGTH} characters` : null;
}

export function newPassphraseKey(): PassphraseKey {
  return { type: "passphrase", kdf: "scrypt", ...PASSPHRASE_KDF, salt: randomBytes(16).toString("base64") };
}

// NFC, so the same passphrase typed on another keyboard or OS derives the same key.
export function derivePassphraseKey(passphrase: string, spec: PassphraseKey): Promise<Buffer> {
  return scryptAsync(passphrase.normalize("NFC"), Buffer.from(spec.salt, "base64"), 32, { N: spec.N, r: spec.r, p: spec.p, maxmem: SCRYPT_MAXMEM });
}

// A passphrase session: the vault key sealed under a random session secret
// that lives in another file. Its end is part of the AAD, so it cannot be
// pushed back without the secret.
export interface SessionWrap { v: 1; id: string; vault: string; expires: number | null; nonce: string; wrapped: string }

function sessionAad(meta: { id: string; vault: string; expires: number | null }): Buffer {
  return Buffer.from(JSON.stringify([1, meta.id, meta.vault, meta.expires]), "utf8");
}

export function sealSession(vault: string, expires: number | null, secret: Buffer, key: Buffer): SessionWrap {
  const id = randomBytes(8).toString("hex");
  const { nonce, data } = seal(secret, key, sessionAad({ id, vault, expires }));
  return { v: 1, id, vault, expires, nonce, wrapped: data };
}

// The vault key, or null for anything malformed, expired, for another vault, or not sealed with this secret.
export function openSession(text: string, secret: Buffer, vault: string, now: number): { key: Buffer; id: string; expires: number | null } | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!isObject(raw)) return null;
  try {
    exactKeys(raw, ["v", "id", "vault", "expires", "nonce", "wrapped"], "session");
    base64(raw.nonce, "nonce", { exact: 12 });
    base64(raw.wrapped, "wrapped key", { exact: 48 });
  } catch { return null; }
  if (raw.v !== 1 || typeof raw.id !== "string" || raw.vault !== vault) return null;
  const expires = raw.expires;
  if (expires !== null && (typeof expires !== "number" || !Number.isFinite(expires) || now >= expires)) return null;
  const key = unseal(secret, raw.nonce as string, raw.wrapped as string, sessionAad({ id: raw.id, vault, expires }));
  return key && key.length === 32 ? { key, id: raw.id, expires } : null;
}
