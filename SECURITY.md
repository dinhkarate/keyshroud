# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability
reporting: *Security → Report a vulnerability* on
[dinhkarate/keyshroud](https://github.com/dinhkarate/keyshroud/security/advisories/new).

Include the version (`keyshroud --version`), OS, agent (Claude Code, pi, omp,
MCP client) and a minimal reproduction. Never include real secret values; use
obviously fake ones.

We aim to acknowledge reports within 3 days and to ship a fix or mitigation for
confirmed issues within 14 days, crediting reporters who want credit.

## Supported versions

Only the latest minor release receives security fixes while the project is
pre-1.0.

## Scope

In scope: any path where a secret value reaches argv, logs, diagnostics, tool or
MCP results, hook output, the audit log, files with permissions wider than
`0600`, or the model's context despite redaction being enabled; auth.json
corruption; session token exposure.

Out of scope (documented limitations, see the README's *Security model*): an
agent deliberately exfiltrating a value it was given (for example over the
network, or after encoding it); secrets shorter than 6 characters; values the
user prints with `get` or `env --shell` on purpose.
