// argument checks. claude code shows the schema to the model and does not enforce it, so the
// package checks every call itself, for the MCP server and the CLI alike. small slips are
// repaired (a number sent as text, an id in lower case, a list sent as "a, b"). everything
// else is refused with the valid arguments and an example, so the next call is right.
import { normId, oneLine } from "./format.ts";

export interface Prop {
  type: "string" | "boolean" | "integer" | "ids" | "artifacts";
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

export function check(tool: string, spec: InputSpec, raw: unknown): Checked {
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
