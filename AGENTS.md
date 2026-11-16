# keyshroud repository

- Runtime-neutral core belongs in `src/core.ts` (plus `src/vault.ts`, `src/refs.ts`, `src/redact.ts`, `src/sources.ts`, and `src/guard.ts`, the shell guard, which may import only `brand.ts` and `redact.ts`); it must not import pi, omp, or Claude Code APIs.
- Product naming lives only in `src/brand.ts`, `package.json`, plugin manifests, and docs.
- Keep secret values out of logs, diagnostics, tool results, hook output, commit messages, and documentation examples.
- Never put Vaultwarden session tokens or credentials in git.
- Use stdin or child-process environment variables for secret material; never pass secrets in command arguments.
- Keep TypeScript erasable-only so Node.js `>=22.18.0` can run `src/` directly; the published CLI runs from compiled `dist/` and must keep working on the oldest Node in `engines` (18.19; CI checks it).
- No `Co-authored-by` trailer or "co-authored with" line for an AI in commits or PR descriptions; CI rejects them.
- Run `npm run check` (typecheck, tests against the fake `bw`, build) before committing.
- `site/docs/` is built from the public pages of `docs/`: after changing one, run `npm run site` and commit the result (the tests fail when it is stale). A new public page also needs its `!docs/<page>.md` line in `.gitignore`, a row in `scripts/build-site-docs.mjs` and a URL in `site/sitemap.xml`.
- Review `npm pack --dry-run` before `npm publish`.
