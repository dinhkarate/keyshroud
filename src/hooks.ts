// Claude Code hook handlers. Hooks run as short-lived processes, so the
// PostToolUse path never touches the vault: it redacts from the fingerprint
// index that SessionStart (or any other unlocked command) last wrote.
import { BRAND } from "./brand.ts";
import * as core from "./core.ts";
import { redactWithIndex, type RedactIndex } from "./redact.ts";

function redactDeep(value: unknown, index: RedactIndex): unknown {
  if (typeof value === "string") return redactWithIndex(value, index);
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, index));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry, index)]));
  }
  return value;
}

async function sessionStart(): Promise<string> {
  await core.ensureSession();
  const env = await core.resolveEntries(await core.authEnvEntries());
  await core.writeRedactIndex(await core.redactionValues(env.secrets));
  const names = Object.keys(env.values);
  const context = names.length
    ? `${BRAND.name}: vault secrets are available by name only: ${names.join(", ")}. Run commands that need them with \`${BRAND.bin} run -- <command>\`; secret values in tool output are replaced with <redacted:NAME>. Never ask the user to paste a secret into chat; use \`${BRAND.bin} add\` in their terminal instead.`
    : `${BRAND.name}: no secrets are wired yet. Ask the user to run \`${BRAND.bin} add --env NAME --item "Item"\` in their own terminal.`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } });
}

async function postToolUse(input: { tool_response?: unknown }): Promise<string> {
  const index = await core.readRedactIndex();
  if (!index || index.entries.length === 0 || input.tool_response === undefined) return "";
  const before = JSON.stringify(input.tool_response);
  const redacted = redactDeep(input.tool_response, index);
  if (JSON.stringify(redacted) === before) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: redacted } });
}

// Hooks must never break the agent: any failure produces no output and exit 0.
export async function runClaudeHook(event: string, stdin: string): Promise<string> {
  try {
    const input = stdin.trim() ? JSON.parse(stdin) as { tool_response?: unknown } : {};
    if (event === "session-start") return await sessionStart();
    if (event === "post-tool-use") return await postToolUse(input);
    throw new Error(`Unknown Claude Code hook event: ${event}`);
  } catch (error) {
    process.stderr.write(`${BRAND.bin} hook: ${error instanceof Error ? error.message : String(error)}\n`);
    return "";
  }
}
