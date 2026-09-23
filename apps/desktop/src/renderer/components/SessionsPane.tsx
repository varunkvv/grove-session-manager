import { useCallback, useEffect, useMemo, useRef } from "react";
import type { SessionKey } from "../../shared/ipc.ts";
import {
  ARCHIVED_FILTER,
  buildList,
  type ListModel,
  nextActiveKey,
  splitQuery,
} from "../logic/rows.ts";
import {
  activate,
  agentHit,
  focusSearch,
  openAgent,
  openCombo,
  openInspector,
  openMenu,
} from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { Banner } from "./Chrome.tsx";
import { optionId, SessionList } from "./SessionList.tsx";
import { Button, Icon, Kbd, Segmented, Spinner } from "./ui.tsx";

const LIST_ID = "session-listbox";

/** the list the keyboard handler in App works against. kept outside React so a keypress never waits for a render. */
export const listRef: { current: ListModel; pageSize: number } = {
  current: {
    items: [],
    keys: [],
    tokens: [],
    elsewhere: 0,
    scoped: false,
    archivedHidden: 0,
    archivedOnly: false,
  },
  pageSize: 8,
};

/** adds `is:archived` to whatever is in the box, so the hidden rows join what is already on screen */
function showArchived(): void {
  const { query, set } = useStore.getState();
  if (!splitQuery(query).archivedOnly) set({ query: `${query.trim()} ${ARCHIVED_FILTER}`.trim() });
  focusSearch(false);
}

/**
 * the one line that says what this list is leaving out. a result is never silently hidden: not by
 * the combo scope, and not by the archive.
 */
function HiddenMatches({ model }: { model: ListModel }) {
  const set = useStore((s) => s.set);
  const elsewhere = model.scoped && model.elsewhere > 0;
  if (!elsewhere && model.archivedHidden === 0) return null;
  return (
    <div className="fade flex shrink-0 items-center gap-4 border-t border-line px-5 py-2 text-sm text-fg-3">
      {elsewhere && (
        <button
          type="button"
          data-testid="search-all"
          onClick={() => set({ scope: "all" })}
          className="fade text-left hover:text-fg-2"
        >
          {model.elsewhere} more {model.elsewhere === 1 ? "match" : "matches"} in all sessions
        </button>
      )}
      {model.archivedHidden > 0 && (
        <button
          type="button"
          data-testid="show-archived"
          onClick={showArchived}
          className="fade text-left hover:text-fg-2"
        >
          {model.archivedHidden} archived
        </button>
      )}
    </div>
  );
}

function EmptyState({ model }: { model: ListModel }) {
  const { query, selectedCombo, sessions, env, editor, index, set, scope } = useStore();
  const label = editor?.label ?? "the editor";
  if (scope === "agents") {
    const q = splitQuery(query).text.trim();
    return (
      <Empty title={q ? `No agents match "${q}"` : "No agents yet"}>
        {!q && <p>Sessions that send agents out show them here, running ones first.</p>}
        {model.archivedHidden > 0 && (
          <Button className="mt-4" onClick={showArchived} data-testid="show-archived">
            Show {model.archivedHidden} in archived sessions
          </Button>
        )}
      </Empty>
    );
  }
  if (query.trim()) {
    return (
      <Empty title={`No sessions match "${query.trim()}"`}>
        {model.scoped && model.elsewhere > 0 && (
          <>
            <p>
              {model.elsewhere} {model.elsewhere === 1 ? "match" : "matches"} in all sessions.
            </p>
            <Button className="mt-4" onClick={() => set({ scope: "all" })} data-testid="search-all">
              Search all sessions
            </Button>
          </>
        )}
        {model.archivedHidden > 0 && (
          <Button className="mt-4" onClick={showArchived} data-testid="show-archived">
            Search {model.archivedHidden} archived{" "}
            {model.archivedHidden === 1 ? "session" : "sessions"}
          </Button>
        )}
      </Empty>
    );
  }
  if (model.archivedHidden > 0) {
    return (
      <Empty title="Everything here is archived">
        <Button className="mt-4" onClick={showArchived} data-testid="show-archived">
          Show {model.archivedHidden} archived {model.archivedHidden === 1 ? "session" : "sessions"}
        </Button>
      </Empty>
    );
  }
  if (model.scoped && selectedCombo) {
    return (
      <Empty title={`No sessions in ${selectedCombo} yet`}>
        <p>Open the combo and start a conversation in {label}. It shows up here on its own.</p>
        <Button variant="primary" className="mt-4" onClick={() => void openCombo(selectedCombo)}>
          Open in {label}
        </Button>
      </Empty>
    );
  }
  if (sessions.length === 0 && index.phase !== "idle" && index.phase !== "degraded") {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-fg-3">
        <Spinner /> Reading sessions
      </div>
    );
  }
  return (
    <Empty title="No Claude Code sessions found">
      <p>
        Looked in{" "}
        <span className="font-mono text-meta">{env?.projectsDir ?? "~/.claude/projects"}</span>. New
        sessions appear here within a second of your first message.
      </p>
    </Empty>
  );
}

function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center px-10 text-center"
      data-testid="list-empty"
    >
      <h2 className="text-hero font-semibold">{title}</h2>
      <div className="mt-2 max-w-md text-fg-3">{children}</div>
    </div>
  );
}

export function SessionsPane() {
  const sessions = useStore((s) => s.sessions);
  const scope = useStore((s) => s.scope);
  const selectedCombo = useStore((s) => s.selectedCombo);
  const combos = useStore((s) => s.combos);
  const query = useStore((s) => s.query);
  const deepState = useStore((s) => s.deep);
  const activeKey = useStore((s) => s.activeKey);
  const now = useStore((s) => s.now);
  const index = useStore((s) => s.index);
  const set = useStore((s) => s.set);
  const setScope = useStore((s) => s.setScope);

  // the instant filter covers titles and prompts. the conversation itself is searched in main,
  // a moment later, and its hits join the list without moving what is already there.
  useEffect(() => {
    // `is:archived` is a mode, not a word: sending it to main would match nothing and the
    // conversation search would quietly stop working for as long as it sat in the box
    const q = splitQuery(query).text;
    if (!q) return;
    const timer = setTimeout(() => {
      void window.grove
        .searchSessions(q)
        .then((res) => {
          if (splitQuery(useStore.getState().query).text !== res.query) return;
          set({
            deep: { query: res.query, hits: new Map(res.hits.map((h) => [h.key, h])) },
          });
        })
        .catch(() => {});
    }, 180);
    return () => clearTimeout(timer);
  }, [query, set]);
  const deep = deepState && deepState.query === splitQuery(query).text ? deepState.hits : undefined;

  const model = useMemo(
    () =>
      buildList(sessions, {
        scope,
        combo: selectedCombo,
        query,
        now,
        ...(deep ? { deep } : {}),
      }),
    [sessions, scope, selectedCombo, query, now, deep],
  );

  // keep the active row stable across live updates. a new query starts again from the top.
  const prev = useRef({ keys: [] as SessionKey[], query, scope, combo: selectedCombo });
  useEffect(() => {
    const p = prev.current;
    const reset = p.query !== query || p.scope !== scope || p.combo !== selectedCombo;
    const next = nextActiveKey(p.keys, model.keys, useStore.getState().activeKey, reset);
    prev.current = { keys: model.keys, query, scope, combo: selectedCombo };
    if (next !== useStore.getState().activeKey) set({ activeKey: next });
  }, [model, query, scope, selectedCombo, set]);

  listRef.current = model;
  const onPageSize = useCallback((rows: number) => {
    listRef.pageSize = rows;
  }, []);
  const onActivate = useCallback((key: SessionKey) => void activate(key), []);
  const onMenu = useCallback((key: SessionKey) => void openMenu(key), []);
  const onInspect = useCallback(
    (key: SessionKey, agent?: string) => {
      if (!agent) return openInspector(key);
      set({ activeKey: key });
      openAgent(key, agent, { find: agentHit(key)?.find ?? "" });
    },
    [set],
  );

  const scanning = index.phase === "scanning" || index.phase === "cache";
  const anyAgents = useMemo(() => sessions.some((r) => (r.agents?.length ?? 0) > 0), [sessions]);
  const noun = scope === "agents" ? "agent" : "session";

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-canvas"
      aria-label="Sessions"
    >
      {/* a container: with the inspector open beside it, the search field keeps its room */}
      <header className="drag @container flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-4">
        {(combos.length > 0 || anyAgents) && (
          <Segmented
            label="Scope"
            value={
              scope === "agents" ? "agents" : scope === "combo" && selectedCombo ? "combo" : "all"
            }
            onChange={(v) => {
              setScope(v);
              focusSearch(false);
            }}
            options={[
              ...(combos.length > 0
                ? [
                    {
                      value: "combo" as const,
                      label: selectedCombo ?? "Combo",
                      disabled: !selectedCombo,
                      testId: "scope-combo",
                    },
                  ]
                : []),
              {
                value: "all" as const,
                label: "All sessions",
                short: "Sessions",
                testId: "scope-all",
              },
              { value: "agents" as const, label: "Agents", testId: "scope-agents" },
            ]}
          />
        )}
        <div className="no-drag relative flex h-8 min-w-0 flex-1 items-center rounded-md bg-raised px-2.5 focus-within:bg-active">
          <Icon name="search" className="text-fg-3" />
          <input
            id="search"
            data-testid="search"
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
            aria-label={scope === "agents" ? "Search agents" : "Search sessions"}
            spellCheck={false}
            autoComplete="off"
            placeholder={
              scope === "agents"
                ? "Search agents - what they were for, what they found, the session"
                : "Search sessions - anything said, files touched, combo, branch, #PR"
            }
            value={query}
            onChange={(e) => set({ query: e.target.value })}
            className="h-full min-w-0 flex-1 bg-transparent px-2 text-body text-fg placeholder:text-fg-4"
          />
          {scanning ? <Spinner /> : !query && <Kbd>/</Kbd>}
        </div>
        <span
          className="no-drag shrink-0 text-sm tabular-nums text-fg-3 @max-xl:hidden"
          aria-live="polite"
          data-testid="result-count"
        >
          {model.keys.length} {model.keys.length === 1 ? noun : `${noun}s`}
        </span>
      </header>
      <Banner />

      {model.keys.length === 0 ? (
        <EmptyState model={model} />
      ) : (
        <>
          <SessionList
            items={model.items}
            tokens={model.tokens}
            activeKey={activeKey}
            now={now}
            listId={LIST_ID}
            total={model.keys.length}
            onActivate={onActivate}
            onMenu={onMenu}
            onInspect={onInspect}
            onPageSize={onPageSize}
          />
          <HiddenMatches model={model} />
        </>
      )}

      <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-line px-5 text-meta text-fg-4">
        <span className="shrink-0 whitespace-nowrap">
          <Kbd>↵</Kbd> open
        </span>
        <span className="shrink-0 whitespace-nowrap">
          <Kbd>⌘K</Kbd> actions
        </span>
        <span className="ml-auto truncate">
          Claude Code deletes transcripts after 30 days. Sessions the editor panel archived still
          show here, unless you archive them.
        </span>
      </footer>
    </section>
  );
}
