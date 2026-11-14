// The sources against the real thing. Each part runs only when its server is named
// (test/live-servers.sh starts them, as CI's `sources` job does; `npm test` alone skips all of it):
//   KEYSHROUD_LIVE_VAULT       dev-mode HashiCorp Vault and/or OpenBao addresses, comma-separated,
//                              with KEYSHROUD_LIVE_VAULT_TOKEN their dev root token
//   KEYSHROUD_LIVE_INFISICAL   a self-hosted Infisical: a fresh one is bootstrapped here, one that
//                              was already needs KEYSHROUD_LIVE_INFISICAL_TOKEN (its admin identity's)
//   KEYSHROUD_LIVE_AWS         an AWS emulator's endpoint (moto), read through the real `aws` CLI
// Every value here is made up.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runCli, sandbox, type Sandbox } from "./helpers.ts";

const VAULTS = (process.env.KEYSHROUD_LIVE_VAULT ?? "").split(",").filter(Boolean);
const ROOT = process.env.KEYSHROUD_LIVE_VAULT_TOKEN ?? "";
const INFISICAL = process.env.KEYSHROUD_LIVE_INFISICAL;
const AWS = process.env.KEYSHROUD_LIVE_AWS;
const blank = () => sandbox([], { blank: true });

async function api(addr: string, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<any> {
  const reply = await fetch(`${addr}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await reply.text();
  return text ? JSON.parse(text) : {};
}

// Masked output of a command that prints the named variables.
async function printed(box: Sandbox, file: string, names: string[], env: Record<string, string> = {}): Promise<string> {
  const run = await runCli(box, ["run", "--no-auth", "--env-file", file, "--", "sh", "-c", names.map((name) => `echo "${name}=$${name}"`).join("; ")], undefined, env);
  return run.stdout + run.stderr;
}

for (const addr of VAULTS) {
  test(`live ${addr}: KV v2 and v1, a mount of several segments, AppRole, what a token may not read, a namespace`, async () => {
    const vault = (method: string, path: string, body?: unknown) => api(addr, method, `/v1/${path}`, { "X-Vault-Token": ROOT }, body);
    const version = (await vault("GET", "sys/health")).version as string;
    const run = Date.now().toString(36);
    await vault("POST", `secret/data/ks-${run}/db`, { data: { username: "svc", password: "kv2-made-up-password-0001", port: 5432 } });
    await vault("POST", `secret/data/ks-${run}/single`, { data: { value: "kv2-made-up-single-0002" } });
    await vault("POST", `sys/mounts/ks1-${run}`, { type: "kv", options: { version: "1" } });
    await vault("POST", `ks1-${run}/legacy`, { token: "kv1-made-up-token-0003" });
    await vault("POST", `sys/mounts/team-${run}/kv`, { type: "kv", options: { version: "2" } });
    await vault("POST", `team-${run}/kv/data/with%20space/it`, { data: { k: "kv2-made-up-deep-0004" } });
    await vault("POST", `sys/policies/acl/ks-${run}`, { policy: `path "secret/data/ks-${run}/db" { capabilities = ["read"] }` });
    await vault("POST", "sys/auth/approle", { type: "approle" });
    await vault("POST", `auth/approle/role/ks-${run}`, { token_policies: `ks-${run}`, token_ttl: "20m" });
    const roleId = (await vault("GET", `auth/approle/role/ks-${run}/role-id`)).data.role_id as string;
    const secretId = (await vault("POST", `auth/approle/role/ks-${run}/secret-id`)).data.secret_id as string;

    // The token `vault login` leaves.
    const box = await blank();
    await writeFile(join(box.env.HOME, ".vault-token"), `${ROOT}\n`, { mode: 0o600 });
    const added = await runCli(box, ["source", "add", "vault", "--addr", addr]);
    assert.equal(added.stdout.trim(), `source=vault addr=${addr} verified=yes`, `${version}: ${added.stderr}`);
    const refs = join(box.dir, ".env.refs");
    await writeFile(refs, [
      `DB_PASSWORD=vault://secret/ks-${run}/db#password`, `DB_PORT=vault://secret/ks-${run}/db#port`, `ONLY=vault://secret/ks-${run}/single`,
      `LEGACY=vault://ks1-${run}/legacy#token`, `DEEP=vault://team-${run}/kv/with space/it#k`, `GONE=vault://secret/ks-${run}/nope#x`, `NO_MOUNT=vault://nowhere-${run}/x#y`,
    ].join("\n"));
    const out = await printed(box, refs, ["DB_PASSWORD", "DB_PORT", "ONLY", "LEGACY", "DEEP", "GONE", "NO_MOUNT"]);
    for (const name of ["DB_PASSWORD", "ONLY", "LEGACY", "DEEP"]) assert.ok(out.includes(`${name}=<redacted:${name}>`), `${version} ${name}: ${out}`);
    assert.ok(out.includes("DB_PORT=5432") && out.includes("GONE=\n") && out.includes("NO_MOUNT=\n"), out);
    assert.match(out, /unresolved \(names only\): GONE, NO_MOUNT/);
    assert.ok(!out.includes("made-up"), out);
    const got = await runCli(box, ["get", `vault://secret/ks-${run}/db#password`]);
    assert.equal(got.stdout, "kv2-made-up-password-0001");
    const several = await runCli(box, ["get", `vault://secret/ks-${run}/db`]);
    assert.equal(several.code, 4);
    assert.match(several.stderr, /holds 3 fields \(.*password.*\): name one as vault:\/\/secret\/ks-\w+\/db#field/);
    // The token itself is masked wherever a command prints it.
    const leak = await runCli(box, ["run", "--no-auth", "--env-file", refs, "--", "cat", join(box.env.HOME, ".vault-token")]);
    assert.equal(leak.stdout.trim(), "<redacted:VAULT_SOURCE_TOKEN>");

    // AppRole: the secret id is kept in the local vault; its token reads what its policy allows.
    const role = await blank();
    const withRole = await runCli(role, ["source", "add", "vault", "--addr", addr, "--role-id", roleId, "--stdin"], secretId);
    assert.equal(withRole.stdout.trim(), `source=vault addr=${addr} verified=yes`, withRole.stderr);
    assert.match((await runCli(role, ["source"])).stdout, new RegExp(`^vault addr=${addr} auth=approle role-id=${roleId} secret-id=keyshroud://Source vault secret id$`, "m"));
    assert.equal((await runCli(role, ["get", `vault://secret/ks-${run}/db#password`])).stdout, "kv2-made-up-password-0001");
    const denied = await runCli(role, ["get", `vault://secret/ks-${run}/single`]);
    assert.equal(denied.code, 4);
    assert.match(denied.stderr, /HTTP 403 \(not allowed\)/);
    assert.ok(!(denied.stdout + denied.stderr).includes(secretId));
    const wrong = await runCli(role, ["source", "add", "vault", "--addr", addr, "--role-id", roleId, "--stdin"], "not-the-secret-id");
    assert.equal(wrong.code, 3);
    assert.match(wrong.stdout, /verified=no \(AppRole login: HTTP 400 \(refused\)\)/);

    // A namespace, where the server has them (OpenBao; in HashiCorp Vault they are Enterprise).
    const made = await fetch(`${addr}/v1/sys/namespaces/ks-${run}`, { method: "POST", headers: { "X-Vault-Token": ROOT } });
    if (!made.ok) return;
    const inside = (method: string, path: string, body?: unknown) => api(addr, method, `/v1/${path}`, { "X-Vault-Token": ROOT, "X-Vault-Namespace": `ks-${run}` }, body);
    await inside("POST", "sys/mounts/apps", { type: "kv", options: { version: "2" } });
    await inside("POST", "apps/data/db", { data: { password: "ns-made-up-password-0010" } });
    const spaced = await blank();
    await writeFile(join(spaced.env.HOME, ".vault-token"), `${ROOT}\n`, { mode: 0o600 });
    const inSpace = await runCli(spaced, ["source", "add", "vault", "--addr", addr, "--namespace", `ks-${run}`]);
    assert.equal(inSpace.stdout.trim(), `source=vault addr=${addr} namespace=ks-${run} verified=yes`, `${version}: ${inSpace.stderr}`);
    assert.equal((await runCli(spaced, ["get", "vault://apps/db#password"])).stdout, "ns-made-up-password-0010");
    // The same path outside the namespace is another mount table.
    assert.equal((await runCli(box, ["get", "vault://apps/db#password"])).code, 4);
  });
}

test("live Infisical: a machine identity reads by project, environment and folder", { skip: !INFISICAL }, async () => {
  const addr = INFISICAL!;
  const admin = process.env.KEYSHROUD_LIVE_INFISICAL_TOKEN
    ?? (await api(addr, "POST", "/api/v1/admin/bootstrap", {}, { email: "admin@keyshroud.test", password: `made-up-${Date.now()}`, organization: "keyshroud-test" })).identity.credentials.token as string;
  const call = (method: string, path: string, body?: unknown) => api(addr, method, path, { Authorization: `Bearer ${admin}` }, body);
  const run = Date.now().toString(36);
  const project = (await call("POST", "/api/v1/projects", { projectName: `ks-${run}`, type: "secret-manager" })).project;
  await call("POST", "/api/v4/secrets/DB_PASSWORD", { projectId: project.id, environment: "dev", secretPath: "/", secretValue: "inf-made-up-password-0005" });
  await call("POST", "/api/v2/folders", { projectId: project.id, environment: "dev", name: "backend", path: "/" });
  await call("POST", "/api/v4/secrets/API_KEY", { projectId: project.id, environment: "dev", secretPath: "/backend", secretValue: "inf-made-up-apikey-0006" });
  const identity = (await call("POST", "/api/v1/identities", { name: `ks-${run}`, organizationId: project.orgId, role: "no-access" })).identity;
  const clientId = (await call("POST", `/api/v1/auth/universal-auth/identities/${identity.id}`, {})).identityUniversalAuth.clientId as string;
  const clientSecret = (await call("POST", `/api/v1/auth/universal-auth/identities/${identity.id}/client-secrets`, {})).clientSecret as string;
  await call("POST", `/api/v1/projects/${project.id}/memberships/identities/${identity.id}`, { roles: [{ role: "viewer" }] });

  const box = await blank();
  const added = await runCli(box, ["source", "add", "infisical", "--addr", addr, "--client-id", clientId, "--stdin"], clientSecret);
  assert.equal(added.stdout.trim(), `source=infisical addr=${addr} verified=yes`, added.stderr);
  const refs = join(box.dir, ".env.refs");
  await writeFile(refs, [`DB_PASSWORD=infisical://${project.id}/dev/DB_PASSWORD`, `API_KEY=infisical://${project.id}/dev/backend/API_KEY`, `GONE=infisical://${project.id}/dev/NOPE`, `OTHER_ENV=infisical://${project.id}/prod/DB_PASSWORD`].join("\n"));
  const out = await printed(box, refs, ["DB_PASSWORD", "API_KEY", "GONE", "OTHER_ENV"]);
  assert.ok(out.includes("DB_PASSWORD=<redacted:DB_PASSWORD>") && out.includes("API_KEY=<redacted:API_KEY>"), out);
  assert.match(out, /unresolved \(names only\): GONE, OTHER_ENV/);
  assert.ok(!out.includes("made-up") && !out.includes(clientSecret), out);
  assert.equal((await runCli(box, ["get", `infisical://${project.id}/dev/backend/API_KEY`])).stdout, "inf-made-up-apikey-0006");
  const wrong = await runCli(box, ["source", "add", "infisical", "--addr", addr, "--client-id", clientId, "--stdin"], "not-the-client-secret");
  assert.equal(wrong.code, 3);
  assert.match(wrong.stdout, /verified=no \(Infisical login: HTTP 401 \(the sign-in was not accepted\)\)/);
});

test("live AWS (an emulator, the real aws CLI): Secrets Manager with a JSON key, Parameter Store", { skip: !AWS }, async () => {
  const env = { AWS_ENDPOINT_URL: AWS!, AWS_ACCESS_KEY_ID: "made-up", AWS_SECRET_ACCESS_KEY: "made-up", AWS_DEFAULT_REGION: "us-east-1", PATH: process.env.PATH ?? "" };
  const aws = (...args: string[]) => promisify(execFile)("aws", args, { env });
  const run = Date.now().toString(36);
  await aws("secretsmanager", "create-secret", "--name", `ks/${run}/db`, "--secret-string", JSON.stringify({ username: "svc", password: "aws-made-up-password-0007" }));
  await aws("secretsmanager", "create-secret", "--name", `ks-${run}-plain`, "--secret-string", "aws-made-up-plain-0008", "--region", "eu-west-1");
  await aws("ssm", "put-parameter", "--name", `/ks/${run}/token`, "--type", "SecureString", "--value", "aws-made-up-param-0009");

  const box = await blank();
  const live = { ...env, PATH: `${box.env.PATH}:${env.PATH}` };
  const refs = join(box.dir, ".env.refs");
  await writeFile(refs, [`DB_PASSWORD=awssecrets://ks/${run}/db#password`, `PLAIN=awssecrets://ks-${run}-plain?region=eu-west-1`, `PARAM=awsssm:///ks/${run}/token`, `GONE=awssecrets://ks/${run}/nope`].join("\n"));
  const out = await printed(box, refs, ["DB_PASSWORD", "PLAIN", "PARAM", "GONE"], live);
  for (const name of ["DB_PASSWORD", "PLAIN", "PARAM"]) assert.ok(out.includes(`${name}=<redacted:${name}>`), `${name}: ${out}`);
  assert.match(out, /unresolved \(names only\): GONE \(aws found no such secret\)/);
  assert.ok(!out.includes("aws-made-up"), out);
  assert.equal((await runCli(box, ["get", `awsssm:///ks/${run}/token`], undefined, live)).stdout, "aws-made-up-param-0009");
});
