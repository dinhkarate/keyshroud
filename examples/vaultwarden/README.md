# Self-host Vaultwarden for keyshroud

This folder runs [Vaultwarden](https://github.com/dani-garcia/vaultwarden), a lightweight
Bitwarden-compatible server, behind [Caddy](https://caddyserver.com) with automatic HTTPS.
It fits on a $5 VPS or a Raspberry Pi. Then it connects the Bitwarden CLI (`bw`) and keyshroud to it.

Don't want to run a server? A free [Bitwarden](https://bitwarden.com) cloud account works the
same way — skip to [step 3](#3-install-and-connect-the-cli).

## 1. Prerequisites

- A Linux host with Docker and Docker Compose, with ports **80 and 443** reachable from the internet
  (Caddy needs them to get a Let's Encrypt certificate).
- A DNS name pointing at the host, e.g. an `A` record `vault.example.com → 203.0.113.10`.
  The Bitwarden clients require HTTPS, so a bare IP will not work.

Vault only on a private network (Tailscale, WireGuard)? See [Private network](#private-network) below.

## 2. Run Vaultwarden

```bash
git clone --depth 1 https://github.com/dinhkarate/keyshroud
cp -r keyshroud/examples/vaultwarden ~/vaultwarden && cd ~/vaultwarden
cp .env.example .env
$EDITOR .env                     # VAULT_DOMAIN=vault.example.com
docker compose up -d
docker compose logs -f caddy     # wait for "certificate obtained successfully"
```

Open `https://vault.example.com`, click **Create account**, and pick a strong master password.

Then close sign-ups so nobody else can register:

```bash
sed -i 's/^SIGNUPS_ALLOWED=.*/SIGNUPS_ALLOWED=false/' .env
docker compose up -d
```

Optional, in the web vault:

- **Settings → Security → Two-step login** — turn it on. The CLI still works through the API key (step 4).
- Create a separate account (or an organization collection) just for agent secrets. keyshroud masks every
  login password in the vault it can see, and a smaller vault means a smaller blast radius.

## 3. Install and connect the CLI

On the machine where your agents run (your laptop, a dev box):

```bash
npm install -g @bitwarden/cli keyshroud
bw config server https://vault.example.com  # Bitwarden cloud: skip this (EU: https://vault.bitwarden.eu)
bw login                                    # once, interactively: email + master password (+ 2FA)
```

## 4. Unlock

By default keyshroud does not store the master password. When the vault is locked and a command needs a secret, it asks
for the master password (a masked prompt in a terminal, a native dialog on the desktop) and opens a
session that `bw lock` ends after 30 minutes. Over SSH, run it yourself:

```bash
keyshroud unlock                 # 30 minutes
ssh -t host keyshroud unlock --unattended   # a host nobody sits at: one session without an end
```

### Optional: unlock without being asked

Any program running as you, an agent included, can read what you store here, and with it open
the vault at any time. Prefer a separate agent account (`keyshroud setup`) if you do this; its
entries are named `keyshroud-master-password`, `keyshroud-api-client-id` and
`keyshroud-api-client-secret` instead of the `vaultwarden-…` names below.
Each command below prompts for the value; nothing lands in shell history. Windows has no keychain support.

```bash
# macOS
security add-generic-password -a "$USER" -s vaultwarden-master-password -w

# Linux (libsecret / GNOME Keyring)
secret-tool store --label=vaultwarden service vaultwarden-master-password account "$USER"
```

Also store the account's API key (web vault: **Settings → Security → Keys → View API key**) and
keyshroud logs `bw` back in by itself when the login expires.

```bash
# macOS
security add-generic-password -a "$USER" -s vaultwarden-api-client-id -w
security add-generic-password -a "$USER" -s vaultwarden-api-client-secret -w

# Linux
secret-tool store --label=vaultwarden service vaultwarden-api-client-id account "$USER"
secret-tool store --label=vaultwarden service vaultwarden-api-client-secret account "$USER"
```

A plaintext `~/.config/keyshroud/master-password` (mode `0600`) still works for old setups, but
anyone who can read that file can open your vault; `keyshroud unlock --unattended` replaces it.

## 5. Check it

```bash
keyshroud doctor
```

You want to see `session=unlocked`, and `master password=not stored` unless you stored it above.
Then store your first secret and use it:

```bash
keyshroud add --env GH_TOKEN --item "GitHub CLI token"   # masked prompt, never echoed
keyshroud run -- gh auth status
```

Next: connect your agent — see [Supported agents](../../README.md#supported-agents).

## Back it up

Everything lives in `vw-data/`. Back up `db.sqlite3` (use `sqlite3 vw-data/db.sqlite3 ".backup backup.sqlite3"`
for a consistent copy), `attachments/`, `sends/`, `rsa_key*` and `config.json`. Encrypt backups at rest
(`age`, `restic`) and keep one copy off the host.

## Private network

To keep the vault off the public internet, drop the `ports` from `caddy` (or bind them to your VPN
address) and give `bw` an HTTPS URL it trusts — for example a `tailscale cert` certificate, or an internal
CA installed on the machine running `bw`.

## Hardening checklist

- Pin image tags (`vaultwarden/server:1.x.y`, `caddy:2.x`) instead of `latest`, and update deliberately.
- Keep `SIGNUPS_ALLOWED=false` after creating your accounts.
- Leave the admin page disabled, or set `ADMIN_TOKEN` to an Argon2 hash (`docker compose exec vaultwarden /vaultwarden hash`).
- Keep `KEYSHROUD_CACHE_TTL_MS` short on shared machines and run `keyshroud lock` when you step away.
- Watch `~/.config/keyshroud/audit.jsonl` to see which secret names agents used (never values).
