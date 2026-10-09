// the Usage screen's numbers: every counted session's day buckets, folded into one row per day.
// nothing here reads a transcript. the scan did, and the index keeps what it found.
import {
  agentIdOfTally,
  assignCombos,
  type Combo,
  costOf,
  localDay,
  type SessionRecord,
  tokenTotal,
  type UsageSource,
} from "@grove/core";
import type { ProjectId, UsageCell, UsageDay, UsageView } from "../../shared/ipc.ts";

/** how far back the view goes: a year, and the year before it for the year's change line */
const DAYS = 730;

const cell = (): UsageCell => ({ tokens: [0, 0, 0, 0, 0], cost: 0, ms: 0 });

interface Building {
  projects: Map<ProjectId | null, UsageCell>;
  models: Map<string, UsageCell>;
  sessions: Set<number>;
  subagents: number;
  /** how many files worked in each 5-minute slot of the day */
  slots: Uint16Array;
  longest: number;
  unpriced: number;
}

/**
 * `projectOf` is combo name -> project id, as the projects list has it. a session in no project,
 * or in a combo the list does not show, is in none
 */
export function buildUsageView(o: {
  sources: readonly UsageSource[];
  combos: readonly Combo[];
  projectOf: ReadonlyMap<string, ProjectId>;
  progress: { counted: number; total: number };
  now: number;
}): UsageView {
  const from = localDay(new Date(o.now).setDate(new Date(o.now).getDate() - DAYS));
  // membership is by cwd, the same call the session rows are made with
  const placed = assignCombos(
    o.sources.map((s) => ({ cwd: s.cwd, projectDirName: s.projectDirName }) as SessionRecord),
    o.combos,
  );
  const days = new Map<string, Building>();
  const on = (day: string): Building => {
    let d = days.get(day);
    if (!d) {
      d = {
        projects: new Map(),
        models: new Map(),
        sessions: new Set(),
        subagents: 0,
        slots: new Uint16Array(288),
        longest: 0,
        unpriced: 0,
      };
      days.set(day, d);
    }
    return d;
  };
  const into = <K>(map: Map<K, UsageCell>, key: K): UsageCell => {
    let c = map.get(key);
    if (!c) {
      c = cell();
      map.set(key, c);
    }
    return c;
  };

  o.sources.forEach((source, n) => {
    const project = o.projectOf.get(placed[n]?.comboName ?? "") ?? null;
    for (const [rel, byDay] of Object.entries(source.files)) {
      // an agent is counted once, on the day it started
      const first = agentIdOfTally(rel) ? Object.keys(byDay).sort()[0] : undefined;
      for (const [day, tally] of Object.entries(byDay)) {
        if (day < from) continue;
        // a response taken back out of a day leaves a model of zeros behind
        const used = Object.entries(tally.models).filter(([, c]) => tokenTotal(c) > 0 || c.ms > 0);
        if (used.length === 0) continue;
        const d = on(day);
        for (const [model, c] of used) {
          const cost = costOf(model, c);
          if (cost === null) d.unpriced += tokenTotal(c);
          for (const to of [into(d.projects, project), into(d.models, model)]) {
            to.tokens[0] += c.input;
            to.tokens[1] += c.output;
            to.tokens[2] += c.cacheRead;
            to.tokens[3] += c.cacheWrite - c.cacheWrite1h;
            to.tokens[4] += c.cacheWrite1h;
            to.cost += cost ?? 0;
            to.ms += c.ms;
          }
        }
        d.sessions.add(n);
        if (day === first) d.subagents++;
        d.longest = Math.max(d.longest, tally.turn ?? 0);
        (tally.slots ?? []).forEach((word, w) => {
          for (let b = 0; b < 32; b++) if ((word >>> b) & 1) d.slots[w * 32 + b]!++;
        });
      }
    }
  });

  return {
    ...o.progress,
    days: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([day, d]): UsageDay => ({
          day,
          projects: [...d.projects].map(([project, c]) => ({ project, ...c })),
          models: [...d.models].map(([model, c]) => ({ model, ...c })),
          sessions: [...d.sessions],
          subagents: d.subagents,
          peak: Math.max(0, ...d.slots),
          longest: d.longest,
          unpriced: d.unpriced,
        }),
      ),
  };
}
