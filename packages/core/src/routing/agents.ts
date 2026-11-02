import { DEFAULT_AGENTS } from "./defaults.ts";
import {
  AGENT_EFFORTS,
  AGENT_MODELS,
  type AgentEdit,
  type AgentEdits,
  type AgentEffort,
  type AgentModel,
  type AgentRow,
  type RoutingAgent,
} from "./types.ts";

export const AGENT_NAME = /^[a-z][a-z0-9-]{0,39}$/;
export const DESCRIPTION_MAX = 300;
export const PROMPT_MAX = 8000;

const FIELDS = ["description", "model", "effort", "prompt"] as const;

const isModel = (v: unknown): v is AgentModel => AGENT_MODELS.includes(v as AgentModel);
const isEffort = (v: unknown): v is AgentEffort => AGENT_EFFORTS.includes(v as AgentEffort);

/** the family a model id belongs to, for colour and a short label. undefined for one we do not know */
export function modelFamily(
  model: string | undefined,
): "opus" | "sonnet" | "haiku" | "fable" | undefined {
  const m = model?.toLowerCase() ?? "";
  for (const f of ["opus", "sonnet", "haiku", "fable"] as const) if (m.includes(f)) return f;
  return undefined;
}

/** the field's value if it is a good one for it, else undefined */
function field(key: (typeof FIELDS)[number], v: unknown): RoutingAgent[typeof key] | undefined {
  if (key === "model") return isModel(v) ? v : undefined;
  if (key === "effort") return isEffort(v) ? v : undefined;
  if (typeof v !== "string" || !v.trim()) return undefined;
  const text = v.trim();
  return text.length <= (key === "description" ? DESCRIPTION_MAX : PROMPT_MAX) ? text : undefined;
}

/** from the settings file: anything malformed is dropped, and a custom agent needs all four fields */
export function cleanEdits(raw: unknown): AgentEdits {
  const out: AgentEdits = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!AGENT_NAME.test(name) || typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const edit: AgentEdit = {};
    if (typeof v.enabled === "boolean") edit.enabled = v.enabled;
    for (const key of FIELDS) {
      const f = field(key, v[key]);
      if (f !== undefined) (edit as Record<string, unknown>)[key] = f;
    }
    if (!(name in DEFAULT_AGENTS) && FIELDS.some((k) => edit[k] === undefined)) continue;
    out[name] = edit;
  }
  return out;
}

/** every agent the editor lists: the shipped ones in their order, then theirs by name */
export function listAgents(edits: AgentEdits = {}): AgentRow[] {
  const rows: AgentRow[] = [];
  for (const [name, base] of Object.entries(DEFAULT_AGENTS)) {
    const e = edits[name] ?? {};
    rows.push({
      name,
      custom: false,
      enabled: e.enabled !== false,
      edited: FIELDS.some((k) => e[k] !== undefined && e[k] !== base[k]),
      description: e.description ?? base.description,
      model: e.model ?? base.model,
      effort: e.effort ?? base.effort,
      prompt: e.prompt ?? base.prompt,
    });
  }
  const own = Object.keys(edits)
    .filter((n) => !(n in DEFAULT_AGENTS))
    .sort();
  for (const name of own) {
    const e = edits[name] as RoutingAgent & { enabled?: boolean };
    rows.push({
      name,
      custom: true,
      enabled: e.enabled !== false,
      edited: false,
      description: e.description,
      model: e.model,
      effort: e.effort,
      prompt: e.prompt,
    });
  }
  return rows;
}

/** what goes to the sdk's `agents` option: the enabled ones, in its shape */
export function resolveAgents(edits: AgentEdits = {}): Record<string, RoutingAgent> {
  const out: Record<string, RoutingAgent> = {};
  for (const r of listAgents(edits)) {
    if (!r.enabled) continue;
    out[r.name] = {
      description: r.description,
      model: r.model,
      effort: r.effort,
      prompt: r.prompt,
    };
  }
  return out;
}

/** why a definition cannot be saved, or undefined. `isNew` also checks the name is free */
export function validateAgent(
  name: string,
  def: Partial<RoutingAgent>,
  edits: AgentEdits,
  isNew: boolean,
): string | undefined {
  if (!AGENT_NAME.test(name))
    return "use lowercase letters, digits and dashes, starting with a letter (40 at most)";
  if (isNew && (name in DEFAULT_AGENTS || name in edits)) return `${name} is taken`;
  if (!field("description", def.description))
    return `the description is needed, up to ${DESCRIPTION_MAX} characters`;
  if (!field("prompt", def.prompt)) return `the prompt is needed, up to ${PROMPT_MAX} characters`;
  if (!isModel(def.model)) return "pick haiku, sonnet or opus";
  if (!isEffort(def.effort)) return "pick medium, high, xhigh or max";
  return undefined;
}

/**
 * the edits after changing one agent. a field equal to the shipped one is not kept, so an agent
 * put back by hand is no longer "edited" and a later release's improvement reaches it. an edit
 * with nothing left is removed
 */
export function applyEdit(edits: AgentEdits, name: string, patch: AgentEdit): AgentEdits {
  const base = DEFAULT_AGENTS[name];
  const merged: AgentEdit = { ...edits[name], ...patch };
  if (base) {
    for (const k of FIELDS) if (merged[k] === base[k]) delete merged[k];
    if (merged.enabled === true) delete merged.enabled;
    if (Object.keys(merged).length === 0) {
      const { [name]: _gone, ...rest } = edits;
      return rest;
    }
  }
  return { ...edits, [name]: merged };
}

/** a shipped agent back to its default (still enabled), or one of theirs deleted */
export function resetAgent(edits: AgentEdits, name: string): AgentEdits {
  const { [name]: _gone, ...rest } = edits;
  return rest;
}
