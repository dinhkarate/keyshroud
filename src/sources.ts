// Sources: the secret managers a team already runs. keyshroud reads single values from them by
// reference (grammar in refs.ts) and never writes there. This file is the protocol side: HTTP
// for HashiCorp Vault / OpenBao and Infisical, and the command each of the others is read with
// (the vendor's own CLI, signed in the way that CLI is). core.ts holds the rest: the settings
// file, the credentials (kept in keyshroud's own vault) and the cache.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { SecretRef } from "./refs.ts";

// `token`, `secretId` and `clientSecret` are references into keyshroud's own vault, never values.
export interface VaultSource { addr: string; namespace?: string; caFile?: string; token?: string; roleId?: string; secretId?: string }
export interface InfisicalSource { addr: string; caFile?: string; clientId: string; clientSecret: string }
export interface Sources { vault?: VaultSource; infisical?: InfisicalSource }

// An address a credential may be sent to: https, or http on this machine alone (a dev server).
// A plain URL, with no user, query or fragment; a path (a server behind a prefix) is kept.
export function sourceAddress(text: string): string {
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`Not an address: ${text}`); }
  const here = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && here)) throw new Error("A source's address must be https:// (http:// only on this machine: localhost, 127.0.0.1, [::1])");
  if (url.username || url.password || url.search || url.hash) throw new Error("A source's address is a plain URL: no user, password, query or fragment");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

const TIMEOUT_MS = 10_000;
const MAX_ANSWER = 4 * 1024 * 1024;
interface Answer { status: number; json: unknown }

// One request, never a second: a redirect is an answer like any other (it is not followed, so a
// token goes only to the address the person gave).
function call(addr: string, path: string, opts: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: unknown; ca?: Buffer } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    // Checked again where it is used: the settings file is a file, and can be edited.
    const url = new URL(sourceAddress(addr) + path);
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers = { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) }), ...opts.headers };
    const fail = (reason: string) => reject(new Error(`${url.host}: ${reason}`));
    // The certificate is checked whatever NODE_TLS_REJECT_UNAUTHORIZED says.
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: opts.method ?? "GET", headers, rejectUnauthorized: true, ...(opts.ca ? { ca: opts.ca } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_ANSWER) req.destroy(new Error("the answer is too large")); else chunks.push(chunk); });
      res.on("end", () => {
        clearTimeout(timer);
        // An answer holds secrets, and a JSON.parse error quotes part of its input.
        let json: unknown = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        resolve({ status: res.statusCode ?? 0, json });
      });
      res.on("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); fail(error.code ?? error.message); });
    });
    const timer = setTimeout(() => req.destroy(new Error(`no answer within ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
    req.on("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); fail(error.code ?? error.message); });
    req.end(body);
  });
}

// What went wrong, by the status alone and in keyshroud's own words: nothing a server says is
// passed on (an answer may hold a secret, or repeat what it was sent). `status` stays on the
// error: 401 and 403 say a login's token is no longer taken.
const MEANS: Record<number, string> = { 400: "refused", 401: "the sign-in was not accepted", 403: "not allowed", 404: "not found", 429: "too many requests" };
function failure(what: string, answer: Answer): Error {
  if (answer.status >= 300 && answer.status < 400) return new Error(`${what}: the server answered with a redirect (HTTP ${answer.status}), which is not followed`);
  const means = MEANS[answer.status] ?? (answer.status >= 500 ? "the server failed" : "");
  return Object.assign(new Error(`${what}: HTTP ${answer.status}${means ? ` (${means})` : ""}`), { status: answer.status });
}

// One field of a secret that holds several: the named one, or the only one.
export function fieldOf(fields: Record<string, unknown>, key: string | null, what: string): string {
  const names = Object.keys(fields);
  const name = key ?? (names.length === 1 ? names[0] : null);
  if (name === null) throw new Error(`${what} holds ${names.length} fields (${names.slice(0, 12).join(", ")}): name one as ${what}#field`);
  const value = Object.hasOwn(fields, name) ? fields[name] : null;
  if (value === null || value === undefined) throw new Error(`${what} has no field ${name}`);
  return typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
}

// --- HashiCorp Vault and OpenBao (one API) ---------------------------------

function vaultHeaders(source: VaultSource, token?: string): Record<string, string> {
  return { "X-Vault-Request": "true", ...(source.namespace ? { "X-Vault-Namespace": source.namespace } : {}), ...(token ? { "X-Vault-Token": token } : {}) };
}
function urlPath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }

// AppRole login: the token it gives and for how long (seconds; 0: no end).
export async function vaultLogin(source: VaultSource, secretId: string, ca?: Buffer): Promise<{ token: string; ttl: number }> {
  const answer = await call(source.addr, "/v1/auth/approle/login", { method: "POST", headers: vaultHeaders(source), body: { role_id: source.roleId, secret_id: secretId }, ca });
  const auth = (answer.json as { auth?: { client_token?: unknown; lease_duration?: unknown } | null } | null)?.auth;
  if (answer.status !== 200 || typeof auth?.client_token !== "string") throw failure("AppRole login", answer);
  return { token: auth.client_token, ttl: typeof auth.lease_duration === "number" ? auth.lease_duration : 0 };
}

// Whether the server takes this token (`source add` says so). The answer holds the token itself.
export async function vaultCheck(source: VaultSource, token: string, ca?: Buffer): Promise<void> {
  const answer = await call(source.addr, "/v1/auth/token/lookup-self", { headers: vaultHeaders(source, token), ca });
  if (answer.status !== 200) throw failure("token", answer);
}

// The fields of one KV secret. The mount and its version are asked of the server, as the
// `vault kv` commands do: a mount of several segments, v1 and v2 all read as mount/path.
export async function vaultRead(source: VaultSource, token: string, path: string, ca?: Buffer): Promise<Record<string, unknown>> {
  const what = `vault://${path}`;
  if (path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`${what} is not <mount>/<path>`);
  const headers = vaultHeaders(source, token);
  const asked = await call(source.addr, `/v1/sys/internal/ui/mounts/${urlPath(path)}`, { headers, ca });
  const mount = (asked.json as { data?: { path?: unknown; type?: unknown; options?: { version?: unknown } | null } | null } | null)?.data;
  if (asked.status !== 200 || typeof mount?.path !== "string") throw failure(what, asked);
  // The mount is the start of the path that was asked about; any other answer is not gone by.
  if (!`${path}/`.startsWith(mount.path)) throw new Error(`${what}: the server named a mount that this path is not in`);
  if (mount.type !== "kv" && mount.type !== "generic") throw new Error(`${what}: ${mount.path} is not a KV mount`);
  if (path.length <= mount.path.length) throw new Error(`${what} names the mount ${mount.path}, not a secret in it`);
  const v2 = mount.options?.version === "2";
  const answer = await call(source.addr, `/v1/${urlPath(mount.path)}${v2 ? "data/" : ""}${urlPath(path.slice(mount.path.length))}`, { headers, ca });
  if (answer.status === 404) throw new Error(`${what}: no such secret`);
  const data = (answer.json as { data?: Record<string, unknown> | null } | null)?.data;
  const fields = v2 ? data?.data : data;
  if (answer.status !== 200 || !fields || typeof fields !== "object" || Array.isArray(fields)) throw failure(what, answer);
  return fields as Record<string, unknown>;
}

// --- Infisical -------------------------------------------------------------

// Universal Auth: a machine identity's client id and secret for an access token (seconds).
export async function infisicalLogin(source: InfisicalSource, clientSecret: string, ca?: Buffer): Promise<{ token: string; ttl: number }> {
  const answer = await call(source.addr, "/api/v1/auth/universal-auth/login", { method: "POST", body: { clientId: source.clientId, clientSecret }, ca });
  const body = answer.json as { accessToken?: unknown; expiresIn?: unknown } | null;
  if (answer.status !== 200 || typeof body?.accessToken !== "string") throw failure("Infisical login", answer);
  return { token: body.accessToken, ttl: typeof body.expiresIn === "number" ? body.expiresIn : 0 };
}

export async function infisicalRead(source: InfisicalSource, token: string, path: string, ca?: Buffer): Promise<string> {
  const what = `infisical://${path}`;
  const [project, environment, ...folders] = path.split("/");
  const name = folders.pop();
  if (!project || !environment || !name || name === "." || name === ".." || folders.some((part) => !part)) throw new Error(`${what} is not <project id>/<environment>/[<folder>/]<NAME>`);
  const query = new URLSearchParams({ projectId: project, environment, secretPath: `/${folders.join("/")}` });
  const answer = await call(source.addr, `/api/v4/secrets/${encodeURIComponent(name)}?${query}`, { headers: { Authorization: `Bearer ${token}` }, ca });
  const value = (answer.json as { secret?: { secretValue?: unknown } | null } | null)?.secret?.secretValue;
  if (answer.status !== 200 || typeof value !== "string") throw failure(what, answer);
  return value;
}

// --- Through the vendor's own CLI ------------------------------------------

export interface SourceCommand { command: string; args: string[]; value: (output: string) => string }

// A CLI's JSON answer, down to one text in it. The output holds the secret: an error never quotes it.
function inJson(output: string, what: string, ...path: string[]): string {
  let node: unknown = null;
  try { node = JSON.parse(output); } catch {}
  for (const name of path) node = node && typeof node === "object" ? (node as Record<string, unknown>)[name] : null;
  if (typeof node !== "string") throw new Error(`${what}: no text value in the answer (a binary secret?)`);
  return node;
}

// What a reference is read with. Every part of it that reaches the command line is first held
// to what the service allows in such a name, so none is taken for an option, or (the AWS CLI)
// for a file:// or http:// to load the argument from.
export function sourceCommand(ref: SecretRef): SourceCommand {
  const what = `${ref.scheme}://${ref.item}`;
  const params = ref.params ?? {};
  const bad = (shape: string): never => { throw new Error(`${what} is not ${shape}`); };
  const only = (...allowed: string[]) => { for (const name of Object.keys(params)) if (!allowed.includes(name)) throw new Error(`${what}: unknown parameter ${name}`); };
  const region = () => {
    if (params.region === undefined) return [];
    if (!/^[a-z0-9][a-z0-9-]*$/.test(params.region)) bad("in a region like eu-west-1");
    return ["--region", params.region];
  };
  switch (ref.scheme) {
    case "op":
      only();
      return { command: "op", args: ["read", "--no-newline", what], value: (output) => output };
    case "awssecrets":
      only("region");
      if (!/^[A-Za-z0-9/_+=.@:][A-Za-z0-9/_+=.@:-]*$/.test(ref.item) || ref.item.includes("://")) bad("a secret's name or ARN");
      return { command: "aws", args: ["secretsmanager", "get-secret-value", "--secret-id", ref.item, "--output", "json", ...region()], value: (output) => inJson(output, what, "SecretString") };
    case "awsssm":
      only("region");
      if (!/^[A-Za-z0-9/_.][A-Za-z0-9/_.-]*$/.test(ref.item)) bad("a parameter's name");
      return { command: "aws", args: ["ssm", "get-parameter", "--name", ref.item, "--with-decryption", "--output", "json", ...region()], value: (output) => inJson(output, what, "Parameter", "Value") };
    case "gcpsecrets": {
      only("version");
      const [project, secret, ...more] = ref.item.split("/");
      const version = params.version ?? "latest";
      if (more.length || !/^[a-z0-9][a-z0-9:.-]*$/i.test(project ?? "") || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(secret ?? "") || !/^(?:latest|\d+)$/.test(version)) bad("<project>/<secret>[?version=N]");
      // gcloud prints the payload as it is stored, and so it is passed on (a line break `echo` added included).
      return { command: "gcloud", args: ["secrets", "versions", "access", version, `--secret=${secret}`, `--project=${project}`], value: (output) => output };
    }
    case "azurekeyvault": {
      only();
      const [vault, secret, version, ...more] = ref.item.split("/");
      const name = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
      if (more.length || !name.test(vault ?? "") || !name.test(secret ?? "") || (version !== undefined && !/^[A-Za-z0-9]+$/.test(version))) bad("<vault name>/<secret>[/<version>]");
      return { command: "az", args: ["keyvault", "secret", "show", "--vault-name", vault, "--name", secret, ...(version ? ["--version", version] : []), "--output", "json"], value: (output) => inJson(output, what, "value") };
    }
    default: throw new Error(`${what} is not read through a command`);
  }
}

// Which kind of failure a CLI's message tells of. The message itself is another program's text
// and is not passed on.
export function cliFailure(command: string, said: string): string {
  if (/denied|forbidden|not authori[sz]ed|permission/i.test(said)) return `${command} was refused access`;
  if (/\bsign(?:ed)? ?in\b|\blog(?:ged)? ?in\b|reauth|expired|credentials|authenticat|unauthori[sz]ed|active account/i.test(said)) return `${command} is not signed in (or its sign-in has ended)`;
  if (/not[ _]?found|isn't an? |does(?: not|n't) exist|no such/i.test(said)) return `${command} found no such secret`;
  return `${command} failed`;
}

// The #key of a value that is a JSON object (how AWS and others keep several fields in one secret).
export function jsonField(text: string, key: string, what: string): string {
  let fields: unknown = null;
  try { fields = JSON.parse(text); } catch {}
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error(`${what} is not a JSON object, so it has no #${key}`);
  return fieldOf(fields as Record<string, unknown>, key, what);
}
