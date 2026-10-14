# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org/).

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
