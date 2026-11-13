import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli, runCliTtySteps, sandbox } from "./helpers.ts";

const VALUE = "value-pass-0123456789abcdef";
const PASS = "correct horse battery staple";

test("pi extension with a passphrase vault: lock and the session's end take values out of pi before the next tool", { skip: process.platform === "win32" }, async () => {
  const box = await sandbox([], { blank: true });
  const env = { KEYSHROUD_VAULT_KEY: "passphrase" };
  const created = await runCliTtySteps(box, ["unlock"], [["New passphrase", PASS], ["Repeat it", PASS]], env);
  assert.equal(created.code, 0, created.stdout);
  for (const [name, item] of [["A_TOKEN", "Item A"], ["B_TOKEN", "Item B"]]) {
    const added = await runCli(box, ["add", "--env", name, "--item", item, "--stdin"], `${VALUE}-${name}`, env);
    assert.equal(added.code, 0, added.stderr);
  }
  // core reads its configuration at import time; pi was started with B_TOKEN set.
  Object.assign(process.env, box.env, env);
  delete process.env.BW_SESSION;
  delete process.env.A_TOKEN;
  process.env.B_TOKEN = "launch-value-b-0123456789";
  const { default: extension } = await import("../extensions/pi/index.ts");

  const handlers = new Map<string, (event: unknown) => unknown>();
  await extension({
    on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler),
    registerTool: () => {},
    registerCommand: () => {},
  } as never);
  const toolCall = () => handlers.get("tool_call")!({ type: "tool_call", toolName: "bash", toolCallId: "1", input: { command: "true" } });
  const userBash = () => handlers.get("user_bash")!({ type: "user_bash", command: "true", excludeFromContext: false, cwd: box.dir });
  const redact = (text: string) => (handlers.get("tool_result")!({ content: [{ type: "text", text }] }) as { content: Array<{ text: string }> } | undefined)?.content[0].text ?? text;

  assert.equal(process.env.A_TOKEN, `${VALUE}-A_TOKEN`);
  assert.equal(process.env.B_TOKEN, "launch-value-b-0123456789");
  assert.equal(await toolCall(), undefined);
  assert.equal(process.env.A_TOKEN, `${VALUE}-A_TOKEN`);

  assert.equal((await runCli(box, ["lock"], undefined, env)).stdout, "locked\n");
  await toolCall();
  assert.equal(process.env.A_TOKEN, undefined);
  assert.equal(process.env.B_TOKEN, "launch-value-b-0123456789");
  // Still masked, should a tool print it.
  assert.equal(redact(`token=${VALUE}-A_TOKEN`), "token=<redacted:A_TOKEN>");

  // Unlocked again in a terminal for 3 s: back before the next `!command`, gone once the session ends.
  const unlocked = await runCliTtySteps(box, ["unlock"], [["Passphrase of the local vault", PASS]], { ...env, KEYSHROUD_SESSION_TTL_MS: "3000" });
  assert.equal(unlocked.code, 0, unlocked.stdout);
  await userBash();
  assert.equal(process.env.A_TOKEN, `${VALUE}-A_TOKEN`);
  await new Promise((resolve) => setTimeout(resolve, 3300));
  await userBash();
  assert.equal(process.env.A_TOKEN, undefined);
  assert.deepEqual(await box.bwCalls(), []);
});
