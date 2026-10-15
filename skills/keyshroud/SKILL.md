---
name: keyshroud
description: Use secrets (API keys, tokens, passwords) from the user's self-hosted Vaultwarden/Bitwarden without ever seeing their values. Use whenever a command needs a credential, the user mentions a token/API key/.env, asks to store or rotate a secret, or output might contain a secret.
---

# keyshroud

The user's secrets live in Vaultwarden. You work with **names and references**,
never values. keyshroud injects values into child processes and replaces them
in output with `<redacted:NAME>`.

## Rules

1. Never ask the user to paste a secret into the chat. To store one, run this
   yourself; it opens a hidden-input dialog on the user's desktop, and you only
   see `created … verified=yes`:
   ```bash
   keyshroud add --env STRIPE_API_KEY --item "Stripe API key" --notes "billing service"
   ```
   Tell the user a dialog is waiting for them, and ask for one secret at a time;
   if they cancel, do not ask again unprompted. Never ask for the vault master
   password. With the MCP server, call `secrets_request` instead. Over SSH or without a display there is no dialog:
   then give the user the command to run in their own terminal.
2. Never print, echo, `cat`, base64, or otherwise transform a secret value.
   `<redacted:NAME>` in output means the secret was used correctly. Do not try
   to recover it.
3. Never write a secret value into a file. Write a reference instead.
4. Run **every** command that uses a secret through `keyshroud run` (or the
   `secrets_run` MCP tool). Plain shell commands are only masked when they
   succeed; `keyshroud run` masks even when the command fails.
5. Never run `keyshroud get`, `keyshroud env --shell`, `keyshroud inject`
   without `-o`, or `bw` directly — they print values.

## See what exists

```bash
keyshroud env            # wired names only
keyshroud doctor         # vault, keychain, and wiring state (no values)
```
MCP: `secrets_list`, `vault_status`.

## Run a command that needs a secret

```bash
keyshroud run -- gh pr list                       # all wired secrets as env vars
keyshroud run --only GH_TOKEN -- gh pr list       # least privilege
keyshroud run --env-file .env.refs -- npm test    # project references
```
Inside the command, refer to `$GH_TOKEN`; keyshroud resolves it. Output is
masked automatically when not attached to a terminal. MCP: `secrets_run`.

## References (safe to commit)

```
bw://<item>                 login password
bw://<item>/username        also: notes, totp, uri, id
bw://<item>/fields/<name>   custom field
```
Percent-encode `/` in item names (`bw://a%2Fb`). A project's `.env.refs`:
```dotenv
DATABASE_URL=bw://Prod DB/fields/url
GH_TOKEN=bw://GitHub CLI token
LOG_LEVEL=debug
```

Config files that cannot read env vars: `keyshroud inject -i config.tpl -o config`
renders `{{ bw://item/field }}` placeholders into a 0600 file. Add the output to
`.gitignore`.

## Before committing

```bash
keyshroud scan .          # exits 1 and lists file:line NAME for any leaked value
```

## Exit codes

`0` ok · `2` usage · `3` vault locked/unavailable (ask the user to run
`keyshroud unlock`) · `4` secret missing or item name ambiguous · `5` would
overwrite existing state.

`setup` and `migrate` are for the user: they touch the personal vault. If an item
is missing after `setup`, ask the user to run `keyshroud migrate --item "NAME"`.
