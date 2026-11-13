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
  // What a tool returns beside its text is sent to the model too, and so is the output of a `!command`.
  const beside = handlers.get("tool_result")!({ content: [{ type: "text", text: "clean" }], details: { stdout: GH, lines: [1, `a ${GH}`] }, structuredContent: { ok: true } }) as Record<string, unknown>;
  assert.deepEqual(beside, { details: { stdout: "<redacted:GH_TOKEN>", lines: [1, "a <redacted:GH_TOKEN>"] } });
  const structured = handlers.get("tool_result")!({ content: [{ type: "text", text: GH }], structuredContent: { token: GH } }) as { structuredContent: unknown };
  assert.deepEqual(structured.structuredContent, { token: "<redacted:GH_TOKEN>" });
  const kept = handlers.get("tool_result")!({ content: [{ type: "text", text: GH }], structuredContent: { ok: true } }) as { structuredContent: unknown };
  assert.deepEqual(kept.structuredContent, { ok: true });
  const context = handlers.get("context")!({ messages: [{ role: "user", content: "hi" }, { role: "bashExecution", command: "printenv", output: `GH_TOKEN=${GH}` }] }) as { messages: Array<{ output?: string }> };
  assert.equal(context.messages[1].output, "GH_TOKEN=<redacted:GH_TOKEN>");
  assert.equal(handlers.get("context")!({ messages: [{ role: "bashExecution", command: "true", output: "clean" }] }), undefined);
  // The `!command` itself runs through pi's own shell with its output masked as it arrives.
  const bash = await handlers.get("user_bash")!({ type: "user_bash", command: "printenv GH_TOKEN", excludeFromContext: false, cwd: box.dir }) as { operations: { exec: (command: string, cwd: string, options: { onData: (data: Buffer) => void }) => Promise<{ exitCode: number | null }> } };
  let shown = "";
  const ran = await bash.operations.exec(`printf 'a %s\\n' "$GH_TOKEN"; printf '%s' "$GH_TOKEN" | head -c 12; sleep 0.2; printf '%s\\n' "$GH_TOKEN" | tail -c 13`, box.dir, { onData: (data) => { shown += data; } });
  assert.equal(ran.exitCode, 0);
  // The second one arrived in two halves.
  assert.equal(shown, "a <redacted:GH_TOKEN>\n<redacted:GH_TOKEN>\n");

  // A value masked once stays masked after its name gets a new one.
  const core = await import("../src/core.ts");
  assert.deepEqual({ ...core.withEarlierValues({ GH_TOKEN: "new-value-1", Item: "new-value-1" }, { GH_TOKEN: "old-value-0", Item: "old-value-0", "Other (2)": "kept-value-9" }) },
    { GH_TOKEN: "new-value-1", Item: "new-value-1", "GH_TOKEN (2)": "old-value-0", Other: "kept-value-9" });

  // Tools start without another vault call.
  const calls = (await box.bwCalls()).length;
  await handlers.get("tool_call")!({ type: "tool_call", toolName: "bash", toolCallId: "1", input: { command: "true" } });
  assert.equal((await box.bwCalls()).length, calls);
  assert.equal(process.env.GH_TOKEN, GH);
});
