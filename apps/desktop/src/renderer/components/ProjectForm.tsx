import { shortPath } from "@grove/core/pure";
import { type FormEvent, useEffect, useState } from "react";
import type { Api, FolderView, FrequentFolder, ProjectView } from "../../shared/ipc.ts";
import { EFFORTS, MODELS } from "../../shared/newSession.ts";
import {
  canSubmit,
  changed,
  draftOf,
  type Form,
  nameHint,
  newRepo,
  type Repo,
  repoNote,
  repoOf,
} from "../logic/projectForm.ts";
import { archiveProject, back, switchProject } from "../state/actions.ts";
import { currentProject, useStore } from "../state/store.ts";
import { Button, cx, Field, Icon, IconButton, inputClass, Select, Spinner } from "./ui.tsx";

const EMPTY: Form = { name: "", goal: "", model: "", effort: "", repos: [] };
const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

function RepoRow({
  r,
  home,
  folder,
  onRemove,
}: {
  r: Repo;
  home?: string;
  /** edit: the project's own view of a locked working copy, for its drift */
  folder?: FolderView;
  onRemove: () => void;
}) {
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
        {!r.info && <Spinner />}
        <IconButton label={`Remove ${r.path}`} onClick={onRemove} data-testid="repo-remove">
          <Icon name="x" size={11} />
        </IconButton>
      </div>
      {note && (
        <p className={cx("-mt-1 pr-2.5 pb-2 pl-[35px] text-sm", note.tone)} data-testid="repo-note">
          {note.text}
        </p>
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
  const set = useStore((s) => s.set);
  const live = useStore(currentProject);
  // the project as it was when the screen opened: the heading, the locked rows, what Save compares
  const [original] = useState(() => (mode === "edit" ? live : undefined));
  const [initial] = useState<Form>(() =>
    original
      ? {
          name: original.name,
          goal: original.goal ?? "",
          model: original.model ?? "",
          effort: original.effort ?? "",
          repos: original.folders.map(repoOf),
        }
      : EMPTY,
  );
  const [form, setForm] = useState(initial);
  const [touched, setTouched] = useState(false);
  /** main's last answer about the name, and the name it was asked about */
  const [check, setCheck] = useState<{
    name: string;
    v: Awaited<ReturnType<Api["validateProjectName"]>>;
  }>();
  const [problems, setProblems] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [frequent, setFrequent] = useState<FrequentFolder[]>([]);

  const { name } = form;
  const self = original?.id;

  // always from the latest list: an answer from main can land between a render and a click
  const setRepos = (fn: (repos: Repo[]) => Repo[]) =>
    setForm((f) => ({ ...f, repos: fn(f.repos) }));
  const patch = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));

  async function inspect(path: string) {
    const info = await window.grove.inspectPath(path);
    setRepos((repos) => repos.map((r) => (r.path !== path ? r : { ...r, info })));
  }

  function addPaths(paths: string[]) {
    setRepos((repos) => [
      ...repos,
      ...paths.filter((p) => !repos.some((r) => r.path === p)).map(newRepo),
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
      const v = await window.grove.validateProjectName(name, self).catch(() => null);
      if (stale || !v) return;
      setCheck({ name, v });
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [name, self]);

  if (mode === "edit" && !original) return null;

  // main answers 120ms after the last keystroke. until it has, a clash is not known, so no submit
  const answered = check?.name === name;
  const nameProblem = name.trim() ? check?.v.problem : undefined;
  const hint = nameHint({
    mode,
    name,
    touched,
    problem: nameProblem,
    appRoot: env?.appRoot ?? "",
    home: env?.home ?? "",
    root: original?.root,
  });
  const submittable = canSubmit({
    mode,
    form,
    initial,
    nameProblem,
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
  const removing = original?.folders.some(
    (f) =>
      f.mode === "worktree" && !form.repos.some((r) => r.path === f.path && r.mode === "worktree"),
  );

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

          <Field
            label="About"
            hint={
              mode === "new"
                ? "One line on what the project is for. It opens the project's CLAUDE.md."
                : "One line on what the project is for."
            }
          >
            <input
              className={inputClass}
              value={form.goal}
              placeholder="What is this project for?"
              onChange={(e) => patch({ goal: e.target.value })}
              data-testid="project-goal"
            />
          </Field>

          <div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Model">
                <Select
                  value={form.model}
                  onChange={(e) => patch({ model: e.target.value as Form["model"] })}
                  data-testid="project-model"
                >
                  <option value="">Default</option>
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Effort">
                <Select
                  value={form.effort}
                  onChange={(e) => patch({ effort: e.target.value as Form["effort"] })}
                  data-testid="project-effort"
                >
                  <option value="">Default</option>
                  {EFFORTS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <p className="mt-1.5 text-sm text-fg-4">
              What a new session here starts on. A chat's own model menu still changes it for that
              session. The Claude panel in your editor picks its own.
            </p>
          </div>

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
                      folder={folder}
                      onRemove={() => setRepos((repos) => repos.filter((x) => x.path !== r.path))}
                    />
                  );
                })}
              </div>
            )}
            <p className="mt-1.5 text-sm text-fg-4">
              Each repo is your own clone. Claude reads it and makes a worktree in the project
              folder for each change.
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
          {self && live && (
            // putting it away and getting its disk space back, away from Save. their words start
            // where the labels do
            <div className="mr-auto -ml-3 flex gap-1">
              <Button
                variant="quiet"
                size="lg"
                onClick={() => void archiveProject(self, !live.archived)}
                data-testid="form-archive"
              >
                {live.archived ? "Unarchive" : "Archive"}
              </Button>
              <Button
                variant="quiet"
                size="lg"
                onClick={() => set({ dialog: { kind: "delete", project: self } })}
                data-testid="form-delete"
              >
                Delete…
              </Button>
            </div>
          )}
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
