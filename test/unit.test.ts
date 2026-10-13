import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRedactIndex, createRedactor, createRedactStream, redactWithIndex } from "../src/redact.ts";
import { formatRef, legacyRefFor, parseEnvFile, parseRef } from "../src/refs.ts";

test("parseRef handles bw:// fields, custom fields, and encoding", () => {
  assert.deepEqual(parseRef("bw://GitHub CLI token"), { item: "GitHub CLI token", field: "password" });
  assert.deepEqual(parseRef("bw://GitHub/username"), { item: "GitHub", field: "username" });
  assert.deepEqual(parseRef("bw://a%2Fb/fields/api%20key"), { item: "a/b", field: { custom: "api key" } });
  assert.deepEqual(parseRef("bw://Sentry/totp"), { item: "Sentry", field: "totp" });
  assert.equal(parseRef("plain-literal"), null);
  assert.equal(parseRef("!echo hi"), null);
  assert.throws(() => parseRef("bw://Item/secret-field"), /Unsupported/);
  assert.throws(() => parseRef("bw:///password"), /no item/);
});

test("parseRef keeps legacy auth.json shell forms working", () => {
  assert.deepEqual(parseRef("!bw get password 'My Item'"), { item: "My Item", field: "password" });
  assert.deepEqual(parseRef("!bw get username 'My Item'"), { item: "My Item", field: "username" });
  assert.deepEqual(parseRef("!$HOME/.local/bin/bw-get 'Item'"), { item: "Item", field: "password" });
});

test("formatRef round-trips", () => {
  for (const raw of ["bw://a%2Fb", "bw://Item/notes", "bw://Item/fields/x%20y"]) assert.equal(formatRef(parseRef(raw)!), raw);
});

test("legacyRefFor refuses quotes that would break the shell form", () => {
  assert.equal(legacyRefFor("A b"), "!bw get password 'A b'");
  assert.throws(() => legacyRefFor("it's"), /single quotes/);
});

test("parseEnvFile parses comments, export, and quotes", () => {
  assert.deepEqual(parseEnvFile("# c\nexport A=bw://X\nB=\"bw://Y/fields/z\"\nC=literal # note\n\nD='k=v'\n"), [
    { name: "A", value: "bw://X" }, { name: "B", value: "bw://Y/fields/z" }, { name: "C", value: "literal" }, { name: "D", value: "k=v" },
  ]);
  assert.throws(() => parseEnvFile("not a line"), /line 1/);
});

test("redactor replaces longest secrets first and ignores short values", () => {
  const redactor = createRedactor({ LONG: "sk-abcdef123456", SHORT: "abcdef", TINY: "xy" });
  assert.equal(redactor.redact("sk-abcdef123456 abcdef xy"), "<redacted:LONG> <redacted:SHORT> xy");
  assert.equal(redactor.size, 2);
});

async function streamThrough(values: Record<string, string>, chunks: string[]): Promise<string> {
  const stream = createRedactStream(createRedactor(values));
  let out = "";
  stream.on("data", (data) => { out += data; });
  const done = new Promise((resolve) => stream.on("end", resolve));
  for (const chunk of chunks) stream.write(Buffer.from(chunk));
  stream.end();
  await done;
  return out;
}

test("redact stream never leaks a secret split across chunks", async () => {
  const values = { A: "sk-abcdef123456", B: "abcdef", D: "defghi", E: "ünïcødé-tøken" };
  const text = "start sk-abcdef123456 mid abcdefghi tail ünïcødé-tøken abcdeX end";
  const expected = createRedactor(values).redact(text);
  const bytes = Buffer.from(text);
  for (let seed = 1; seed < 300; seed++) {
    const chunks: string[] = [];
    let position = 0;
    let state = seed;
    while (position < bytes.length) {
      state = (state * 1103515245 + 12345) % 2147483648;
      const size = 1 + (state % 7);
      chunks.push(bytes.subarray(position, position + size).toString("latin1"));
      position += size;
    }
    const stream = createRedactStream(createRedactor(values));
    let out = "";
    stream.on("data", (data) => { out += data; });
    const done = new Promise((resolve) => stream.on("end", resolve));
    for (const chunk of chunks) stream.write(Buffer.from(chunk, "latin1"));
    stream.end();
    await done;
    for (const secret of Object.values(values)) assert.ok(!out.includes(secret), `seed ${seed} leaked ${secret}`);
    assert.equal(out, expected);
  }
  assert.equal(await streamThrough(values, ["no secrets here"]), "no secrets here");
});

test("index redaction matches plaintext redaction without holding values", () => {
  const values = { A: "sk-abcdef123456", B: "abcdef", C: "correct horse battery" };
  const index = buildRedactIndex(values);
  assert.ok(!JSON.stringify(index).includes("abcdef"));
  const text = "x sk-abcdef123456 y abcdef z correct horse battery abcdeg";
  assert.equal(redactWithIndex(text, index), createRedactor(values).redact(text));
  assert.equal(redactWithIndex("short", index), "short");
});
