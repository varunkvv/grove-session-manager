// argument checks. claude code shows the schema to the model and does not enforce it, so the
// package checks every call itself, for the MCP server and the CLI alike. small slips are
// repaired (a number sent as text, an id in lower case, a list sent as "a, b"). everything
// else is refused with the valid arguments and an example, so the next call is right.
import path from "node:path";
import { cut, normId, oneLine } from "./format.ts";

export interface Prop {
  type: "string" | "boolean" | "integer" | "ids" | "artifacts" | "sources";
  description: string;
  enum?: string[];
  /** longest allowed value, in characters. */
  max?: number;
  /** id: upper-cased. line: every run of whitespace becomes one space. */
  format?: "id" | "line";
}

export interface InputSpec {
  properties: Record<string, Prop>;
  required: string[];
  example: Record<string, unknown>;
  /** other names a model reaches for, taken as the real one when that is not given: { text: "summary" }. */
  aliases?: Record<string, string>;
}

export const ARTIFACT_TYPES = ["file", "branch", "pr", "link"];
/** a conclusion's sources: how many, and how long a ref and a note may be. search prints them in full. */
export const SOURCE_LIMITS = { count: 12, ref: 1000, note: 300 };

/** the JSON Schema sent in tools/list. this is what the model reads. */
export function jsonSchema(spec: InputSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(spec.properties)) {
    if (p.type === "ids")
      properties[name] = { type: "array", items: { type: "string" }, description: p.description };
    else if (p.type === "artifacts") {
      properties[name] = {
        type: "array",
        description: p.description,
        items: {
          type: "object",
          properties: { type: { type: "string", enum: ARTIFACT_TYPES }, ref: { type: "string" } },
          required: ["type", "ref"],
          additionalProperties: false,
        },
      };
    } else if (p.type === "sources") {
      properties[name] = {
        type: "array",
        description: p.description,
        // the limits are check()'s to enforce. this schema is in every request, so it stays short
        items: {
          type: "object",
          properties: { ref: { type: "string" }, note: { type: "string" } },
          required: ["ref"],
        },
      };
    } else {
      const s: Record<string, unknown> = { type: p.type, description: p.description };
      if (p.enum) s.enum = p.enum;
      if (p.max) s.maxLength = p.max;
      properties[name] = s;
    }
  }
  return { type: "object", properties, required: spec.required, additionalProperties: false };
}

export function usage(tool: string, spec: InputSpec): string {
  const names = Object.keys(spec.properties).map((n) =>
    spec.required.includes(n) ? `${n} (required)` : n,
  );
  return `${tool} takes: ${names.length ? names.join(", ") : "no arguments"}. Example: ${JSON.stringify(spec.example)}`;
}

export type Checked = { ok: true; args: Record<string, unknown> } | { ok: false; text: string };

/** an http(s) url with a host and no credentials in it: the only kind the app will open. */
function isWebUrl(ref: string): boolean {
  try {
    const u = new URL(ref);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      !!u.hostname &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}

/** `root` is the project folder. with it, a path given in full is stored from the root. */
export function check(tool: string, spec: InputSpec, raw: unknown, root?: string): Checked {
  const bad = (why: string): Checked => ({
    ok: false,
    text: `${tool}: ${why}. ${usage(tool, spec)}`,
  });
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw))
    return bad("the arguments must be one JSON object");
  const input = { ...(raw as Record<string, unknown>) };
  for (const [alias, real] of Object.entries(spec.aliases ?? {})) {
    if (alias in input && !(real in input)) {
      input[real] = input[alias];
      delete input[alias];
    }
  }
  const args: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (!(key in spec.properties)) return bad(`unknown argument "${key}"`);
  }
  for (const [name, p] of Object.entries(spec.properties)) {
    let v = input[name];
    const required = spec.required.includes(name);
    if (
      v === undefined ||
      v === null ||
      (typeof v === "string" && v.trim() === "" && p.type !== "boolean")
    ) {
      if (required) return bad(`"${name}" is required${v === "" ? " and was empty" : ""}`);
      continue;
    }
    if (p.type === "string") {
      if (typeof v === "number" || typeof v === "boolean") v = String(v);
      if (typeof v !== "string") return bad(`"${name}" must be text`);
      let s = v;
      if (p.format === "id") s = normId(s);
      if (p.format === "line") s = oneLine(s);
      if (p.enum) {
        const hit = p.enum.find((e) => e === s.trim().toLowerCase());
        if (!hit) return bad(`"${name}" must be one of: ${p.enum.join(", ")}. got "${s}"`);
        s = hit;
      }
      if (p.max && Array.from(s).length > p.max)
        return bad(
          `"${name}" is ${Array.from(s).length} characters, the limit is ${p.max}. Shorten it${name === "what" || name === "title" ? " and put the detail in the other text argument" : ""}`,
        );
      args[name] = s;
    } else if (p.type === "boolean") {
      if (v === true || v === "true") args[name] = true;
      else if (v === false || v === "false" || v === "") args[name] = false;
      else return bad(`"${name}" must be true or false`);
    } else if (p.type === "integer") {
      // 6 and "6" mean 6. "AUTH-4#6" is refused: its card part could disagree with the card argument
      const n =
        typeof v === "number"
          ? v
          : typeof v === "string" && /^\d+$/.test(v.trim())
            ? Number(v.trim())
            : Number.NaN;
      if (!Number.isInteger(n) || n < 1)
        return bad(`"${name}" must be a whole number, 1 or more. For AUTH-4#6 pass 6`);
      args[name] = n;
    } else if (p.type === "ids") {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
        return bad(`"${name}" must be a list of ids, like ["D-4"]`);
      args[name] = (v as string[]).map(normId).filter(Boolean);
    } else if (p.type === "sources") {
      const shape = `{"ref": "a url, or a path from the project root", "note": "what in it mattered"}`;
      if (!Array.isArray(v)) return bad(`"${name}" must be a list, like [${shape}]`);
      if (v.length > SOURCE_LIMITS.count)
        return bad(
          `"${name}" has ${v.length} entries, the limit is ${SOURCE_LIMITS.count}. List the ones that mattered`,
        );
      const out: { ref: string; note?: string }[] = [];
      for (const item of v) {
        // a bare string is a ref with no note
        const given = typeof item === "string" ? { ref: item } : (item ?? {});
        const { ref: rawRef, note: rawNote } = given as { ref?: unknown; note?: unknown };
        if (typeof rawRef !== "string" || (rawNote != null && typeof rawNote !== "string"))
          return bad(`each entry of "${name}" must be ${shape}`);
        // one line each: a control character never reaches a terminal or a row through these
        let ref = oneLine(rawRef);
        const note = oneLine((rawNote as string | undefined) ?? "");
        if (!ref) return bad(`each entry of "${name}" must be ${shape}`);
        const tooLong =
          Array.from(ref).length > SOURCE_LIMITS.ref
            ? `its ref is over ${SOURCE_LIMITS.ref} characters`
            : Array.from(note).length > SOURCE_LIMITS.note
              ? `its note is over ${SOURCE_LIMITS.note} characters`
              : "";
        if (tooLong)
          return bad(
            `source "${cut(ref, 60)}": ${tooLong}. Shorten it, or save a digest under artifacts/ and list that file`,
          );
        if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) {
          if (!isWebUrl(ref))
            return bad(
              `source "${cut(ref, 60)}" must be an http(s) url with no password in it, or a path from the project root like artifacts/thread-digest.md`,
            );
        } else {
          // a file is a path inside the project, from its root: what another agent's Read takes and the app joins
          if (root && path.isAbsolute(ref)) ref = path.relative(root, ref);
          if (
            !ref ||
            path.isAbsolute(ref) ||
            ref.startsWith("~") ||
            ref.split(/[/\\]/).includes("..")
          )
            return bad(
              `source "${cut(oneLine(rawRef), 60)}" must be a url, or a file inside the project as a path from its root, like artifacts/thread-digest.md`,
            );
        }
        out.push(note ? { ref, note } : { ref });
      }
      args[name] = out;
    } else {
      if (!Array.isArray(v))
        return bad(
          `"${name}" must be a list, like [{"type": "file", "ref": "artifacts/report.md"}]`,
        );
      const out: { type: string; ref: string }[] = [];
      for (const item of v) {
        const t = String((item as { type?: unknown } | null)?.type ?? "").toLowerCase();
        const ref = (item as { ref?: unknown } | null)?.ref;
        if (!ARTIFACT_TYPES.includes(t) || typeof ref !== "string" || !ref.trim())
          return bad(
            `each entry of "${name}" must be {"type": "file" | "branch" | "pr" | "link", "ref": "..."}`,
          );
        // a file is a path inside the project, from its root. the app offers to open it
        if (t === "file" && (ref.trim().startsWith("/") || ref.split(/[/\\]/).includes("..")))
          return bad(
            `file "${ref}" must be a path from the project root, like artifacts/report.md, with no ".."`,
          );
        out.push({ type: t, ref: oneLine(ref) });
      }
      args[name] = out;
    }
  }
  return { ok: true, args };
}
