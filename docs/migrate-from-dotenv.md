# Move a project off `.env`

A `.env` file keeps the values where an agent can read them. This guide moves them into the vault and
leaves a `.env.refs` file of names and references that you can commit. It takes about five minutes
and nothing is written until you say so.

## 1. See what would move

```bash
cd my-project
keyshroud import
```

```text
import plan for .env (item prefix "my-project")
  STRIPE_KEY    secret    new      -> keyshroud://my-project STRIPE_KEY
  PORT          literal   kept
  DATABASE_URL  secret    new      -> keyshroud://my-project DATABASE_URL
2 secret(s): 2 new, 0 already in the vault, 0 conflict(s); 1 literal(s), 0 reference(s)
Dry run: nothing written. Re-run with --yes to create 2 item(s) and write .env.refs
```

`import` decides which lines are secrets by name (`*_TOKEN`, `*_KEY`, …) or by value (`sk-…`, a URL
with a password). The plan shows names only. If it got one wrong, `--only A,B` moves just those names
and `--skip A,B` leaves some where they are. `--from FILE` reads another file, `--prefix P` names the
vault items differently.

## 2. Move them

```bash
keyshroud import --yes
```

Each secret becomes one vault item, is read back to check it, and `.env.refs` is written with your
comments and non-secret lines kept:

```dotenv
STRIPE_KEY=keyshroud://my-project STRIPE_KEY
PORT=3000
# comment
DATABASE_URL=keyshroud://my-project DATABASE_URL
```

## 3. Run with the references

```bash
keyshroud run --env-file .env.refs -- npm test
keyshroud run --env-file .env.refs -- npm run dev
```

The command gets the real values. Whatever it prints is masked when the output goes to an agent, a
pipe or CI. If your `package.json` scripts load `.env` themselves (`dotenv`, `node --env-file=.env`),
remove that and let `keyshroud run` set the environment.

## 4. Delete the plaintext

`.env` still holds the values until you remove it. Check step 3 works first, then:

```bash
rm .env
keyshroud scan .          # any copy of a vault value left in the working tree?
git add .env.refs
```

`keyshroud import --yes --replace` does steps 2 and 4 in one go: it rewrites `.env` in place into
references, with no backup copy.

If `.env` was ever committed, the values are in the git history: treat them as leaked and
[rotate them](rotate-a-key.md).

## For your teammates

`.env.refs` names items, and each person's vault holds their own values. A teammate runs
`keyshroud add --env STRIPE_KEY --item "my-project STRIPE_KEY"` once per name, or you keep the shared
values in [Vaultwarden](vaultwarden.md) or in [the secret manager your team runs](team-secret-managers.md)
and write those references (`bw://…`, `vault://…`) into `.env.refs` instead.

## Good to know

- Multiline values, `${VAR}` expansion and duplicate keys are rejected with the line number, never the value.
- Running `import` again reuses items that already hold the same value and stops on one that differs.
- To give an agent in this project only this project's names, add a [project scope](project-scope.md):
  `keyshroud scope --only 'STRIPE_*,DATABASE_URL'`.
