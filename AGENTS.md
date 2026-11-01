# keyshroud repository

- Runtime-neutral core belongs in `src/core.ts` (plus `src/refs.ts`, `src/redact.ts`); it must not import pi, omp, or Claude Code APIs.
- Product naming lives only in `src/brand.ts`, `package.json`, plugin manifests, and docs.
- Keep secret values out of logs, diagnostics, tool results, hook output, commit messages, and documentation examples.
- Never put Vaultwarden session tokens or credentials in git.
- Use stdin or child-process environment variables for secret material; never pass secrets in command arguments.
- Keep TypeScript erasable-only so Node.js `>=22.18.0` can run `src/` directly; the published CLI runs from compiled `dist/`.
- No `Co-authored-by` trailer or "co-authored with" line for an AI in commits or PR descriptions; CI rejects them.
- Run `npm run check` (typecheck, tests against the fake `bw`, build) before committing.
- Review `npm pack --dry-run` before `npm publish`.
