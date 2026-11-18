# Troubleshooting

Start with `keyshroud doctor`. It prints which vault is in use, whether it is open, every wired name
and whether it resolves, and the state of the Claude Code pieces. Names only, never a value.

```text
backend=local (/home/you/.config/keyshroud/backend says local)
local vault=~/.config/keyshroud/vault.json key=keychain status=unlocked items=12
/home/you/.config/keyshroud/env.json GH_TOKEN resolved=yes
redact index=present
apiKeyHelper wired=no
claude guard=off
```

A line that says `status=locked` or `resolved=no` is the place to look.

## A secret does not resolve

| Message | What it means | Fix |
|---|---|---|
| `Secret unresolved: NAME is not wired` (exit `4`) | No variable of that name points at a vault item | `keyshroud list` to see what is wired; `keyshroud add --env NAME --item "Item"` or `keyshroud wire --env NAME --item "Item"` |
| `Secret unresolved: NAME is outside this project's scope (…/.keyshroud.json)` (exit `4`) | A [project scope](project-scope.md) in this directory leaves that name out | Run the command where the name belongs, or widen the scope yourself: `keyshroud scope --only '…'`. An agent should ask you, not edit the file |
| `keyshroud: unresolved (names only): NAME` | A reference in a `--refs` file points at an item that does not exist here; the command still runs, without that variable | Check the item's name in `.env.refs` against `keyshroud list`; a teammate's vault may not have it yet |
| `keyshroud: unresolved (names only): NAME (The local vault is locked: …)` | The vault could not be opened, so the command ran without that variable | See the next section |
| `Secret unresolved: NAME (…)` from `run --only NAME` (exit `3` or `4`) | The name you asked for did not resolve, so the command was not run: `3` when the vault could not be unlocked, `4` otherwise | The reason is in the brackets; fix it and run the command again |
| `Ambiguous vault item name: NAME` (exit `4`) | Two items share that name | Rename one of them in the vault |
| `node: FILE: not found` (exit `9`) | The file was named with `--env-file`, and Node.js 20.6 or later read that flag itself before keyshroud started | Use `--refs FILE`, and check the path |

## The vault is locked

A keychain, Secret Service or DPAPI vault opens by itself. A passphrase or Touch ID vault, and
Vaultwarden, have sessions of 30 minutes:

- **In a terminal**, the command asks again.
- **From an agent on your desktop**, a dialog opens. If you cancel it, the command still starts, without
  the secrets, and keyshroud prints `unresolved (names only): NAME (Cancelled)`; with `--only NAME` it
  does not start, and exits `3`. No second dialog opens for 30 seconds, and the agent should not ask
  again by itself.
- **Over SSH or without a display**, no dialog can open: the same line says
  ``The local vault is locked: run `keyshroud unlock` in a terminal``. Do that, then run the command again.
  `No terminal and no dialog here (SSH or no display)` from `add` or `rotate` is the same situation:
  run it in a terminal, or pipe the value with `--stdin`.
- **`keyshroud status` exits `3`** while the vault is locked, which is handy in a script.
- **`The Linux keyring is locked`**: you are logged in over SSH without a desktop session. Unlock the
  keyring, or give that machine a passphrase vault: `keyshroud rekey --to passphrase`.
- **Windows over SSH, `Access is denied`**: a key-based SSH login carries no Windows password, so DPAPI
  refuses. Use the desktop or RDP session, or a passphrase vault.

## A value was printed unmasked

Check these in order:

1. **The command was run with `--no-mask`, or with keyshroud before 0.13 on a terminal.** `--no-mask`
   hands the terminal to the command and masks nothing. Before 0.13, `keyshroud run` masked only when
   its output was not a terminal, and Gemini CLI, Cline and other agents that run commands on a
   pseudo-terminal got the values as they were: update with `npm i -g keyshroud@latest`.
2. **The command failed, in Claude Code, and the guard is off.** Claude Code's hook cannot rewrite the
   output of a failed command. Run secret-using commands through `keyshroud run`, or turn on
   [the guard](claude-code.md#the-guard-failed-commands-masked-too): `keyshroud claude-guard`.
3. **The agent has no hook.** Only Claude Code and pi/omp mask commands you did not wrap. In Codex,
   Cursor, OpenCode and Gemini CLI, masking happens inside `keyshroud run`.
4. **The value is not in the vault.** keyshroud masks the values it holds. A key that lives only in a
   `.env` file is unknown to it: [move it](migrate-from-dotenv.md).
5. **The value was changed on the way out.** Masking is exact-match: a part of the value, base64 or
   another encoding of it is not recognised. Values shorter than 6 characters are never masked.
6. **You rotated it.** After `keyshroud rotate`, the old value is no longer known; see
   [rotate a key](rotate-a-key.md).

If none of these fit, that is a bug worth reporting: see [SECURITY.md](../SECURITY.md).

## An interactive program gets no terminal

`keyshroud run` masks what a command prints, so the command writes into a pipe. A program that wants
the terminal itself (`psql`, `ssh`, an editor, an agent's interface such as `claude`) then shows no
prompt, loses its colours, or says its output is not a terminal. Start it with `--no-mask`:

```bash
keyshroud run --no-mask -- psql
```

It gets the terminal, and nothing it prints is masked: this is for you, in your own terminal, never
for a command an agent runs.

## Claude Code

- **Nothing happens after installing or updating the plugin.** Hooks load when a session starts:
  restart Claude Code. The hooks call the `keyshroud` on your `PATH`, so `keyshroud --version` in a
  terminal tells you which version they run.
- **The agent does not know my secrets' names.** The SessionStart hook lists the wired names that are
  in scope for the directory the session started in. `keyshroud env` shows the same list.
- **With the guard on, a command exits `126` without running.** The guard could not start its masking
  process or read Claude Code's settings, and it does not run a command it cannot mask. The message
  says which. `keyshroud claude-guard --off` turns it off; sessions that are open keep working.
- **The guard is on but old sessions are not masked.** It takes effect in sessions started after
  `keyshroud claude-guard`.

## Vaultwarden and Bitwarden

- **`bw login` prints `KeyIdBackfillError`.** `bw` 2026.9 and later call an endpoint that Vaultwarden
  added in 1.37.4. The login is saved anyway; update Vaultwarden to make the error go away.
- **A copied `bw` data directory logged the original out.** A copy shares one refresh token with the
  original, and the server accepts each token once. Do not copy that directory between machines: sign
  in on each one with `keyshroud setup --registered`.
- More in [Vaultwarden or Bitwarden](vaultwarden.md).

## Team secret managers

Exit `3` from a `vault://`, `op://`, `awssecrets://` or similar reference means the source did not
accept the sign-in: the token expired, or the vendor CLI is logged out. `keyshroud source` lists what
is set up and which CLIs it found; sign in the way you normally do (`op signin`, `aws sso login`,
`gcloud auth login`, `az login`) and run the command again. Details per source:
[team secret managers](team-secret-managers.md).

## Still stuck

Open an issue at <https://github.com/dinhkarate/keyshroud/issues> with the output of
`keyshroud doctor` and `keyshroud --version`. Both print names only, so they are safe to paste.
