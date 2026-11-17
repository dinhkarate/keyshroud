# FAQ

**Do I need Vaultwarden?** No. Secrets live in an encrypted file on your machine by default.
Vaultwarden (or the official Bitwarden cloud) is optional: use it to have the same secrets on several
machines, or a copy on a server.

**Do secrets leave my machine?** Not with the local vault. With Vaultwarden or Bitwarden, only between
`bw` and your server; with a [source](team-secret-managers.md),
only from that server to your machine. keyshroud has no backend of its own and sends no telemetry; values go into the
environment of the command you run.

**I used keyshroud 0.7. What changes?** Nothing. A machine with a `bw` login, keyshroud's files, wired
`bw://` or `!bw` entries, `BW_SESSION`, or the master password in the keychain keeps Vaultwarden as the
default and writes that down in `~/.config/keyshroud/backend`. Only a machine where none of these exist
looks new and gets the local vault; set `KEYSHROUD_BACKEND=bw` there if it should not.

**How do I leave Vaultwarden?** `keyshroud migrate --to local`: see
[moving back to the local vault](vaultwarden.md#moving-back-to-the-local-vault).

**How do I back up the local vault?** `keyshroud backup` writes one file sealed under a passphrase you
choose, and `keyshroud restore FILE --yes` brings its items and their wiring back on any machine
([Backup and restore](local-vault.md#backup-and-restore)). A plain copy of `vault.json` is not a backup: it opens only
with its key, which stays in this machine's key store. For the same secrets on several machines at
once, use Vaultwarden or Bitwarden.

**Can a project get only its own secrets?** Yes: `keyshroud scope --only 'STRIPE_*,GH_TOKEN'` in the
repo writes a `.keyshroud.json` that narrows `run`, `env` and what the agents are told there to those
names ([Least privilege: a project's own names](project-scope.md)).

**We use HashiCorp Vault (or AWS, 1Password, …) at work. Do I have to move the secrets?** No.
keyshroud reads them where they are: see [team secret managers](team-secret-managers.md).
It never writes to those systems, and what your account may read there is still decided by their policies.

**Can I use it in CI or a Docker build?** Yes, with a passphrase vault. Create it once in a terminal
(`KEYSHROUD_VAULT_KEY=passphrase keyshroud unlock`), add the secrets, and copy `vault.json` into the job
(it is encrypted, so it can live in the repository or an artifact). Keep only the passphrase in the CI's
secret store, then:

```bash
mkdir -p ~/.config/keyshroud && cp vault.json ~/.config/keyshroud/
printf '%s' "$KEYSHROUD_PASSPHRASE" | keyshroud unlock --stdin   # a session of 30 minutes
keyshroud run --refs .env.refs -- npm test
```

`--stdin` only opens an existing passphrase vault; a new passphrase is always chosen in a terminal.
`KEYSHROUD_PASSPHRASE` is the name keyshroud knows the passphrase by: commands started by `run` do not
receive that variable, and its value is masked in their output. A
server you reach over SSH can instead run `keyshroud unlock --unattended` there once (no time limit).
The whole walk-through, with a GitHub Actions job and a Dockerfile, is in [CI and Docker](ci-and-docker.md).

**Can the agent still use the key?** Yes. The command gets the real value; only the text
the model reads is masked.

**Is this a sandbox?** No. It stops *accidental* disclosure. A hostile or prompt-injected
agent can still exfiltrate a value it can use — see the [security model](security.md).

**Doesn't Claude Code do this itself?** Partly, and differently. Claude Code can deny reads of
files such as `.env` (`permissions.deny`), strip credential-like variables from the processes it
starts (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`), and its sandbox can show a command a placeholder for a
credential and put the real value on requests to hosts you allow (`sandbox.credentials` with
`"mode": "mask"`: opt-in, for sandboxed Bash commands, and it needs the sandbox's TLS termination,
which Claude Code's documentation calls experimental). It has no secret store and does not rewrite
what a tool prints. keyshroud is the store, works the same across agents, covers secrets that are
not sent over HTTP (a database password, a signing key), and masks output. The two combine: the
sandbox for the credentials it can keep out of the shell, keyshroud for the rest. (As of Claude
Code's documentation on 2026-11-15.)

**Why not just `.gitignore` my `.env`?** That stops commits, not reads. Agents read `.env`
to debug, and whatever they read goes to the model provider.

**Does it work on Windows?** Yes, tested on Windows 10 with Node 22. The local vault keeps its key
with DPAPI, bound to your Windows account. `bw` and other npm CLIs (`.cmd` shims) run without a shell,
the unlock dialog is a small PowerShell window, and sessions end after 30 minutes like elsewhere. Files in
`%USERPROFILE%\.config\keyshroud` are protected by your profile's ACL (you, SYSTEM, Administrators), not
by `0600`. One gap: over an SSH session with a terminal (`ssh -t`), Windows ends the lock timer when the
SSH session closes, so that session ends on the next keyshroud call instead. There is no keychain support
for the Vaultwarden master password on Windows: keyshroud asks for it (`migrate` too, in a terminal;
it is not tested there). pi `auth.json` entries of the `!command` form and the `apiKeyHelper` that
`claude-setup` writes need `/bin/sh`: for those, run keyshroud and the agent inside WSL (Git Bash beside
a native Windows Node is not enough).
DPAPI may be refused over SSH with a key (`Access is denied`): such a login carries no Windows
password. keyshroud says so; run the command in the desktop or RDP session, or give a machine used only
over SSH a passphrase vault (`keyshroud rekey --to passphrase`).

**`bw login` prints `KeyIdBackfillError`?** `bw` 2026.9 and later call an endpoint that Vaultwarden
added in 1.37.4 ([vaultwarden#7750](https://github.com/dani-garcia/vaultwarden/issues/7750)). The login
is saved anyway (`bw status` says `locked`), and `keyshroud setup` and the API-key login carry on by
themselves. Update Vaultwarden to 1.37.4 or later to make the error go away.
