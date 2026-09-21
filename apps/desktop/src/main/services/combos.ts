import { type FSWatcher, watch } from "node:fs";
import path from "node:path";
import {
  type Combo,
  type ComboFolder,
  comboDirSlug,
  combosFilePath,
  ensureRoot,
  ensureWorktrees,
  type FolderOutcome,
  type FolderStatus,
  forceRemoveWorktree,
  type LongWorkMode,
  loadCombos,
  prepareComboOpen,
  reconcileCombo,
  repairCombo,
  repairFolder,
  samePath,
  syncComboStatusHooks,
  syncLongWorkPolicy,
  type TeardownOutcome,
  targetDirFor,
  teardownCombo,
  updateCombos,
  validateComboName,
  validateComboRoot,
  validateFolders,
  workspaceFilePath,
} from "@grove/core";
import type { ComboView, ToastMessage } from "../../shared/ipc.ts";
import { AppError } from "../errors.ts";
import { log } from "../log.ts";
import type { OpQueue } from "../opQueue.ts";
import type { CleanDraft } from "./draft.ts";
import {
  type Busy,
  buildComboView,
  buildFolderViews,
  type ComboRuntime,
  emptyRuntime,
  folderKey,
  isRemaining,
  mergeStatus,
  type OutcomeContext,
  outcomeToast,
  statusFromOutcome,
} from "./views.ts";

export type Lane = "mutate" | "read";

const COMBOS_DEBOUNCE_MS = 200;

export interface ComboServiceOptions {
  appRoot: string;
  queue: OpQueue<Lane>;
  gitPath?: string;
  onCombosChanged: (combos: ComboView[], problem?: string) => void;
  onFolders: (view: ComboView) => void;
  onToast: (toast: ToastMessage) => void;
  /** combos moved, so session -> combo has to be worked out again */
  onModelChanged: (combos: Combo[]) => void;
}

export class ComboService {
  private readonly opts: ComboServiceOptions;
  private combos: Combo[] = [];
  private problem?: string;
  /** keyed by combo root, which never changes for the life of a combo */
  private runtimes = new Map<string, ComboRuntime>();
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private selfWriteUntil = 0;

  constructor(opts: ComboServiceOptions) {
    this.opts = opts;
  }

  list(): Combo[] {
    return this.combos;
  }

  views(): ComboView[] {
    return this.combos.map((c) =>
      buildComboView(c, this.runtimes.get(c.root), workspaceFilePath(c)),
    );
  }

  problemMessage(): string | undefined {
    return this.problem;
  }

  find(name: string): Combo {
    const combo = this.combos.find((c) => c.name === name);
    if (!combo) throw new AppError("no-combo", `There is no combo called "${name}".`);
    return combo;
  }

  async load(announce = false): Promise<void> {
    const loaded = await loadCombos(this.opts.appRoot);
    this.combos = loaded.combos;
    this.problem =
      loaded.status === "invalid"
        ? loaded.message
        : loaded.problems.length > 0
          ? loaded.problems.map((p) => (p.combo ? `${p.combo}: ${p.message}` : p.message)).join(" ")
          : undefined;
    for (const root of [...this.runtimes.keys()]) {
      if (!this.combos.some((c) => c.root === root)) this.runtimes.delete(root);
    }
    if (announce) {
      this.opts.onCombosChanged(this.views(), this.problem);
      this.opts.onModelChanged(this.combos);
    }
  }

  /** people edit combos.json by hand. the app follows it rather than fighting it. */
  watchFile(): void {
    const file = combosFilePath(this.opts.appRoot);
    try {
      this.watcher = watch(path.dirname(file), { persistent: false }, (_event, name) => {
        if (name?.toString() !== path.basename(file)) return;
        if (Date.now() < this.selfWriteUntil) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.reloadFromDisk(), COMBOS_DEBOUNCE_MS);
      });
    } catch (e) {
      log.warn("combos.json watch:", e);
    }
  }

  private async reloadFromDisk(): Promise<void> {
    await this.load(true);
    void this.reconcileAll();
  }

  // --- reads -------------------------------------------------------------

  /** coalesced per combo: a burst of focus events costs one git pass */
  reconcile(combo: Combo, dirty = false): Promise<void> {
    return this.opts.queue.run(
      "read",
      async () => {
        const runtime = this.runtime(combo.root);
        runtime.checking = true;
        this.pushFolders(combo);
        try {
          const statuses = await reconcileCombo(combo, { gitPath: this.opts.gitPath, dirty });
          this.applyStatuses(combo, statuses);
          runtime.reconciled = true;
          runtime.checkedAt = Date.now();
        } catch (e) {
          log.error("reconcile", combo.name, e);
        } finally {
          runtime.checking = false;
          this.pushFolders(combo);
        }
      },
      { key: `reconcile:${combo.root}:${dirty ? "dirty" : "plain"}` },
    );
  }

  async reconcileAll(dirty = false): Promise<void> {
    await Promise.all(this.combos.map((c) => this.reconcile(c, dirty)));
  }

  /** window focus. never while a mutation is in flight - it would fight for the same git locks. */
  reconcileOnFocus(): void {
    if (this.opts.queue.busy("mutate")) return;
    void this.reconcileAll(false);
  }

  statusesOf(combo: Combo): FolderStatus[] {
    const runtime = this.runtimes.get(combo.root);
    return combo.folders.map(
      (f) =>
        runtime?.statuses.get(folderKey(f)) ?? {
          folder: f,
          target: targetDirFor(combo, f),
          state: "absent",
        },
    );
  }

  // --- mutations ---------------------------------------------------------

  /**
   * one lane for every combo, not one per combo: two combos can share an origin clone, and git
   * does not queue behind another `worktree add` in the same repo, it fails.
   */
  private mutate<T>(run: () => Promise<T>): Promise<T> {
    return this.opts.queue.run("mutate", run);
  }

  /** every combo reports session status, including ones created before that existed */
  async syncStatusHooks(): Promise<void> {
    for (const combo of this.list()) {
      await syncComboStatusHooks(this.opts.appRoot, combo).catch(() => undefined);
    }
  }

  ensure(combo: Combo, context: OutcomeContext, repairStale = false): Promise<FolderOutcome[]> {
    // before it is queued, not when the lane gets round to it: otherwise a new combo reads
    // "Not created yet" for an instant, and anything waiting on "Creating" sees nothing to wait for
    this.setBusyAll(combo, "creating");
    return this.mutate(async () => {
      await ensureRoot(combo);
      // there from the first session on, not only after the first "open"
      await syncLongWorkPolicy(combo);
      await syncComboStatusHooks(this.opts.appRoot, combo).catch(() => undefined);
      try {
        const outcomes = await ensureWorktrees(combo, {
          gitPath: this.opts.gitPath,
          repairStale,
          onOutcome: (o) => this.applyOutcome(combo, o, context),
        });
        return outcomes;
      } finally {
        this.clearBusy(combo);
        void this.reconcile(combo);
      }
    });
  }

  repair(combo: Combo, folderPath?: string): Promise<FolderOutcome[]> {
    return this.mutate(async () => {
      await ensureRoot(combo);
      const targets = folderPath
        ? combo.folders.filter(
            (f) => samePath(f.path, folderPath) || samePath(targetDirFor(combo, f), folderPath),
          )
        : combo.folders;
      for (const f of targets) this.setBusy(combo, f, "creating");
      this.pushFolders(combo);
      try {
        if (folderPath) {
          const outcome = await repairFolder(combo, folderPath, {
            gitPath: this.opts.gitPath,
            onOutcome: (o) => this.applyOutcome(combo, o, "repair"),
          });
          return [outcome];
        }
        return await repairCombo(combo, {
          gitPath: this.opts.gitPath,
          onOutcome: (o) => this.applyOutcome(combo, o, "repair"),
        });
      } finally {
        this.clearBusy(combo);
        void this.reconcile(combo);
      }
    });
  }

  teardown(combo: Combo): Promise<TeardownOutcome[]> {
    this.setBusyAll(combo, "removing");
    return this.mutate(async () => {
      try {
        return await teardownCombo(combo, { gitPath: this.opts.gitPath });
      } finally {
        this.clearBusy(combo);
        void this.reconcile(combo, true);
      }
    });
  }

  forceRemove(combo: Combo, folderPath: string): Promise<TeardownOutcome> {
    return this.mutate(async () => {
      const folder = combo.folders.find(
        (f) => samePath(f.path, folderPath) || samePath(targetDirFor(combo, f), folderPath),
      );
      if (folder) this.setBusy(combo, folder, "removing");
      this.pushFolders(combo);
      try {
        return await forceRemoveWorktree(combo, folderPath, { gitPath: this.opts.gitPath });
      } finally {
        this.clearBusy(combo);
        void this.reconcile(combo, true);
      }
    });
  }

  open(
    combo: Combo,
    sessionId?: string,
  ): Promise<{ workspaceFile: string; outcomes: FolderOutcome[]; warnings: string[] }> {
    return this.mutate(async () => {
      this.setBusyAll(combo, "creating");
      try {
        const report = await prepareComboOpen(this.opts.appRoot, combo, {
          sessionId,
          gitPath: this.opts.gitPath,
          source: "app",
          onOutcome: (o) => this.applyOutcome(combo, o, "open"),
        });
        return {
          workspaceFile: report.workspaceFile,
          outcomes: report.outcomes,
          warnings: report.warnings.map((w) => w.message),
        };
      } finally {
        this.clearBusy(combo);
        void this.reconcile(combo);
      }
    });
  }

  // --- the combos.json file ----------------------------------------------

  validateName(name: string, self?: string): { slug: string; root: string; problem?: string } {
    const { slug, problem } = validateComboName(name, this.combos, self);
    const existing = self ? this.combos.find((c) => c.name === self) : undefined;
    return { slug, root: existing?.root ?? path.join(this.opts.appRoot, slug || "…"), problem };
  }

  /** everything wrong with a draft, in one list, before anything is written */
  problemsWithDraft(draft: CleanDraft, self?: string): string[] {
    const problems: string[] = [];
    const { slug, problem } = validateComboName(draft.name, this.combos, self);
    if (problem) problems.push(problem);
    const existing = self ? this.combos.find((c) => c.name === self) : undefined;
    const combo: Combo = {
      name: draft.name,
      root: existing?.root ?? path.join(this.opts.appRoot, comboDirSlug(draft.name) || slug),
      folders: draft.folders,
    };
    problems.push(...validateFolders(combo));
    problems.push(...validateComboRoot(combo, this.combos, this.opts.appRoot).problems);
    return problems;
  }

  private async save(mutateList: (combos: Combo[]) => Combo[]): Promise<void> {
    // our own write must not look like a hand edit and trigger a reload
    this.selfWriteUntil = Date.now() + 1500;
    const res = await updateCombos(this.opts.appRoot, mutateList);
    if (!res.ok) throw new AppError(res.error.code, res.error.message);
    await this.load(true);
  }

  async create(draft: CleanDraft): Promise<Combo> {
    const root = path.join(this.opts.appRoot, comboDirSlug(draft.name));
    const combo: Combo = {
      name: draft.name,
      root,
      folders: draft.folders,
      ...(draft.note ? { note: draft.note } : {}),
    };
    await this.save((combos) => [...combos, combo]);
    return this.find(draft.name);
  }

  /**
   * the root is the combo's identity: it is where Claude's sessions live and what VS Code
   * remembers the workspace by. a rename changes the display name only.
   */
  async update(
    name: string,
    draft: CleanDraft,
  ): Promise<{ combo: Combo; kept: TeardownOutcome[] }> {
    const before = this.find(name);
    const removed = before.folders.filter(
      (old) =>
        old.mode === "worktree" && !draft.folders.some((f) => folderKey(f) === folderKey(old)),
    );
    const kept: TeardownOutcome[] = [];
    if (removed.length > 0) {
      kept.push(...(await this.teardown({ ...before, folders: removed })).filter(isRemaining));
    }
    // a worktree git would not give up stays in the combo, so nothing is left orphaned on disk
    const keptFolders = removed.filter((f) =>
      kept.some((k) => folderKey(k.folder as ComboFolder) === folderKey(f)),
    );
    const next: Combo = {
      ...before,
      name: draft.name,
      folders: [...draft.folders, ...keptFolders],
      ...(draft.note ? { note: draft.note } : {}),
    };
    if (!draft.note) delete next.note;
    await this.save((combos) => combos.map((c) => (c.root === before.root ? next : c)));
    return { combo: this.find(draft.name), kept };
  }

  /**
   * a running session reads the policy file right before long work, so this takes effect on its
   * next long task. nothing restarts.
   */
  async setLongWork(name: string, mode: LongWorkMode): Promise<void> {
    const before = this.find(name);
    const next: Combo = { ...before, longWork: mode };
    await this.save((combos) => combos.map((c) => (c.root === before.root ? next : c)));
    await syncLongWorkPolicy(this.find(name));
  }

  /** removes clean worktrees first and refuses while any remain: nothing is left orphaned */
  async remove(name: string): Promise<{ remaining: TeardownOutcome[] }> {
    const combo = this.find(name);
    const outcomes = await this.teardown(combo);
    const remaining = outcomes.filter(isRemaining);
    if (remaining.length > 0) return { remaining };
    await this.save((combos) => combos.filter((c) => c.root !== combo.root));
    return { remaining: [] };
  }

  // --- runtime state -----------------------------------------------------

  private runtime(root: string): ComboRuntime {
    let runtime = this.runtimes.get(root);
    if (!runtime) {
      runtime = emptyRuntime();
      this.runtimes.set(root, runtime);
    }
    return runtime;
  }

  private applyStatuses(combo: Combo, statuses: FolderStatus[]): void {
    const runtime = this.runtime(combo.root);
    const next = new Map<string, FolderStatus>();
    for (const [i, status] of statuses.entries()) {
      const folder = combo.folders[i];
      if (!folder) continue;
      const key = folderKey(folder);
      next.set(key, mergeStatus(runtime.statuses.get(key), status));
    }
    runtime.statuses = next;
  }

  private applyOutcome(combo: Combo, outcome: FolderOutcome, context: OutcomeContext): void {
    const runtime = this.runtime(combo.root);
    const key = folderKey(outcome.folder);
    runtime.statuses.set(key, statusFromOutcome(runtime.statuses.get(key), outcome));
    runtime.busy.delete(key);
    this.pushFolders(combo);
    const toast = outcomeToast(outcome, context);
    if (toast) this.opts.onToast(toast);
  }

  private setBusy(combo: Combo, folder: ComboFolder, busy: Busy): void {
    if (folder.mode !== "worktree") return;
    this.runtime(combo.root).busy.set(folderKey(folder), busy);
  }

  private setBusyAll(combo: Combo, busy: Busy): void {
    for (const f of combo.folders) this.setBusy(combo, f, busy);
    this.pushFolders(combo);
  }

  private clearBusy(combo: Combo): void {
    this.runtime(combo.root).busy.clear();
    this.pushFolders(combo);
  }

  private pushFolders(combo: Combo): void {
    const runtime = this.runtimes.get(combo.root);
    const view = buildComboView(combo, runtime, workspaceFilePath(combo));
    view.folders = buildFolderViews(combo, runtime);
    this.opts.onFolders(view);
  }

  dispose(): void {
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
  }
}
