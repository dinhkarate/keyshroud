import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli, sandbox } from "./helpers.ts";

const TOKEN = "ghp_LOCALEXT0123456789abcdef";

test("pi extension on a blank machine: hydrates from the local vault, reports it, and never calls bw", async () => {
  const box = await sandbox([], { blank: true });
  const added = await runCli(box, ["add", "--env", "GH_TOKEN", "--item", "GitHub token", "--stdin"], TOKEN);
  assert.equal(added.code, 0, added.stderr);
  // core reads its configuration at import time.
  Object.assign(process.env, box.env);
  delete process.env.BW_SESSION;
  delete process.env.GH_TOKEN;
  const { default: extension } = await import("../extensions/pi/index.ts");

  const handlers = new Map<string, (event: unknown) => unknown>();
  const tools = new Map<string, { execute: () => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> }>();
  await extension({
    on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler),
    registerTool: (tool: { name: string; execute: never }) => tools.set(tool.name, tool),
    registerCommand: () => {},
  } as never);

  assert.equal(process.env.GH_TOKEN, TOKEN);
  const result = handlers.get("tool_result")!({ content: [{ type: "text", text: `token=${TOKEN}` }] }) as { content: Array<{ text?: string }> };
  assert.equal(result.content[0].text, "token=<redacted:GH_TOKEN>");
  const status = await tools.get("vault_status")!.execute();
  assert.match(status.content[0].text, /^keyshroud: local vault unlocked \(.*vault\.json, key in keychain\) \/ items: 1 \/ injected env \(names only\): GH_TOKEN/);
  assert.doesNotMatch(status.content[0].text, new RegExp(TOKEN));
  assert.equal(status.details.backend, "local");
  assert.deepEqual(await box.bwCalls(), []);
});
