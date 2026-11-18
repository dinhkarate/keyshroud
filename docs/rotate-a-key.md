# Rotate a key that leaked

A key was pasted into a chat, printed by a command, or committed. Masking cannot take it back: the
copy that left is out. The fix is a new key. keyshroud makes that a one-line change, because every
config file, `.env.refs` and agent holds the name, not the value.

## 1. Find the copies first

Do this before you rotate. `scan` and `redact` look for the values the vault holds now, so once the
item has the new value they no longer recognise the old one.

```bash
keyshroud scan .                       # files in this project
keyshroud scan ~/logs ./dist debug.log # or any other paths
```

```text
debug.log:2 GH_TOKEN
1 leaked secret value(s) found
```

It prints file, line and name, never the value, and exits `1` when it finds something. Delete or
clean those files. For a log you want to keep:

```bash
keyshroud redact < debug.log > debug.clean.log
```

## 2. Make a new key at the provider

Revoke the old key where it was issued (GitHub, Stripe, your cloud console) and create a new one.
keyshroud cannot do this part: only the provider can make the old key stop working.

## 3. Store the new value

```bash
keyshroud rotate --item "GitHub token"
```

Type or paste it into the masked prompt. When an agent runs the command, a hidden-input dialog opens
on your desktop instead, so the value still never goes through the chat. Over SSH, pipe it:
`pbpaste | ssh host keyshroud rotate --item "GitHub token" --stdin`.

Not sure of the item's name? `keyshroud list` shows items and the variables wired to them, names only.

## 4. Nothing else to change

The name stays wired to the same item, so `keyshroud run`, `.env.refs` files, the MCP server and the
hooks use the new value from the next command on. Check it:

```bash
keyshroud run --only GH_TOKEN -- gh auth status
```

A process that was already running (a dev server, an agent started with `keyshroud run --no-mask -- claude`)
keeps the old value in its environment until you restart it.

## If it is in git history

`scan` reads the working tree, not old commits. A value that was committed is public the moment the
repository is, and rewriting history does not undo copies that were already cloned. Rotate first, then
clean the history if you want to (`git filter-repo`), in that order.

## Where the value lives elsewhere

- **Vaultwarden or Bitwarden**: `keyshroud rotate --item "bw://GitHub token"` writes the new value as
  the item's password there, and other machines get it on their next sync.
- **A team secret manager** (`vault://`, `op://`, `awssecrets://`, …): keyshroud only reads those.
  Rotate the secret in that system; keyshroud picks up the new value on the next read
  (a long-running process keeps what it read for up to an hour, see `KEYSHROUD_CACHE_TTL_MS` in the
  [CLI reference](cli.md#configuration)).
