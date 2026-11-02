/** the tiers a routing agent can pin. 'inherit' is left out: an agent that follows the parent routes nothing */
export const AGENT_MODELS = ["haiku", "sonnet", "opus"] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

/** never low: a cheap model on low effort is a false saving */
export const AGENT_EFFORTS = ["medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

/** what the sdk's `agents` option takes for one agent, without the fields grove never sets */
export interface RoutingAgent {
  description: string;
  model: AgentModel;
  effort: AgentEffort;
  prompt: string;
}

/**
 * what a person changed. for a shipped agent it is a partial over the default, so a later grove
 * release can still improve the fields they left alone. for an agent of their own it is the whole
 * definition. `enabled` absent is on.
 */
export type AgentEdit = Partial<RoutingAgent> & { enabled?: boolean };
export type AgentEdits = Record<string, AgentEdit>;

/** one row of the editor: the default and the edit, merged */
export interface AgentRow extends RoutingAgent {
  name: string;
  /** theirs, not one grove ships */
  custom: boolean;
  enabled: boolean;
  /** a shipped agent with any field changed */
  edited: boolean;
}
