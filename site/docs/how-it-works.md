# How it works

```
              ┌──────────────────────────── your machine ─────────────────────────────┐
              │  vault.json ◄── key: keychain · Secret Service · DPAPI · passphrase   │
              │      │                                                                │
              │      ▼                                                                │
 Vaultwarden ◄┼─bw─ keyshroud ─ resolves keyshroud:// and bw:// refs ─► command's env │
 (optional)   │      ▲                                                   │            │
              │      └──── redactor ◄──── stdout / stderr ◄──────────────┘            │
              │                │ <redacted:NAME>                                      │
              └────────────────┼──────────────────────────────────────────────────────┘
                               ▼
                  agent transcript / LLM provider
```

1. **Wiring.** A secret is wired by *name*: `GH_TOKEN → keyshroud://GitHub token` (or
   `bw://GitHub CLI token`). Wiring lives in `~/.config/keyshroud/env.json` and in project `.env.refs`
   files. When pi or omp is installed (`~/.pi/agent`, `~/.omp/agent` exists), a name is also
   written to its `auth.json`, where pi/omp run the `!keyshroud get '…'` entries on their own
   (`--target pi|omp|both` writes there in any case). keyshroud writes only names and references to
   these files, so what it wrote is safe to read. A key that you or pi put into `auth.json` as plain
   text is still there: keyshroud masks it in output like a vault value, but cannot take it out of
   the file. Every reference in these files is masked as well, whatever a command injects of it
   (a `bw://` one when the command has the bw vault open already: keyshroud does not unlock bw,
   renew its session or ask for one for a value nobody asked for). An entry that cannot be read
   is left out by itself.
2. **Unlock.** The local vault's key comes from the OS keychain, or from a passphrase session that
   ends after 30 minutes. Vaultwarden: keyshroud asks for the master password (or reads one you
   stored in the OS keychain); the session token is cached in `~/.config/keyshroud/session`
   (`0600`) and locked again after 30 minutes.
3. **Resolve.** `keyshroud://` references are read from the vault file; `bw://` references resolve
   from one `bw list items` snapshot held in memory for `KEYSHROUD_CACHE_TTL_MS` (default 1 h).
4. **Inject.** Values go into the child process environment — never into argv
   or tool results (`inject` writes `0600` files only when you ask it to).
5. **Redact.** In-process (`run`, MCP, pi/omp) output passes through a redactor
   that knows every wired value, the session token or vault key, and every value in
   the vault. Out-of-process Claude Code hooks use a keyed-HMAC
   fingerprint index (`redact-index.json`, `0600`) of wired values, values you
   printed with `get`, `inject` or `api-key`, and the session token or key only,
   so they never hold plaintext or fingerprint the rest of your vault.
