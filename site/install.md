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

Any `bw` release from 2025.6 on works (older ones cannot save items on Vaultwarden 1.37.4), and on
macOS `brew install bitwarden-cli` does too. With `bw` 2026.9 or
later and Vaultwarden before 1.37.4, `bw login` prints `KeyIdBackfillError` but saves the login;
keyshroud carries on, and Vaultwarden 1.37.4 makes the error go away.

## 3. Connect your agent

Pick the line for the agent you are running in:

| Agent | Do this |
|---|---|
| Claude Code | Ask the user to type `/plugin marketplace add dinhkarate/keyshroud`, then `/plugin install keyshroud@keyshroud`, then restart Claude Code. You cannot run slash commands yourself. |
| Codex | `npx skills add dinhkarate/keyshroud -g -a codex -y` |
| OpenCode | `npx skills add dinhkarate/keyshroud -g -a opencode -y` |
| Gemini CLI | `npx skills add dinhkarate/keyshroud -g -a gemini-cli -y` |
| Cursor (agent) | `npx skills add dinhkarate/keyshroud -g -a cursor -y` |
| pi / omp | `pi install npm:keyshroud` (or `omp install npm:keyshroud`) |
| Claude Desktop, chat-only clients | Add the MCP JSON below to the client's settings (`~/Library/Application Support/Claude/claude_desktop_config.json` for Claude Desktop on macOS) |

If you can run shell commands, use the CLI (`keyshroud run`, `keyshroud add`): it needs no
tool schemas in your context. The MCP server is only for clients that cannot run commands:

```json
{ "mcpServers": { "keyshroud": { "command": "keyshroud", "args": ["mcp"] } } }
```

Merge it into an existing `mcpServers` object instead of replacing the file.
If you do use MCP from non-interactive `codex exec`, also allow the tool in `~/.codex/config.toml`:

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

# Unlock for 30 minutes (asks for the master password; keyshroud does not store it)
keyshroud unlock
```

Later, when a session has ended, a command that needs a secret opens a dialog on
the user's desktop and waits; over SSH it says to run `keyshroud unlock`.

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
