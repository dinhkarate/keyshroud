#!/bin/sh
# Starts the shell the demo is recorded in: a new machine with a fresh HOME,
# keyshroud from this checkout, and test/fixtures on PATH, so the fake
# `security` keeps the vault key out of the real keychain. No real secrets.
repo=$(cd "$(dirname "$0")/../.." && pwd)
home=$(mktemp -d)
mkdir -p "$home/bin" "$home/keychain" "$home/app"
printf '#!/bin/sh\nexec node "%s/src/cli.ts" "$@"\n' "$repo" > "$home/bin/keyshroud"
chmod +x "$home/bin/keyshroud"
cd "$home/app" || exit 1
exec env -i HOME="$home" USER=demo TERM="${TERM:-xterm-256color}" LANG=en_US.UTF-8 \
  PATH="$home/bin:$repo/test/fixtures:$(dirname "$(command -v node)"):/usr/bin:/bin" \
  FAKE_KEYCHAIN_DIR="$home/keychain" PS1='$ ' \
  bash --noprofile --norc
