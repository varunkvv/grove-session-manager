import {
  AGENT_EFFORTS,
  AGENT_MODELS,
  type AgentEdits,
  type AgentRow,
  applyEdit,
  listAgents,
  resetAgent,
} from "@grove/core/pure";
import { useEffect, useState } from "react";
import {
  type AgentFilter,
  type Draft,
  draftErrors,
  draftOf,
  FILTERS,
  filterRows,
  groupRows,
  isDirty,
  isValid,
  rowTitle,
  saveDraft,
} from "../logic/routing.ts";
import { useStore } from "../state/store.ts";
import {
  Button,
  cx,
  EditedDot,
  EFFORT_WORD,
  Field,
  Icon,
  IconButton,
  inputClass,
  Modal,
  Segmented,
  SidePane,
  Switch,
  TierDot,
  tierTint,
} from "./ui.tsx";

const NONE: AgentEdits = {};

/** the saved map, from the store: the chat window reads it from bootstrap, the main window by push */
export const useRoutingEdits = (): AgentEdits => useStore((s) => s.settings?.routingAgents) ?? NONE;

/** the map as saved now, not as drawn: two quick changes must both land */
const latest = (): AgentEdits => useStore.getState().settings?.routingAgents ?? NONE;

/** the whole map goes to main. an error comes back as a line, a save goes into the store at once */
async function persist(next: AgentEdits): Promise<string | undefined> {
  const res = await window.grove.updateSettings({ routingAgents: next });
  if (!res.ok) return res.error.message;
  useStore.getState().set({ settings: res.value });
  return undefined;
}

function AgentRowView({
  row,
  onOpen,
  onToggle,
}: {
  row: AgentRow;
  onOpen: () => void;
  onToggle: (on: boolean) => void;
}) {
  return (
    <li
      className="-mx-2 flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-raised"
      data-testid="routing-agent"
      data-name={row.name}
      data-enabled={row.enabled}
    >
      <span className="mt-[7px]">
        <TierDot model={row.model} on={row.enabled} />
      </span>
      <button
        type="button"
        title={rowTitle(row)}
        onClick={onOpen}
        className="no-drag min-w-0 flex-1 text-left"
      >
        <span className="flex items-center gap-1.5">
          <span className={cx("truncate", row.enabled ? "text-fg" : "text-fg-4")}>{row.name}</span>
          {row.edited && <EditedDot />}
        </span>
        <span className="block truncate text-sm text-fg-4">{row.description}</span>
      </button>
      <span className="pt-0.5">
        <Switch
          label={row.name}
          checked={row.enabled}
          onChange={onToggle}
          testId="routing-agent-switch"
        />
      </span>
    </li>
  );
}

function ListView({
  edits,
  onOpen,
  onNew,
  bare,
}: {
  edits: AgentEdits;
  onOpen: (name: string) => void;
  onNew: () => void;
  /** in a dialog: + New is here, there is no header for it */
  bare: boolean;
}) {
  const [filter, setFilter] = useState<AgentFilter>("all");
  const [error, setError] = useState<string>();
  const shown = filterRows(listAgents(edits), filter);
  const toggle = async (name: string, enabled: boolean) =>
    setError(await persist(applyEdit(latest(), name, { enabled })));
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-4 py-2">
        <Segmented
          label="Show"
          size="sm"
          value={filter}
          options={FILTERS.map((f) => ({
            value: f,
            label: f === "all" ? "All" : f === "on" ? "On" : "Off",
            testId: `routing-filter-${f}`,
          }))}
          onChange={setFilter}
        />
        <span className="flex-1" />
        {bare && (
          <Button size="sm" variant="quiet" onClick={onNew} data-testid="routing-new">
            + New
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        {error && <p className="mb-2 text-sm text-danger">{error}</p>}
        {shown.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-fg-4">
            Nothing here
            <Button size="sm" variant="quiet" onClick={() => setFilter("all")}>
              Show all
            </Button>
          </p>
        ) : (
          groupRows(shown).map((g) => (
            <section key={g.tier} className="mt-1.5" data-tier={g.tier}>
              <h4 className="text-meta text-fg-4">
                {g.tier} <span className="tabular-nums">{g.rows.length}</span>
              </h4>
              <ul>
                {g.rows.map((r) => (
                  <AgentRowView
                    key={r.name}
                    row={r}
                    onOpen={() => onOpen(r.name)}
                    onToggle={(on) => void toggle(r.name, on)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </>
  );
}

function EditView({
  row,
  edits,
  onBack,
}: {
  /** undefined: a new agent */
  row: AgentRow | undefined;
  edits: AgentEdits;
  onBack: () => void;
}) {
  const isNew = !row;
  const [draft, setDraft] = useState<Draft>(draftOf(row));
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const errors = draftErrors(draft, edits, isNew);
  const canSave = !busy && isDirty(draft, row) && isValid(draft, edits, isNew);
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const touch = (k: string) => setTouched(new Set(touched).add(k));
  // an error shows once the field was left, so a blank new agent starts clean
  const problem = (k: "name" | "description" | "prompt") =>
    touched.has(k) &&
    errors[k] && (
      <p className="mt-1 text-sm text-danger" data-testid={`routing-error-${k}`}>
        {errors[k]}
      </p>
    );

  const run = async (next: AgentEdits) => {
    setBusy(true);
    const failed = await persist(next);
    setBusy(false);
    if (failed) setError(failed);
    else onBack();
  };

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line pr-2 pl-2">
        <IconButton label="Back" onClick={onBack} data-testid="routing-back">
          <Icon name="chevron" size={12} className="rotate-180" />
        </IconButton>
        <h2 className="min-w-0 flex-1 truncate font-medium text-fg">
          {row ? row.name : "New agent"}
        </h2>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <div>
          <Field label="Name">
            <input
              className={cx(inputClass, "font-mono text-meta", row && !row.custom && "text-fg-3")}
              spellCheck={false}
              readOnly={!!row && !row.custom}
              data-autofocus={isNew || undefined}
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              onBlur={() => touch("name")}
              data-testid="routing-name"
            />
          </Field>
          {problem("name")}
        </div>
        <div>
          <Field label="Description">
            <input
              className={inputClass}
              value={draft.description}
              onChange={(e) => set({ description: e.target.value })}
              onBlur={() => touch("description")}
              data-testid="routing-description"
            />
          </Field>
          {problem("description")}
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium text-fg-2">Model</p>
          <Segmented
            label="Model"
            value={draft.model}
            options={AGENT_MODELS.map((m) => ({
              value: m,
              label: m,
              tint: tierTint(m),
              testId: `routing-model-${m}`,
            }))}
            onChange={(model) => set({ model })}
          />
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium text-fg-2">Effort</p>
          <Segmented
            label="Effort"
            value={draft.effort}
            options={AGENT_EFFORTS.map((e) => ({
              value: e,
              label: EFFORT_WORD[e] ?? e,
              testId: `routing-effort-${e}`,
            }))}
            onChange={(effort) => set({ effort })}
          />
        </div>
        <div>
          <Field label="Prompt">
            <textarea
              className={cx(inputClass, "h-60 resize-none py-2 font-mono text-meta")}
              spellCheck={false}
              value={draft.prompt}
              onChange={(e) => set({ prompt: e.target.value })}
              onBlur={() => touch("prompt")}
              data-testid="routing-prompt"
            />
          </Field>
          {problem("prompt")}
        </div>
      </div>
      {error && (
        <p className="shrink-0 px-4 pb-2 text-sm text-danger" data-testid="routing-save-error">
          {error}
        </p>
      )}
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-2.5">
        <Button
          variant="primary"
          disabled={!canSave}
          onClick={() => void run(saveDraft(latest(), draft))}
          data-testid="routing-save"
        >
          Save
        </Button>
        <Button variant="ghost" onClick={onBack}>
          Cancel
        </Button>
        <span className="flex-1" />
        {row && !row.custom && row.edited && (
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => void run(resetAgent(latest(), row.name))}
            data-testid="routing-reset"
          >
            Reset to default
          </Button>
        )}
        {row?.custom &&
          (confirming ? (
            <span className="flex items-center gap-1 text-sm text-fg-3">
              Delete?
              <Button
                size="sm"
                variant="quiet"
                className="text-danger"
                disabled={busy}
                onClick={() => void run(resetAgent(latest(), row.name))}
                data-testid="routing-delete-yes"
              >
                Yes
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>
                No
              </Button>
            </span>
          ) : (
            <Button
              variant="quiet"
              onClick={() => setConfirming(true)}
              data-testid="routing-delete"
            >
              Delete
            </Button>
          ))}
      </div>
    </>
  );
}

type Show = { kind: "list" } | { kind: "edit"; name?: string };

/**
 * the routing agents: the list, and one agent's edit view over it. `bare` is in a dialog, which
 * has its own title and close
 */
function AgentsPanel({
  bare,
  onClose,
  onEditing,
}: {
  bare?: boolean;
  onClose?: () => void;
  onEditing?: (editing: boolean) => void;
}) {
  const edits = useRoutingEdits();
  const [show, setShow] = useState<Show>({ kind: "list" });
  const editing = show.kind === "edit";
  useEffect(() => onEditing?.(editing), [editing, onEditing]);
  if (show.kind === "edit") {
    const row = show.name ? listAgents(edits).find((r) => r.name === show.name) : undefined;
    return (
      <EditView
        key={show.name ?? ""}
        row={row}
        edits={edits}
        onBack={() => setShow({ kind: "list" })}
      />
    );
  }
  return (
    <>
      {!bare && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
          <h2 className="flex-1 font-medium text-fg">Agents</h2>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => setShow({ kind: "edit" })}
            data-testid="routing-new"
          >
            + New
          </Button>
          <IconButton label="Close" onClick={() => onClose?.()} data-testid="routing-close">
            <Icon name="x" size={12} />
          </IconButton>
        </div>
      )}
      <ListView
        edits={edits}
        bare={!!bare}
        onOpen={(name) => setShow({ kind: "edit", name })}
        onNew={() => setShow({ kind: "edit" })}
      />
    </>
  );
}

/** the chat window's agents pane: the shell of the Outputs pane, wider while one is edited */
export function RoutingPane({ onClose }: { onClose: () => void }) {
  const [wide, setWide] = useState(false);
  return (
    // the editor asks for more room than a list: the width he dragged to still counts, as a floor
    <SidePane storageKey="grove.width.pane" fallback="320px" atLeast={wide ? 384 : undefined}>
      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-line bg-chrome"
        data-testid="routing-pane"
      >
        <AgentsPanel onClose={onClose} onEditing={setWide} />
      </section>
    </SidePane>
  );
}

/** the main window has no pane beside a conversation: the same panel, in a dialog */
export function RoutingDialog() {
  const open = useStore((s) => s.dialog?.kind === "routing");
  const set = useStore((s) => s.set);
  return (
    <Modal
      open={open}
      onClose={() => set({ dialog: null })}
      title="Routing agents"
      width={460}
      testId="routing-dialog"
    >
      <div className="-mx-5 flex h-[60vh] flex-col">
        <AgentsPanel bare />
      </div>
    </Modal>
  );
}
