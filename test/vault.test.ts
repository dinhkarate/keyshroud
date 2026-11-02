import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  derivePassphraseKey, findLocalItem, keychainService, newPassphraseKey, newVaultId, openSession, openVault, parseVaultFile,
  passphraseProblem, sealSession, sealVault, serializeVault, VAULT_KIND, VaultFormatError, VaultVersionError, type VaultData, type VaultHeader,
} from "../src/vault.ts";

const item = (name: string, value: string) => ({ id: `id-${name}`, name, value, created: "2026-11-02T00:00:00.000Z", updated: "2026-11-02T00:00:00.000Z" });

function keychainVault(data: VaultData = { items: [item("GitHub token", "s3cret-value")] }) {
  const id = newVaultId();
  const header: VaultHeader = { v: 1, kind: VAULT_KIND, id, key: { type: "keychain", service: keychainService(id) } };
  const key = randomBytes(32);
  return { key, header, text: serializeVault(sealVault(header, data, key)) };
}

test("a sealed vault opens with its key and keeps the value out of the file", () => {
  const { key, text } = keychainVault();
  assert.doesNotMatch(text, /s3cret-value|GitHub token/);
  const data = openVault(parseVaultFile(text), key);
  assert.equal(data?.items[0].value, "s3cret-value");
  assert.equal(openVault(parseVaultFile(text), randomBytes(32)), null);
});

test("every write uses a fresh nonce", () => {
  const { key, header } = keychainVault();
  const a = sealVault(header, { items: [] }, key);
  const b = sealVault(header, { items: [] }, key);
  assert.notEqual(a.nonce, b.nonce);
});

test("changing any part of the header, nonce or data fails the check", () => {
  const { key, text } = keychainVault();
  const file = JSON.parse(text);
  const other = newVaultId();
  const variants = [
    { ...file, id: other, key: { type: "keychain", service: keychainService(other) } },
    { ...file, nonce: randomBytes(12).toString("base64") },
    { ...file, data: Buffer.from(Buffer.from(file.data, "base64").map((byte, index) => index === 0 ? byte ^ 1 : byte)).toString("base64") },
    // A shorter tag must not be accepted.
    { ...file, data: Buffer.from(file.data, "base64").subarray(0, -4).toString("base64") },
  ];
  for (const variant of variants) assert.equal(openVault(parseVaultFile(JSON.stringify(variant)), key), null);
});

test("unknown fields, key types, foreign keychain entries and weaker scrypt parameters are refused", () => {
  const { text } = keychainVault();
  const file = JSON.parse(text);
  const refused = [
    { ...file, extra: 1 },
    { ...file, kind: "other" },
    { ...file, v: 0 },
    { ...file, id: "XYZ" },
    { ...file, key: { type: "keychain", service: "keyshroud-vault-0000000000000000" } },
    { ...file, key: { type: "keychain", service: file.key.service, account: "x" } },
    { ...file, key: { type: "plaintext" } },
    { ...file, key: { ...newPassphraseKey(), N: 1024 } },
    { ...file, nonce: "AAAA" },
    { ...file, data: "not base64!" },
  ];
  for (const variant of refused) assert.throws(() => parseVaultFile(JSON.stringify(variant)), VaultFormatError);
  assert.throws(() => parseVaultFile("{"), VaultFormatError);
  assert.throws(() => parseVaultFile(JSON.stringify({ ...file, v: 2, other: true })), VaultVersionError);
});

test("item fields a newer version adds survive a rewrite", () => {
  const { key, header } = keychainVault();
  const data = { items: [{ ...item("A", "x"), future: { y: 1 } }], later: true } as unknown as VaultData;
  const reopened = openVault(parseVaultFile(serializeVault(sealVault(header, data, key))), key) as unknown as Record<string, unknown>;
  assert.deepEqual(reopened, data);
});

test("malformed items inside a sealed vault are refused", () => {
  const { key, header } = keychainVault();
  const sealed = serializeVault(sealVault(header, { items: [{ id: "1", name: "A" }] } as unknown as VaultData, key));
  assert.throws(() => openVault(parseVaultFile(sealed), key), VaultFormatError);
});

test("findLocalItem matches ids exactly and names case-insensitively", () => {
  const data: VaultData = { items: [item("GitHub token", "a"), item("Other", "b")] };
  assert.equal(findLocalItem(data, "github TOKEN")?.value, "a");
  assert.equal(findLocalItem(data, "id-Other")?.value, "b");
  assert.equal(findLocalItem(data, "missing"), null);
});

test("passphrase keys are derived from the NFC form and need 12 characters", async () => {
  assert.match(passphraseProblem("short") ?? "", /12 characters/);
  assert.equal(passphraseProblem("correct horse battery"), null);
  const spec = newPassphraseKey();
  const composed = await derivePassphraseKey("mật khẩu đủ dài", spec);
  const decomposed = await derivePassphraseKey("mật khẩu đủ dài".normalize("NFD"), spec);
  assert.deepEqual(composed, decomposed);
  assert.notDeepEqual(await derivePassphraseKey("mật khẩu đủ dàI", spec), composed);
});

test("a passphrase session opens only with its secret, for its vault, before its end", () => {
  const key = randomBytes(32);
  const secret = randomBytes(32);
  const now = Date.now();
  const wrap = sealSession("aaaaaaaaaaaaaaaa", now + 60_000, secret, key);
  const text = JSON.stringify(wrap);
  assert.deepEqual(openSession(text, secret, "aaaaaaaaaaaaaaaa", now)?.key, key);
  assert.equal(openSession(text, randomBytes(32), "aaaaaaaaaaaaaaaa", now), null);
  assert.equal(openSession(text, secret, "bbbbbbbbbbbbbbbb", now), null);
  assert.equal(openSession(text, secret, "aaaaaaaaaaaaaaaa", now + 60_000), null);
  // Pushing the end back breaks the seal.
  assert.equal(openSession(JSON.stringify({ ...wrap, expires: now + 3_600_000 }), secret, "aaaaaaaaaaaaaaaa", now), null);
  assert.equal(openSession(JSON.stringify({ ...wrap, expires: null }), secret, "aaaaaaaaaaaaaaaa", now), null);
  const forever = sealSession("aaaaaaaaaaaaaaaa", null, secret, key);
  assert.deepEqual(openSession(JSON.stringify(forever), secret, "aaaaaaaaaaaaaaaa", now + 1e12)?.key, key);
});
