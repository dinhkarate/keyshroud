# Team secret managers: Vault, OpenBao, Infisical, 1Password, AWS, Google Cloud, Azure

A company usually has a secret manager already. keyshroud reads from it and never writes there, so a
secret kept in HashiCorp Vault reaches a command the way a local one does: by name, with its value
masked in the output. These are *sources*: a reference says which secret, and nothing is copied into
keyshroud's vault.

```bash
# HashiCorp Vault or OpenBao: name the server once
keyshroud source add vault --addr https://vault.example.com    # reads with the token of `vault login`

# then wire a name to a secret there, or put the reference in .env.refs
keyshroud wire --env DB_PASSWORD --item 'vault://secret/myapp/db#password'
keyshroud run --only DB_PASSWORD -- ./migrate.sh
```

```dotenv
# .env.refs: safe to commit, names only
DB_PASSWORD=vault://secret/myapp/db#password
STRIPE_KEY=awssecrets://prod/stripe#api_key
SENTRY_DSN=op://Engineering/Sentry/dsn
```

| System | Reference | Signs in with | Tested against |
|---|---|---|---|
| HashiCorp Vault, OpenBao (KV v1 and v2) | `vault://<mount>/<path>#<field>` | `source add vault`: the token of `vault login`, a token, or AppRole | real servers in CI: Vault 2.2.2, OpenBao 2.7.2 (namespaces on OpenBao) |
| Infisical (cloud or self-hosted) | `infisical://<project id>/<environment>/[<folder>/]<NAME>` | `source add infisical`: a machine identity (Universal Auth) | a real self-hosted server in CI (0.167.10) |
| AWS Secrets Manager | `awssecrets://<name or ARN>[?region=R][#<json key>]` | your `aws` CLI | the real `aws` CLI against the moto emulator, in CI |
| AWS SSM Parameter Store | `awsssm://<parameter>[?region=R]` (`awsssm:///prod/db` is `/prod/db`) | your `aws` CLI | same |
| 1Password | `op://<vault>/<item>/[<section>/]<field>`, as 1Password writes it | your `op` CLI | a stand-in `op`: the command line from 1Password's documentation |
| Google Cloud Secret Manager | `gcpsecrets://<project>/<secret>[?version=N][#<json key>]` | your `gcloud` CLI | a stand-in `gcloud`, likewise |
| Azure Key Vault | `azurekeyvault://<vault name>/<secret>[/<version>][#<json key>]` | your `az` CLI | a stand-in `az`, likewise |

The last three have no open-source server to test against, so only the command keyshroud runs is
checked; tell us in an issue if one misbehaves on a real account.

**Vault and OpenBao.** `source add vault` takes `--addr` (or `VAULT_ADDR` / `BAO_ADDR` as it is set when
you run it), `--namespace` (`VAULT_NAMESPACE`) and `--ca-file` (`VAULT_CACERT`, a PEM file for a private
CA), checks that the server accepts the sign-in, and writes them to `~/.config/keyshroud/sources.json`.
Three ways to sign in:

- nothing more: the token `vault login` (or `bao login`) left in `~/.vault-token`, so OIDC, LDAP or
  whatever your team uses to log in keeps working and keyshroud stores no credential;
- `--token`: asks for a token (masked prompt, dialog or `--stdin`) and keeps it in keyshroud's vault as the item `Source vault token`;
- `--role-id ID`: AppRole, for machines and CI. Asks for the secret id, keeps it as the item
  `Source vault secret id`, and logs in at `auth/approle` when a secret is needed.

`#field` picks one field of the secret; without it, a secret with a single field gives that field, and
one with several is an error that lists the field names. The mount may be several segments deep
(`vault://team/kv/app#key`): keyshroud asks the server where the mount ends and whether it is KV v1 or v2,
and reads only KV mounts.

**Infisical.** `keyshroud source add infisical --client-id ID` (add `--addr` for a self-hosted server)
asks for the machine identity's client secret and keeps it as the item `Source infisical client secret`.
The project id is the one in the project's settings; `infisical://<id>/prod/STRIPE_KEY` is at the root
folder, `infisical://<id>/prod/payments/STRIPE_KEY` in `/payments`.

**1Password, AWS, Google Cloud, Azure.** Nothing to set up in keyshroud: it runs the vendor's CLI
(`op read`, `aws secretsmanager get-secret-value`, `aws ssm get-parameter --with-decryption`,
`gcloud secrets versions access`, `az keyvault secret show`) with the sign-in that CLI already has
(profile, SSO, service account, `OP_SERVICE_ACCOUNT_TOKEN`). `#key` picks one key of a secret that is a
JSON document. `keyshroud source` lists what is set up and which of these CLIs it found.

What holds for all of them:

- **Read-only.** `add`, `rotate` and `rm` refuse a source reference; keyshroud has no code that writes to a source.
- **A reference never names a server.** For Vault, OpenBao and Infisical the address comes from
  `source add`, so a `.env.refs` in a cloned repository cannot send your token somewhere else;
  `?address=…` and other parameters a reference does not know are refused. A vendor's CLI goes by its
  own configuration (profile, endpoint, proxy), of which a reference can pick only the AWS `?region=`.
- **HTTPS only** for Vault, OpenBao and Infisical, except `http://` on localhost for a dev server.
  The certificate is always checked (there is no option to skip it, and `NODE_TLS_REJECT_UNAUTHORIZED=0`
  does not reach it), and redirects are not followed.
- **Errors in keyshroud's own words.** What a server or a vendor's CLI says when it fails is not
  passed on (it could repeat a token or a secret): you get the HTTP status (`HTTP 403 (not allowed)`),
  or which kind of failure it was (`aws is not signed in`, `aws was refused access`,
  `aws found no such secret`). For the full message, run the vendor's CLI yourself in a terminal.
- **Credentials stay in keyshroud's vault** and are masked like any other value, as are the tokens a
  login returns (`<redacted:VAULT_SOURCE_TOKEN>`, `<redacted:INFISICAL_SOURCE_TOKEN>`).
- **Values are not stored**, only kept in memory by a long-running process (the pi extension, the MCP
  server) for at most `KEYSHROUD_CACHE_TTL_MS` (`0`: not at all), 256 references at a time. Each
  `keyshroud run` reads them again. A value is passed on as the source stores it, a line break at its
  end included (store with `echo -n`, or `printf`).
- `keyshroud source rm vault|infisical` forgets the server; the credential item stays until you `keyshroud rm` it.

Not built in yet: Doppler, Bitwarden Secrets Manager, CyberArk Conjur, Akeyless, Vault auth methods
other than token and AppRole, and Vault's dynamic secrets (database, AWS, PKI engines).
