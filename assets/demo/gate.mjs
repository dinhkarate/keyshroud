// PreToolUse hook of the recorded Claude demos (agent-shell.sh), for every
// tool. It denies every call except running the smoke test (through
// `keyshroud run` or secrets_run), reading the script, listing names, the
// vault's status and loading the keyshroud skill. It never allows anything
// itself: a call it lets through still needs the demo's permission settings
// (dontAsk, exact allowlist).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { tool_name: tool = "", tool_input: input = {}, cwd = "" } = JSON.parse(readFileSync(0, "utf8"));
const command = typeof input.command === "string" ? input.command.trim() : "";
const smoke = String.raw`(?:(?:sh|bash) )?(?:\./)?scripts/smoke\.sh`;
const shell = new RegExp(String.raw`^(?:keyshroud run (?:--only ACME_API_KEY )?-- ${smoke}(?: 2>&1)?|cat (?:\./)?scripts/smoke\.sh|keyshroud (?:env|status))$`);
const only = (...keys) => Object.keys(input).every((key) => keys.includes(key));

const allowed =
  tool === "Bash" ? shell.test(command) && !input.run_in_background
  : tool === "mcp__keyshroud__secrets_run" ? new RegExp(`^(?:${smoke}|cat (?:\\./)?scripts/smoke\\.sh)$`).test(command) && only("command", "cwd", "only", "timeout_ms")
    && (input.cwd === undefined || (typeof input.cwd === "string" && resolve(input.cwd) === resolve(cwd)))
    && (input.only === undefined || JSON.stringify(input.only) === '["ACME_API_KEY"]')
    && (input.timeout_ms === undefined || typeof input.timeout_ms === "number")
  : tool === "mcp__keyshroud__secrets_list" || tool === "mcp__keyshroud__vault_status" ? only()
  : tool === "Read" ? typeof input.file_path === "string" && resolve(cwd, input.file_path) === resolve(cwd, "scripts/smoke.sh")
  : tool === "Skill" ? input.skill === "keyshroud:keyshroud" || input.skill === "keyshroud"
  : false;

if (!allowed) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Blocked by the demo's tool gate (assets/demo/gate.mjs).",
    },
  }));
}
