# Sync across machines: Vaultwarden or Bitwarden

Keep the secrets in Vaultwarden or Bitwarden instead to have them on several machines; `run`, the
hooks, the MCP server and everything else work the same, through the Bitwarden CLI.

**Get a vault** — pick one:

- **Self-host Vaultwarden** (free, your server): follow
  [examples/vaultwarden](https://github.com/dinhkarate/keyshroud/tree/main/examples/vaultwarden#readme) — Docker Compose + Caddy with automatic HTTPS,
  from an empty VPS to `keyshroud doctor`, plus backups and hardening.
- **Bitwarden cloud** (free account, no server): sign up at [bitwarden.com](https://bitwarden.com)
  and skip `bw config server` below (EU accounts: `bw config server https://vault.bitwarden.eu`).

```bash
npm install -g @bitwarden/cli

# 1. Point bw at your server and log in once
bw config server https://vault.example.com
bw login

# 2. Make it the default for new items (keyshroud:// items keep working)
mkdir -p ~/.config/keyshroud && echo bw > ~/.config/keyshroud/backend

# 3. Unlock for 30 minutes (asks for the master password, which is not stored)
keyshroud unlock

# 4. Check everything
keyshroud doctor
```

keyshroud picks the default once per machine and writes it to `~/.config/keyshroud/backend`:
Vaultwarden when it finds a `bw` login or anything keyshroud 0.7 left behind, so upgrades change
nothing; the local vault otherwise. `KEYSHROUD_BACKEND=local|bw` overrides it, and `keyshroud setup`
switches to Vaultwarden by itself. References name their vault, so `keyshroud://…` and `bw://…` items work
side by side, and `--item keyshroud://Name` or `--item bw://Name` picks one for a single item.

keyshroud never stores the master password unless you do. When Vaultwarden is locked
and a command needs a secret, it asks: a masked prompt in a terminal, a native dialog
on the desktop (so an agent's command waits for you), and over SSH it tells you to run
`keyshroud unlock`. A session ends after 30 minutes (`KEYSHROUD_SESSION_TTL_MS`): a timer
runs `bw lock`, so a copied session token stops working too. On a host nobody sits at,
`keyshroud unlock --unattended` asks once, in a terminal only, and opens a session without an end.

To unlock without being asked, store the master password in the OS keychain
(`security add-generic-password -a "$USER" -s vaultwarden-master-password -w`, or
`secret-tool store` on Linux; after `setup` the entry is `keyshroud-master-password`; see the
[vault setup guide](https://github.com/dinhkarate/keyshroud/tree/main/examples/vaultwarden#optional-unlock-without-being-asked)). Any program running
as you can then read it, agents included. Windows has no keychain support for it.

## Least privilege: a separate agent account

With the steps above, an unlocked session opens your whole Vaultwarden vault, and an agent that
runs `bw` as you can use it. `setup` gives keyshroud its own `bw` login on a dedicated
account instead, which holds only the secrets agents need:

```bash
keyshroud setup --email you+agent@example.com   # opens the signup page, then logs in with the
                                                 # new master password (asked, not stored);
                                                 # no `bw config server`: Bitwarden cloud
keyshroud migrate                                # dry run: which wired items would be copied
keyshroud migrate --yes                          # copy them; references keep working
```

- The agent login lives in `~/.config/keyshroud/bw` (`BITWARDENCLI_APPDATA_DIR`). Your own `bw`
  login is untouched. Its master password is not stored: keyshroud asks for it when a session
  ends and keeps only a scrypt hash, so `add` can refuse it as a secret.
- `migrate` copies the items that wired names (and any `--env-file` / `--item`) reference, with
  the same names, then locks your personal vault again. Originals stay where they are. It asks
  for your personal master password in a terminal (or reads the keychain entry `vaultwarden-master-password`).
- An agent can run `setup` too. Without a terminal it opens the signup page, where you pick the
  agent account's master password yourself (save it in your password manager); then the agent
  runs `setup --registered`, which asks for it in a dialog. The password never passes through
  anything the agent can read. `--confirm-unlock` and `--unattended` need a terminal.
- `--confirm-unlock` (macOS) stores the master password in the keychain entry
  `keyshroud-master-password` so that macOS asks you before every read, i.e. every unlock.
- If bw loses the login (a rejected refresh token logs it out), keyshroud on a Mac with the
  master password in the keychain asks for Touch ID and logs the agent account back in.
- `--unattended` (hosts nobody sits at, e.g. over `ssh -t`) logs in with a session without an
  end. Unlock it again with `keyshroud unlock --unattended`.
- Self-hosted Vaultwarden with `SIGNUPS_ALLOWED=false`: invite the address from the admin page
  (`/admin`), or allow signups for a minute, then pass `--registered` once the account exists.

## Moving back to the local vault

`keyshroud migrate --to local` shows which Vaultwarden items your wired
names use; `--yes` copies them into the local vault, checks each copy, rewires the names and makes the
local vault the default for new items. A field other than the password becomes an item of its own
(`Sentry (field dsn)`). Vaultwarden keeps the originals, the previous references are saved next to the
vault (names and references only), and `.env.refs` files keep their `bw://` references until you change
them. Other machines that use the same Vaultwarden are not affected.
