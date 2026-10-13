# Contributing

Thanks for helping! Small, focused pull requests are easiest to review.

## Setup

```bash
git clone https://github.com/dinhkarate/keyshroud.git
cd keyshroud
npm install
npm run check   # typecheck, tests, build
```

Tests run against a fake `bw` (`test/fixtures/bw`) and a fake keychain, so you
do not need a Vaultwarden account. Never use real secrets in tests or issues.

## Layout

| Path | Purpose |
|---|---|
| `src/core.ts` | Runtime-neutral core: session, vault snapshot, references, auth.json. Must not import agent APIs. |
| `src/refs.ts` | `bw://` reference grammar and env-file parser. |
| `src/redact.ts` | Plaintext and fingerprint-index redaction, streaming redactor. |
| `src/cli.ts` | CLI entry point. |
| `src/mcp.ts` | MCP stdio server. |
| `src/hooks.ts` | Claude Code hooks. |
| `extensions/pi/` | pi / omp extension (loaded as TypeScript by the host). |
| `skills/keyshroud/` | Agent skill (Claude Code plugin, skills.sh). |
| `.claude-plugin/`, `hooks/`, `.mcp.json` | Claude Code plugin + marketplace. |

## Rules

- TypeScript stays **erasable-only** (no enums, namespaces, parameter
  properties) so Node ≥ 22.18 runs `src/` directly.
- No runtime dependencies without discussion.
- Secret material travels through stdin or child-process environment variables,
  never command-line arguments, and never appears in output, errors, or tests'
  snapshots.
- Every behavior change needs a test. Bug fixes start with a failing test.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`,
  `fix:`, `docs:` …) and add a line to `CHANGELOG.md` under *Unreleased*.

## Releasing (maintainers)

1. Update `CHANGELOG.md` and bump `version` in `package.json` and
   `.claude-plugin/plugin.json`.
2. `npm run check && npm pack --dry-run` — review the file list.
3. Tag `vX.Y.Z` and push; the release workflow publishes to npm with provenance.
