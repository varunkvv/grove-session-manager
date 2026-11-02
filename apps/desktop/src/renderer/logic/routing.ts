import {
  type AgentEdits,
  type AgentEffort,
  type AgentModel,
  type AgentRow,
  applyEdit,
  validateAgent,
} from "@grove/core/pure";

export type AgentFilter = "all" | "on" | "off";

export const FILTERS: AgentFilter[] = ["all", "on", "off"];

/** the tiers in the order the list shows them: cheapest first */
export const TIERS: AgentModel[] = ["haiku", "sonnet", "opus"];

export const enabledCount = (rows: readonly AgentRow[]): number =>
  rows.filter((r) => r.enabled).length;

export const filterRows = (rows: readonly AgentRow[], filter: AgentFilter): AgentRow[] =>
  rows.filter((r) => filter === "all" || r.enabled === (filter === "on"));

/** the rows under a header each, a tier with none left out */
export function groupRows(
  rows: readonly AgentRow[],
): Array<{ tier: AgentModel; rows: AgentRow[] }> {
  return TIERS.map((tier) => ({ tier, rows: rows.filter((r) => r.model === tier) })).filter(
    (g) => g.rows.length > 0,
  );
}

/** what the edit view holds: the fields of one agent, as typed */
export interface Draft {
  name: string;
  description: string;
  model: AgentModel;
  effort: AgentEffort;
  prompt: string;
}

export const BLANK: Draft = {
  name: "",
  description: "",
  model: "haiku",
  effort: "medium",
  prompt: "",
};

export const draftOf = (row: AgentRow | undefined): Draft =>
  row
    ? {
        name: row.name,
        description: row.description,
        model: row.model,
        effort: row.effort,
        prompt: row.prompt,
      }
    : BLANK;

export const isDirty = (draft: Draft, row: AgentRow | undefined): boolean => {
  const base = draftOf(row);
  return (Object.keys(base) as Array<keyof Draft>).some((k) => draft[k] !== base[k]);
};

export interface DraftErrors {
  name?: string;
  description?: string;
  prompt?: string;
}

const OK = { description: "x", prompt: "x", model: "haiku", effort: "medium" } as const;

/** validateAgent says one thing at a time: each field is asked with the others held good */
export function draftErrors(draft: Draft, edits: AgentEdits, isNew: boolean): DraftErrors {
  const name = validateAgent(draft.name, OK, edits, isNew);
  const description = validateAgent("a", { ...OK, description: draft.description }, {}, false);
  const prompt = validateAgent("a", { ...OK, prompt: draft.prompt }, {}, false);
  return {
    ...(name && { name }),
    ...(description && { description }),
    ...(prompt && { prompt }),
  };
}

export const isValid = (draft: Draft, edits: AgentEdits, isNew: boolean): boolean =>
  Object.keys(draftErrors(draft, edits, isNew)).length === 0;

/** the edits once a draft is saved: applyEdit drops what a shipped agent has as default */
export function saveDraft(edits: AgentEdits, draft: Draft): AgentEdits {
  const { name, ...fields } = draft;
  return applyEdit(edits, name, fields);
}

/** the row's hover title: its model and effort, which the row itself leaves out */
export const rowTitle = (r: AgentRow): string => `${r.model} · ${r.effort}`;
