// backup / restore: the local vault in one file under a passphrase of its own.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, runCliTtySteps, sandbox, type Sandbox } from "./helpers.ts";

const PASS = "backup passphrase 1";
const A = "value-aaaa-1111", B = "value-bbbb-2222";
const posix = { skip: process.platform === "win32" };
const NEW: Array<[string, string]> = [["New passphrase for the backup", PASS], ["Repeat it", PASS]];
const OPEN: Array<[string, string]> = [["Passphrase of the backup", PASS]];

const blank = () => sandbox([], { blank: true });
const add = (box: Sandbox, env: string, item: string, value: string, extra: Record<string, string> = {}) => runCli(box, ["add", "--env", env, "--item", item, "--stdin"], value, extra);
const show = (box: Sandbox) => runCli(box, ["run", "--no-mask", "--only", "A_TOKEN,B_KEY", "--", "sh", "-c", 'echo "$A_TOKEN $B_KEY"']);

// A vault with two wired items, and a backup of it.
async function backedUp(): Promise<{ box: Sandbox; file: string }> {
  const box = await blank();
  assert.equal((await add(box, "A_TOKEN", "Item A", A)).code, 0);
  assert.equal((await add(box, "B_KEY", "Item B", B)).code, 0);
  const file = join(box.dir, "vault-backup.json");
  const made = await runCliTtySteps(box, ["backup", "--out", file], NEW);
  assert.equal(made.code, 0, made.stdout);
  assert.match(made.stdout, /backup=.*vault-backup\.json items=2/);
  return { box, file };
}

test("backup writes a passphrase vault that restore opens on a machine with nothing on it", posix, async () => {
  const { box, file } = await backedUp();
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const text = await readFile(file, "utf8");
  assert.ok(!text.includes(A) && !text.includes(B));
  const header = JSON.parse(text) as { id: string; key: { type: string } };
  assert.equal(header.key.type, "passphrase");
  assert.notEqual(header.id, (JSON.parse(await readFile(join(box.configDir, "vault.json"), "utf8")) as { id: string }).id);

  // Never over a file that is there, never without a terminal, never under a short passphrase.
  const twice = await runCliTtySteps(box, ["backup", "--out", file], NEW);
  assert.notEqual(twice.code, 0);
  assert.match(twice.stdout, /is there already; nothing was written/);
  assert.equal(await readFile(file, "utf8"), text);
  const piped = await runCli(box, ["backup"], `${PASS}\n${PASS}\n`);
  assert.equal(piped.code, 2);
  assert.match(piped.stderr, /run it in a terminal/);
  const short = await runCliTtySteps(box, ["backup", "--out", join(box.dir, "short.json")], [["New passphrase for the backup", "too short"]]);
  assert.match(short.stdout, /must be at least 12 characters; nothing was written/);
  assert.ok(!existsSync(join(box.dir, "short.json")));

  const other = await blank();
  const wrong = await runCliTtySteps(other, ["restore", file, "--yes"], [["Passphrase of the backup", `${PASS}!`]]);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.stdout, /Wrong passphrase; nothing was changed/);
  const dry = await runCliTtySteps(other, ["restore", file], OPEN);
  assert.equal(dry.code, 0, dry.stdout);
  assert.match(dry.stdout, /restore plan .*\r?\n  add \(2\): Item A, Item B\r?\n  wire \(2\): A_TOKEN, B_KEY\r?\nDry run: nothing changed/);
  assert.ok(!existsSync(join(other.configDir, "vault.json")));
  assert.equal((await runCli(other, ["restore", file, "--yes"])).code, 2);

  const restored = await runCliTtySteps(other, ["restore", file, "--yes"], OPEN);
  assert.equal(restored.code, 0, restored.stdout);
  assert.match(restored.stdout, /  added \(2\): Item A, Item B\r?\n  wired \(2\): A_TOKEN, B_KEY/);
  assert.ok(!restored.stdout.includes(A) && !restored.stdout.includes(B));
  assert.equal((await show(other)).stdout, `${A} ${B}\n`);
  // Its values are masked from then on.
  assert.equal((await runCli(other, ["run", "--", "sh", "-c", 'echo "$A_TOKEN"'])).stdout, "<redacted:A_TOKEN>\n");
  const again = await runCliTtySteps(other, ["restore", file, "--yes"], OPEN);
  assert.match(again.stdout, /  already here \(2\): Item A, Item B/);
  assert.doesNotMatch(again.stdout, /added|wired/);
});

test("restore keeps an item that has another value here, unless --replace", posix, async () => {
  const { box, file } = await backedUp();
  assert.equal((await runCli(box, ["rotate", "--item", "Item A", "--stdin"], "value-aaaa-NEW9")).code, 0);
  assert.equal((await runCliTtySteps(box, ["rm", "--item", "Item B", "--yes"], [])).code, 0);
  assert.equal((await runCli(box, ["unwire", "--env", "B_KEY"])).code, 0);

  const dry = await runCliTtySteps(box, ["restore", file], OPEN);
  assert.match(dry.stdout, /  add \(1\): Item B\r?\n  another value here, kept \(--replace takes the backup's\) \(1\): Item A\r?\n  wire \(1\): B_KEY/);
  const kept = await runCliTtySteps(box, ["restore", file, "--yes"], OPEN);
  assert.equal(kept.code, 0, kept.stdout);
  assert.equal((await show(box)).stdout, `value-aaaa-NEW9 ${B}\n`);

  const replaced = await runCliTtySteps(box, ["restore", file, "--replace", "--yes"], OPEN);
  assert.match(replaced.stdout, /  already here \(1\): Item B\r?\n  replaced \(1\): Item A/);
  assert.equal((await show(box)).stdout, `${A} ${B}\n`);

  // An item is found by its name alone: one named like the id of an item here is not that item.
  const other = await blank();
  assert.equal((await add(other, "X_TOKEN", "Item X", "value-xxxx-3333")).code, 0);
  const id = (await runCli(other, ["get", "keyshroud://Item X/id"])).stdout.trim();
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal((await add(other, "ID_TOKEN", id, "value-named-like-an-id")).code, 5);
  const twin = await blank();
  assert.equal((await add(twin, "ID_TOKEN", id, "value-named-like-an-id")).code, 0);
  const twinFile = join(twin.dir, "twin.json");
  assert.equal((await runCliTtySteps(twin, ["backup", "--out", twinFile], NEW)).code, 0);
  const refused = await runCliTtySteps(other, ["restore", twinFile, "--replace", "--yes"], OPEN);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stdout, /is named like the id of another item of the local vault; nothing was changed/);
  assert.equal((await runCli(other, ["get", "X_TOKEN"])).stdout, "value-xxxx-3333");
  // What restore adds gets an id of its own.
  const ids = async (box: Sandbox) => (await runCli(box, ["get", "keyshroud://Item B/id"])).stdout.trim();
  const fresh = await blank();
  assert.equal((await runCliTtySteps(fresh, ["restore", file, "--yes"], OPEN)).code, 0);
  assert.notEqual(await ids(fresh), await ids(box));
});

test("restore takes a backup only, and a passphrase vault proves its passphrase before it is copied", posix, async () => {
  const box = await blank();
  const env = { KEYSHROUD_VAULT_KEY: "passphrase" };
  const VAULT_PASS = "the vault's own passphrase";
  assert.equal((await runCliTtySteps(box, ["unlock"], [["New passphrase", VAULT_PASS], ["Repeat it", VAULT_PASS]], env)).code, 0);
  assert.equal((await add(box, "A_TOKEN", "Item A", A, env)).code, 0);
  const file = join(box.dir, "b.json");
  // The session that is open is not enough.
  const wrong = await runCliTtySteps(box, ["backup", "--out", file], [["Passphrase of the local vault", PASS]], env);
  assert.match(wrong.stdout, /Wrong passphrase; nothing was changed/);
  assert.ok(!existsSync(file));
  const made = await runCliTtySteps(box, ["backup", "--out", file], [["Passphrase of the local vault", VAULT_PASS], ...NEW], env);
  assert.equal(made.code, 0, made.stdout);
  assert.match(made.stdout, /items=1/);

  const other = await blank();
  await writeFile(join(other.dir, "junk.json"), '{"items":[]}');
  const junk = await runCliTtySteps(other, ["restore", join(other.dir, "junk.json")], OPEN);
  assert.match(junk.stdout, /junk\.json is not a keyshroud backup; nothing was changed/);
  assert.equal((await add(other, "X_TOKEN", "Item X", "value-xxxx-3333")).code, 0);
  const machine = await runCliTtySteps(other, ["restore", join(other.configDir, "vault.json")], OPEN);
  assert.match(machine.stdout, /is a vault whose key stays on the machine it was made on/);
  const missing = await runCliTtySteps(other, ["restore", join(other.dir, "nope.json")], OPEN);
  assert.match(missing.stdout, /nope\.json could not be read \(ENOENT\)/);
  // What was there stays, next to what the backup brings.
  assert.equal((await runCliTtySteps(other, ["restore", file, "--yes"], OPEN)).code, 0);
  assert.equal((await runCli(other, ["env"])).stdout, "X_TOKEN\nA_TOKEN\n");
});
