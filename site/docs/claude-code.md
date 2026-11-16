# Claude Code

Install the CLI, then the plugin (redaction hooks + skill):

```bash
npm install -g keyshroud
```
```text
/plugin marketplace add dinhkarate/keyshroud
/plugin install keyshroud@keyshroud
```

What you get:

- **SessionStart hook** — refreshes the redaction index and tells Claude which
  secret *names* exist. It never asks for a master password or passphrase: with a
  locked vault it tells Claude to ask you to run `keyshroud unlock`.
- **PostToolUse hook** — rewrites any successful tool result that contains a
  wired value or the vault session token to `<redacted:NAME>` using Claude
  Code's `updatedToolOutput` (tested with Claude Code 2.1.296).
  **Limit:** when a command fails, Claude Code fires `PostToolUseFailure`, which
  cannot rewrite output. The skill and session context therefore tell Claude to
  run every secret-using command through `keyshroud run`, which masks inside
  the process regardless of the exit code; the guard below covers the commands
  that are not run that way.
- **Skill** — teaches Claude to use names and references, never values.

Claude uses the CLI from its Bash tool, so the plugin adds no MCP server (since
0.6.1). To add one anyway: `claude mcp add keyshroud -- keyshroud mcp`.

The plugin calls `keyshroud` from `PATH`. If Claude Code is launched from a GUI
that doesn't see your npm/nvm bin directory, run `keyshroud link-cli` (links it
into `~/.local/bin`) and make sure that directory is on the GUI's `PATH`.

To give Bash commands the secrets as env vars, start Claude through keyshroud:

```bash
keyshroud run -- claude
```

Use a vault item as Claude Code's own API key (`apiKeyHelper`):

```bash
keyshroud claude-setup --item "Anthropic API key" --ttl-ms 600000
```

It backs up `settings.json` first and refuses to replace an existing helper
without `--force`.

## The guard: failed commands masked too

```bash
keyshroud claude-guard          # on (macOS, Linux); takes effect in new Claude Code sessions
keyshroud claude-guard --off
```

With the guard on, Claude Code starts its shell through keyshroud (`CLAUDE_CODE_SHELL` in
`~/.claude/settings.json` points at a small launcher in `~/.config/keyshroud/guard/`). Each Bash
command runs in your real bash or zsh with the same arguments; what it prints passes through a
masking process on its way to Claude Code, so a wired value becomes `<redacted:NAME>` whether the
command succeeds, fails or is interrupted, and whether or not it was run through `keyshroud run`.
The exit status, the order of stdout and stderr, the working directory and background jobs behave as
before; a command costs about 0.2 s more.

**What it knows.** The guard knows values the way the hook does: from the fingerprint index, never
from the vault, so it never asks for anything and masks nothing before an index exists. It covers the
Bash tool; the `PostToolUse` hook stays on for the other tools.

**When it cannot mask, the command does not run.**

- If its pipes or the masking process cannot be started, the command is not run (exit 126, with the
  reason) rather than run unmasked.
- If the masking process stops while a command runs, the shell and what it started are told to end,
  and killed after two seconds. That is as good as the list of processes it can get: one that has cut
  itself loose from the shell is not found, and if the list cannot be had at that moment the guard
  stops what it knows of and says that the rest may still run (the list comes from `/proc` or the
  system's `ps`; a machine with neither runs nothing through the guard).
- If the settings cannot be read, the launcher does not take that for off: the command is not run.

**On and off.** The settings alone say whether the guard is on: a launcher looks there before each
command, so sessions that were started while it was on keep working after `--off` (their launcher then
only starts the shell), and mask again after `claude-guard`. `--off` restores what the setting was.
`--shell PATH` picks the bash or zsh it stands in for (default: the one Claude Code was set to use,
else your `$SHELL`). `keyshroud doctor` shows `claude guard=on|off`.

**Limit.** A value of several lines that is printed with a pause between its lines is masked by its
runs of 20 characters or more only.
