import { formatRelativeTime } from "@grove/core/pure";
import { useEffect, useMemo, useState } from "react";
import type { SessionHit } from "../../shared/ipc.ts";
import {
  cap,
  type DayRange,
  familiesOf,
  filterOutputs,
  glyphOf,
  lookOf,
  type OutputFilter,
  type OutputGlyphKind,
  projectsOf,
  screenOutputs,
  shortKey,
} from "../logic/outputs.ts";
import { openSession } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { OutputFilters } from "./OutputFilters.tsx";
import { OutputGlyph } from "./ui.tsx";

const open = (url: string) => void window.grove.openExternal(url);

/** the sessions of the list the person came from: a project's, or every project's from home */
function useSessions(scope: string | null): SessionHit[] | null {
  const [hits, setHits] = useState<SessionHit[] | null>(null);
  useEffect(() => {
    let live = true;
    const ask = () =>
      void window.grove
        .listSessions(scope)
        .then((h) => live && setHits(h))
        .catch(() => {});
    ask();
    const off = window.grove.on("sessions:changed", ask);
    return () => {
      live = false;
      off();
    };
  }, [scope]);
  return hits;
}

/** what the sessions made, newest first, with the session it came from. the lineage in one list */
export function OutputsScreen() {
  // always every project's sessions: a project is a filter here, not the scope
  const now = useStore((s) => s.now);
  const hits = useSessions(null);
  const entries = useMemo(() => screenOutputs(hits ?? []), [hits]);
  const families = familiesOf(entries);
  const projects = projectsOf(entries);
  const [pick, setPick] = useState<{ projects: string[]; kinds: OutputGlyphKind[] }>({
    projects: [],
    kinds: [],
  });
  const [range, setRange] = useState<DayRange>({});
  // a filter that left the list is no filter
  const filter: OutputFilter = {
    projects: pick.projects.filter((p) => projects.some((x) => x.name === p)),
    kinds: pick.kinds.filter((k) => families.some((f) => f.glyph === k)),
    ...range,
  };
  const shown = filterOutputs(entries, filter);

  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]" data-testid="outputs">
      <div className="mx-auto max-w-[920px] px-6 pt-8 pb-16">
        <div className="flex items-center gap-3">
          <h1 className="text-title font-semibold">Outputs</h1>
          <span className="text-sm text-fg-3">all sessions</span>
        </div>
        <OutputFilters
          projects={projects}
          families={families}
          picked={filter}
          range={range}
          now={now}
          onProjects={(next) => setPick({ ...pick, projects: next })}
          onKinds={(next) => setPick({ ...pick, kinds: next })}
          onRange={setRange}
        />
        {hits && shown.length === 0 && (
          <p className="mt-6 text-fg-3" data-testid="outputs-empty">
            Nothing made yet.
          </p>
        )}
        <ul className="mt-4">
          {shown.map(({ o, session }, i) => (
            <li
              key={o.url ?? `${o.key}${i}`}
              data-testid="output-row"
              data-kind={o.kind}
              className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 hover:bg-raised"
            >
              <button
                type="button"
                disabled={!o.url}
                title={o.url}
                data-testid="output-open"
                onClick={() => o.url && open(o.url)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-fg-3 enabled:hover:text-fg"
              >
                <OutputGlyph kind={glyphOf(o.kind)} {...(o.pr ? { look: lookOf(o.pr) } : {})} />
                <span className="w-28 shrink-0 truncate">{cap(o.label)}</span>
                {o.key && <span className="shrink-0 tabular-nums text-fg-2">{shortKey(o)}</span>}
                <span className="min-w-0 truncate text-fg">{o.title ?? ""}</span>
                {o.description && (
                  <span className="min-w-0 flex-1 truncate text-fg-4">{o.description}</span>
                )}
              </button>
              <span className="w-20 shrink-0 text-sm text-fg-3">{o.verb}</span>
              <button
                type="button"
                title={session.title}
                data-testid="output-session"
                onClick={() => openSession(session.key, session.open, session.title)}
                className="fade w-52 shrink-0 truncate text-left text-sm text-fg-3 hover:text-fg"
              >
                {session.title}
                {o.agent ? ` · ${o.agent}` : ""}
              </button>
              <span className="w-16 shrink-0 text-right text-sm tabular-nums text-fg-4">
                {formatRelativeTime(o.last, now)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
