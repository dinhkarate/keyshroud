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
  redact(text: string): string;
  // Largest prefix length that can be redacted now: the remainder may still
  // grow into a secret, and no complete secret straddles the cut.
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
// survives between two replacements.
function applyHits(text: string, hits: Hit[]): string {
  if (!hits.length) return text;
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let cursor = 0;
  let current: Hit | null = null;
  for (const hit of hits) {
    if (current && hit.start < current.end) { current.end = Math.max(current.end, hit.end); continue; }
    if (current) { out += text.slice(cursor, current.start) + placeholder(current.name); cursor = current.end; }
    current = { ...hit };
  }
  if (current) { out += text.slice(cursor, current.start) + placeholder(current.name); cursor = current.end; }
  return out + text.slice(cursor);
}

export function createRedactor(values: Record<string, string>): Redactor {
  const byValue = new Map<string, string>();
  for (const [name, value] of Object.entries(values)) {
    for (const form of redactForms(value)) if (!byValue.has(form)) byValue.set(form, name);
  }
  // Longest first so a secret containing another secret is replaced whole.
  const secrets = [...byValue.entries()].sort((a, b) => b[0].length - a[0].length);
  const maxLength = secrets.reduce((max, [value]) => Math.max(max, value.length), 0);
  return {
    size: secrets.length,
    redact(text) {
      const hits: Hit[] = [];
      for (const [value, name] of secrets) {
        for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) hits.push({ start: at, end: at + value.length, name });
      }
      return applyHits(text, hits);
    },
    safeCut(text) {
      let cut = text.length;
      for (let i = Math.max(0, text.length - maxLength + 1); i < text.length; i++) {
        const tail = text.slice(i);
        if (secrets.some(([value]) => value.length > tail.length && value.startsWith(tail))) { cut = i; break; }
      }
      // Hold back any complete secret that straddles the cut too: it may merge
      // with the unfinished one once the next chunk arrives.
      const straddling = (at: number) => secrets.find(([value]) => {
        for (let hit = text.indexOf(value, Math.max(0, at - value.length + 1)); hit !== -1 && hit < at; hit = text.indexOf(value, hit + 1)) {
          if (hit + value.length > at) return true;
        }
        return false;
      });
      for (let moved = true; moved;) {
        moved = false;
        for (const [value] of secrets) {
          for (let at = text.indexOf(value, Math.max(0, cut - value.length + 1)); at !== -1 && at < cut; at = text.indexOf(value, at + 1)) {
            if (at + value.length > cut) { cut = at; moved = true; break; }
          }
        }
      }
      if (text.length - cut <= MAX_HOLD) return cut;
      // Bounded fallback: cut near the end, moving forward past any complete
      // secret that straddles it, so whole matches are still replaced.
      cut = Math.max(0, text.length - maxLength);
      while (cut < text.length && straddling(cut)) cut++;
      return cut;
    },
  };
}

// Streams child output through the redactor, holding back only a trailing
// fragment that could still grow into a secret on the next chunk.
export function createRedactStream(redactor: Redactor): Transform {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const text = pending + decoder.write(chunk);
      const cut = redactor.safeCut(text);
      pending = text.slice(cut);
      callback(null, redactor.redact(text.slice(0, cut)));
    },
    flush(callback) {
      callback(null, redactor.redact(pending + decoder.end()));
    },
  });
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
    return applyHits(text, hits);
  };
}
