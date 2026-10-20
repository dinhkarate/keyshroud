# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.7.4] - 2026-10-20

### Fixed
- `bw` commands that talk to the server (sync, login, unlock, create, edit,
  delete) run one at a time across every keyshroud process on the machine.
  Vaultwarden replaces the refresh token on each use, so two agents refreshing
  at once could leave bw with a rejected token, and bw then logged the machine
  out for every agent.
- When bw has lost its login, the unresolved-names message says so and how to
  log in again, instead of listing the names with no reason.

## [0.7.3] - 2026-10-19

### Added
- `keyshroud mcp` picks up an update by itself: once `npm i -g keyshroud@…`
  puts a new version on disk, the running server hands requests to a server
  started from the new files, so MCP clients need no restart. Servers started
  before this release need one last restart. `vault_status` shows the version
  that answered.

## [0.7.2] - 2026-10-19

### Security
- Windows: an argument with a line break to a `.cmd`/`.bat` file is refused;
  cmd.exe would run what follows as a command, with the secrets in its
  environment (BatBadBut).
- The trial unlock behind the master-password refusal keeps a session's end only
  up to one session length, so an end date written into the session file no
  longer survives it.

### Fixed
- A logged-out `bw` is reported before anyone is asked for the master password,
  with how to log in again, instead of a request to run `keyshroud unlock`.
- `setup` run again after a logout no longer assumes Bitwarden cloud when no
  `--server` is given; only a first setup does.
- `migrate` asks for the personal master password in a terminal when it is not
  in the keychain.
- `secrets_list` says why names are unresolved; `run` exits 127 for a missing
  command; `keyshroud doctor | head` no longer prints a stack trace; a failed
  `setup` login no longer claims keyshroud switched to the new login.
- Windows: plain words reach a `.cmd`/`.bat` unchanged, so a batch file that
  reads `%1` works again; the lock timer also locks with `BW_PRETTY=true`.

## [0.7.1] - 2026-10-19

### Security
- `setup` from an agent's shell no longer generates the agent account's master
  password and puts it on the clipboard, where the agent could read it. It opens
  the signup page and you pick the password there; `setup --registered` asks for
  it in a dialog. `--confirm-unlock` and `--unattended` need a terminal.
- `add`, `rotate` and `secrets_request` always check a value against the vault
  unless it matches the stored master password or its hash, so a decoy
  `master-password` file no longer turns the refusal off.
- The lock timer asks `bw` whether its own token still works instead of trusting
  the session file, so rewriting that file no longer keeps a session open.
  `KEYSHROUD_SESSION_TTL_MS` is capped at a day.

### Fixed
- `env` lists wired names while the vault is locked.
- `setup` without `--server` uses Bitwarden cloud when `bw` has no server set.
- Install commands pin `@bitwarden/cli@2026.8.0`; the docs give the
  `keyshroud-…` keychain names used after `setup`, say that Windows has no
  keychain support, and the translations cover Windows and the CLI-first setup.

## [0.7.0] - 2026-10-19

### Changed
- keyshroud no longer needs a stored master password. When the vault is locked
  and a command needs a secret, it asks: a masked prompt in a terminal, a native
  dialog on the desktop (a waiting agent command continues once you unlock), or,
  over SSH, a message to run `keyshroud unlock`. A master password already in the
  keychain or in `~/.config/keyshroud/master-password` still unlocks without asking.
- Sessions end after 30 minutes (`KEYSHROUD_SESSION_TTL_MS`). A background timer
  runs `bw lock` then, so a copied session token stops working too. It follows the
  clock, so time a laptop spends asleep counts. Without `setup`, keyshroud shares
  bw's default login, so this also ends a `bw` session you opened yourself.
- `setup` no longer stores the agent account's master password unless you pass
  `--confirm-unlock`; from an agent's shell the generated password goes to the
  clipboard only, and `setup --registered` asks for it in a dialog.

### Added
- `unlock --unattended` and `setup --unattended` for hosts nobody sits at: they
  always ask in a terminal (never in a dialog an agent could open), then open a
  session without an end. A wrong password leaves the running session alone. Unlike a master-password file,
  a leaked session cannot log in elsewhere or change the password.
- `doctor` reports where the master password is stored, if anywhere, and when the
  session ends.
- Windows support (tested on Windows 10, Node 22): `bw`, `npm` and other npm CLIs
  installed as `.cmd` shims run without a shell (other `.cmd`/`.bat` files through
  `cmd.exe`), the unlock and secret dialogs are a PowerShell window, the lock timer is
  a detached Node process, `secrets_run` uses `cmd.exe`, and the clipboard and signup
  page work. Over `ssh -t`, Windows ends the timer with the SSH session; that session
  then ends on the next call. System tools (`powershell`, `clip`, `taskkill`,
  `explorer`) run by absolute path, and a command that is not on `PATH` fails
  instead of running a file of that name from the current directory.
- `doctor` warns when `bw` 2026.9 or later talks to a self-hosted server: those
  releases cannot log in to Vaultwarden yet (`KeyIdBackfillError`, vaultwarden#7750).

### Fixed
- `add` and `rotate` still refuse the master password as a secret when it is not
  stored: keyshroud keeps a scrypt hash of a typed master password for that check,
  and tries the value against the vault when that file is missing or altered.
- A command waiting for another command's unlock dialog asks again when that
  dialog closes without unlocking, instead of waiting five minutes.
- Running `setup` again on a logged-in agent account keeps the open session.
- `run` and `secrets_run` mask a `~/.config/keyshroud/master-password` file that a
  command prints.
- `setup` works on a host whose keyring is locked (SSH): it no longer needs the
  keychain.
- A wrong master password says so instead of printing bw's decryption errors.

## [0.6.2] - 2026-10-18

### Fixed
- A locked vault whose master password could not be read made every command hang
  on `bw`'s hidden master-password prompt (20 s per `bw` call). keyshroud now runs
  `bw` with `BW_NOINTERACTION`, so it fails at once.
- A locked Linux keyring (no desktop login, e.g. over SSH) is reported as
  `keyring=locked` by `doctor` instead of `missing`; `run` and `secrets_run` say
  why names are unresolved, and storing a keychain entry fails instead of waiting
  forever for an unlock prompt.
- `setup` no longer switches keyshroud to the new agent login before that login
  works: a run that stops early (no clipboard over SSH, waiting for signup, or a
  failed login) leaves the personal login in place.
- An empty literal (`NAME=`) in an env file reaches the command instead of being
  reported as unresolved.
- The Claude Code SessionStart hook says wired secrets could not be resolved
  instead of claiming none are wired.

## [0.6.1] - 2026-10-18

### Changed
- CLI first. The Claude Code plugin no longer starts an MCP server: Claude runs
  `keyshroud` from its Bash tool, the hooks still mask tool results, and no tool
  schemas sit in the context. Add the server yourself with
  `claude mcp add keyshroud -- keyshroud mcp` if you want it.
- Codex, OpenCode, Gemini CLI and Cursor's agent are set up with the skill
  (`npx skills add dinhkarate/keyshroud`) and the CLI instead of MCP. The MCP
  server stays for clients without a shell, such as Claude Desktop.

## [0.6.0] - 2026-10-17

### Added
- `setup --email`: keyshroud gets its own `bw` login on a dedicated agent account
  (`~/.config/keyshroud/bw`, keychain entry `keyshroud-master-password`), so agents
  can no longer unlock your personal vault. `--confirm-unlock` (macOS) makes the
  keychain ask before every unlock. Run from an agent's shell, it generates the
  agent account's password, stores it over stdin, and hands it to you on the
  clipboard for the signup page.
- `migrate`: copies the items your wired names reference from the personal vault
  into the agent account (dry run unless `--yes`, names only, originals kept).

## [0.5.3] - 2026-10-15

### Security
Fixes from an independent audit and a multi-model review of 0.5.2.
- The native dialog could be used by a prompt-injected agent to phish new
  secrets, including the vault master password. It now says a program asked for
  it and warns against the master password, refuses multi-line, control or bidi
  characters and names over 120 characters, refuses a value equal to the master
  password, opens one at a time with a 30 s pause after a cancel, and is audited.
  zenity runs with `--no-markup`.
- Env files could set `PATH`, `NODE_OPTIONS`, `LD_PRELOAD` and other loader
  variables, so a cloned repo's `.env.refs` could run code. They are rejected
  in env files, refused by `add`/`wire`/`secrets_request`, and never injected.
- Streaming redaction leaked most of a secret longer than 4096 characters.
- `secrets_run` could return a partial secret when output hit the collection
  limit; the cut tail is now dropped before masking, with per-stream budgets.
- `import` missed `*_PASS`, URL passwords with no username, hex keys, and known
  key formats in names containing `PUBLIC`; `.env.refs` is now written `0600`.
- `inject -o` replaces a planted symlink instead of writing through it; temp
  files use random names and exclusive creation.

### Changed
- `add`/`rotate` read stdin only with `--stdin`; a multi-line paste into the
  `*` prompt is drained and refused instead of reaching the shell.
- `secrets_request` checks names and existing items before opening the dialog,
  reports auth.json conflicts instead of claiming success, and returns errors.
- Item names with leading or trailing spaces are refused (they shadowed
  existing items). `add`, `rotate` and `secrets_request` refresh the redact
  index and write to the audit log.

## [0.5.2] - 2026-10-15

### Added
- `keyshroud import`: moves the secrets in a `.env` into the vault and writes
  `.env.refs`. Dry run with names only by default, `--yes` to write; values are
  verified after storing, never printed, and `--replace` rewrites the source
  atomically without a backup.

- `add`/`rotate` without a terminal, and the `secrets_request` MCP tool, open a
  native hidden-input dialog (macOS `osascript`, Linux `zenity`/`kdialog`), so
  an agent can start the command and the user only pastes. `--dialog` forces it.

### Changed
- The `add` and `rotate` prompts echo `*` per character (a count after 24) so
  typing and pastes are visible without showing the value; Backspace, Ctrl-U
  and Ctrl-C work as in a password prompt.

## [0.5.1] - 2026-10-14

### Added
- `mcpName` in `package.json` and a `server.json` for the official MCP Registry
  (`io.github.dinhkarate/keyshroud`).

### Fixed
- `bin` path written as `dist/cli.js` so `npm publish` no longer rewrites it.

### Docs
- README: supported agents table, use cases, FAQ, demo GIF; Vietnamese,
  Simplified Chinese and Japanese translations; OpenCode v2 setup via
  `opencode mcp add`; `approval_mode` note for non-interactive `codex exec`.

## [0.5.0] - 2026-10-13

First public release, renamed from `pi-vaultwarden` to **keyshroud**.

### Added
- `bw://item[/field|/fields/name]` references, including `username`, `notes`,
  `uri`, `id`, custom fields and TOTP codes.
- `run --env-file` for commit-safe reference files, `--only` for least
  privilege, and streaming output masking (on by default when not a TTY).
- `inject` template rendering into `0600` files, `redact` filter, `scan` leak
  finder, `lock`, append-only `audit.jsonl` (names only).
- MCP stdio server: `secrets_list`, `secrets_run`, `secrets_request`,
  `vault_status`.
- Claude Code plugin: SessionStart + PostToolUse redaction hooks, MCP server,
  skill.
- pi/omp `tool_result` redaction of every tool result.
- Test suite against a fake `bw`; CI; compiled `dist/` so the CLI runs from
  `node_modules`.

### Changed
- Default cache TTL is 1 hour (`KEYSHROUD_CACHE_TTL_MS`; was 7 days via
  `PI_VAULTWARDEN_CACHE_TTL_MS`).
- Config moved to `~/.config/keyshroud/`.
- pi commands renamed: `/vault_add`, `/vault_wire`, `/vault_rotate`,
  `/vault_status`; tools `vault_add_secret`, `vault_status`.
- `/secret` no longer needs a hard-coded local model; the planner is optional
  (`KEYSHROUD_PLANNER_URL`).
- Duplicate vault item names fail closed instead of picking one.

- `run` and MCP `secrets_run` strip `BW_SESSION`, `BW_PASSWORD`,
  `BW_CLIENTID` and `BW_CLIENTSECRET` from the child environment.
- Env files (`--env-file`, MCP `env_file`) reject `!command` values, including
  legacy `!bw get …` lines; auth.json still accepts them.
- `run` exits with 128+N when the child dies from signal N.
- auth.json writes refuse to replace an unparseable file, use pi's directory
  lock (`auth.json.lock/`), and write through symlinks.

### Removed
- Hard-coded server URL and personal infrastructure defaults.

### Migration from pi-vaultwarden
- Existing `!bw get password '…'` auth.json entries keep working unchanged.
- Rename `PI_VAULTWARDEN_CACHE_TTL_MS` → `KEYSHROUD_CACHE_TTL_MS`.
- Move `~/.config/pi-vaultwarden/master-password` (if used) to
  `~/.config/keyshroud/master-password`.
- Replace `pi install @piskill/pi-vaultwarden` with `pi install npm:keyshroud`.
