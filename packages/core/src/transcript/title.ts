import type { ParsedMeta, TitleSource } from "../types.ts";

export const TITLE_MAX = 200;
export const PROMPT_MAX = 500;

export function squash(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const PRECEDENCE: TitleSource[] = [
  "customTitle",
  "agentName",
  "aiTitle",
  "summary",
  "firstPrompt",
  "lastPrompt",
  "firstCommand",
];

/** explicit name > generated title > summary > what the person first typed */
export function pickTitle(meta: Partial<ParsedMeta>): {
  title?: string;
  titleSource?: TitleSource;
} {
  for (const source of PRECEDENCE) {
    const value = meta[source];
    if (typeof value === "string" && value.trim()) {
      return { title: squash(value, TITLE_MAX), titleSource: source };
    }
  }
  return {};
}
