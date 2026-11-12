# Set up keyshroud (instructions for AI agents)

You are an AI coding agent. The user asked you to set up keyshroud: it lets you
run commands that need API keys while every secret value reaches you only as
`<redacted:NAME>`. Secrets live in an encrypted vault on the user's machine, or
in their own Vaultwarden or Bitwarden vault.

Work through the steps in order. Run the commands yourself unless a step says
the **user** must run it. Report each result in one line.

## Rules for the whole session

- Never ask the user to paste a secret, token, or password into the chat.
- Never handle a vault master password or passphrase. Never read one, or the
  local vault's key, from the keychain, and never put one in a command
  argument, file, or environment variable.
- Never run `keyshroud get`, `bw get`, `bw unlock`, or `bw list` yourself. They
  print values or unlock a vault outside keyshroud's masking.
- Never print, echo, or log a secret value. Use names (`GH_TOKEN`) and
  references (`keyshroud://GitHub token`) only.

## 1. Check prerequisites

```bash
node --version          # needs v18.19 or newer
npm --version
```

If both print a version and Node.js is 18.19 or newer, go on to step 2.

If `node` or `npm` is missing or too old, tell the user in one line and ask
before installing Node.js (it changes their system). Then use the usual way for
their OS:

| OS | Install Node.js |
|---|---|
| macOS | `brew install node`, or the installer from <https://nodejs.org> |
| Windows | `winget install OpenJS.NodeJS.LTS`, then open a new terminal |
| Linux (glibc: Debian, Ubuntu, Fedora, RHEL, Arch, …) | The official build in `~/.local`, below: no sudo, about 30 MB, and `npm install -g` needs no sudo either |
| Alpine | `sudo apk add nodejs npm` |

```bash
arch=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
v=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -o "node-v[0-9.]*-linux-$arch.tar.xz" | head -1)
mkdir -p ~/.local && curl -fsSL "https://nodejs.org/dist/latest-v24.x/$v" |
  tar -xJ -C ~/.local --strip-components=1 --wildcards "*/bin/*" "*/lib/*" "*/include/*" "*/share/*"
export PATH="$HOME/.local/bin:$PATH"   # new login shells add it themselves on most distros
node --version
```

The distro's packages also work (`sudo apt-get install -y nodejs npm`, `sudo dnf install -y nodejs npm`),
but Ubuntu's `npm` package pulls in hundreds of packages and can take more than five minutes: give
that command a long timeout, or a shell tool may kill it halfway and leave dpkg to repair with
`sudo dpkg --configure -a`.

If you cannot install it, tell the user what is missing and the command to run;
never stop without saying why.

## 2. Install the CLI

```bash
npm install -g keyshroud
keyshroud --version
keyshroud status
```

If `npm install -g` fails with `EACCES` (Linux, Node.js from the distro), install
it for this user instead of using sudo:

```bash
npm config set prefix ~/.local
npm install -g keyshroud
export PATH="$HOME/.local/bin:$PATH"   # new login shells add it themselves on most distros
```

`status` prints `backend=local …` on a machine that has never used keyshroud with
Vaultwarden: secrets go to the local vault, and there is nothing else to set up.
A line starting with `server=` means this machine already uses Vaultwarden or
Bitwarden; keep it that way.

## 3. Connect your agent

Pick the line for the agent you are running in:

| Agent | Do this |
|---|---|
| Claude Code | Ask the user to type `/plugin marketplace add dinhkarate/keyshroud`, then `/plugin install keyshroud@keyshroud`, then restart Claude Code. You cannot run slash commands yourself. |
| Codex, OpenCode | Copy the skill that comes with the CLI (below) |
| Gemini CLI | `npx skills add dinhkarate/keyshroud -g -a gemini-cli -y` |
| Cursor (agent) | `npx skills add dinhkarate/keyshroud -g -a cursor -y` |
| pi / omp | `pi install npm:keyshroud` (or `omp install npm:keyshroud`) |
| Claude Desktop, chat-only clients | Add the MCP JSON below to the client's settings (`~/Library/Application Support/Claude/claude_desktop_config.json` for Claude Desktop on macOS) |

The skill that comes with the CLI, for Codex and OpenCode (both read `~/.agents/skills`):

```bash
mkdir -p ~/.agents/skills && cp -R "$(npm root -g)/keyshroud/skills/keyshroud" ~/.agents/skills/
```

On Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$HOME\.agents\skills" | Out-Null
Copy-Item -Recurse -Force "$(npm root -g)\keyshroud\skills\keyshroud" "$HOME\.agents\skills\"
```

`npx skills` (the Gemini CLI and Cursor lines) needs Node.js 22.20 or newer. On an older Node,
copy the same folder into `~/.gemini/skills/` or `~/.cursor/skills/` instead.

If you can run shell commands, use the CLI (`keyshroud run`, `keyshroud add`): it needs no
tool schemas in your context. The MCP server is only for clients that cannot run commands:

```json
{ "mcpServers": { "keyshroud": { "command": "keyshroud", "args": ["mcp"] } } }
```

Merge it into an existing `mcpServers` object instead of replacing the file.
If you do use MCP from non-interactive `codex exec`, also allow the tool in `~/.codex/config.toml`:

```toml
[mcp_servers.keyshroud.tools.secrets_run]
approval_mode = "approve"
```

## 4. Where the secrets live

**The local vault (default).** The first `keyshroud add` creates it, with its key in the
macOS keychain, the Linux Secret Service or Windows DPAPI. Nothing to do now.

On a Linux machine without a desktop keyring (a server, a container, an SSH session) or
without systemd, the vault is protected by a passphrase instead, and `keyshroud add` from your shell exits with
code 3 and asks for `keyshroud unlock`. The **user** runs that in their own terminal: it
asks for a new passphrase twice and creates the vault. Never type or relay the passphrase.

On a Mac, the user can choose Touch ID instead of the keychain: they run
`KEYSHROUD_VAULT_KEY=secure-enclave keyshroud unlock` (or `keyshroud rekey --to secure-enclave` for an
existing vault) at the Mac and approve one Touch ID sheet. It needs the Xcode Command Line Tools once.
After that, a command that needs a secret shows a Touch ID sheet when no session is open; if an error
says the vault "opens with Touch ID at the Mac", ask the user to approve it or run `keyshroud unlock`.

**Several machines: Vaultwarden or Bitwarden.** Only if the user wants the same secrets on
several machines. These commands handle the master password, so the **user** runs them in
their own terminal window, not through you:

```bash
npm install -g @bitwarden/cli

# Self-hosted Vaultwarden only (skip for bitwarden.com; EU cloud: https://vault.bitwarden.eu)
bw config server https://vault.example.com

bw login

# New items go to Vaultwarden from now on (keyshroud:// items keep working)
mkdir -p ~/.config/keyshroud && echo bw > ~/.config/keyshroud/backend

# Unlock for 30 minutes (asks for the master password; keyshroud does not store it)
keyshroud unlock
```

No server yet? Point them to https://bitwarden.com (free account) or the self-hosting guide:
https://github.com/dinhkarate/keyshroud/tree/main/examples/vaultwarden#readme. Any `bw` release
from 2025.6 on works; with `bw` 2026.9 or later and Vaultwarden before 1.37.4, `bw login` prints
`KeyIdBackfillError` but saves the login.

Later, when a session has ended (Vaultwarden, or a passphrase or Touch ID vault), a command that needs a
secret opens a dialog or Touch ID sheet on the user's desktop and waits; over SSH it says to run `keyshroud unlock`.

Wait until the user says they are done.

## 5. Verify

```bash
keyshroud doctor
```

`doctor` prints names and status only. If it reports something missing, tell
the user which line failed and what to run. Do not try to fix a vault login
yourself.

## 6. Add and use secrets

- **Store a new secret:** run `keyshroud add --env NAME --item "Item name"`
  (or call the `secrets_request` MCP tool). Without a terminal it opens a
  hidden-input dialog on the user's desktop; the user pastes the value there.
- **Move an existing `.env` into the vault:** `keyshroud import` shows a dry
  run with names only; `keyshroud import --yes` stores the values and writes a
  commit-safe `.env.refs` file of `keyshroud://` (or `bw://`) references.
- **Run a command that needs secrets:** `keyshroud run -- <command>` (or the
  `secrets_run` MCP tool). Values are injected into the command's environment
  and masked as `<redacted:NAME>` in its output, even when it fails.
- **List what is available:** `keyshroud env` (names only) or `secrets_list`.

## 7. Finish

Tell the user, in two or three lines: which agent integration you installed,
where the secrets live (`keyshroud status`), what `doctor` reported, and that from
now on secret-using commands go through `keyshroud run`.

Docs: https://github.com/dinhkarate/keyshroud#readme · Security model:
https://github.com/dinhkarate/keyshroud#security-model
