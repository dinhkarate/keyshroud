#!/bin/sh
# Starts the shell the Claude demos are recorded in: claude.tape, and with the
# argument "mcp", claude-mcp.tape. Like shell.sh it is a new machine: a fresh
# HOME, keyshroud from this checkout, and test/fixtures on PATH, so the vault
# key goes to a fake keychain. Off screen it also sets up:
# - three fake secrets in the local vault, wired by name as usual;
# - the "Acme API": a local mock (mock-api.mjs) that accepts only the fake
#   ACME_API_KEY, and ~/acme-app/scripts/smoke.sh, which calls it with curl -v;
# - Claude Code with its own config dir: the keyshroud plugin from this checkout
#   (with "mcp": no plugin, and mcp.json for --mcp-config), permission mode
#   dontAsk with an exact allowlist, and gate.mjs as a PreToolUse hook.
# Claude Code signs in through DEMO_API_KEY_HELPER, an apiKeyHelper command that
# prints an Anthropic API key. Claude Code runs it as a child process, so no key
# is ever in this shell; the script stops if one is. A key that is not scoped to
# a workspace also needs DEMO_ANTHROPIC_WORKSPACE_ID. The script also stops
# unless site/index.html quotes what this setup prints: the SessionStart text,
# the smoke test's masked output, the secrets_run result, the API's log line and
# the MCP entry. Everything lives in DEMO_DIR (default: a new temporary dir).
set -eu
mode=${1:-plugin}
case $mode in plugin|mcp) ;; *) echo "usage: $0 [plugin|mcp]" >&2; exit 2 ;; esac
fail() { echo "agent-shell.sh: $*" >&2; exit 1; }
[ -n "${DEMO_API_KEY_HELPER:-}" ] || fail "set DEMO_API_KEY_HELPER to a command that prints an Anthropic API key"
repo=$(cd "$(dirname "$0")/../.." && pwd)
root=${DEMO_DIR:-$(mktemp -d)}
mkdir -p "$root"
root=$(cd "$root" && pwd -P)
[ -z "$(ls -A "$root")" ] || fail "DEMO_DIR must be empty: $root"
home=$root/home
app=$home/acme-app
check=$root/check
claude=$(command -v claude) || fail "claude is not on PATH"
node=$(command -v node) || fail "node is not on PATH"
mkdir -p "$home/.local/bin" "$home/.claude" "$app/scripts" "$root/keychain" "$check"
ln -s "$claude" "$home/.local/bin/claude"
printf '#!/bin/sh\nexec "%s" "%s/src/cli.ts" "$@"\n' "$node" "$repo" > "$home/.local/bin/keyshroud"
chmod +x "$home/.local/bin/keyshroud"
path="$home/.local/bin:$repo/test/fixtures:$(dirname "$node"):/usr/bin:/bin"
# A login shell (Claude Code's Bash tool) puts the system's PATH first: put these back in front.
printf 'PATH="%s:$PATH"\n' "$path" > "$home/.bashrc"
printf '. ~/.bashrc\n' > "$home/.bash_profile"

# The Acme API, until this script exits.
"$node" "$repo/assets/demo/mock-api.mjs" "$home/acme-api.log" "$root/acme-api.port" $$ > "$root/mock-api.out" 2>&1 &
i=0
while [ ! -s "$root/acme-api.port" ]; do
  i=$((i + 1)); [ "$i" -le 50 ] || fail "the mock API did not start"; sleep 0.1
done
api=http://127.0.0.1:$(cat "$root/acme-api.port")

demo() {
  env -i HOME="$home" USER=demo LOGNAME=demo SHELL=/bin/bash LANG=en_US.UTF-8 TZ=UTC \
    TERM="${TERM:-xterm-256color}" COLORTERM=truecolor PATH="$path" \
    FAKE_KEYCHAIN_DIR="$root/keychain" KEYSHROUD_BACKEND=local \
    KEYSHROUD_CONFIG_DIR="$home/.config/keyshroud" PI_CODING_AGENT_DIR="$home/.omp/agent" \
    CLAUDE_CONFIG_DIR="$home/.claude" DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    ACME_API_URL="$api" PS1='$ ' "$@"
}

# Fake secrets. The vault key must reach the fake keychain, never the login keychain.
[ "$(demo sh -c 'command -v security')" = "$repo/test/fixtures/security" ] || fail "security is not the fake keychain"
add() {
  printf '%s' "$3" | demo keyshroud add --env "$1" --item "$2" --stdin > /dev/null 2>> "$root/add.err" || fail "keyshroud add --env $1 failed (see $root/add.err)"
}
add ACME_API_KEY "Acme API key" acme_DEMO_not_a_real_key_4f9c2e7a1b
add GH_TOKEN "GitHub token" ghp_DEMOdemo0123456789demo0123456789demo
add DATABASE_URL "Acme database" postgres://acme:DEMO_not_a_real_password@db.acme.test:5432/acme
for entry in "$root"/keychain/keyshroud-vault-*; do
  [ -f "$entry" ] || fail "no vault key in the fake keychain"
  case $entry in *.confirm) continue ;; esac
  [ "$(uname)" = Darwin ] || continue
  code=0; /usr/bin/security find-generic-password -s "$(basename "$entry")" > /dev/null 2>&1 || code=$?
  [ "$code" -eq 44 ] || fail "$(basename "$entry") is in the login keychain (security exit $code)"
done

cat > "$app/scripts/smoke.sh" <<'EOF'
#!/bin/sh
# Smoke test: does the Acme API still accept ACME_API_KEY?
curl -sv "$ACME_API_URL/v1/ping" -H "Authorization: Bearer $ACME_API_KEY" 2>&1 |
  grep -E '^(> Authorization|< HTTP|\{")' | tr -d '\r'
EOF
chmod +x "$app/scripts/smoke.sh"
printf '%s\n' '{ "mcpServers": { "keyshroud": { "command": "keyshroud", "args": ["mcp"] } } }' > "$check/mcp.json"
if [ "$mode" = mcp ]; then cp "$check/mcp.json" "$app/mcp.json"; fi

# Claude Code: onboarding done, this folder trusted, the classic (main-screen) renderer.
# The gate is copied into the demo's home so that no path of this machine is in a hook command.
cp "$repo/assets/demo/gate.mjs" "$home/.claude/gate.mjs"
version=$(demo claude --version < /dev/null | cut -d' ' -f1)
DEMO_MODE=$mode DEMO_REPO=$repo DEMO_APP=$app DEMO_HELPER=$DEMO_API_KEY_HELPER DEMO_VERSION=$version \
DEMO_WORKSPACE=${DEMO_ANTHROPIC_WORKSPACE_ID:-} "$node" - "$home/.claude" <<'EOF'
const fs = require("fs");
const { DEMO_MODE, DEMO_REPO, DEMO_APP, DEMO_HELPER, DEMO_VERSION, DEMO_WORKSPACE } = process.env;
const dir = process.argv[2];
const allow = DEMO_MODE === "mcp" ? ["mcp__keyshroud__secrets_run", "mcp__keyshroud__secrets_list", "mcp__keyshroud__vault_status"]
  : ["Bash(keyshroud env)", "Bash(keyshroud status)", "Bash(cat scripts/smoke.sh)", "Bash(cat ./scripts/smoke.sh)"];
if (DEMO_MODE === "plugin") {
  for (const only of ["", "--only ACME_API_KEY "]) for (const sh of ["", "sh ", "bash "])
    for (const script of ["scripts/smoke.sh", "./scripts/smoke.sh"]) for (const end of ["", " 2>&1"])
      allow.push(`Bash(keyshroud run ${only}-- ${sh}${script}${end})`);
}
const settings = {
  apiKeyHelper: DEMO_HELPER,
  env: {
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "3600000",
    ...(DEMO_WORKSPACE ? { ANTHROPIC_CUSTOM_HEADERS: `anthropic-workspace-id: ${DEMO_WORKSPACE}` } : {}),
  },
  tui: "default",
  spinnerTipsEnabled: false,
  // Claude Code 2.1 starts in auto mode and takes no dontAsk default while auto mode is available.
  permissions: { defaultMode: "dontAsk", disableAutoMode: "disable", allow },
  hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "node ~/.claude/gate.mjs" }] }] },
  ...(DEMO_MODE === "plugin" ? {
    extraKnownMarketplaces: { keyshroud: { source: { source: "directory", path: DEMO_REPO } } },
    enabledPlugins: { "keyshroud@keyshroud": true },
  } : {}),
};
const state = {
  hasCompletedOnboarding: true, lastOnboardingVersion: DEMO_VERSION, lastReleaseNotesSeen: DEMO_VERSION,
  lastClawdEntranceVersion: DEMO_VERSION, hasSeenAutoDefaultNotice: true, officialMarketplaceAutoInstallAttempted: true,
  theme: "dark", projects: { [DEMO_APP]: { hasTrustDialogAccepted: true } },
};
fs.writeFileSync(`${dir}/settings.json`, `${JSON.stringify(settings, null, 2)}\n`);
fs.writeFileSync(`${dir}/.claude.json`, `${JSON.stringify(state, null, 2)}\n`);
EOF

# What the site quotes must be what this setup prints, byte for byte.
printf '{}' | demo keyshroud hook claude session-start |
  "$node" -e 'let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => process.stdout.write(JSON.parse(s).hookSpecificOutput.additionalContext));' > "$check/session-start.txt"
(cd "$app" && demo keyshroud run -- scripts/smoke.sh < /dev/null) > "$check/smoke.txt"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent-shell","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"secrets_run","arguments":{"command":"./scripts/smoke.sh"}}}' |
  (cd "$app" && demo keyshroud mcp) |
  "$node" -e 'let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => { for (const line of s.split("\n")) { if (line && JSON.parse(line).id === 2) process.stdout.write(JSON.parse(line).result.content[0].text); } });' > "$check/secrets_run.txt"
tail -n 1 "$home/acme-api.log" > "$check/api-log.txt"
PAGE=$repo/site/index.html CHECK=$check "$node" - <<'EOF'
const fs = require("fs");
const { PAGE, CHECK } = process.env;
const decode = (html) => html.replace(/<[^>]*>/g, "").replace(/&(#\d+|lt|gt|amp|quot);/g, (_, e) =>
  e[0] === "#" ? String.fromCodePoint(Number(e.slice(1))) : { lt: "<", gt: ">", amp: "&", quot: '"' }[e]);
const quotes = [...fs.readFileSync(PAGE, "utf8").matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => decode(m[1]));
let failed = false;
for (const [label, file] of [["SessionStart text", "session-start.txt"], ["smoke test output", "smoke.txt"],
  ["secrets_run result", "secrets_run.txt"], ["API log line", "api-log.txt"], ["MCP entry", "mcp.json"]]) {
  const text = fs.readFileSync(`${CHECK}/${file}`, "utf8").replace(/\n$/, "");
  // A quote that ends in " …" quotes the start of the text.
  if (quotes.some((q) => q === text || (q.endsWith(" …") && text.startsWith(q.slice(0, -2))))) continue;
  console.error(`agent-shell.sh: site/index.html does not quote this ${label}:\n${text}\n`);
  failed = true;
}
process.exit(failed ? 1 : 0);
EOF
: > "$home/acme-api.log"

# The recorded shell holds no Anthropic key and no ANTHROPIC_ variable.
demo env > "$check/env.txt"
! grep -q 'sk-ant' "$check/env.txt" || fail "an Anthropic key is in the environment"
! grep -q '^ANTHROPIC_' "$check/env.txt" || fail "an ANTHROPIC_ variable is in the environment"
rm "$check/env.txt"

cd "$app"
demo bash --noprofile --norc
