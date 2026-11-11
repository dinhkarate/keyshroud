import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { runCli, sandbox } from "./helpers.ts";

const VALUE = "value-touchid-0123456789abcdef";

test("pi extension with a Touch ID vault: lock and the session's end take values out of pi; unlock brings them back", { skip: process.platform === "win32" }, async () => {
  const box = await sandbox([], { blank: true });
  const env = { KEYSHROUD_VAULT_KEY: "secure-enclave", FAKE_DIALOG_LOG: join(box.dir, "dialog.log") };
  const approve = { ...env, FAKE_DIALOG_VALUE: "ok" };
  const created = await runCli(box, ["unlock"], undefined, approve);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stderr, /created the local vault .*opens with Touch ID/);
  const added = await runCli(box, ["add", "--env", "A_TOKEN", "--item", "Item A", "--stdin"], VALUE, env);
  assert.equal(added.code, 0, added.stderr);
  // pi runs without FAKE_DIALOG_VALUE: its refresh never asks.
  Object.assign(process.env, box.env, env);
  delete process.env.BW_SESSION;
  delete process.env.A_TOKEN;
  const { default: extension } = await import("../extensions/pi/index.ts");

  const handlers = new Map<string, (event: unknown) => unknown>();
  await extension({
    on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler),
    registerTool: () => {},
    registerCommand: () => {},
  } as never);
  const toolCall = () => handlers.get("tool_call")!({ type: "tool_call", toolName: "bash", toolCallId: "1", input: { command: "true" } });
  const redact = (text: string) => (handlers.get("tool_result")!({ content: [{ type: "text", text }] }) as { content: Array<{ text: string }> } | undefined)?.content[0].text ?? text;

  assert.equal(process.env.A_TOKEN, VALUE);
  assert.equal((await runCli(box, ["lock"], undefined, env)).stdout, "locked\n");
  await toolCall();
  assert.equal(process.env.A_TOKEN, undefined);
  assert.equal(redact(`token=${VALUE}`), "token=<redacted:A_TOKEN>");

  const unlocked = await runCli(box, ["unlock"], undefined, { ...approve, KEYSHROUD_SESSION_TTL_MS: "3000" });
  assert.match(unlocked.stdout, /^unlocked until /, unlocked.stderr);
  await toolCall();
  assert.equal(process.env.A_TOKEN, VALUE);
  await new Promise((resolve) => setTimeout(resolve, 3300));
  await toolCall();
  assert.equal(process.env.A_TOKEN, undefined);
  assert.deepEqual(await box.bwCalls(), []);
});
