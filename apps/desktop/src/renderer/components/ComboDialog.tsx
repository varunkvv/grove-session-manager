import { COMBO_RESERVED_NAMES, comboDirSlug, validateBranchName } from "@grove/core/pure";
import { useEffect, useMemo, useState } from "react";
import type { ComboDraft, FolderDraft, FrequentFolder, PathInfoView } from "../../shared/ipc.ts";
import { useStore } from "../state/store.ts";
import {
  Button,
  cx,
  Field,
  Icon,
  IconButton,
  inputClass,
  Modal,
  Mono,
  Segmented,
  Select,
  Spinner,
} from "./ui.tsx";

type BranchKind = "detach" | "new" | "existing";

interface Card {
  path: string;
  info?: PathInfoView;
  mode: "worktree" | "reference";
  branchKind: BranchKind;
  newBranch: string;
  existingBranch: string;
  as: string;
  /** already part of the combo. its mode and branch are fixed: remove and re-add to change them. */
  frozen: boolean;
}

function baseName(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function toDraft(card: Card): FolderDraft {
  if (card.mode === "reference") return { path: card.path, mode: "reference" };
  const branch =
    card.branchKind === "new"
      ? ({ kind: "new", name: card.newBranch.trim() } as const)
      : card.branchKind === "existing"
        ? ({ kind: "existing", name: card.existingBranch } as const)
        : ({ kind: "detach" } as const);
  return {
    path: card.path,
    mode: "worktree",
    branch,
    ...(card.as.trim() ? { as: card.as.trim() } : {}),
  };
}

function FolderCard({
  card,
  needsName,
  onChange,
  onRemove,
}: {
  card: Card;
  needsName: "clash" | "reserved" | null;
  onChange: (patch: Partial<Card>) => void;
  onRemove: () => void;
}) {
  const info = card.info;
  const canWorktree = info?.canBeWorktree ?? false;
  const branchError =
    card.mode === "worktree" && card.branchKind === "new"
      ? validateBranchName(card.newBranch.trim())
      : null;
  const taken = info?.branches.find((b) => b.name === card.newBranch.trim());

  return (
    <div className="rounded-md border border-line bg-canvas p-3" data-testid="folder-card">
      <div className="flex items-center gap-2">
        <Icon name={card.mode === "worktree" ? "branch" : "folder"} className="text-fg-3" />
        <span className="font-medium">{baseName(card.path)}</span>
        <Mono className="min-w-0 flex-1 truncate text-fg-3" title={card.path}>
          {card.path}
        </Mono>
        {!info && <Spinner />}
        <IconButton label="Remove from combo" onClick={onRemove}>
          <Icon name="x" />
        </IconButton>
      </div>

      {info && !info.exists && (
        <p className="mt-2 text-sm text-accent">This folder no longer exists.</p>
      )}

      {info && (
        <div className="mt-3 flex items-center gap-3">
          <Segmented
            label="How to include this folder"
            value={card.mode}
            onChange={(mode) => onChange({ mode })}
            options={[
              {
                value: "reference",
                label: "Reference",
                disabled: card.frozen,
                testId: "mode-reference",
              },
              {
                value: "worktree",
                label: "Working copy",
                disabled: card.frozen || !canWorktree,
                testId: "mode-worktree",
              },
            ]}
          />
          <span className="text-meta text-fg-3">
            {card.frozen
              ? "Already in this combo. Remove and re-add to change it."
              : !info.isGitRepo
                ? "Not a git repository, so it can only be added as a reference."
                : !canWorktree
                  ? "Not the top level of a repository, so it can only be a reference."
                  : card.mode === "reference"
                    ? "Context to read. Points at your real clone."
                    : "A place to edit, inside the combo folder."}
          </span>
        </div>
      )}

      {info && card.mode === "worktree" && !card.frozen && (
        <div className="mt-3 space-y-2 border-t border-line pt-3">
          <p className="text-sm text-fg-3">
            A working copy is a fresh git worktree. It starts clean: your uncommitted changes,
            running dev servers and editor state stay in the original clone.
          </p>
          <BranchOption
            checked={card.branchKind === "detach"}
            onSelect={() => onChange({ branchKind: "detach" })}
            title="Detached at HEAD"
            testId="branch-detach"
          >
            No branch is created, so it can never collide with another combo.
          </BranchOption>
          <BranchOption
            checked={card.branchKind === "new"}
            onSelect={() => onChange({ branchKind: "new" })}
            title="New branch"
            testId="branch-new"
          >
            {card.branchKind === "new" && (
              <>
                <input
                  className={cx(inputClass, "mt-1.5 font-mono text-meta")}
                  value={card.newBranch}
                  spellCheck={false}
                  onChange={(e) => onChange({ newBranch: e.target.value })}
                  data-testid="new-branch-name"
                />
                {branchError && <span className="mt-1 block text-accent">{branchError}</span>}
                {!branchError && taken && (
                  <span className="mt-1 block">
                    {taken.checkedOutAt
                      ? `That branch is checked out at ${taken.checkedOutAt}. Pick another name.`
                      : "That branch already exists. It will be checked out here instead of created."}
                  </span>
                )}
              </>
            )}
          </BranchOption>
          <BranchOption
            checked={card.branchKind === "existing"}
            onSelect={() =>
              onChange({
                branchKind: "existing",
                existingBranch:
                  card.existingBranch || (info.branches.find((b) => !b.checkedOutAt)?.name ?? ""),
              })
            }
            title="Existing branch"
            testId="branch-existing"
          >
            {card.branchKind === "existing" && (
              <Select
                wrapClassName="mt-1.5"
                className="font-mono text-meta"
                value={card.existingBranch}
                onChange={(e) => onChange({ existingBranch: e.target.value })}
                data-testid="existing-branch"
              >
                {info.branches.map((b) => (
                  // a branch can only be checked out in one worktree. that is git's rule.
                  <option key={b.name} value={b.name} disabled={Boolean(b.checkedOutAt)}>
                    {b.name}
                    {b.checkedOutAt ? `  (checked out at ${b.checkedOutAt})` : ""}
                  </option>
                ))}
              </Select>
            )}
          </BranchOption>
        </div>
      )}

      {card.mode === "worktree" && !card.frozen && (needsName || card.as) && (
        <div className="mt-3">
          <Field
            label="Folder name inside the combo"
            hint={
              needsName === "clash"
                ? "Two folders share this name. One of them needs another."
                : needsName === "reserved"
                  ? "The combo folder uses this name itself, for plans, artifacts or shared context."
                  : undefined
            }
          >
            <input
              className={cx(inputClass, "font-mono text-meta")}
              value={card.as}
              spellCheck={false}
              onChange={(e) => onChange({ as: e.target.value })}
              data-testid="folder-as"
            />
          </Field>
        </div>
      )}
    </div>
  );
}

function BranchOption({
  checked,
  onSelect,
  title,
  children,
  testId,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  children?: React.ReactNode;
  testId: string;
}) {
  return (
    <label className="flex cursor-default items-start gap-2.5">
      <input
        type="radio"
        checked={checked}
        onChange={onSelect}
        className="mt-1"
        data-testid={testId}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-body text-fg">{title}</span>
        <span className="block text-meta text-fg-3">{children}</span>
      </span>
    </label>
  );
}

/** one click per folder, for the repos that keep coming back. the picker is still there for the rest. */
function FrequentStrip({
  folders,
  onAdd,
}: {
  folders: FrequentFolder[];
  onAdd: (path: string) => void;
}) {
  if (folders.length === 0) return null;
  // two clones called "api" read as parent/api, so the chips are never ambiguous
  const dupes = new Set(folders.map((f) => f.name).filter((n, i, all) => all.indexOf(n) !== i));
  const label = (f: FrequentFolder) =>
    dupes.has(f.name) ? `${baseName(f.path.slice(0, -f.name.length - 1))}/${f.name}` : f.name;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5" data-testid="frequent-folders">
      <span className="mr-0.5 text-meta text-fg-3">Frequent</span>
      {folders.map((f) => (
        <button
          key={f.path}
          type="button"
          title={f.path}
          onClick={() => onAdd(f.path)}
          data-testid="frequent-folder"
          className="fade flex h-6 items-center gap-1 rounded-md border border-line-strong px-2 font-mono text-meta text-fg-2 hover:bg-raised hover:text-fg"
        >
          <Icon name="plus" size={10} className="text-fg-4" />
          {label(f)}
        </button>
      ))}
    </div>
  );
}

export function ComboDialog() {
  const dialog = useStore((s) => s.dialog);
  const combos = useStore((s) => s.combos);
  const env = useStore((s) => s.env);
  const set = useStore((s) => s.set);
  const selectCombo = useStore((s) => s.selectCombo);
  const open = dialog?.kind === "combo";
  const editing = open ? dialog.editing : undefined;
  const original = useMemo(() => combos.find((c) => c.name === editing), [combos, editing]);

  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [nameProblem, setNameProblem] = useState<string>();
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [frequent, setFrequent] = useState<FrequentFolder[]>([]);

  const slug = comboDirSlug(name);
  const root = original?.root ?? (env ? `${env.appRoot}/${slug || "…"}` : "");

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens
  useEffect(() => {
    if (!open) return;
    setName(original?.name ?? "");
    setNote(original?.note ?? "");
    setProblems([]);
    setNameProblem(undefined);
    setSaving(false);
    const initial: Card[] = (original?.folders ?? []).map((f) => ({
      path: f.path,
      mode: f.mode,
      branchKind: f.branchSpec?.kind ?? "detach",
      newBranch: f.branchSpec?.kind === "new" ? f.branchSpec.name : "",
      existingBranch: f.branchSpec?.kind === "existing" ? f.branchSpec.name : "",
      as: f.mode === "worktree" && f.dirName !== baseName(f.path) ? f.dirName : "",
      frozen: true,
    }));
    setCards(initial);
    for (const c of initial) void inspect(c.path);
    setFrequent([]);
    void window.grove
      .frequentFolders()
      .then(setFrequent)
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open || !name.trim()) return setNameProblem(undefined);
    const t = setTimeout(
      async () => setNameProblem((await window.grove.validateComboName(name, editing)).problem),
      120,
    );
    return () => clearTimeout(t);
  }, [open, name, editing]);

  async function inspect(path: string) {
    const info = await window.grove.inspectPath(path);
    setCards((cs) => cs.map((c) => (c.path === path ? { ...c, info } : c)));
  }

  async function addFolders() {
    addPaths(await window.grove.pickDirectories());
  }

  function addPaths(picked: string[]) {
    const fresh = picked.filter((p) => !cards.some((c) => c.path === p));
    if (fresh.length === 0) return;
    setCards((cs) => [
      ...cs,
      // most folders in a combo are context. a worktree is the surprising option, so it is opt-in.
      ...fresh.map(
        (p): Card => ({
          path: p,
          mode: "reference",
          branchKind: "detach",
          newBranch: slug,
          existingBranch: "",
          as: "",
          frozen: false,
        }),
      ),
    ]);
    for (const p of fresh) void inspect(p);
  }

  const dirNames = cards
    .filter((c) => c.mode === "worktree")
    .map((c) => (c.as.trim() || baseName(c.path)).toLowerCase());
  const clashes = new Set(dirNames.filter((n, i) => dirNames.indexOf(n) !== i));

  async function save() {
    setSaving(true);
    const draft: ComboDraft = {
      name: name.trim(),
      note: note.trim() || undefined,
      folders: cards.map(toDraft),
    };
    const check = await window.grove.validateDraft(draft, editing);
    if (check.problems.length > 0) {
      setProblems(check.problems);
      return setSaving(false);
    }
    const res = editing
      ? await window.grove.updateCombo(editing, draft)
      : await window.grove.createCombo(draft);
    setSaving(false);
    if (!res.ok) return setProblems([res.error.message]);
    // close straight away. the folders go from "not created yet" to ready in place, in the rail.
    set({ dialog: null });
    selectCombo(res.value.name);
  }

  const close = () => set({ dialog: null });
  const blocked = !name.trim() || Boolean(nameProblem) || cards.some((c) => !c.info) || saving;

  return (
    <Modal
      open={open}
      onClose={close}
      title={editing ? `Edit ${editing}` : "New combo"}
      width={620}
      testId="combo-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={blocked}
            onClick={() => void save()}
            data-testid="save-combo"
          >
            {saving ? "Saving" : editing ? "Save" : "Create combo"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Name"
          hint={
            nameProblem ? (
              <span className="text-accent">{nameProblem}</span>
            ) : (
              <>
                Folder: <Mono data-testid="root-preview">{root}</Mono>
                {editing && " - the folder never moves, only the name changes"}
              </>
            )
          }
        >
          <input
            className={inputClass}
            value={name}
            autoFocus
            spellCheck={false}
            placeholder="prod-debug"
            onChange={(e) => setName(e.target.value)}
            data-testid="combo-name"
          />
        </Field>
        <Field label="What is it for?">
          <input
            className={inputClass}
            value={note}
            placeholder="incident triage"
            onChange={(e) => setNote(e.target.value)}
            data-testid="combo-note"
          />
        </Field>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm text-fg-2">Folders</span>
            <Button size="sm" onClick={() => void addFolders()} data-testid="add-folder">
              <Icon name="plus" size={12} /> Add folder
            </Button>
          </div>
          <FrequentStrip
            folders={frequent.filter((f) => !cards.some((c) => c.path === f.path))}
            onAdd={(p) => addPaths([p])}
          />
          {cards.length === 0 ? (
            <p className="rounded-md border border-dashed border-line-strong px-4 py-6 text-center text-fg-3">
              Add the repos this task needs. Each one is either a reference you read or a working
              copy you edit.
            </p>
          ) : (
            <div className="space-y-2">
              {cards.map((c) => (
                <FolderCard
                  key={c.path}
                  card={c}
                  needsName={
                    clashes.has((c.as.trim() || baseName(c.path)).toLowerCase())
                      ? "clash"
                      : COMBO_RESERVED_NAMES.has((c.as.trim() || baseName(c.path)).toLowerCase())
                        ? "reserved"
                        : null
                  }
                  onChange={(patch) =>
                    setCards((cs) => cs.map((x) => (x.path === c.path ? { ...x, ...patch } : x)))
                  }
                  onRemove={() => setCards((cs) => cs.filter((x) => x.path !== c.path))}
                />
              ))}
            </div>
          )}
          {editing && original && cards.length < original.folders.length && (
            <p className="mt-2 text-meta text-fg-3">
              Removed working copies are taken down without force. One with uncommitted changes
              stays in the combo.
            </p>
          )}
        </div>

        {problems.length > 0 && (
          <ul
            className="space-y-1 rounded-md bg-accent-soft px-3 py-2 text-sm text-fg"
            data-testid="draft-problems"
          >
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
