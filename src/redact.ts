import { createHmac, randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// Values shorter than this are not redacted: short IDs and flags would turn
// ordinary output into noise.
export const MIN_REDACT_LENGTH = 6;

export interface Redactor {
  readonly size: number;
  redact(text: string): string;
  // Largest prefix length that can be redacted now: the remainder may still
  // grow into a secret, and no complete secret straddles the cut.
  safeCut(text: string): number;
}

export function placeholder(name: string): string { return `<redacted:${name}>`; }

export function createRedactor(values: Record<string, string>): Redactor {
  const byValue = new Map<string, string>();
  for (const [name, value] of Object.entries(values)) {
    if (value.length >= MIN_REDACT_LENGTH && !byValue.has(value)) byValue.set(value, name);
  }
  // Longest first so a secret containing another secret is replaced whole.
  const secrets = [...byValue.entries()].sort((a, b) => b[0].length - a[0].length);
  const maxLength = secrets.reduce((max, [value]) => Math.max(max, value.length), 0);
  return {
    size: secrets.length,
    redact(text) {
      let out = text;
      for (const [value, name] of secrets) if (out.includes(value)) out = out.split(value).join(placeholder(name));
      return out;
    },
    safeCut(text) {
      let cut = text.length;
      for (let i = Math.max(0, text.length - maxLength + 1); i < text.length; i++) {
        const tail = text.slice(i);
        if (secrets.some(([value]) => value.length > tail.length && value.startsWith(tail))) { cut = i; break; }
      }
      for (let moved = true; moved;) {
        moved = false;
        for (const [value] of secrets) {
          for (let at = text.indexOf(value, Math.max(0, cut - value.length + 1)); at !== -1 && at < cut; at = text.indexOf(value, at + 1)) {
            if (at + value.length > cut) { cut = at + value.length; moved = true; }
          }
        }
      }
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

export function buildRedactIndex(values: Record<string, string>): RedactIndex {
  const key = randomBytes(32);
  const seen = new Set<string>();
  const entries: RedactIndex["entries"] = [];
  for (const [name, value] of Object.entries(values)) {
    if (value.length < MIN_REDACT_LENGTH || seen.has(value)) continue;
    seen.add(value);
    entries.push({ name, length: value.length, roll: rollHash(value, 0, value.length), mac: mac(key, value) });
  }
  return { v: 1, key: key.toString("base64"), entries };
}

export function redactWithIndex(text: string, index: RedactIndex): string {
  const key = Buffer.from(index.key, "base64");
  const byLength = new Map<number, Map<number, RedactIndex["entries"]>>();
  for (const entry of index.entries) {
    const rolls = byLength.get(entry.length) ?? new Map();
    rolls.set(entry.roll, [...(rolls.get(entry.roll) ?? []), entry]);
    byLength.set(entry.length, rolls);
  }
  const hits: Array<{ start: number; end: number; name: string }> = [];
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
  if (!hits.length) return text;
  // Prefer the longest match at each position, then drop overlaps.
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    out += text.slice(cursor, hit.start) + placeholder(hit.name);
    cursor = hit.end;
  }
  return out + text.slice(cursor);
}
