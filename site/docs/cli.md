# CLI reference

```text
keyshroud get <ENV_NAME | keyshroud://ref | bw://ref | source ref>   print one value (for scripts; not for agents)
keyshroud run [--refs F]... [--only A,B] [--no-auth] [--mask|--no-mask] -- <cmd>
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
keyshroud migrate [--item NAME]... [--refs F]... [--yes]                                        (Vaultwarden)
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
[source reference](team-secret-managers.md) such as `vault://secret/app#password`.

`rm` prints what it would do (delete a local item permanently, or move a bw item to the bw trash, and
which variables it unwires) until you add `--yes`. With `--yes` it needs a terminal, or
a Touch ID approval on a Mac when an agent runs it. It works on bw only with keyshroud's own agent
account, and refuses the item Claude Code's apiKeyHelper uses. `.env.refs` files that point at a
removed item then fail as unresolved.

`run` masks output whenever stdout is not a terminal (agents, CI, pipes) and
passes the TTY through untouched for interactive use. Force either way with
`--mask` / `--no-mask`. `exec` is an alias of `run`.

A wired name that does not resolve is left out and named on stderr (`unresolved (names only): …`), and
the command still runs. A name you ask for with `--only` is one the command needs: when it does not
resolve, the command is not run, and `run` exits `3` (the vault could not be unlocked) or `4`.
`secrets_run` with `only` does the same.

`--refs F` adds the names in a file of references (a `.env.refs`); give it more than once for several
files. Before 0.12.3 the flag was `--env-file`. That spelling still works, so scripts keep running,
but Node.js 20.6 and later reads a file named with `--env-file` itself, before keyshroud starts, and
keyshroud cannot check the file first: use `--refs`, above all with a file you did not write.

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
keyshroud run --refs .env.refs -- npm test
```

**Exit codes:** `0` ok · `2` usage · `3` vault locked or unavailable, or a source that did not accept
the sign-in · `4` secret missing or item name ambiguous · `5` refusing to overwrite existing state.
`run` exits with the child's code (or `3`/`4` before it starts, when a name given with `--only` does not resolve).

## References

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

## Configuration

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
