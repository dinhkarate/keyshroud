# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
