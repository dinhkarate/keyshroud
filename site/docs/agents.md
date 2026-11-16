# pi, omp and other agents

## pi / omp

```bash
pi install npm:keyshroud
```

The extension:

- hydrates wired secrets into the agent's environment before provider auth
  resolves, so `$CUSTOM_KEY` provider references work at startup;
- redacts every tool result, successful or failed, through the `tool_result`
  hook (wired values, the session token or vault key, and every password in the vault): its text,
  and the details and structured data a tool returns beside it. What a tool streams while it is
  still running is shown as it is; its result is masked;
- masks the output of a `!command` you type as it arrives, so the masked text is what pi shows,
  saves and later summarizes (through pi's own shell, the one your own pi settings name: a shell
  that only a project's settings name is not used for a masked `!command`; in a host
  without it, or when another extension runs your `!commands`, only what is sent to the model with
  a turn is masked). A value is masked before pi's environment holds it;
- with a passphrase vault, takes its values out of the agent's environment once the
  session ends or you run `keyshroud lock`, checked before every tool and `!command`;
- adds `/secret` (describe → confirm name → masked paste), `/vault_add`,
  `/vault_wire`, `/vault_rotate`, `/vault_status`, and the `vault_add_secret` /
  `vault_status` tools.

`/secret` can ask a local OpenAI-compatible model to propose the item and
variable names. Only your description is sent — never the value:

```bash
export KEYSHROUD_PLANNER_URL=http://127.0.0.1:8080/v1/chat/completions
export KEYSHROUD_PLANNER_MODEL=qwen3-4b
```

Without a planner, names are derived from the description and you can edit them.

## Other agents with a shell

Codex, OpenCode, Gemini CLI, Cursor's agent and anything else that can run commands: install the
CLI and the skill, which teaches the agent to run secret-using commands as `keyshroud run -- …`
and to store new secrets with `keyshroud add`:

```bash
npm install -g keyshroud
npx skills add dinhkarate/keyshroud
```

`npx skills` needs Node.js 22.20+. On an older Node, copy the skill that comes with the CLI;
Codex and OpenCode read `~/.agents/skills`:

```bash
mkdir -p ~/.agents/skills && cp -R "$(npm root -g)/keyshroud/skills/keyshroud" ~/.agents/skills/
```

## MCP clients without a shell

Claude Desktop, chat-only clients, or an agent you do not allow to run commands. Any client that
speaks MCP over stdio:

```json
{ "mcpServers": { "keyshroud": { "command": "keyshroud", "args": ["mcp"] } } }
```

Codex, if you want MCP there too: `codex mcp add keyshroud -- keyshroud mcp`. Non-interactive `codex exec` refuses MCP calls that need approval; allow keyshroud's tools explicitly:

```toml
# ~/.codex/config.toml
[mcp_servers.keyshroud.tools.secrets_run]
approval_mode = "approve"
```

OpenCode: `opencode mcp add keyshroud -- keyshroud mcp`.

| Tool | Does | Returns |
|---|---|---|
| `secrets_list` | Lists wired names (+ optional `env_file`) | resolved / unresolved names |
| `secrets_run` | Runs a shell command with secrets injected (`only`, `env_file`, `cwd`, `timeout_ms`) | exit code + masked stdout/stderr |
| `secrets_request` | Opens a hidden-input dialog on the user's desktop and stores the value | `created … verified=yes`, or a `keyshroud add …` command for *their* terminal when no dialog can be shown |
| `vault_status` | Which vault, lock state, item count | status line |
