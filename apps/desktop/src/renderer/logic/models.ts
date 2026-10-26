import type { ChatStatus } from "../../shared/ipc";

type Model = ChatStatus["models"][number];

/** the family a model is of: opus, sonnet, haiku, fable. anything else is a series of its own */
const FAMILY = /(opus|sonnet|haiku|fable)/;

const seriesOf = (m: Model): string => {
  const name = m.id ?? m.value;
  return FAMILY.exec(name)?.[1] ?? name;
};

/**
 * its version, from its id: claude-opus-5-5 is [5, 5], claude-sonnet-5 is [5]. a trailing date
 * (claude-haiku-4-5-20251001) is not part of it
 */
const versionOf = (m: Model): number[] =>
  (m.id ?? m.value)
    .split("-")
    .filter((p) => /^\d{1,3}$/.test(p))
    .map(Number);

/** a newer than b: 5.5 over 5, 5 over 4.8 */
function newer(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** an alias (`opus`) tracks the latest, so it wins a tie with the id it stands for */
const isAlias = (m: Model) => !m.value.startsWith("claude-");

/**
 * the model menu's rows: Default, then the newest of each series, in claude's order. the rest go
 * under More
 */
export function splitModels(models: readonly Model[]): { top: Model[]; more: Model[] } {
  const best = new Map<string, Model>();
  for (const m of models) {
    if (m.value === "default") continue;
    const key = seriesOf(m);
    const was = best.get(key);
    if (!was) {
      best.set(key, m);
      continue;
    }
    const d = newer(versionOf(m), versionOf(was));
    if (d > 0 || (d === 0 && isAlias(m) && !isAlias(was))) best.set(key, m);
  }
  const keep = new Set(best.values());
  return {
    top: models.filter((m) => m.value === "default" || keep.has(m)),
    more: models.filter((m) => m.value !== "default" && !keep.has(m)),
  };
}
