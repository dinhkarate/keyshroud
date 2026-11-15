#!/bin/sh
# Starts the shell guard.tape and team.tape are recorded in. Like shell.sh it is a
# new machine: a fresh HOME, keyshroud from this checkout, and test/fixtures on
# PATH, so the vault key goes to a fake keychain. No real secrets. Off screen it
# also sets up:
# - three fake secrets in the local vault, wired by name as usual;
# - the "Acme API": a local mock (mock-api.mjs) that accepts only the fake
#   ACME_API_KEY on /v1/ping, and ~/acme-app/scripts/deploy.sh, which calls an
#   endpoint the mock refuses with curl -v, so it prints the header it sends and fails.
# With the argument "guard", the recorded shell is started through `keyshroud run`,
# the way Claude Code is (`keyshroud run -- claude`): its commands have the
# secrets in their environment.
# team.tape reads a real HashiCorp Vault dev server on localhost (the address
# is typed in the tape) whose KV mount secret/ holds myapp/db with a field
# "password"; test/live-servers.sh shows how one is started.
set -eu
mode=${1:-team}
case $mode in guard|team) ;; *) echo "usage: $0 [guard|team]" >&2; exit 2 ;; esac
fail() { echo "tour-shell.sh: $*" >&2; exit 1; }
repo=$(cd "$(dirname "$0")/../.." && pwd)
root=$(mktemp -d)
root=$(cd "$root" && pwd -P)
home=$root/home
app=$home/acme-app
node=$(command -v node) || fail "node is not on PATH"
mkdir -p "$home/bin" "$home/.claude" "$app/scripts" "$root/keychain"
printf '#!/bin/sh\nexec "%s" "%s/src/cli.ts" "$@"\n' "$node" "$repo" > "$home/bin/keyshroud"
chmod +x "$home/bin/keyshroud"
path="$home/bin:$repo/test/fixtures:$(dirname "$node"):/usr/bin:/bin"

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
    ACME_API_URL="$api" PS1='$ ' "$@"
}

[ "$(demo sh -c 'command -v security')" = "$repo/test/fixtures/security" ] || fail "security is not the fake keychain"
add() {
  printf '%s' "$3" | demo keyshroud add --env "$1" --item "$2" --stdin > /dev/null 2>> "$root/add.err" || fail "keyshroud add --env $1 failed (see $root/add.err)"
}
add ACME_API_KEY "Acme API key" acme_DEMO_not_a_real_key_4f9c2e7a1b
add GH_TOKEN "GitHub token" ghp_DEMOdemo0123456789demo0123456789demo
add STRIPE_KEY "Stripe key" sk_test_DEMOdemo0123456789demo0123

cat > "$app/scripts/deploy.sh" <<'EOF'
#!/bin/sh
# Deploy: the Acme API refuses this call, and curl -v prints the header it sent.
out=$(curl -sv --fail "$ACME_API_URL/v1/deploy" -H "Authorization: Bearer $ACME_API_KEY" 2>&1); code=$?
printf '%s\n' "$out" | grep -E '^(> Authorization|< HTTP|curl:)' | tr -d '\r'
exit $code
EOF
chmod +x "$app/scripts/deploy.sh"

cd "$app"
if [ "$mode" = guard ]; then
  # run does not pass a prompt string on: set it again for the shell it starts.
  demo keyshroud run --no-mask -- env PS1='$ ' bash --noprofile --norc
else
  demo bash --noprofile --norc
fi
