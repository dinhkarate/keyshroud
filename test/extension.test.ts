import assert from "node:assert/strict";
import { test } from "node:test";
import { item, sandbox, writeAuth } from "./helpers.ts";

const GH = "ghp_FAKE0123456789abcdef";

test("pi extension hydrates env, registers tools, and redacts tool results", async () => {
  const box = await sandbox([item("id-1", "GitHub CLI token", GH)]);
  await writeAuth(box, { GH_TOKEN: { type: "api_key", key: "!bw get password 'GitHub CLI token'" } });
  // core reads its configuration at import time.
  Object.assign(process.env, box.env);
  delete process.env.BW_SESSION;
  delete process.env.GH_TOKEN;
  const { default: extension } = await import("../extensions/pi/index.ts");

  const handlers = new Map<string, (event: unknown) => unknown>();
  const tools: string[] = [];
  const commands: string[] = [];
  await extension({
    on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler),
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: (name: string) => commands.push(name),
  } as never);

  assert.equal(process.env.GH_TOKEN, GH);
  assert.deepEqual(tools.sort(), ["vault_add_secret", "vault_status"]);
  assert.deepEqual(commands.sort(), ["secret", "vault_add", "vault_rotate", "vault_status", "vault_wire"]);

  const result = handlers.get("tool_result")!({ content: [{ type: "text", text: `token=${GH}` }, { type: "image", data: "x" }] }) as { content: Array<{ text?: string }> };
  assert.equal(result.content[0].text, "token=<redacted:GH_TOKEN>");
  assert.equal(handlers.get("tool_result")!({ content: [{ type: "text", text: "clean" }] }), undefined);
});
