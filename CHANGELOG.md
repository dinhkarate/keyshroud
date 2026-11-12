# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.10.1] - 2026-11-12

### Fixed
- Over SSH with a key, Windows can refuse DPAPI (`Access is denied`, or `Key not valid for use in
  specified state`), since such a login has no Windows password; on a test machine it came and went. keyshroud said the vault opened only for the Windows user who created it; it now names the
  SSH session as the cause and says to use the desktop or RDP session, or a passphrase vault.

## [0.10.0] - 2026-11-12

### Changed
- Local vault items are now referenced as `keyshroud://Item` (`keyshroud://Item/notes`,
  `{{ keyshroud://Item }}` in templates). Everything keyshroud writes uses it: wiring, `.env.refs` from
  `import`, `list`, `rm` and messages. `local://Item`, the first spelling, is still read everywhere, so
  existing wiring and committed `.env.refs` files keep working unchanged. The backend is still called
  `local` (`--to local`, `KEYSHROUD_BACKEND=local`).

## [0.9.5] - 2026-11-11

### Fixed
- Windows PowerShell drops `--` when it runs npm's `keyshroud.ps1`, so `keyshroud run -- <cmd>`
  failed with the usage text there. Without `--`, the command now starts at the first argument that is
  not one of `run`'s own options.
- DPAPI on Windows waited only 30 seconds for PowerShell, which can take a minute to start on a slow
  or busy machine: creating a vault failed with "DPAPI could not protect the key", and opening one
  said it belonged to another Windows user. It now waits two minutes and says when PowerShell did not answer.

## [0.9.4] - 2026-11-11

### Fixed
- Several commands asking for the vault at once could open two dialogs or Touch ID sheets: one
  that found no dialog lock yet then removed the lock another had just taken. Only a stale lock that
  is still unchanged is removed now.

## [0.9.3] - 2026-11-11

### Changed
- Runs on Node.js 18.19 or newer (was 22.18), so the Node.js that Ubuntu 24.04 and Debian 13 install
  with apt is enough. CI runs the whole test suite against the built CLI on Node 18.19 and 20.
- The agent install guide (`keyshroud.dev/install.md`) says how to install Node.js on each OS, asking
  the user first, and how to install without sudo when `npm install -g` fails with `EACCES`.

## [0.9.2] - 2026-11-11

### Added
- `keyshroud migrate --to local [--yes]` moves off Vaultwarden: every Vaultwarden item a wired name
  uses is copied into the local vault, read back, and the names are rewired to it; the local vault then
  becomes the default for new items. Fields other than the password become items of their own. A dry run
  unless `--yes`; Vaultwarden keeps the originals, and the previous references are saved to
  `migrate-local-<time>.json` (references only, `0600`).

## [0.9.1] - 2026-11-11

### Added
- `keyshroud unlock --stdin` reads a passphrase vault's passphrase from stdin, for CI jobs and
  containers: copy the encrypted `vault.json` in and keep only the passphrase in the CI's secret store.
  It opens an existing vault only (a new passphrase is still chosen in a terminal), and its session
  ends after 30 minutes.

## [0.9.0] - 2026-11-11

### Added
- A Touch ID key for the local vault on Macs (`KEYSHROUD_VAULT_KEY=secure-enclave`). The vault key is
  wrapped to a P-256 key in the Mac's Secure Enclave and opens only after Touch ID (or the Mac's
  password); a session then lasts 30 minutes, as with a passphrase. The helper is built from
  `src/touchid.swift` on first use (needs the Xcode Command Line Tools). Hooks, `status` and `doctor`
  never ask; over SSH keyshroud says to run `keyshroud unlock` at the Mac.
- `keyshroud rekey [--to TYPE]`: a new key and vault id for the local vault, between keychain,
  secure-enclave, passphrase and dpapi. Terminal only; it always proves the current key afresh.
- `keyshroud list`: item references and the variables wired to them, names only.
- `keyshroud rm --item ITEM [--yes]`: deletes an item and unwires it. A dry run unless
  `--yes`; `--yes` needs a terminal, or Touch ID on a Mac. bw items only on keyshroud's own agent
  account (moved to the bw trash); the apiKeyHelper's item is refused.

### Changed
- Wiring (which variable points at which item) now lives in keyshroud's own
  `~/.config/keyshroud/env.json`. pi's and omp's `auth.json` are written only when that agent is
  installed (its `~/.pi/agent` or `~/.omp/agent` directory exists) or `--target` names it, so a
  machine without them no longer gets those directories. Names already in an `auth.json` keep
  working; `unwire` without `--target` clears a name from all three files.
- An unknown `KEYSHROUD_VAULT_KEY` value is now an error instead of being ignored.
- A second local unlock dialog waits for the one already open and uses its session.
- The Save dialog also warns against typing the Mac's password.

### Fixed
- Two processes asking at the same moment could both take the dialog lock (one read the lock file
  before the other had written to it) and show two dialogs.

### Note
- 0.8.x cannot read a Touch ID vault (format v2). Run `keyshroud rekey --to keychain` before
  downgrading.

## [0.8.0] - 2026-11-02

### Added
- A local encrypted vault, the default on a machine that has never used
  keyshroud with Vaultwarden. `~/.config/keyshroud/vault.json` is AES-256-GCM
  (item names included); its key is in the macOS keychain, the Linux Secret
  Service or Windows DPAPI, or is derived from a passphrase (scrypt) where none
  of these works (containers, servers, SSH, Linux without systemd's `busctl`).
  No account, no server and no `bw`: after `npm i -g keyshroud`, the first
  `keyshroud add` creates it.
- `local://Item` references (also `/notes` and `/id`) in env files, templates,
  `get` and `inject`. pi/omp auth.json entries are written as
  `!keyshroud get 'local://Item'`, which pi/omp can run without the extension.
- `--item local://Name` or `--item bw://Name` picks the vault for one item in
  `add`, `rotate`, `wire` and `api-key`; `import` writes `local://` references.
- `KEYSHROUD_BACKEND=local|bw` and the file `~/.config/keyshroud/backend`
  choose the default vault. `KEYSHROUD_VAULT_KEY=keychain|dpapi|passphrase`
  chooses how a new local vault keeps its key.
- Passphrase vaults: `keyshroud unlock` creates one in a terminal (typed twice,
  at least 12 characters) and opens 30-minute sessions. `lock` and the end of a
  session also close it for MCP servers and pi sessions that are already running:
  pi removes its values from its environment before the next tool or `!command`.

### Changed
- A machine that used keyshroud 0.7 keeps Vaultwarden as the default: a `bw`
  login, keyshroud's own files, `BW_SESSION`, `bw://` or `!bw` entries in
  auth.json, or the master password in the keychain decide it, and the choice
  is written to `~/.config/keyshroud/backend`. `setup` switches to Vaultwarden.
- `status`, `doctor`, `unlock`, `lock`, the MCP `vault_status` tool and the pi
  extension describe the local vault when it is the default, without starting `bw`.
- Messages show paths in your home directory as `~/…` (not on Windows).

### Fixed
- An error while parsing `bw` output no longer quotes that output, which can
  hold a secret.
- `keyshroud lock` on a machine with no vault says there is nothing to lock.
- On Windows, keyshroud no longer starts `security` or `secret-tool` by bare
  name, which Windows looks up in the current directory first.

## [0.7.6] - 2026-10-24

### Added
- On a Mac, when bw has lost the agent account's login and the master password
  is in the keychain, keyshroud asks for Touch ID (or the Mac's password) and
  logs back in by itself. `setup` remembers the account's email and server in
  `~/.config/keyshroud/account.json`, since bw forgets both on logout; `doctor`
  shows whether a relogin is possible.

### Fixed
- `doctor` no longer takes minutes when bw is logged out: it says so for each
  name instead of trying to resolve every one.

## [0.7.5] - 2026-10-20

### Fixed
- Any `bw` release works, including 2026.9 and later on Vaultwarden before
  1.37.4. Those `bw` releases save the login and then exit with
  `KeyIdBackfillError`; `setup` and the API-key login now go on when `bw` is
  logged in anyway. The first unlock after upgrading `bw` fails its data
  migration in the same way, so keyshroud tries once more. Tested with `bw`
  2024.12 to 2026.10 on Vaultwarden 1.37.3, and 2025.6 to 2026.10 on 1.37.4
  (Vaultwarden 1.37.4 refuses new items from older `bw` releases).
- `doctor` no longer tells you to stay on `bw` 2026.8.0, and the install
  commands no longer pin it.

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
