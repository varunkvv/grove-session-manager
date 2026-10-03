import type { AgentRef } from "@grove/core/pure";

/** what the avatar and the name cells take */
export interface WhoView {
  kind: "person" | "agent";
  /** what the colour is hashed from: a display name changes, the session id does not */
  id: string;
  name: string;
}

/** "person" is you. an agent is its session id, plus `/` and its `as` when a subagent wrote it */
export function whoView(ref: AgentRef | "person" | undefined): WhoView | undefined {
  if (ref === undefined) return undefined;
  if (ref === "person") return { kind: "person", id: "person", name: "you" };
  return {
    kind: "agent",
    id: ref.sub ? `${ref.sessionId}/${ref.sub}` : ref.sessionId,
    name: ref.name,
  };
}

/** 32-bit FNV-1a over the UTF-16 code units */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** which of the nine avatar fills an agent gets, 1 to 9 */
export const agentHue = (id: string): number => (fnv1a(id) % 9) + 1;

/** `idp config` IC, `chat-features-35` CF, `Explore` E, nothing `?` */
export function initials(name: string): string {
  const parts = name.split(/[\s\-_./]+/).filter(Boolean);
  return (
    parts
      .slice(0, 2)
      .map((p) => [...p][0])
      .join("")
      .toUpperCase() || "?"
  );
}
