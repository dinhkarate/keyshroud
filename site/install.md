# Set up keyshroud (instructions for AI agents)

You are an AI coding agent. The user asked you to set up keyshroud: it lets you
run commands that need API keys while every secret value reaches you only as
`<redacted:NAME>`. Secrets live in the user's own Vaultwarden or Bitwarden vault.

Work through the steps in order. Run the commands yourself unless a step says
the **user** must run it. Report each result in one line.

## Rules for the whole session

- Never ask the user to paste a secret, token, or password into the chat.
- Never handle the vault master password. Never read it from the keychain and
  never put it in a command argument, file, or environment variable.
- Never run `keyshroud get`, `bw get`, `bw unlock`, or `bw list` yourself. They
  print values or unlock the vault outside keyshroud's masking.
- Never print, echo, or log a secret value. Use names (`GH_TOKEN`) and
  references (`bw://GitHub token`) only.

## 1. Check prerequisites

```bash
node --version          # needs v22.18 or newer
command -v bw || echo "bw missing"
```

If Node.js is older than 22.18, stop and tell the user to upgrade it.

## 2. Install the CLI

```bash
npm install -g keyshroud @bitwarden/cli
keyshroud --version
```

On macOS `brew install bitwarden-cli` also works for `bw`.

## 3. Connect your agent

Pick the line for the agent you are running in:

| Agent | Do this |
|---|---|
| Claude Code | Ask the user to type `/plugin marketplace add dinhkarate/keyshroud`, then `/plugin install keyshroud@keyshroud`, then restart Claude Code. You cannot run slash commands yourself. |
| Codex | `codex mcp add keyshroud -- keyshroud mcp` |
| OpenCode | `opencode mcp add keyshroud -- keyshroud mcp` |
| pi / omp | `pi install npm:keyshroud` (or `omp install npm:keyshroud`) |
| Cursor | Add the JSON below to `~/.cursor/mcp.json` |
| Claude Desktop | Add the JSON below to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Gemini CLI | Add the JSON below to `~/.gemini/settings.json` |
| Cline, others | Add the JSON below to the client's MCP settings |

```json
{ "mcpServers": { "keyshroud": { "command": "keyshroud", "args": ["mcp"] } } }
```

Merge it into an existing `mcpServers` object instead of replacing the file.
For non-interactive `codex exec`, also allow the tool in `~/.codex/config.toml`:

```toml
[mcp_servers.keyshroud.tools.secrets_run]
approval_mode = "approve"
```

## 4. Connect the vault (the user does this)

These commands handle the master password, so the **user** runs them in their
own terminal window, not through you. Ask which vault they use, then give them
the matching block.

No vault yet? Point them to https://bitwarden.com (free account) or the
self-hosting guide: https://github.com/dinhkarate/keyshroud/tree/main/examples/vaultwarden#readme

```bash
# Self-hosted Vaultwarden only (skip for bitwarden.com; EU cloud: https://vault.bitwarden.eu)
bw config server https://vault.example.com

bw login

# Let keyshroud unlock without prompting. macOS:
security add-generic-password -a "$USER" -s vaultwarden-master-password -w
# Linux:
# secret-tool store --label=vaultwarden service vaultwarden-master-password account "$USER"
```

Wait until the user says they are done.

## 5. Verify

```bash
keyshroud doctor
```

`doctor` prints names and status only. If it reports something missing, tell
the user which line failed and what to run. Do not try to fix vault login
yourself.

## 6. Add and use secrets

- **Store a new secret:** run `keyshroud add --env NAME --item "Item name"`
  (or call the `secrets_request` MCP tool). Without a terminal it opens a
  hidden-input dialog on the user's desktop; the user pastes the value there.
- **Move an existing `.env` into the vault:** `keyshroud import` shows a dry
  run with names only; `keyshroud import --yes` stores the values and writes a
  commit-safe `.env.refs` file of `bw://` references.
- **Run a command that needs secrets:** `keyshroud run -- <command>` (or the
  `secrets_run` MCP tool). Values are injected into the command's environment
  and masked as `<redacted:NAME>` in its output, even when it fails.
- **List what is available:** `keyshroud env` (names only) or `secrets_list`.

## 7. Finish

Tell the user, in two or three lines: which agent integration you installed,
what `doctor` reported, and that from now on secret-using commands go through
`keyshroud run`.

Docs: https://github.com/dinhkarate/keyshroud#readme · Security model:
https://github.com/dinhkarate/keyshroud#security-model
