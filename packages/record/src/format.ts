// the on-disk format: where each record lives, how a record file is written and how it is read back.
// writing is strict (one shape). reading is tolerant (hand edits, half files) and never throws.
import path from "node:path";
import { FORMAT_VERSION } from "./version.ts";

// ---------- layout ----------

export const PROJECT_FILE = path.join(".claude", "grove-project.json");

export function paths(root: string) {
  const cards = path.join(root, "cards");
  const conclusions = path.join(root, "conclusions");
  return {
    project: path.join(root, PROJECT_FILE),
    cards,
    cardDir: (id: string) => path.join(cards, id),
    cardFile: (id: string) => path.join(cards, id, "card.md"),
    comments: (id: string) => path.join(cards, id, "comments"),
    claims: (id: string) => path.join(cards, id, "claims"),
    conclusions,
    index: path.join(conclusions, "INDEX.md"),
  };
}

// ---------- ids ----------

/** a card id. D, F and V alone are conclusion letters, never a card prefix, so D-1 is never a card. */
export const CARD_ID = /^(?![DFV]-)[A-Z][A-Z0-9]{0,7}-[1-9][0-9]*$/;
export const CONCLUSION_ID = /^[DFV]-[1-9][0-9]*$/;
export const PREFIX = /^[A-Z][A-Z0-9]{0,7}$/;
/** every id in a piece of text, for cross-references. */
export const ANY_ID = /\b(?:[A-Z][A-Z0-9]{0,7}-[1-9][0-9]*)(?:#[1-9][0-9]*)?\b/g;

import type { ConclusionKind } from "./types.ts";

export type { ConclusionKind } from "./types.ts";
export const KIND_LETTER: Record<ConclusionKind, string> = {
  decision: "D",
  finding: "F",
  verdict: "V",
};
export const LETTER_KIND: Record<string, ConclusionKind> = {
  D: "decision",
  F: "finding",
  V: "verdict",
};

/** ids are upper case on disk. the default macOS volume is case-insensitive, so only one spelling may exist. */
export function normId(raw: string): string {
  return raw.trim().toUpperCase();
}

export function idNumber(id: string): number {
  const m = /-(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

export function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

// ---------- text helpers ----------

export function nowIso(): string {
  return new Date().toISOString();
}

/** one line: control characters go, every run of whitespace becomes one space. */
export function oneLine(s: string): string {
  return (
    s
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** cut to a number of characters, with an ellipsis when something was cut. */
export function cut(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** cut to a number of UTF-8 bytes on a character boundary. */
export function cutBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, "utf8");
    if (used + b > maxBytes - 3) break;
    out += ch;
    used += b;
  }
  return `${out}…`;
}

/** "10-02 18:24" from an ISO time, in UTC. fixed text, so the same state always prints the same. */
export function shortTime(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : "?";
}

// ---------- writing ----------

/**
 * a frontmatter value. a string is free text and is written as a JSON string, which is also a
 * valid YAML double-quoted scalar and round-trips every byte. `bare` is for ids, enums, numbers
 * and timestamps that need no quotes. a list is written as a one-line JSON array.
 */
export type FmValue = string | number | boolean | { bare: string } | unknown[] | undefined;

export function bare(s: string): { bare: string } {
  return { bare: s };
}

export function renderRecord(fields: [string, FmValue][], body = ""): string {
  const lines = ["---", `v: ${FORMAT_VERSION}`];
  for (const [key, value] of fields) {
    if (value === undefined) continue;
    if (typeof value === "string") lines.push(`${key}: ${JSON.stringify(value)}`);
    else if (typeof value === "number" || typeof value === "boolean")
      lines.push(`${key}: ${value}`);
    else if (Array.isArray(value)) lines.push(`${key}: ${JSON.stringify(value)}`);
    else lines.push(`${key}: ${value.bare}`);
  }
  lines.push("---");
  // the body is stored as given plus one newline, and read back with exactly one newline removed
  return `${lines.join("\n")}\n${body}\n`;
}

// ---------- reading ----------

export interface Parsed {
  fields: Record<string, unknown>;
  body: string;
  /** what was wrong with the file. empty for a file this package wrote. */
  problems: string[];
}

function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "") return "";
  if (v[0] === '"') {
    try {
      return JSON.parse(v);
    } catch {
      // a hand-written YAML string that is not valid JSON. take what is between the quotes
      const end = v.lastIndexOf('"');
      return v
        .slice(1, end > 0 ? end : undefined)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
  }
  if (v[0] === "'") {
    const end = v.lastIndexOf("'");
    return v.slice(1, end > 0 ? end : undefined).replace(/''/g, "'");
  }
  if (v[0] === "[" || v[0] === "{") {
    try {
      return JSON.parse(v);
    } catch {
      if (v[0] === "[") {
        // YAML flow list written by hand: [D-1, D-4]
        return v
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => String(parseScalar(s)))
          .filter((s) => s !== "");
      }
      return v;
    }
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v) && v.length < 16) return Number(v);
  return v;
}

/** never throws. a file with no frontmatter is all body. an unclosed frontmatter is read as far as it goes. */
export function parseRecord(textIn: string): Parsed {
  const problems: string[] = [];
  const fields: Record<string, unknown> = {};
  const text = String(textIn ?? "")
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { fields, body: text.replace(/\n$/, ""), problems: ["no frontmatter"] };
  }
  let i = 1;
  let closed = false;
  let listKey: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") {
      closed = true;
      i++;
      break;
    }
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (fields[listKey] as unknown[]).push(parseScalar(item[1]!));
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*)|\s*)$/.exec(line);
    if (!m) {
      problems.push(`line ${i + 1} is not "key: value"`);
      listKey = null;
      continue;
    }
    const key = m[1]!;
    if (key in fields) {
      problems.push(`"${key}" is there twice, the first one counts`);
      listKey = null;
      continue;
    }
    if (m[2] === undefined || m[2].trim() === "") {
      // "key:" followed by "  - item" lines is a YAML block list
      const next = lines[i + 1];
      if (next !== undefined && /^\s+-\s+/.test(next)) {
        fields[key] = [];
        listKey = key;
      } else {
        fields[key] = "";
        listKey = null;
      }
      continue;
    }
    listKey = null;
    fields[key] = parseScalar(m[2]);
  }
  if (!closed) problems.push("frontmatter is not closed");
  const v = fields.v;
  if (typeof v === "number" && v > FORMAT_VERSION)
    problems.push(`written with format ${v}, this reader knows ${FORMAT_VERSION}`);
  const body = closed ? lines.slice(i).join("\n").replace(/\n$/, "") : "";
  return { fields, body, problems };
}

// ---------- typed access to parsed fields, each tolerant of the wrong type ----------

export function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

export function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return 0;
}

export function bool(v: unknown): boolean {
  return v === true || v === "true" || v === "yes";
}

export function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter((s) => s !== "");
  const s = str(v).trim();
  if (!s) return [];
  return s.split(/[\s,]+/).filter(Boolean);
}

export function isIso(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s) && !Number.isNaN(Date.parse(s));
}
