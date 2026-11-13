// Claude Code hook handlers. Hooks run as short-lived processes, so the
// PostToolUse path never touches the vault: it redacts from the fingerprint
// index that SessionStart (or any other unlocked command) last wrote.
import { BRAND } from "./brand.ts";
import * as core from "./core.ts";
import { compileRedactIndex, redactDeep } from "./redact.ts";

async function sessionStart(): Promise<string> {
  let context: string;
  try {
    await core.ensureSession();
    const env = await core.resolveEntries(await core.authEnvEntries());
    await core.writeRedactIndex(await core.indexedValues(env.secrets));
    const names = Object.keys(env.values);
    context = names.length
      ? `${BRAND.name}: vault secrets are available by name only: ${names.join(", ")}. Run every command that uses one through \`${BRAND.bin} run --only NAME -- <command>\` (or the secrets_run MCP tool with \`only\`), naming just the secrets that command needs: its output is masked as <redacted:NAME> even when the command fails. Never print a secret. Never ask the user to paste a secret into chat. To store a new one, run \`${BRAND.bin} add --env NAME --item "Item"\` (or call secrets_request): it opens a dialog on the user's desktop for the value.`
      : env.missing.length
      ? `${BRAND.name}: wired secrets could not be resolved from the vault: ${env.missing.join(", ")}. Ask the user to run \`${BRAND.bin} doctor\` (with an agent account, \`${BRAND.bin} migrate\` copies missing items into it).`
      : `${BRAND.name}: no secrets are wired yet. To store one, run \`${BRAND.bin} add --env NAME --item "Item"\` (or call secrets_request): it opens a dialog on the user's desktop for the value.`;
  } catch (error) {
    context = `${BRAND.name}: the vault could not be unlocked (${error instanceof Error ? error.message : String(error)}), so tool-output redaction may be incomplete this session. Do not print or inspect secrets; ask the user to run \`${BRAND.bin} unlock\`.`;
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } });
}

async function postToolUse(input: { tool_response?: unknown }): Promise<string> {
  const index = await core.readRedactIndex();
  if (!index || index.entries.length === 0 || input.tool_response === undefined) return "";
  const before = JSON.stringify(input.tool_response);
  const redacted = redactDeep(input.tool_response, compileRedactIndex(index));
  if (JSON.stringify(redacted) === before) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: redacted } });
}

// Hooks must never break the agent: any failure produces no output and exit 0.
export async function runClaudeHook(event: string, stdin: string): Promise<string> {
  try {
    // The input is a tool's output, and a JSON.parse error quotes what it was given.
    let input: { tool_response?: unknown } = {};
    if (stdin.trim()) { try { input = JSON.parse(stdin) as { tool_response?: unknown }; } catch { throw new Error("the hook input is not JSON"); } }
    if (event === "session-start") return await sessionStart();
    if (event === "post-tool-use") return await postToolUse(input);
    throw new Error(`Unknown Claude Code hook event: ${event}`);
  } catch (error) {
    process.stderr.write(`${BRAND.bin} hook: ${error instanceof Error ? error.message : String(error)}\n`);
    return "";
  }
}
