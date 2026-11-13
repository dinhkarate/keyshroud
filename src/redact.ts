import { createHmac, randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// Values shorter than this are not redacted: short IDs and flags would turn
// ordinary output into noise.
export const MIN_REDACT_LENGTH = 6;

// Upper bound on how much output the stream holds back. Periodic output that
// keeps matching a repetitive secret would otherwise stall until EOF.
const MAX_HOLD = 4096;

export interface Redactor {
  readonly size: number;
  // `before` and `after` are the text around `text` in one output, which is masked piece by
  // piece: only `text` is returned. A secret that runs on into `after` is masked up to the end
  // of `text`; one that began in `before` got its placeholder there, and its rest just goes.
  redact(text: string, before?: string, after?: string): string;
  // How much of the text already let go a stream keeps, to pass as `before`.
  readonly lookBehind: number;
  // A prefix length that can be let go now: nothing from the cut on has begun a secret that
  // is still unfinished at the end of `text`. Finished secrets may straddle the cut (only when
  // there are more of them than a stream may hold back): pass the rest to `redact` as `after`.
  safeCut(text: string): number;
}

export function placeholder(name: string): string { return `<redacted:${name}>`; }

function stringLeaves(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (node && typeof node === "object") for (const child of Object.values(node)) stringLeaves(child, out);
  return out;
}

// What is masked for one secret: the value, and what is left of it once a tool reshapes it. Padding
// goes when a shell expands the variable, so the value is masked without it too. A value of several
// parts (a PEM key, a JSON key file) is broken up by line numbers, diff marks and JSON escapes, so each
// run of 20 or more letters, digits and +/=_- in it is masked as well (in JSON: in its string values).
export function redactForms(value: string): string[] {
  const trimmed = value.trim();
  const forms = new Set([value, trimmed]);
  let parts: string[] | null = null;
  if (/^[[{]/.test(trimmed)) { try { parts = stringLeaves(JSON.parse(trimmed)); } catch {} }
  if (parts || /\s/.test(trimmed)) for (const part of parts ?? [trimmed]) for (const run of part.match(/[A-Za-z0-9+/=_-]{20,}/g) ?? []) forms.add(run);
  return [...forms].filter((form) => form.length >= MIN_REDACT_LENGTH);
}

interface Hit { start: number; end: number; name: string }

// Overlapping matches merge into one placeholder, so no fragment of any secret
// survives between two replacements. Only the text from `from` up to `to` is returned: a match
// that began before `from` has its placeholder in what came before.
function applyHits(text: string, hits: Hit[], from = 0, to = text.length): string {
  if (!hits.length) return text.slice(from, to);
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let cursor = from;
  let current: Hit | null = null;
  const flush = (hit: Hit) => {
    if (hit.end <= from || hit.start >= to) return;
    if (hit.start >= from) out += text.slice(cursor, Math.max(cursor, hit.start)) + placeholder(hit.name);
    cursor = Math.min(hit.end, to);
  };
  for (const hit of hits) {
    if (current && hit.start < current.end) { current.end = Math.max(current.end, hit.end); continue; }
    if (current) flush(current);
    current = { ...hit };
  }
  if (current) flush(current);
  return out + text.slice(cursor, to);
}

// `maxHold`: see MAX_HOLD (tests lower it).
export function createRedactor(values: Record<string, string>, maxHold = MAX_HOLD): Redactor {
  const byValue = new Map<string, string>();
  for (const [name, value] of Object.entries(values)) {
    for (const form of redactForms(value)) if (!byValue.has(form)) byValue.set(form, name);
  }
  // Longest first so a secret containing another secret is replaced whole.
  const secrets = [...byValue.entries()].sort((a, b) => b[0].length - a[0].length);
  const maxLength = secrets.reduce((max, [value]) => Math.max(max, value.length), 0);
  return {
    size: secrets.length,
    lookBehind: Math.max(0, maxLength - 1),
    redact(text, before = "", after = "") {
      const all = before + text + after;
      const hits: Hit[] = [];
      for (const [value, name] of secrets) {
        for (let at = all.indexOf(value); at !== -1; at = all.indexOf(value, at + 1)) hits.push({ start: at, end: at + value.length, name });
      }
      return applyHits(all, hits, before.length, before.length + text.length);
    },
    safeCut(text) {
      // The earliest place where a secret may have begun that the text ends inside of. Whatever
      // covers a character before it is a finished secret, since one begun earlier and still
      // unfinished would have put this place earlier: so nothing before it can still turn out to
      // be part of a secret, and the cut is never moved past it.
      let open = text.length;
      for (let i = Math.max(0, text.length - maxLength + 1); i < text.length; i++) {
        const tail = text.slice(i);
        if (secrets.some(([value]) => value.length > tail.length && value.startsWith(tail))) { open = i; break; }
      }
      // A finished secret that straddles the cut is held back whole, so that it gets one placeholder.
      let cut = open;
      for (let moved = true; moved;) {
        moved = false;
        for (const [value] of secrets) {
          for (let at = text.indexOf(value, Math.max(0, cut - value.length + 1)); at !== -1 && at < cut; at = text.indexOf(value, at + 1)) {
            if (at + value.length > cut) { cut = at; moved = true; break; }
          }
        }
      }
      // Output that keeps repeating a secret which overlaps itself would be held back without
      // end: past the bound, the cut goes through finished secrets, which `redact` masks on both sides.
      return text.length - cut <= maxHold ? cut : open;
    },
  };
}

// An output masked as it arrives: `push` returns what can be let go of a chunk, `end` the rest.
// Only a trailing fragment that could still grow into a secret is held back. What was let go
// is remembered for the length of a secret, for one that the cut went through.
export function createRedactFeed(redactor: Redactor): { push(text: string): string; end(): string } {
  let pending = "";
  let gone = "";
  const emit = (cut: number) => {
    const text = pending.slice(0, cut), after = pending.slice(cut);
    const out = redactor.redact(text, gone, after);
    gone = redactor.lookBehind ? (gone + text).slice(-redactor.lookBehind) : "";
    pending = after;
    return out;
  };
  return {
    push(text) { pending += text; return emit(redactor.safeCut(pending)); },
    end() { return emit(pending.length); },
  };
}

// Streams child output through the redactor (see createRedactFeed).
export function createRedactStream(redactor: Redactor): Transform {
  const decoder = new StringDecoder("utf8");
  const feed = createRedactFeed(redactor);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) { callback(null, feed.push(decoder.write(chunk))); },
    flush(callback) { callback(null, feed.push(decoder.end()) + feed.end()); },
  });
}

// Every string in a JSON-like value, keys included, through `redact`.
export function redactDeep(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  // A secret of digits may come back as a JSON number.
  if (typeof value === "number") { const text = String(value); const masked = redact(text); return masked === text ? value : masked; }
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, redact));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redact(key), redactDeep(entry, redact)]));
  }
  return value;
}

// Out-of-process hooks (Claude Code PostToolUse) cannot hold plaintext, so
// they redact from an index of keyed fingerprints: a cheap rolling hash finds
// candidate windows and an HMAC confirms them.
export interface RedactIndex {
  v: 1;
  key: string;
  entries: Array<{ name: string; length: number; roll: number; mac: string }>;
}

const ROLL_BASE = 257;

function rollPower(length: number): number {
  let power = 1;
  for (let i = 0; i < length - 1; i++) power = Math.imul(power, ROLL_BASE) >>> 0;
  return power;
}

function rollHash(text: string, start: number, length: number): number {
  let hash = 0;
  for (let i = start; i < start + length; i++) hash = (Math.imul(hash, ROLL_BASE) + text.charCodeAt(i)) >>> 0;
  return hash;
}

function mac(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex").slice(0, 32);
}

export function buildRedactIndex(values: Record<string, string>, previous?: RedactIndex): RedactIndex {
  const key = previous ? Buffer.from(previous.key, "base64") : randomBytes(32);
  const entries: RedactIndex["entries"] = [];
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(values)) for (const form of redactForms(value)) {
    const digest = mac(key, form);
    if (seen.has(digest)) continue;
    seen.add(digest);
    entries.push({ name, length: form.length, roll: rollHash(form, 0, form.length), mac: digest });
  }
  for (const entry of previous?.entries ?? []) if (!seen.has(entry.mac)) { seen.add(entry.mac); entries.push(entry); }
  return { v: 1, key: key.toString("base64"), entries };
}

export function redactWithIndex(text: string, index: RedactIndex): string {
  return compileRedactIndex(index)(text);
}

export function compileRedactIndex(index: RedactIndex): (text: string) => string {
  const find = compileIndexSearch(index);
  return (text) => applyHits(text, find(text));
}

// Where the indexed values are in a text: the name and the offset of each (for `scan`).
export function compileIndexSearch(index: RedactIndex): (text: string) => Array<{ start: number; end: number; name: string }> {
  const key = Buffer.from(index.key, "base64");
  const byLength = new Map<number, Map<number, RedactIndex["entries"]>>();
  for (const entry of index.entries) {
    const rolls = byLength.get(entry.length) ?? new Map();
    rolls.set(entry.roll, [...(rolls.get(entry.roll) ?? []), entry]);
    byLength.set(entry.length, rolls);
  }
  return (text) => {
    const hits: Hit[] = [];
    for (const [length, rolls] of byLength) {
      if (text.length < length) continue;
      const power = rollPower(length);
      let hash = rollHash(text, 0, length);
      for (let start = 0; ; start++) {
        const candidates = rolls.get(hash);
        if (candidates) {
          const digest = mac(key, text.slice(start, start + length));
          const match = candidates.find((entry) => entry.mac === digest);
          if (match) hits.push({ start, end: start + length, name: match.name });
        }
        if (start + length >= text.length) break;
        const outgoing = Math.imul(text.charCodeAt(start), power) >>> 0;
        hash = (Math.imul((hash - outgoing) >>> 0, ROLL_BASE) + text.charCodeAt(start + length)) >>> 0;
      }
    }
    return hits;
  };
}
