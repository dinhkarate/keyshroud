# The local vault

`~/.config/keyshroud/vault.json` holds every item, encrypted with AES-256-GCM under one random
256-bit key. Item names are encrypted too; the file is `0600`. Where the key lives depends on the machine:

| Machine | Key | Unlocking |
|---|---|---|
| macOS | login keychain, entry `keyshroud-vault-<id>` | none |
| macOS with `KEYSHROUD_VAULT_KEY=secure-enclave` (or `keyshroud rekey --to secure-enclave`) | wrapped to a key in the Mac's Secure Enclave | Touch ID (or the Mac's password) when a command needs a secret; a session ends after 30 minutes |
| Linux with a desktop keyring and systemd | Secret Service (`secret-tool`; found with `busctl`) | none |
| Windows | DPAPI, bound to your Windows account | none |
| Docker, servers, SSH with a locked keyring, Linux without systemd | derived from a passphrase (scrypt) | `keyshroud unlock`; a session ends after 30 minutes |

The key mode is chosen once, when the vault is created. To be asked for a passphrase on any machine,
create it with `KEYSHROUD_VAULT_KEY=passphrase keyshroud unlock` in a terminal (typed twice, at least
12 characters). When a session has ended, a command that needs a secret asks again: a masked prompt in
a terminal, a dialog on the desktop, and over SSH it tells you to run `keyshroud unlock`.

A Touch ID vault needs the Xcode Command Line Tools once (`xcode-select --install`): keyshroud builds
a small helper from `src/touchid.swift` on first use, which takes a few seconds. The sheet appears for
any caller that may ask (the CLI, `secrets_run`, Claude Code's apiKeyHelper); for this vault hooks,
`status` and `doctor` never ask (with Vaultwarden they renew a session from a stored master
password, which asks if you set that keychain entry to ask, and after bw has logged itself out they
log in again once you approve a Touch ID sheet), and over SSH it tells you to run `keyshroud unlock` at the Mac. `keyshroud rekey`
moves a vault between key types (a new key and vault id each time); run `rekey --to passphrase` before
moving to another Mac.

Nothing can recover a lost key or a forgotten passphrase, and the vault belongs to one machine:
`vault.json` copied elsewhere does not open without its key, which stays in this machine's key store.

## Backup and restore

```bash
keyshroud backup                           # asks for a new passphrase, writes ./keyshroud-backup-<date>.json
keyshroud restore keyshroud-backup-….json  # what it would add; --yes does it
```

`backup` (in a terminal) copies every item of the local vault into one file in the vault's own format,
sealed under a passphrase you choose now (at least 12 characters, typed twice), not under this
machine's key: it opens anywhere. It first proves the vault's current key the way `rekey` does (a
passphrase vault asks for its passphrase, a Touch ID vault for Touch ID; an open session is not enough),
never writes over a file that is there (`--out FILE` names another), and the file is `0600`. Keep it
somewhere that is not this machine. Nothing can recover its passphrase.

`restore FILE` (in a terminal) asks for that passphrase and prints a plan of names: items the local
vault lacks are added, items it holds with the same value are left alone, and an item that has another
value here is kept as it is unless you add `--replace`. Nothing changes until `--yes`. The variable an
item was stored for (`add --env NAME`) is wired to it again when nothing is wired under that name, so
on a new machine `keyshroud restore FILE --yes` is the whole move; the vault it creates there gets
that machine's own key. Items in Vaultwarden, the servers of the sources and their sign-ins are not
part of a backup. For the same secrets on several machines at once, use Vaultwarden or Bitwarden.
