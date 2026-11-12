import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRedactIndex, createRedactor, createRedactStream, redactWithIndex } from "../src/redact.ts";
import { formatRef, isLoaderEnvName, itemNameProblem, legacyRefFor, looksSecret, parseEnvFile, parseRef } from "../src/refs.ts";

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
  for (const raw of ["bw://a%2Fb", "bw://Item/notes", "bw://Item/fields/x%20y", "keyshroud://a%2Fb", "keyshroud://Item/fields/x%20y"]) assert.equal(formatRef(parseRef(raw)!), raw);
});

test("keyshroud:// and local:// both name local vault items; local:// is written as keyshroud://", () => {
  for (const raw of ["keyshroud://Item/notes", "local://Item/notes"]) assert.deepEqual(parseRef(raw), { item: "Item", field: "notes", scheme: "local" });
  assert.equal(formatRef(parseRef("local://a%2Fb")!), "keyshroud://a%2Fb");
  assert.deepEqual(parseRef("!keyshroud get 'local://Item'"), { item: "Item", field: "password", scheme: "local" });
  for (const raw of ["keyshroud:///x", "local:///var/data"]) assert.equal(parseRef(raw), null);
});

test("legacyRefFor refuses quotes that would break the shell form", () => {
  assert.equal(legacyRefFor("A b"), "!bw get password 'A b'");
  assert.throws(() => legacyRefFor("it's"), /single quotes/);
});

test("parseEnvFile parses comments, export, and quotes", () => {
  assert.deepEqual(parseEnvFile("# c\nexport A=bw://X\nB=\"bw://Y/fields/z\"\nC=literal # note\n\nD='k=v'\n"), [
    { name: "A", value: "bw://X" }, { name: "B", value: "bw://Y/fields/z" }, { name: "C", value: "literal" }, { name: "D", value: "k=v" },
  ]);
  assert.deepEqual(parseEnvFile('A="x y" # note'), [{ name: "A", value: "x y" }]);
  assert.throws(() => parseEnvFile("not a line"), /line 1/);
});

test("redactor replaces longest secrets first and ignores short values", () => {
  const redactor = createRedactor({ LONG: "sk-abcdef123456", SHORT: "abcdef", TINY: "xy" });
  assert.equal(redactor.redact("sk-abcdef123456 abcdef xy"), "<redacted:LONG> <redacted:SHORT> xy");
  assert.equal(redactor.size, 2);
});

test("a padded value is masked without its padding, and a key file line by line", () => {
  const pem = ["-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", "AAAEDfakefakefakefakefakefake+/0123456789==", "-----END OPENSSH PRIVATE KEY-----"].join("\n");
  const json = JSON.stringify({ type: "service_account", auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs", private_key_id: "0123456789abcdef0123456789abcdef01234567", private_key: `-----BEGIN PRIVATE KEY-----\nMIIEfakefakefakefakefakefake0123\n-----END PRIVATE KEY-----\n` }, null, 2);
  const values = { PADDED: "tok-FAKE-0123456789\n", SSH_KEY: pem, SA_KEY: json, WORDS: "correct horse battery staple" };
  const text = [
    "token=tok-FAKE-0123456789 done",
    "     2\tb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ",
    "+AAAEDfakefakefakefakefakefake+/0123456789==",
    'key: "MIIEfakefakefakefakefakefake0123\\n" id 0123456789abcdef0123456789abcdef01234567',
    "auth_provider_x509_cert_url https://www.googleapis.com/oauth2/v1/certs service_account -----BEGIN PRIVATE KEY----- horse battery",
  ].join("\n");
  const expected = [
    "token=<redacted:PADDED> done",
    "     2\t<redacted:SSH_KEY>",
    "+<redacted:SSH_KEY>",
    'key: "<redacted:SA_KEY>\\n" id <redacted:SA_KEY>',
    "auth_provider_x509_cert_url https://www.googleapis.com/oauth2/v1/certs service_account -----BEGIN PRIVATE KEY----- horse battery",
  ].join("\n");
  assert.equal(createRedactor(values).redact(text), expected);
  assert.equal(redactWithIndex(text, buildRedactIndex(values)), expected);
  assert.equal(createRedactor(values).redact(`a ${pem} b ${json} c`), "a <redacted:SSH_KEY> b <redacted:SA_KEY> c");
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

test("overlapping secrets: plain, streaming, and index redaction agree and never leak", async () => {
  let state = 7;
  const rand = (n: number) => { state = (state * 1103515245 + 12345) % 2147483648; return state % n; };
  const word = (length: number) => Array.from({ length }, () => "xy"[rand(2)]).join("");
  for (let round = 0; round < 400; round++) {
    const values: Record<string, string> = { A: word(6 + rand(3)), B: word(6 + rand(3)), C: word(7) };
    const text = word(20 + rand(40));
    const redactor = createRedactor(values);
    const expected = redactor.redact(text);
    for (const secret of Object.values(values)) assert.ok(!expected.includes(secret), `round ${round} plain leaked`);
    assert.equal(redactWithIndex(text, buildRedactIndex(values)), expected, `round ${round} index`);
    const cuts: string[] = [];
    for (let at = 0; at < text.length;) { const size = 1 + rand(5); cuts.push(text.slice(at, at + size)); at += size; }
    assert.equal(await streamThrough(values, cuts), expected, `round ${round} stream`);
  }
});

test("redact stream never leaks part of a secret longer than the hold limit", async () => {
  const secret = Array.from({ length: 6000 }, (_, i) => "abcdefghijklmnopqrstuvwxyz0123456789"[(i * 7 + 3) % 36]).join("");
  const text = `head ${secret} tail`;
  for (let seed = 1; seed < 40; seed++) {
    const chunks: string[] = [];
    let state = seed;
    for (let position = 0; position < text.length;) {
      state = (state * 1103515245 + 12345) % 2147483648;
      const size = 1 + (state % 1500);
      chunks.push(text.slice(position, position + size));
      position += size;
    }
    const out = await streamThrough({ LONG: secret }, chunks);
    assert.equal(out, "head <redacted:LONG> tail", `seed ${seed}`);
  }
});

test("redact stream keeps flowing on output that repeats a periodic secret", async () => {
  const stream = createRedactStream(createRedactor({ ZEROS: "00000000" }));
  let early = 0;
  let out = "";
  stream.on("data", (data) => { out += data; });
  for (let i = 0; i < 64; i++) stream.write(Buffer.from("0".repeat(1024)));
  early = out.length;
  const done = new Promise((resolve) => stream.on("end", resolve));
  stream.end();
  await done;
  assert.ok(early > 0, "nothing emitted before EOF");
  assert.ok(!out.includes("00000000"));
});

test("index redaction matches plaintext redaction without holding values", () => {
  const values = { A: "sk-abcdef123456", B: "abcdef", C: "correct horse battery" };
  const index = buildRedactIndex(values);
  assert.ok(!JSON.stringify(index).includes("abcdef"));
  const text = "x sk-abcdef123456 y abcdef z correct horse battery abcdeg";
  assert.equal(redactWithIndex(text, index), createRedactor(values).redact(text));
  assert.equal(redactWithIndex("short", index), "short");
});

test("looksSecret: known formats beat PUBLIC names, and common credential names are caught", () => {
  for (const [name, value] of [
    ["SMTP_PASS", "fakesmtppass123"], ["DB_PASS", "x1"], ["REDIS_URL", "redis://:lowercasepass@cache:6379"],
    ["NEXT_PUBLIC_STRIPE", "sk_live_FAKE0123456789"], ["PUBLICATION_TOKEN", "abc123"], ["ADMIN_CREDS", "admin:hunter2"],
    ["SIGNING", "0123456789abcdef0123456789abcdef"], ["SESSION_JWT", "short"],
  ]) assert.ok(looksSecret(name, value), `${name} should be a secret`);
  for (const [name, value] of [
    ["NEXT_PUBLIC_API_URL", "https://api.example.com"], ["PORT", "3000"], ["PASSENGER_COUNT", "4"], ["LOG_LEVEL", "debug"],
    ["GH_TOKEN", "bw://GitHub CLI token"],
  ]) assert.ok(!looksSecret(name, value), `${name} should not be a secret`);
});

test("loader variables and unsafe item names are refused", () => {
  for (const name of ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "GIT_SSH_COMMAND", "npm_config_script_shell", "ComSpec", "PSModulePath", "DOTNET_STARTUP_HOOKS", "LUA_INIT_5_4", "RUSTC_WRAPPER"]) assert.ok(isLoaderEnvName(name), name);
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GIT_TOKEN", "DATABASE_URL"]) assert.ok(!isLoaderEnvName(name), name);
  assert.equal(itemNameProblem("GitHub CLI token"), null);
  assert.equal(itemNameProblem("kikigaki/RESEND_API_KEY"), null);
  for (const name of ["", " padded", "padded ", "two\nlines", "bidi\u202Eevil", "x".repeat(121)]) assert.ok(itemNameProblem(name), JSON.stringify(name));
});
