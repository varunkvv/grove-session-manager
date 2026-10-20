// decisioning (beta): a local model judges the person's own prompts for judgment day odds. off
// unless the setting is on, and nothing runs below macOS 14. it reads each transcript from where it
// stopped, judges what is new as it lands, and the backlog (the backfill) only on AC power. the
// model runs in its own process (scorer.ts). what is kept is scores, never what was said.

import path from "node:path";
import {
  type FileState,
  type FreshPrompt,
  isTempCwd,
  type Known,
  knownOf,
  loadScores,
  type ModelEntry,
  type Probs,
  type Rubric,
  readPrompts,
  type ScoreFile,
  saveScores,
  scoreKey,
  scorerKey,
  sweepOldScores,
  toKept,
} from "@grove/core";
import type { ScorerMode } from "../../scorer/protocol.ts";
import type { DecisioningStatus, OddsView, ProjectId } from "../../shared/ipc.ts";
import { log } from "../log.ts";
import {
  DownloadError,
  type DownloadOptions,
  downloadModel,
  type ModelFile,
  modelBytes,
  modelReady,
  removeModel,
  weightsPath,
} from "./modelFile.ts";
import { buildOddsView, oddsProgress } from "./odds.ts";
import { Scorer, type ScorerChild } from "./scorer.ts";

/** a prompt this young is new, and judged on battery too. older ones are the backfill */
const NEW_MS = 10 * 60_000;
/** prompts per message to the scorer */
const BATCH = 4;
/** what moves the work along: often enough that a new prompt is judged within seconds */
const KICK_MS = 1500;
/** while the usage count reads every transcript, the backfill waits this long and looks again */
const BUSY_MS = 5000;
const SAVE_MS = 2000;
/** after the scorer failed (no model load, a crash), the next try waits this long */
const RETRY_MS = 60_000;

export interface DecisioningOptions {
  /** the score cache's folder: `decisioning/` in grove's state dir, one file per task */
  stateDir: string;
  /** where the weights go */
  modelsDir: string;
  model: ModelEntry;
  /** what the download checks: the model's own pin, or a test root's stand-in file */
  file: ModelFile;
  /** where the weights come from. absent: nowhere (a test root with no stand-in server) */
  url?: string;
  rubric: Rubric;
  mode: ScorerMode;
  /** the setting, read fresh */
  enabled: () => boolean;
  /** macOS 14 or later, and memory enough for the model */
  supported: boolean;
  /** why not, for Settings */
  unsupported?: string;
  /** every top-level transcript grove lists */
  transcripts: () => ReadonlyArray<{ path: string; size: number }>;
  /** a session folder whose prompts are not judged. temp folders unless a test root says */
  ignore?: (cwd: string) => boolean;
  onBattery: () => boolean;
  /** the usage count is still reading every transcript: the backfill waits its turn */
  busy: () => boolean;
  spawn: () => ScorerChild;
  fetch: DownloadOptions["fetch"];
  onStatus: (s: DecisioningStatus) => void;
  now?: () => number;
  /** a test's free disk space */
  free?: DownloadOptions["free"];
}

/** node-llama-cpp's metal build declares macOS 14 as its minimum */
export const macosSupported = (platform: string, version: string): boolean =>
  platform === "darwin" && Number(version.split(".")[0]) >= 14;

/** why this mac cannot run the model, or undefined when it can */
export function unsupportedWhy(o: {
  platform: string;
  systemVersion: string;
  totalMemory: number;
  model: Pick<ModelEntry, "minMemoryGB">;
  /** the real model loads. a test root's keyword stub needs no memory to speak of */
  loads: boolean;
}): string | undefined {
  if (!macosSupported(o.platform, o.systemVersion)) return "Needs macOS 14 or later.";
  // GiB, as a mac's memory is sold: a 16 GB mac reports 16 x 1024^3
  if (o.loads && o.totalMemory < o.model.minMemoryGB * 1024 ** 3) {
    return `Needs a Mac with ${o.model.minMemoryGB} GB of memory or more.`;
  }
  return undefined;
}

/**
 * where the model goes and what judges with it. a test root keeps the weights under its own state
 * dir, judges with the keyword stub unless GROVE_SCORER=llama, downloads only from GROVE_MODEL_URL
 * (a stand-in file checked against GROVE_MODEL_SHA256 / GROVE_MODEL_SIZE), and reads its fixture
 * sessions, which live in temp folders
 */
export function decisioningSetup(o: {
  env: NodeJS.ProcessEnv;
  customRoot: boolean;
  stateDir: string;
  appData: string;
  model: ModelEntry;
  url: string;
  platform: string;
  systemVersion: string;
  totalMemory: number;
}): Pick<
  DecisioningOptions,
  | "stateDir"
  | "modelsDir"
  | "model"
  | "file"
  | "url"
  | "mode"
  | "supported"
  | "unsupported"
  | "ignore"
> {
  const test = o.customRoot;
  const size = Number(o.env.GROVE_MODEL_SIZE);
  const stand = test && o.env.GROVE_MODEL_SHA256 && size > 0;
  const mode = test && o.env.GROVE_SCORER !== "llama" ? "stub" : "llama";
  const why = unsupportedWhy({ ...o, model: o.model, loads: mode === "llama" });
  return {
    stateDir: path.join(o.stateDir, "decisioning"),
    // appData, not userData: a dev build shares the one download with the installed app
    modelsDir: test ? path.join(o.stateDir, "models") : path.join(o.appData, "Grove", "models"),
    model: o.model,
    file: stand ? { sha256: o.env.GROVE_MODEL_SHA256 ?? "", size } : o.model,
    ...((test ? o.env.GROVE_MODEL_URL : o.url)
      ? { url: test ? o.env.GROVE_MODEL_URL : o.url }
      : {}),
    mode,
    supported: why === undefined,
    ...(why ? { unsupported: why } : {}),
    ...(test ? { ignore: () => false } : {}),
  };
}

interface Pending extends FreshPrompt {
  path: string;
}

export class DecisioningService {
  private readonly o: DecisioningOptions;
  private file: ScoreFile;
  private known: Known = knownOf([]);
  private loaded = false;
  /** each transcript's last prompt text, for the next one's context. memory only */
  private readonly last = new Map<string, string>();
  /** read and not judged yet: the only place a prompt's text is held, and only until it is */
  private readonly pending = new Map<string, Pending>();
  private ready = false;
  private download: { abort: AbortController; got: number } | null = null;
  private failed: string | undefined;
  private scorer: Scorer | null = null;
  private timer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private waiting: "battery" | undefined;
  private retryAt = 0;
  private stalled: string | undefined;
  private disposed = false;

  constructor(o: DecisioningOptions) {
    this.o = o;
    this.file = { v: 1, rubric: "", files: {}, scores: {} };
  }

  /** the scorer process is up: a test root asks, to see it never is while the switch is off */
  get scorerRunning(): boolean {
    return this.scorer?.running ?? false;
  }

  private get key(): string {
    return scorerKey(this.o.model);
  }

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  private get active(): boolean {
    return this.o.enabled() && this.o.supported && this.ready && !this.disposed;
  }

  /** the cache and the weights as they are on disk. nothing is judged yet */
  async load(): Promise<void> {
    this.file = await loadScores(this.o.stateDir, this.o.rubric, this.key);
    this.known = knownOf(Object.values(this.file.files));
    void sweepOldScores(this.o.stateDir, this.o.rubric);
    this.ready = await modelReady(this.o.modelsDir, this.o.file);
    this.loaded = true;
    this.push();
    this.kick();
  }

  status(): DecisioningStatus {
    const { prompts, scored } = oddsProgress(this.file);
    const model: DecisioningStatus["model"] = {
      label: this.o.model.label,
      size: this.o.file.size,
      state: this.ready
        ? "ready"
        : this.download
          ? "downloading"
          : this.failed
            ? "failed"
            : "missing",
      ...(this.download ? { got: this.download.got } : {}),
      ...(this.failed && !this.ready ? { error: this.failed } : {}),
    };
    return {
      on: this.o.enabled(),
      supported: this.o.supported,
      ...(this.o.unsupported ? { unsupported: this.o.unsupported } : {}),
      model,
      prompts,
      scored,
      ...(this.waiting && this.active ? { waiting: this.waiting } : {}),
      ...(this.stalled && this.active ? { stalled: this.stalled } : {}),
    };
  }

  private push(): void {
    if (!this.disposed) this.o.onStatus(this.status());
  }

  /** the setting moved. on, the model comes down by itself the first time */
  switched(on: boolean): void {
    if (on && this.o.supported && !this.ready && !this.download) void this.fetchModel();
    if (!on) {
      // off is off: no download goes on, and the model's process and memory go now
      this.download?.abort.abort();
      this.scorer?.stop();
      this.scorer = null;
    }
    this.push();
    this.kick();
  }

  /** the odds, when there is anything to show: the setting on and the model ready */
  odds(
    place: (path: string) => { title: string; project: ProjectId | null } | null,
  ): OddsView | undefined {
    if (!this.active) return undefined;
    return buildOddsView({ file: this.file, rubric: this.o.rubric, model: this.o.model, place });
  }

  async fetchModel(): Promise<void> {
    if (this.download || this.ready || !this.o.supported) return;
    if (!this.o.url) {
      this.failed = "A test root downloads the model only from GROVE_MODEL_URL.";
      this.push();
      return;
    }
    const abort = new AbortController();
    this.download = { abort, got: await modelBytes(this.o.modelsDir, this.o.file) };
    this.failed = undefined;
    this.push();
    try {
      await downloadModel({
        dir: this.o.modelsDir,
        model: this.o.file,
        url: this.o.url,
        fetch: this.o.fetch,
        signal: abort.signal,
        ...(this.o.free ? { free: this.o.free } : {}),
        onProgress: (got) => {
          if (this.download) this.download.got = got;
          this.push();
        },
      });
      this.ready = true;
    } catch (e) {
      // stopped on purpose: what came down is kept, and the next try carries on from it
      if (!(e instanceof DownloadError && e.code === "aborted")) {
        this.failed = e instanceof Error ? e.message : String(e);
        log.warn("decisioning model download:", this.failed);
      }
    } finally {
      this.download = null;
      this.push();
      this.kick();
    }
  }

  /** the weights off the disk. the scores stay: they are the same model's */
  async deleteModel(): Promise<void> {
    this.download?.abort.abort();
    this.scorer?.stop();
    this.scorer = null;
    this.ready = false;
    this.failed = undefined;
    // a download in flight lets go of the part file first
    while (this.download) await new Promise((r) => setTimeout(r, 20));
    await removeModel(this.o.modelsDir, this.o.file);
    this.push();
  }

  /** transcripts moved, the power came back, the model is ready: look for work soon */
  kick(delay = KICK_MS): void {
    if (!this.loaded || this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
    this.timer.unref?.();
  }

  /** one pass at a time. one asked for during a pass runs after it */
  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass()
      .catch((e) => log.warn("decisioning:", e))
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.kick(0);
        }
      });
    return this.running;
  }

  private async pass(): Promise<void> {
    if (!this.active) return;
    await this.read();
    if (this.now < this.retryAt) return this.kick(this.retryAt - this.now);
    await this.judge();
  }

  /** what was appended to every transcript since the last read */
  private async read(): Promise<void> {
    const ignore = this.o.ignore ?? isTempCwd;
    const list = [...this.o.transcripts()].sort((a, b) => a.path.localeCompare(b.path));
    let moved = false;
    for (const { path, size } of list) {
      if (!this.active) return;
      const st = this.file.files[path];
      // judged before a restart: the text is gone, so the transcript is read again for it
      const lost = st?.prompts.some(
        (p) => !p.short && !this.file.scores[scoreKey(p)] && !this.pending.has(scoreKey(p)),
      );
      if (st && !lost && size === st.offset) continue;
      if (st?.ignored && size >= st.offset) continue;
      if (lost && st) this.forget(st);
      try {
        const r = await readPrompts(path, lost ? undefined : st, this.known, {
          ...(lost ? {} : { last: this.last.get(path) }),
          ignore,
        });
        this.file.files[path] = r.state;
        if (r.last !== undefined) this.last.set(path, r.last);
        for (const p of r.fresh) {
          if (!p.short && !this.file.scores[scoreKey(p)]) {
            this.pending.set(scoreKey(p), { ...p, path });
          }
        }
        moved = true;
      } catch (e) {
        // gone between the listing and the read
        log.warn("decisioning read:", (e as Error).message);
      }
    }
    if (moved) {
      this.save();
      this.push();
    }
  }

  private forget(st: FileState): void {
    for (const p of st.prompts) {
      this.known.uuids.delete(p.uuid);
      this.known.copies.delete(`${p.at}|${p.raw}`);
    }
  }

  /** the new ones first, then the backlog newest first, while there is power for it */
  private async judge(): Promise<void> {
    while (this.active && this.pending.size) {
      const now = this.now;
      const all = [...this.pending.values()].sort((a, b) => b.at - a.at);
      const fresh = all.filter((p) => now - p.at < NEW_MS);
      const battery = this.o.onBattery();
      this.waiting = battery && fresh.length < all.length ? "battery" : undefined;
      let batch = fresh.slice(0, BATCH);
      if (!batch.length) {
        if (battery) break;
        // the first usage count after an upgrade reads every transcript too: it goes first
        if (this.o.busy()) {
          this.kick(BUSY_MS);
          break;
        }
        batch = all.slice(0, BATCH);
      }
      const answers = await this.score(batch);
      if (!answers) break;
      batch.forEach((p, i) => {
        const probs = answers[i];
        // null: it could not be judged (longer than the model reads). kept as nothing, not again
        this.file.scores[scoreKey(p)] = probs
          ? toKept(this.o.rubric, this.key, probs)
          : { m: this.key, p: [] };
        this.pending.delete(scoreKey(p));
      });
      this.save();
      this.push();
      // the rest of the app goes on between batches
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!this.pending.size) this.waiting = undefined;
    this.push();
  }

  private async score(batch: Pending[]): Promise<Array<Probs | null> | null> {
    this.scorer ??= new Scorer({
      spawn: this.o.spawn,
      mode: this.o.mode,
      modelPath: weightsPath(this.o.modelsDir, this.o.file),
      model: this.o.model,
      rubric: this.o.rubric,
    });
    try {
      const answers = await this.scorer.score(batch.map((p) => ({ text: p.text, prev: p.prev })));
      this.stalled = undefined;
      return answers;
    } catch (e) {
      // the model would not load, or the process died: tried again on the next kick, and Settings
      // says so meanwhile, so a broken model never looks like slow judging
      this.stalled = e instanceof Error ? e.message : String(e);
      log.warn("decisioning scorer:", this.stalled);
      this.scorer.stop();
      this.scorer = null;
      this.retryAt = this.now + RETRY_MS;
      return null;
    }
  }

  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, SAVE_MS);
    this.saveTimer.unref?.();
  }

  async flush(): Promise<void> {
    if (!this.loaded) return;
    await saveScores(this.o.stateDir, this.o.rubric, this.file).catch((e) =>
      log.warn("decisioning cache:", e),
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.download?.abort.abort();
    this.scorer?.stop();
    await this.flush();
  }
}
