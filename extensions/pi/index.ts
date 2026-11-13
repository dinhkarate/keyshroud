import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { BRAND } from "../../src/brand.ts";
import * as core from "../../src/core.ts";
import { StringDecoder } from "node:string_decoder";
import { createRedactFeed, createRedactor, redactDeep, type Redactor } from "../../src/redact.ts";
import { ENV_NAME_RE, isLoaderEnvName } from "../../src/refs.ts";
import { confirmInBorderedPopup, inputInBorderedPopup, selectInBorderedPopup } from "./ui/bordered-popups.ts";

export type UiContext = Pick<ExtensionContext, "ui">;
// UPPER_SNAKE_CASE, and not a variable that changes what programs load or run (PATH, NODE_OPTIONS, …).
function envNameOk(name: string): boolean { return ENV_NAME_RE.test(name) && !isLoaderEnvName(name); }
let currentEnv: Record<string, string> = {};
let redactor: Redactor = createRedactor({});
// Masked values outlive a lock that removes them from the environment.
let masked: Record<string, string> = {};
// What this extension set in process.env, kept per process: pi loads a fresh
// copy of this module on /reload, and process.env keeps what the last one set.
const own = ((globalThis as Record<symbol, unknown>)[Symbol.for(`${BRAND.bin}.pi.injected`)] ??= {}) as Record<string, string>;
// A passphrase vault's session can end (`lock`, or its time is up) while pi
// runs: its state when the environment was last built (null: not such a vault).
let sessionState: string | null = null;

// omp injects its own TypeBox (or zod) builder; pi resolves the peer dependency.
type Builder = { Object: (p: Record<string, unknown>) => TSchema; String: (o?: unknown) => TSchema };
async function getBuilder(pi: ExtensionAPI): Promise<Builder> {
  const injected = (pi as unknown as { typebox?: { Type?: Partial<Builder> } }).typebox?.Type;
  if (injected?.Object && injected?.String) return injected as Builder;
  const zod = (pi as unknown as { zod?: { object?: (p: Record<string, unknown>) => TSchema; string?: (o?: unknown) => TSchema } }).zod;
  if (zod?.object && zod?.string) return { Object: zod.object, String: zod.string };
  for (const spec of ["typebox", "@sinclair/typebox"]) {
    try {
      const mod = await import(spec) as { Type?: Builder };
      if (mod.Type?.Object) return mod.Type;
    } catch {}
  }
  throw new Error("No TypeBox-compatible schema builder available");
}
// Values pi was started with are left as they are.
function applyEnv(next: Record<string, string>): void {
  for (const key of Object.keys({ ...currentEnv, ...own })) if (!(key in next)) { delete process.env[key]; delete own[key]; }
  for (const [key, value] of Object.entries(next)) {
    if (process.env[key] === value && !(key in own)) continue;
    process.env[key] = value;
    own[key] = value;
  }
  currentEnv = next;
}

function mappedError(error: unknown): string { return error instanceof Error ? error.message : String(error); }

let refreshPromise: Promise<void> | null = null;
let refreshTimer: { unref(): void } | null = null;

// Extension load awaits the first refresh so `$VAR` provider keys resolve;
// later refreshes (resume/fork) run in the background and retry with backoff.
function refreshEnv(): Promise<void> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try { await core.ensureSession(); } catch { scheduleRetry(); }
      const next = await core.buildEnvMap(own);
      // A value masked once stays masked: a tool started before a rotation can still print the old one.
      // And a value is masked before the environment holds it, for a command that starts meanwhile.
      masked = core.withEarlierValues(await core.redactionValues(next), masked);
      redactor = createRedactor(masked);
      applyEnv(next);
      const local = await core.localStatus();
      sessionState = core.keyHasSessions(local.key) ? local.status : null;
    })().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

function scheduleRetry(delay = 5000): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshEnv().catch(() => scheduleRetry(Math.min(delay * 2, 60000)));
  }, delay);
  if (typeof refreshTimer === "object" && "unref" in refreshTimer) refreshTimer.unref();
}

// Values from a passphrase vault leave pi when its session ends, and come back
// once it is unlocked again. Reading the session never starts bw.
async function recheckSession(): Promise<void> {
  if (sessionState !== null && (await core.localStatus()).status !== sessionState) await refreshEnv();
}

async function hydratedEnv(): Promise<Record<string, string>> {
  await refreshEnv();
  return currentEnv;
}

// What the default backend is called in prompts and messages.
async function vaultLabel(): Promise<string> { return (await core.defaultBackend()) === "local" ? "the local vault" : "Vaultwarden"; }

async function report(): Promise<{ report: string; details: Record<string, unknown> }> {
  if ((await core.defaultBackend()) === "local") {
    const local = await core.localStatus();
    const names = Object.keys(await hydratedEnv());
    const report = `${BRAND.name}: local vault ${local.status} (${local.status === "none" ? "created by the first secret" : `${local.path}, key in ${local.key}`}) / items: ${local.items ?? "unknown"} / injected env (names only): ${names.length ? names.join(", ") : "none"} / redacting ${redactor.size} value(s) from tool output`;
    return { report, details: { backend: "local", status: local.status, key: local.key, items: local.items, injectedEnvNames: names, redactedValues: redactor.size } };
  }
  const status = await core.getStatus();
  const names = Object.keys(await hydratedEnv());
  const report = `${BRAND.name}: vault ${status.status} (bw ${status.version ?? "unknown"}) / server: ${status.serverUrl ?? "unknown"} / items: ${status.items ?? "unknown"} / injected env (names only): ${names.length ? names.join(", ") : "none"} / redacting ${redactor.size} value(s) from tool output`;
  return { report, details: { status: status.status, version: status.version, items: status.items, injectedEnvNames: names, redactedValues: redactor.size } };
}

async function writeBoth(name: string, itemName: string, overwrite = false): Promise<void> {
  const ref = core.referenceFor(itemName, await core.defaultBackend());
  const results = await Promise.all(core.wiringTargets(["omp", "pi"]).map((path) => core.writeAuthEntry(path, name, ref, { overwrite })));
  const failed = results.find((result) => !result.ok);
  if (failed) throw new Error(failed.message);
  // A Claude Code session on this machine reads the hook index, not this process.
  await core.refreshRedactIndex().catch(() => {});
}

async function addFlow(ctx: UiContext, envName: string, itemName: string, purpose: string): Promise<string> {
  if (!envNameOk(envName)) return "Invalid env_name; use UPPER_SNAKE_CASE.";
  try {
    await core.ensureSession();
    const secret = await inputInBorderedPopup(ctx, { title: `Paste secret for ${envName}`, prompt: "Value is not shown", mask: true });
    if (!secret) return "Cancelled.";
    const { created } = await core.createSecretItem({ itemName, secret, envName, notes: purpose });
    await core.audit("add", [envName], "pi");
    await writeBoth(envName, itemName);
    await refreshEnv();
    const verified = (await core.resolveShellValue(core.referenceFor(itemName, await core.defaultBackend()))) !== null;
    return `${created ? `${created}\n` : ""}created item=${itemName} env=${envName} verified=${verified ? "yes" : "no"}`;
  } catch (error) { return mappedError(error); }
}

async function chooseItem(ctx: UiContext, title: string): Promise<{ id: string; name: string } | null> {
  const label = await vaultLabel();
  const query = await inputInBorderedPopup(ctx, { title: `Search ${label}`, prompt: "Leave empty to list all items" });
  if (query === undefined) return null;
  const items = await core.findItems(query);
  if (!items.length) { ctx.ui.notify(`No ${label} items found.`, "warning"); return null; }
  const id = await selectInBorderedPopup(ctx, { title, items: items.map((item) => ({ value: item.id, label: item.name })), maxVisible: 16 });
  return items.find((item) => item.id === id) ?? null;
}
type SecretPlan = { itemName: string; envName: string; purpose: string };

// Optional OpenAI-compatible endpoint (ideally a local model) that turns a
// description into names. Only the description is sent; never the value.
const PLANNER_URL = process.env[`${BRAND.envPrefix}_PLANNER_URL`]?.trim();
const PLANNER_MODEL = process.env[`${BRAND.envPrefix}_PLANNER_MODEL`]?.trim() ?? "local";
const PLANNER_API_KEY = process.env[`${BRAND.envPrefix}_PLANNER_API_KEY`]?.trim();

function parseSecretPlan(raw: string): SecretPlan {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Planner returned no secret plan");
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { throw new Error("Planner returned invalid secret plan"); }
  const plan = parsed as Partial<SecretPlan>;
  if (typeof plan.itemName !== "string" || !plan.itemName.trim()) throw new Error("Secret plan has no itemName");
  if (typeof plan.envName !== "string" || !envNameOk(plan.envName)) throw new Error("Secret plan has invalid envName");
  if (typeof plan.purpose !== "string" || !plan.purpose.trim()) throw new Error("Secret plan has no purpose");
  return { itemName: plan.itemName.trim(), envName: plan.envName, purpose: plan.purpose.trim() };
}

function heuristicPlan(description: string): SecretPlan {
  const words = description.replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 5);
  const envName = words.join("_").toUpperCase().replace(/^(\d)/, "_$1") || "NEW_SECRET";
  const itemName = words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ") || "New secret";
  return { itemName, envName, purpose: description.trim().slice(0, 200) };
}

async function inferSecretPlan(description: string): Promise<SecretPlan> {
  if (!PLANNER_URL) return heuristicPlan(description);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(PLANNER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...(PLANNER_API_KEY ? { authorization: `Bearer ${PLANNER_API_KEY}` } : {}) },
      signal: controller.signal,
      body: JSON.stringify({
        model: PLANNER_MODEL,
        messages: [{ role: "system", content: "Return only JSON with keys itemName, envName, purpose. Choose a concise unique vault itemName, an uppercase UPPER_SNAKE_CASE envName, and a short purpose. Never ask for or repeat a secret value." }, { role: "user", content: description }],
        max_tokens: 160,
        temperature: 0,
        stream: false,
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!response.ok) throw new Error(`Planner HTTP ${response.status}`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("Planner returned no content");
    return parseSecretPlan(content);
  } finally { clearTimeout(timer); }
}

function secretUsage(plan: SecretPlan): string {
  return `Usage: $${plan.envName} in commands, or ${BRAND.bin} get ${plan.envName}`;
}
async function secretFlow(ctx: UiContext, rawDescription: string): Promise<void> {
  const description = rawDescription.trim() || await inputInBorderedPopup(ctx, { title: "Secret purpose", prompt: "Describe the credential and which agents need it" });
  if (!description) return;
  try {
    const proposed = await inferSecretPlan(description);
    const itemName = await inputInBorderedPopup(ctx, { title: "Vault item name", prompt: "Edit or press Enter", defaultValue: proposed.itemName });
    if (!itemName) return;
    const envName = await inputInBorderedPopup(ctx, { title: "Environment variable", prompt: "UPPER_SNAKE_CASE; edit or press Enter", defaultValue: proposed.envName });
    if (!envName || !envNameOk(envName)) { ctx.ui.notify("Invalid env var name; use UPPER_SNAKE_CASE.", "error"); return; }
    const plan: SecretPlan = { itemName, envName, purpose: proposed.purpose };
    const confirmed = await confirmInBorderedPopup(ctx, {
      title: "Configure vault secret?",
      message: `Item: ${plan.itemName}\nVariable: ${plan.envName}\nPurpose: ${plan.purpose}\n\nThe value is entered in a masked prompt and never reaches the model.`,
    });
    if (!confirmed) return;
    const secret = await inputInBorderedPopup(ctx, { title: `Paste secret for ${plan.envName}`, prompt: "Value is not shown and never reaches the model", mask: true });
    if (!secret) return;
    await core.ensureSession();
    const { created } = await core.createSecretItem({ itemName: plan.itemName, secret, envName: plan.envName, notes: plan.purpose });
    await core.audit("add", [plan.envName], "pi");
    await writeBoth(plan.envName, plan.itemName);
    await refreshEnv();
    ctx.ui.notify(`${created ? `${created}\n` : ""}Configured item=${plan.itemName} env=${plan.envName} for omp and pi.\n${secretUsage(plan)}`, "info");
  } catch (error) {
    ctx.ui.notify(`Secret configuration failed: ${mappedError(error)}`, "error");
  }
}

export default async function (pi: ExtensionAPI): Promise<void> {
  let T: Builder;
  try { T = await getBuilder(pi); } catch { return; }
  const emptySchema = T.Object({});
  await refreshEnv();
  // Fires on startup and every resume/fork; cache + single-flight make it free
  // while the vault is warm.
  pi.on("session_start", () => { void refreshEnv(); });
  // Checked before every tool and `!command` starts.
  pi.on("tool_call", recheckSession);
  // The model never sees vault values: every tool result is scrubbed before it
  // enters the context, whatever the tool printed. Its details and structured data (kept in the
  // session file, read by scripts) are scrubbed the same way.
  pi.on("tool_result", (event) => {
    if (redactor.size === 0) return undefined;
    let changed = false;
    const content = event.content.map((part) => {
      if (part.type !== "text") return part;
      const text = redactor.redact(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    const scrub = (value: unknown) => {
      if (value === undefined) return undefined;
      const scrubbed = redactDeep(value, (text) => redactor.redact(text));
      return JSON.stringify(scrubbed) === JSON.stringify(value) ? undefined : scrubbed;
    };
    const { details: rawDetails, structuredContent: rawStructured } = event as { details?: unknown; structuredContent?: unknown };
    const details = scrub(rawDetails), structuredContent = scrub(rawStructured);
    if (!changed && details === undefined && structuredContent === undefined) return undefined;
    return {
      ...(changed ? { content } : {}),
      ...(details !== undefined ? { details } : {}),
      // Replacing the content drops the structured data unless it is returned with it.
      ...(structuredContent !== undefined ? { structuredContent } : changed && rawStructured !== undefined ? { structuredContent: rawStructured } : {}),
    } as never;
  });
  // The output of the user's own `!command` reaches the model as a message, not as a tool
  // result: it is scrubbed in what is sent (the screen and the session file keep what was printed).
  // A `!command` the user types: its output is masked as it arrives, so what pi shows, saves and
  // later summarizes is the masked text. (An agent host without pi's local shell falls back to
  // the `context` handler below, which masks what is sent to the model with a turn.)
  pi.on("user_bash", async (event) => {
    await recheckSession();
    const host = await import("@earendil-works/pi-coding-agent").catch(() => null) as {
      createLocalBashOperations?: (options?: { shellPath?: string }) => { exec: (command: string, cwd: string, options: { onData: (data: Buffer) => void }) => Promise<{ exitCode: number | null }> };
      SettingsManager?: { create(cwd: string, agentDir?: string, options?: { projectTrusted?: boolean }): { getShellPath(): string | undefined } };
    } | null;
    if (!host?.createLocalBashOperations) return undefined;
    // The shell the user set for pi in their own settings, as pi would pick it for this command
    // (one set by the project's settings is not taken: whether pi trusts that project is not known here).
    let shellPath: string | undefined;
    try { shellPath = host.SettingsManager?.create((event as { cwd: string }).cwd, undefined, { projectTrusted: false }).getShellPath(); } catch {}
    const local = host.createLocalBashOperations({ shellPath });
    // The values known when a piece of output arrives, not when the command was typed: the
    // shell may start after a refresh that came in between.
    const live: Redactor = {
      get size() { return redactor.size; },
      get lookBehind() { return redactor.lookBehind; },
      redact: (text, before, after) => redactor.redact(text, before, after),
      safeCut: (text) => redactor.safeCut(text),
    };
    return {
      operations: {
        exec: async (command, cwd, options) => {
          const decoder = new StringDecoder("utf8"), feed = createRedactFeed(live);
          const pass = (text: string) => { if (text) options.onData(Buffer.from(text, "utf8")); };
          try { return await local.exec(command, cwd, { ...options, onData: (data: Buffer) => pass(feed.push(decoder.write(data))) }); }
          finally { pass(feed.push(decoder.end()) + feed.end()); }
        },
      },
    };
  });

  pi.on("context", (event) => {
    if (redactor.size === 0) return undefined;
    let changed = false;
    for (const message of event.messages as Array<{ role?: string; output?: unknown }>) {
      if (message.role !== "bashExecution" || typeof message.output !== "string") continue;
      const output = redactor.redact(message.output);
      if (output !== message.output) { message.output = output; changed = true; }
    }
    return changed ? { messages: event.messages } : undefined;
  });

  pi.registerTool({
    name: "vault_status", label: "Vault Status",
    description: "Check vault state and injected environment names without exposing values.", parameters: emptySchema,
    async execute() { const result = await report(); return { content: [{ type: "text", text: result.report }], details: result.details }; },
  });
  pi.registerTool({
    name: "vault_add_secret", label: "Add Vault Secret",
    description: "Prompt the user for a masked secret, create a vault item, and wire it as an environment variable. The value never passes through the model.",
    parameters: T.Object({ env_name: T.String({ description: "UPPER_SNAKE_CASE environment variable name" }), item_name: T.String({ description: "Vault item name to create" }), purpose: T.String({ description: "Short note stored with the item" }) }),
    async execute(_id, params, _signal, _update, ctx) { const input = params as { env_name: string; item_name: string; purpose: string }; const text = await addFlow(ctx, input.env_name, input.item_name, input.purpose); return { content: [{ type: "text", text }], details: {} }; },
  });

  pi.registerCommand("secret", { description: "Describe a credential, confirm its name, and paste it into a masked prompt.", handler: async (args, ctx) => { await secretFlow(ctx, args); } });
  pi.registerCommand("vault_status", { description: "Show vault status, injected names, and redaction coverage.", handler: async (_args, ctx) => { const result = await report(); ctx.ui.notify(result.report, "info"); } });
  pi.registerCommand("vault_add", { description: "Create and wire a new vault secret.", handler: async (_args, ctx) => {
    const itemName = await inputInBorderedPopup(ctx, { title: "Vault item name", prompt: "Name for the new item" }); if (!itemName) return;
    const envName = await inputInBorderedPopup(ctx, { title: "Environment variable", prompt: "Use UPPER_SNAKE_CASE" }); if (!envName) return;
    const purpose = await inputInBorderedPopup(ctx, { title: "Purpose", prompt: "Short note stored with the item" }); if (purpose === undefined) return;
    const secret = await inputInBorderedPopup(ctx, { title: `Paste secret for ${envName}`, prompt: "Value is not shown", mask: true }); if (!secret) return;
    if (!envNameOk(envName)) { ctx.ui.notify("Invalid env var name; use UPPER_SNAKE_CASE.", "error"); return; }
    const backend = await core.defaultBackend();
    if (!await confirmInBorderedPopup(ctx, { title: "Create and wire secret?", message: `"${envName}": "${core.referenceFor(itemName, backend)}"` })) return;
    try { await core.ensureSession(); const { created } = await core.createSecretItem({ itemName, secret, envName, notes: purpose }); await core.audit("add", [envName], "pi"); await writeBoth(envName, itemName); await refreshEnv(); const verified = (await core.resolveShellValue(core.referenceFor(itemName, backend))) !== null; ctx.ui.notify(`${created ? `${created}\n` : ""}Created item=${itemName} env=${envName} verified=${verified ? "yes" : "no"}`, verified ? "info" : "warning"); } catch (error) { ctx.ui.notify(mappedError(error), "error"); }
  } });
  pi.registerCommand("vault_wire", { description: "Wire an existing vault item to both agent auth stores.", handler: async (_args, ctx) => {
    try {
      await core.ensureSession(); const item = await chooseItem(ctx, `Choose ${(await core.defaultBackend()) === "local" ? "a local vault" : "Vaultwarden"} item`); if (!item) return;
      const envName = await inputInBorderedPopup(ctx, { title: "Environment variable", prompt: "Use UPPER_SNAKE_CASE" }); if (!envName || !envNameOk(envName)) { ctx.ui.notify("Invalid env var name; use UPPER_SNAKE_CASE", "error"); return; }
      const existing = (await core.wiredEntries())[envName] !== undefined;
      let overwrite = false; if (existing) { const choice = await selectInBorderedPopup(ctx, { title: `${envName} already exists`, items: [{ value: "replace", label: "Replace" }, { value: "keep", label: "Keep" }] }); if (choice !== "replace") return; overwrite = true; }
      if (!await confirmInBorderedPopup(ctx, { title: "Save reference?", message: `"${envName}": "${core.referenceFor(item.name, await core.defaultBackend())}"` })) return;
      await writeBoth(envName, item.name, overwrite); await core.audit("wire", [envName], "pi"); await refreshEnv(); ctx.ui.notify("Saved; reload to apply", "info");
    } catch (error) { ctx.ui.notify(mappedError(error), "error"); }
  } });
  pi.registerCommand("vault_rotate", { description: "Rotate a vault item's password.", handler: async (_args, ctx) => {
    try { await core.ensureSession(); const item = await chooseItem(ctx, "Choose item to rotate"); if (!item) return; const secret = await inputInBorderedPopup(ctx, { title: `Rotate ${item.name}`, prompt: "Value is not shown", mask: true }); if (!secret) return; if (!await confirmInBorderedPopup(ctx, { title: "Rotate secret?", message: `Item: ${item.name}` })) return; await core.rotateSecretItem({ itemName: item.name, secret }); await core.audit("rotate", [item.name], "pi"); await refreshEnv(); ctx.ui.notify(`Rotated item=${item.name}; injected environment refreshed.`, "info"); } catch (error) { ctx.ui.notify(mappedError(error), "error"); }
  } });
}

export { core };
export const { resolveShellValue, resolveRef, getSecret, buildEnvMap, writeAuthEntry, deleteAuthEntry, getStatus, ensureSession } = core;
