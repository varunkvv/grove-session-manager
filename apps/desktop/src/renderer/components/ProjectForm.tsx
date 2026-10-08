import {
  COMBO_RESERVED_NAMES,
  comboDirSlug,
  shortPath,
  validateBranchName,
} from "@grove/core/pure";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import type {
  Api,
  FolderView,
  FrequentFolder,
  PathInfoView,
  ProjectView,
} from "../../shared/ipc.ts";
import {
  canSubmit,
  changed,
  defaultMode,
  draftOf,
  type Form,
  nameHint,
  type Repo,
  repoNote,
  repoOf,
} from "../logic/projectForm.ts";
import { back, switchProject } from "../state/actions.ts";
import { currentProject, useStore } from "../state/store.ts";
import {
  Button,
  cx,
  Field,
  Icon,
  IconButton,
  inputClass,
  Segmented,
  Select,
  Spinner,
} from "./ui.tsx";

const EMPTY: Form = { name: "", goal: "", repos: [] };
const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
/** the folder a working copy gets inside the project */
const dirOf = (r: Repo) => (r.as.trim() || baseName(r.path)).toLowerCase();
// inputClass sets the body size. a path or a branch is mono, one size down
const monoInput = cx(inputClass, "font-mono text-sm!");

type NeedsName = "clash" | "reserved" | null;

function BranchOption({
  group,
  checked,
  onSelect,
  title,
  testId,
  children,
}: {
  group: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  testId: string;
  children?: ReactNode;
}) {
  return (
    <label className="flex cursor-default items-start gap-2.5">
      <input
        type="radio"
        name={group}
        checked={checked}
        onChange={onSelect}
        className="mt-1"
        data-testid={testId}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-body text-fg">{title}</span>
        <span className="block text-sm text-fg-4">{children}</span>
      </span>
    </label>
  );
}

/** what a new working copy checks out, and its folder name when the repo's own is taken */
function BranchChoice({
  r,
  info,
  slug,
  needsName,
  onChange,
}: {
  r: Repo;
  info: PathInfoView;
  /** the project's folder name: what a new branch is called until the person says otherwise */
  slug: string;
  needsName: NeedsName;
  onChange: (patch: Partial<Repo>) => void;
}) {
  const group = useId();
  const error = validateBranchName(r.newBranch.trim());
  const taken = info.branches.find((b) => b.name === r.newBranch.trim());
  return (
    <div className="space-y-2 border-t border-line px-2.5 py-3 pl-[35px]">
      <BranchOption
        group={group}
        checked={r.branchKind === "detach"}
        onSelect={() => onChange({ branchKind: "detach" })}
        title="Detached at HEAD"
        testId="branch-detach"
      >
        No branch is created, so it can never collide with another project.
      </BranchOption>
      <BranchOption
        group={group}
        checked={r.branchKind === "new"}
        onSelect={() => onChange({ branchKind: "new", newBranch: r.newBranch || slug })}
        title="New branch"
        testId="branch-new"
      >
        {r.branchKind === "new" && (
          <>
            <input
              className={cx(monoInput, "mt-1.5")}
              value={r.newBranch}
              spellCheck={false}
              onChange={(e) => onChange({ newBranch: e.target.value })}
              data-testid="new-branch-name"
            />
            {error ? (
              <span className="mt-1 block text-danger">{error}</span>
            ) : (
              taken && (
                <span className="mt-1 block">
                  {taken.checkedOutAt
                    ? `That branch is checked out at ${taken.checkedOutAt}. Pick another name.`
                    : "That branch already exists. It will be checked out here instead of created."}
                </span>
              )
            )}
          </>
        )}
      </BranchOption>
      <BranchOption
        group={group}
        checked={r.branchKind === "existing"}
        onSelect={() =>
          onChange({
            branchKind: "existing",
            existingBranch:
              r.existingBranch || (info.branches.find((b) => !b.checkedOutAt)?.name ?? ""),
          })
        }
        title="Existing branch"
        testId="branch-existing"
      >
        {r.branchKind === "existing" && (
          <Select
            wrapClassName="mt-1.5"
            className="font-mono text-sm!"
            value={r.existingBranch}
            onChange={(e) => onChange({ existingBranch: e.target.value })}
            data-testid="existing-branch"
          >
            {info.branches.map((b) => (
              // a branch can only be checked out in one worktree. that is git's rule
              <option key={b.name} value={b.name} disabled={Boolean(b.checkedOutAt)}>
                {b.name}
                {b.checkedOutAt ? `  (checked out at ${b.checkedOutAt})` : ""}
              </option>
            ))}
          </Select>
        )}
      </BranchOption>
      {(needsName || r.as) && (
        <Field
          label="Folder name inside the project"
          hint={
            needsName === "clash"
              ? "Two folders share this name. One of them needs another."
              : needsName === "reserved"
                ? "The project folder uses this name itself."
                : undefined
          }
        >
          <input
            className={monoInput}
            value={r.as}
            spellCheck={false}
            onChange={(e) => onChange({ as: e.target.value })}
            data-testid="folder-as"
          />
        </Field>
      )}
    </div>
  );
}

function RepoRow({
  r,
  home,
  slug,
  needsName,
  folder,
  onChange,
  onRemove,
}: {
  r: Repo;
  home?: string;
  slug: string;
  needsName: NeedsName;
  /** edit: the project's own view of a locked working copy, for its drift */
  folder?: FolderView;
  onChange: (patch: Partial<Repo>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const name = baseName(r.path);
  const canBranch = r.info && r.mode === "worktree" && !r.locked;
  // a folder name that is taken opens it by itself, and one the person typed keeps it open
  const shown = canBranch && (open || needsName !== null || r.as !== "");
  const note = repoNote({ info: r.info, folder });
  return (
    <div
      className="border-b border-line last:border-b-0"
      data-testid="repo-row"
      data-mode={r.mode}
      data-locked={r.locked || undefined}
    >
      <div className="flex h-10 items-center gap-3 px-2.5">
        <Icon name={r.mode === "worktree" ? "branch" : "folder"} size={11} faint />
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg" title={r.path}>
          {shortPath(r.path, undefined, home)}
        </span>
        {r.info ? (
          <Segmented
            size="sm"
            label={`Access for ${name}`}
            value={r.mode}
            disabled={r.locked}
            onChange={(mode) => onChange({ mode })}
            options={[
              {
                value: "worktree",
                label: "Working copy",
                disabled: !r.info.canBeWorktree,
                testId: "mode-worktree",
              },
              { value: "reference", label: "Reference", testId: "mode-reference" },
            ]}
          />
        ) : (
          <Spinner />
        )}
        {canBranch ? (
          <IconButton
            label={`Branch options for ${name}`}
            aria-expanded={shown}
            onClick={() => setOpen(!shown)}
            data-testid="branch-toggle"
          >
            <Icon name="chevron" size={8} className={shown ? "rotate-90" : ""} />
          </IconButton>
        ) : (
          // the button's place is kept, so the access controls line up down the list and the one
          // just clicked does not move from under the mouse
          <span className="w-6 shrink-0" />
        )}
        <IconButton label={`Remove ${r.path}`} onClick={onRemove} data-testid="repo-remove">
          <Icon name="x" size={11} />
        </IconButton>
      </div>
      {note && (
        <p className={cx("-mt-1 pr-2.5 pb-2 pl-[35px] text-sm", note.tone)} data-testid="repo-note">
          {note.text}
        </p>
      )}
      {shown && r.info && (
        <BranchChoice r={r} info={r.info} slug={slug} needsName={needsName} onChange={onChange} />
      )}
    </div>
  );
}

/** only while something is wrong: what grove could not write into the project's folder */
function SyncProblem({ project }: { project: ProjectView }) {
  if (!project.syncProblem) return null;
  return (
    <section data-testid="sync-problem">
      <h2 className="mb-1.5 text-sm font-medium text-fg-2">Files</h2>
      <p className="break-words text-sm text-danger">
        Grove could not update this project's files. {project.syncProblem}
      </p>
      <p className="mt-1 text-sm text-fg-4">Fix it, then press ⌘R to check again.</p>
    </section>
  );
}

/** New project and Edit project (ui.md 4.5, 4.6): one form on the draft, validate and save flow */
export function ProjectForm({ mode, first }: { mode: "new" | "edit"; first?: boolean }) {
  const env = useStore((s) => s.env);
  const live = useStore(currentProject);
  // the project as it was when the screen opened: the heading, the locked rows, what Save compares
  const [original] = useState(() => (mode === "edit" ? live : undefined));
  const [initial] = useState<Form>(() =>
    original
      ? { name: original.name, goal: original.goal ?? "", repos: original.folders.map(repoOf) }
      : EMPTY,
  );
  const [form, setForm] = useState(initial);
  const [touched, setTouched] = useState(false);
  /** main's last answer about the name and the prefix, and what it was asked */
  const [check, setCheck] = useState<{
    name: string;
    typed?: string;
    v: Awaited<ReturnType<Api["validateProjectName"]>>;
  }>();
  const [showPrefix, setShowPrefix] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [frequent, setFrequent] = useState<FrequentFolder[]>([]);

  const { name, prefix } = form;
  const self = original?.id;

  // always from the latest list: an answer from main can land between a render and a click
  const setRepos = (fn: (repos: Repo[]) => Repo[]) =>
    setForm((f) => ({ ...f, repos: fn(f.repos) }));
  const patch = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));

  async function inspect(path: string) {
    const info = await window.grove.inspectPath(path);
    setRepos((repos) =>
      repos.map((r) =>
        r.path !== path
          ? r
          : // a new repo is a working copy unless it cannot be one. after that the choice is the person's
            { ...r, info, mode: r.locked || r.info ? r.mode : defaultMode(info) },
      ),
    );
  }

  function addPaths(paths: string[]) {
    setRepos((repos) => [
      ...repos,
      ...paths
        .filter((p) => !repos.some((r) => r.path === p))
        .map(
          (path): Repo => ({
            path,
            mode: "worktree",
            branchKind: "detach",
            newBranch: "",
            existingBranch: "",
            as: "",
            locked: false,
          }),
        ),
    ]);
    for (const p of paths) void inspect(p);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the screen opens
  useEffect(() => {
    for (const r of initial.repos) void inspect(r.path);
    void window.grove
      .frequentFolders()
      .then(setFrequent)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!name.trim()) return;
    let stale = false;
    const t = setTimeout(async () => {
      const v = await window.grove.validateProjectName(name, self, prefix).catch(() => null);
      if (stale || !v) return;
      setCheck({ name, typed: prefix, v });
      // once it is drawn it stays for as long as the screen is open
      if (v.prefixProblem) setShowPrefix(true);
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [name, prefix, self]);

  if (mode === "edit" && !original) return null;

  // main answers 120ms after the last keystroke. until it has, a clash is not known, so no submit
  const answered = check?.name === name && check.typed === prefix;
  const nameProblem = name.trim() ? check?.v.problem : undefined;
  const prefixProblem = check?.v.prefixProblem;
  const hint = nameHint({
    mode,
    name,
    touched,
    problem: nameProblem,
    prefix: original?.prefix ?? (answered ? check.v.prefix : ""),
    appRoot: env?.appRoot ?? "",
    home: env?.home ?? "",
    root: original?.root,
  });
  const submittable = canSubmit({
    mode,
    form,
    initial,
    nameProblem,
    prefixProblem,
    running: running || !answered,
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!submittable) return;
    setRunning(true);
    const draft = draftOf(form);
    try {
      const checked = await window.grove.validateProjectDraft(draft, self);
      if (checked.problems.length > 0) return setProblems(checked.problems);
      const res = self
        ? await window.grove.updateProject(self, draft)
        : await window.grove.createProject(draft);
      if (!res.ok) return setProblems([res.error.message]);
      if (self) back();
      else {
        // the new project's sessions: none yet, and how to start one
        switchProject(res.value.id);
      }
    } catch (err) {
      setProblems([err instanceof Error ? err.message : String(err)]);
    } finally {
      setRunning(false);
    }
  }

  const offered = frequent.filter((f) => !form.repos.some((r) => r.path === f.path)).slice(0, 6);
  // two clones called "api" read as parent/api, so a chip is never ambiguous
  const twice = new Set(offered.map((f) => f.name).filter((n, i, all) => all.indexOf(n) !== i));
  const dirs = form.repos.filter((r) => r.mode === "worktree").map(dirOf);
  const clashes = new Set(dirs.filter((n, i) => dirs.indexOf(n) !== i));
  const needsName = (r: Repo): NeedsName =>
    r.mode !== "worktree" || r.locked
      ? null
      : clashes.has(dirOf(r))
        ? "clash"
        : COMBO_RESERVED_NAMES.has(dirOf(r))
          ? "reserved"
          : null;
  const removing = original?.folders.some(
    (f) =>
      f.mode === "worktree" && !form.repos.some((r) => r.path === f.path && r.mode === "worktree"),
  );
  const shownPrefix = prefix ?? check?.v.prefix ?? "";

  return (
    <div
      className="h-full overflow-y-auto"
      data-testid="project-form"
      data-mode={mode}
      // Escape leaves a form with changes alone
      data-form-dirty={changed(initial, form) || undefined}
    >
      <form className="mx-auto max-w-[520px] px-4 pt-12 pb-16" onSubmit={submit} noValidate>
        <h1 className="text-title font-semibold">
          {original ? `Edit ${original.name}` : "New project"}
        </h1>
        <div className="mt-7 space-y-7">
          <Field
            label="Name"
            hint={hint.problem ? <span className="text-danger">{hint.text}</span> : hint.text}
          >
            <input
              className={inputClass}
              value={name}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                setTouched(true);
                patch({ name: e.target.value });
              }}
              data-testid="project-name"
            />
          </Field>

          {mode === "new" && showPrefix && (
            <Field
              label="Card prefix"
              hint={
                prefixProblem ? (
                  <span className="text-danger">{prefixProblem}</span>
                ) : (
                  `Cards will be ${check?.v.prefix}-1, ${check?.v.prefix}-2…`
                )
              }
            >
              <input
                // inputClass is full width
                className={cx(inputClass, "w-[120px]! uppercase")}
                value={shownPrefix}
                maxLength={8}
                spellCheck={false}
                onChange={(e) => patch({ prefix: e.target.value.toUpperCase() })}
                data-testid="project-prefix"
              />
            </Field>
          )}

          <Field
            label="Goal"
            hint={
              mode === "new"
                ? "Every agent in the project starts from this."
                : "What an agent started from Grove is told to work toward."
            }
          >
            <input
              className={inputClass}
              value={form.goal}
              placeholder="What does done look like?"
              onChange={(e) => patch({ goal: e.target.value })}
              data-testid="project-goal"
            />
          </Field>

          {/* not a Field: that is a label, and a click on its text would press the first control inside */}
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-fg-2">Repos</legend>
            <div className="flex flex-wrap items-center gap-1.5">
              {offered.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  title={f.path}
                  onClick={() => addPaths([f.path])}
                  data-testid="repo-suggestion"
                  className="fade flex h-6 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2 text-sm text-fg-2 hover:bg-active hover:text-fg"
                >
                  <Icon name="plus" size={8} faint />
                  {twice.has(f.name)
                    ? `${baseName(f.path.slice(0, -f.name.length - 1))}/${f.name}`
                    : f.name}
                </button>
              ))}
              <Button
                variant="quiet"
                size="sm"
                // alone on its line, its words start where the labels do
                className={offered.length === 0 ? "-ml-2" : undefined}
                onClick={async () => addPaths(await window.grove.pickDirectories())}
                data-testid="add-folder"
              >
                Add folder…
              </Button>
            </div>
            {form.repos.length === 0 ? (
              <p
                className="mt-3 rounded-md border border-dashed border-line-strong p-3 text-sm text-fg-4"
                data-testid="repos-empty"
              >
                {mode === "edit" && initial.repos.length === 0
                  ? "This project has no repos."
                  : "Add at least one repo."}
              </p>
            ) : (
              <div className="mt-3 rounded-md border border-line">
                {form.repos.map((r) => {
                  const folder =
                    r.locked && r.mode === "worktree"
                      ? live?.folders.find((f) => f.path === r.path && f.mode === "worktree")
                      : undefined;
                  return (
                    <RepoRow
                      key={r.path}
                      r={r}
                      home={env?.home}
                      slug={comboDirSlug(name)}
                      needsName={needsName(r)}
                      folder={folder}
                      onChange={(p) =>
                        setRepos((repos) =>
                          repos.map((x) => (x.path === r.path ? { ...x, ...p } : x)),
                        )
                      }
                      onRemove={() => setRepos((repos) => repos.filter((x) => x.path !== r.path))}
                    />
                  );
                })}
              </div>
            )}
            <p className="mt-1.5 text-sm text-fg-4">
              {mode === "new"
                ? "A working copy is a fresh git worktree that agents edit. A reference is your own clone, read only."
                : "To change how a repo is included, remove it and add it again."}
            </p>
            {removing && (
              <p className="mt-1 text-sm text-fg-4" data-testid="remove-warning">
                Removing a working copy removes its worktree from the project folder. One with
                uncommitted changes stays.
              </p>
            )}
          </fieldset>

          {mode === "edit" && live && <SyncProblem project={live} />}
        </div>

        {problems.length > 0 && (
          <ul className="mt-6 space-y-1 text-sm text-danger" data-testid="draft-problems">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="mt-9 flex justify-end gap-2 border-t border-line pt-4">
          {!first && (
            <Button variant="ghost" size="lg" onClick={back} data-testid="form-cancel">
              Cancel
            </Button>
          )}
          <Button
            variant="primary"
            size="lg"
            type="submit"
            disabled={!submittable}
            data-testid="form-submit"
          >
            {mode === "new"
              ? running
                ? "Creating"
                : "Create project"
              : running
                ? "Saving"
                : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}
