# Least privilege: a project's own names

By default `keyshroud run` puts every wired secret into the command, so an agent working on one
project can use the tokens of all the others. A scope narrows that for a directory:

```bash
cd ~/code/shop
keyshroud scope --only 'STRIPE_*,GH_TOKEN'   # writes ./.keyshroud.json
keyshroud scope                              # what is in scope here, and how many names are not
```

```json
{ "only": ["STRIPE_*", "GH_TOKEN"] }
```

In that directory and below it (the nearest `.keyshroud.json` going up decides):

- `keyshroud run`, `secrets_run`, `env`, `env --shell` and pi/omp's shell get only the names in
  scope; `run` and `secrets_run` do not pass a wired name outside it on, not even from the
  environment the agent was started with.
- `run --only NAME`, `get NAME` and `secrets_run` with `only` refuse a name outside the scope, and
  say so.
- The names Claude Code is told at session start, and `secrets_list`, are the ones in scope.
- Masking is not narrowed: a value outside the scope that turns up in output is still masked (a
  name wired to a [team secret manager](team-secret-managers.md)
  from the moment its value has been read there: masking never contacts a source by itself).
- `secrets_run` takes the scope of the directory its command runs in (`cwd`; through a link, the
  directory it leads to), `secrets_list` the one of the directory the MCP server was started in.
- `add` and `wire` say when the name they just wired is outside the scope, so you can add it there.

The file holds names and patterns only (`*` stands for any run of characters), so it can be committed;
a teammate's machine applies it to whatever they have wired under those names. A file that cannot be
read as a scope (also a link to a file that is gone) puts nothing in scope and says why, instead of
falling back to everything or to a scope further up. References
(`--refs .env.refs`, `get keyshroud://Item`) are not narrowed: they already name what they want.
A scope is a default against accidents, not a wall: see the [security model](security.md).
