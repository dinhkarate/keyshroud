# CI and Docker

A CI job or a Docker build has no keychain and nobody to type a passphrase. The pattern is the same
everywhere: an encrypted vault file travels with the job, and the CI's own secret store holds one
thing, the passphrase that opens it. The job's log shows `<redacted:NAME>` wherever a value is printed.

If your CI already injects secrets as environment variables and no agent runs there, you may not need
keyshroud in CI at all. This guide is for when you want one `.env.refs` to work on laptops and in CI
alike, or masked logs.

## 1. Create a vault for CI

On your machine, in a terminal. A directory of its own keeps it apart from your personal vault:

```bash
export KEYSHROUD_CONFIG_DIR=~/.config/keyshroud-ci
KEYSHROUD_VAULT_KEY=passphrase keyshroud unlock      # choose a passphrase: 12+ characters, typed twice
keyshroud add --env DEPLOY_TOKEN --item "ci DEPLOY_TOKEN"
keyshroud add --env NPM_TOKEN --item "ci NPM_TOKEN"
unset KEYSHROUD_CONFIG_DIR
```

Then put two things in place:

- **`vault.json`** from that directory goes into the repository (or an artifact). It is encrypted
  with AES-256-GCM under a key derived from the passphrase, item names included. Copy only that
  file, none of the others beside it:
  `mkdir -p ci && cp ~/.config/keyshroud-ci/vault.json ci/vault.json`
- **The passphrase** goes into the CI's secret store as `KEYSHROUD_PASSPHRASE`.

And a `.env.refs` in the repository that names the items:

```dotenv
DEPLOY_TOKEN=keyshroud://ci DEPLOY_TOKEN
NPM_TOKEN=keyshroud://ci NPM_TOKEN
```

To add or rotate a secret later, do it in that directory again and commit the new `vault.json`.

## 2. In the job

```bash
npm i -g keyshroud
mkdir -p ~/.config/keyshroud && cp ci/vault.json ~/.config/keyshroud/
printf '%s' "$KEYSHROUD_PASSPHRASE" | keyshroud unlock --stdin   # a session of 30 minutes
keyshroud run --env-file .env.refs -- npm run deploy
```

`unlock --stdin` only opens an existing passphrase vault; a new passphrase is always chosen in a
terminal. `keyshroud run` does not hand `KEYSHROUD_PASSPHRASE` on to the command it starts, and masks
its value in the output like any other secret.

### GitHub Actions

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 22 }
      - run: npm i -g keyshroud
      - name: Open the vault
        env:
          KEYSHROUD_PASSPHRASE: ${{ secrets.KEYSHROUD_PASSPHRASE }}
        run: |
          mkdir -p ~/.config/keyshroud && cp ci/vault.json ~/.config/keyshroud/
          printf '%s' "$KEYSHROUD_PASSPHRASE" | keyshroud unlock --stdin
      - run: keyshroud run --env-file .env.refs -- npm run deploy
```

Later steps in the same job use the open session; they do not need the passphrase again. A job that
runs longer than 30 minutes before it needs a secret unlocks again at that point, or sets
`KEYSHROUD_SESSION_TTL_MS` higher.

## Docker builds

Pass the passphrase as a BuildKit secret, so it is in no layer and no `docker history`, and open,
use and lock the vault inside one `RUN`:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim
RUN npm i -g keyshroud
WORKDIR /app
COPY . .
RUN --mount=type=secret,id=keyshroud_passphrase \
    mkdir -p ~/.config/keyshroud && cp ci/vault.json ~/.config/keyshroud/ && \
    keyshroud unlock --stdin < /run/secrets/keyshroud_passphrase && \
    keyshroud run --env-file .env.refs -- npm run build && \
    keyshroud lock
```

```bash
docker build --secret id=keyshroud_passphrase,env=KEYSHROUD_PASSPHRASE .
```

`keyshroud lock` at the end matters: an open session is a file beside the vault, and without the lock
it would be saved in that layer. A value your build writes into its own output (a bundled API key, a
generated config) is in the image regardless: keyshroud masks what is printed, not what is built.

## A container at run time

A container is a new machine: it has no keychain, so the vault there is a passphrase vault. Mount the
vault file, pass the passphrase the way your platform passes secrets, and start the service through
keyshroud:

```bash
printf '%s' "$KEYSHROUD_PASSPHRASE" | keyshroud unlock --stdin && exec keyshroud run --env-file .env.refs -- node server.js
```

## A server you reach over SSH

Create a passphrase vault there and run `keyshroud unlock --unattended` once in a terminal: that
session has no time limit, until `keyshroud lock`.

## Limits

- Anyone who has both `vault.json` and the passphrase has every secret in it. Keep a CI vault small:
  only what the jobs need, not a copy of your own vault.
- A fork's pull request does not get your CI secrets, so it cannot open the vault. That is what you want.
- These steps are checked on Linux (a GitHub-style job and a real `docker build`). They are not
  tested on Windows runners.
