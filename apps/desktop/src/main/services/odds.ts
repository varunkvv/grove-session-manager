// judgment day odds for the Usage screen, from the scores grove keeps: the ledger over each day's
// judged prompts, over each session's, and the session judged last. numbers and titles only.
import {
  fromKept,
  ledgerSeries,
  localDay,
  type ModelEntry,
  promptPoints,
  type Rubric,
  readAnswer,
  type ScoreFile,
  scoreKey,
} from "@grove/core";
import type { OddsSession, OddsView, ProjectId } from "../../shared/ipc.ts";

/** how many judged prompts the cache holds, and how many prompts there are to judge */
export function oddsProgress(file: ScoreFile): { prompts: number; scored: number } {
  let prompts = 0;
  let scored = 0;
  for (const st of Object.values(file.files)) {
    if (st.ignored) continue;
    for (const p of st.prompts) {
      if (p.short) continue;
      prompts++;
      if (file.scores[scoreKey(p)]) scored++;
    }
  }
  return { prompts, scored };
}

export function buildOddsView(o: {
  file: ScoreFile;
  rubric: Rubric;
  model: Pick<ModelEntry, "calibration" | "tieMargin">;
  /** a transcript's title and project, or null when grove no longer lists it */
  place: (path: string) => { title: string; project: ProjectId | null } | null;
}): OddsView {
  const { ledger } = o.rubric;
  const judged: Array<{ path: string; at: number; points: number }> = [];
  for (const [path, st] of Object.entries(o.file.files)) {
    if (st.ignored) continue;
    for (const p of st.prompts) {
      const kept = p.short ? undefined : o.file.scores[scoreKey(p)];
      // too long for the model: it stays out of the ledger, like a short one
      if (!kept?.p.length) continue;
      const probs = readAnswer(o.rubric, fromKept(o.rubric, kept), o.model);
      judged.push({ path, at: p.at, points: promptPoints(ledger, probs) });
    }
  }
  judged.sort((a, b) => a.at - b.at);

  const bySession = new Map<string, { at: number; points: number[] }>();
  const byDay = new Map<string, number[]>();
  for (const j of judged) {
    const s = bySession.get(j.path) ?? { at: 0, points: [] };
    s.at = j.at;
    s.points.push(j.points);
    bySession.set(j.path, s);
    const day = localDay(j.at);
    const d = byDay.get(day) ?? [];
    d.push(j.points);
    byDay.set(day, d);
  }

  const sessions: OddsSession[] = [];
  let current: OddsView["current"];
  for (const [path, s] of bySession) {
    const series = ledgerSeries(ledger, s.points);
    const end = series.at(-1) ?? ledger.start;
    if (!current || s.at > current.at) current = { key: path, odds: end, at: s.at };
    const where = o.place(path);
    if (where) sessions.push({ key: path, ...where, day: localDay(s.at), at: s.at, series });
  }
  return {
    days: [...byDay]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, points]) => ({
        day,
        odds: ledgerSeries(ledger, points).at(-1) ?? ledger.start,
        prompts: points.length,
      })),
    sessions: sessions.sort((a, b) => a.at - b.at),
    ...(current ? { current } : {}),
    ...oddsProgress(o.file),
  };
}
