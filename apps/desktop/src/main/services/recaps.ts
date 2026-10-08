// a recap per session: four lines a small model writes from a digest of the conversation, through
// the person's own `claude -p`. written when a session starts needing them and when its panel
// opens, kept in a cache file, and never for a session that is working: it would be old at once.
//
// the digest is the session's own words, so the call can do nothing but answer (`--tools ""`), and
// what comes back is only ever drawn as plain text.
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ConversationState,
  isObject,
  parseRecap,
  RECAP_LABELS,
  type Recap,
  readConversation,
  readJsonGuarded,
  recapDigest,
  recapPrompt,
  writeFileAtomic,
} from "@grove/core";
import type { RecapView, SessionKey, SessionRow } from "../../shared/ipc.ts";
import { log } from "../log.ts";
import { type RunClaude, runClaude } from "./background.ts";

/** in grove's state dir. a cache: safe to delete */
export const RECAP_FILE = "recaps.v1.json";
/** the newest ones kept */
const KEEP = 500;
/** this spends the person's own Claude login, so it never fans out */
const CONCURRENCY = 2;
/** measured on 13 real sessions: 8 to 20s a call */
const TIMEOUT_MS = 30_000;
/** a call that failed is not made again for the same conversation sooner than this */
const RETRY_MS = 60_000;
const MODEL = "claude-haiku-4-5-20251001";

/**
 * every flag is needed, and docs/claude-code-facts.md says why: nothing is left on disk, no
 * settings file is read (so grove's own status hooks do not fire for it), no MCP server starts,
 * nothing can wait on a permission prompt, and it has no tool to call
 */
export function recapArgs(): string[] {
  return [
    "-p",
    "--model",
    MODEL,
    "--no-session-persistence",
    "--restricted",
    "--strict-mcp-config",
    "--permission-prompts",
    "none",
    "--tools",
    "",
  ];
}

/** what grove itself knows about where a session stands, as the digest's last line */
export function standing(row: Pick<SessionRow, "live" | "interrupted">): string | undefined {
  if (row.interrupted) {
    return row.interrupted.why === "failed"
      ? "its background run failed. nothing is running it"
      : "it stopped mid-turn: its process went away while it was working on the last thing the person typed. nothing is running it, and it only carries on when the person opens it again";
  }
  const live = row.live;
  if (live?.state === "permission") {
    const what = [live.detail, live.target].filter(Boolean).join(" ");
    return `it is waiting for the person to allow a tool call${what ? `: ${what}` : ""}`;
  }
  if (live?.state === "failed") return `it stopped on an error: ${live.detail ?? "an API error"}`;
  if (live?.state === "waiting") return "its turn is over. it is the person's turn";
  return undefined;
}

interface Kept extends Recap {
  /** when it was written */
  at: number;
  /** `ConversationState.end` of what it was written from. the conversation moved when this did */
  end: number;
}

export interface RecapsOptions {
  stateDir: string;
  claudeBin: () => Promise<string>;
  env: () => Promise<NodeJS.ProcessEnv>;
  /** the setting is on, and there is a claude this may run. read fresh: it is switched while the app is open */
  enabled: () => boolean;
  /** what `view` says of a session changed */
  onChange: () => void;
  /** a session's transcript, folded. throws when it is gone */
  read?: (key: SessionKey) => Promise<ConversationState>;
  run?: RunClaude;
  now?: () => number;
}

export class RecapService {
  private readonly o: RecapsOptions;
  private kept = new Map<SessionKey, Kept>();
  /** the conversation is known to have moved on since its recap, or is taken to have */
  private old = new Set<SessionKey>();
  /** a call for it is waiting or running */
  private writing = new Set<SessionKey>();
  /** being looked at: one look per session at a time */
  private looking = new Set<SessionKey>();
  /** a look asked for while one was under way: it runs after it, since the transcript may have moved */
  private redo = new Map<SessionKey, SessionRow>();
  /** where the conversation ended when a call for it failed, and when that was */
  private failed = new Map<SessionKey, { end: number; at: number }>();
  private running = 0;
  private waiting: Array<() => void> = [];

  constructor(o: RecapsOptions) {
    this.o = o;
  }

  async load(): Promise<void> {
    const read = await readJsonGuarded(path.join(this.o.stateDir, RECAP_FILE));
    if (read.status !== "ok" || !isObject(read.value)) return;
    for (const [key, v] of Object.entries(read.value)) {
      if (!isObject(v) || typeof v.at !== "number" || typeof v.end !== "number") continue;
      if (!RECAP_LABELS.every((l) => typeof v[l] === "string" && v[l])) continue;
      this.kept.set(key, v as unknown as Kept);
    }
  }

  /** what a row and the panel draw. nothing while recaps are off, whatever is kept */
  view(key: SessionKey): RecapView | undefined {
    if (!this.o.enabled()) return undefined;
    const k = this.kept.get(key);
    const view: RecapView = {};
    if (k) {
      view.lines = { goal: k.goal, done: k.done, state: k.state, needs: k.needs };
      view.at = k.at;
      if (this.old.has(key)) view.old = true;
    }
    if (this.writing.has(key)) view.writing = true;
    return k || view.writing ? view : undefined;
  }

  /**
   * the session is looked at, or just started needing the person (`moved`: its recap is taken to
   * be old until the transcript says otherwise). writes one when there is none for where the
   * conversation ends now. `again` writes one whatever is kept. never for a session that is
   * working. a call that failed is silent, and is made again when the conversation has moved, a
   * minute has passed or the person asks
   */
  async want(row: SessionRow, how: { moved?: boolean; again?: boolean } = {}): Promise<void> {
    const key = row.key;
    if (!this.o.enabled() || row.live?.state === "running") return;
    if (this.looking.has(key)) return void this.redo.set(key, row);
    this.looking.add(key);
    if (how.moved && this.kept.has(key) && !this.old.has(key)) {
      this.old.add(key);
      this.o.onChange();
    }
    try {
      let state = await this.read(key);
      if (state.end === 0) return;
      if (!how.again && (this.fresh(key, state) || this.gaveUp(key, state))) return;
      if (this.kept.has(key)) this.old.add(key);
      this.writing.add(key);
      this.o.onChange();
      await this.slot();
      try {
        // again, now that it is this one's turn: the wait can be long
        state = await this.read(key);
        const lines = how.again || !this.fresh(key, state) ? await this.ask(row, state) : "kept";
        if (lines === null) this.failed.set(key, { end: state.end, at: this.now() });
        else if (lines !== "kept") {
          this.failed.delete(key);
          this.kept.set(key, { ...lines, at: this.now(), end: state.end });
          this.old.delete(key);
          await this.save();
        }
      } finally {
        this.release();
      }
    } catch (e) {
      // the transcript is gone or cannot be read: what is kept stays
      log.warn("recap of", key, e instanceof Error ? e.message : e);
    } finally {
      this.looking.delete(key);
      if (this.writing.delete(key)) this.o.onChange();
      const again = this.redo.get(key);
      this.redo.delete(key);
      if (again) void this.want(again);
    }
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** a call for this very conversation failed a moment ago */
  private gaveUp(key: SessionKey, state: ConversationState): boolean {
    const f = this.failed.get(key);
    return f !== undefined && f.end === state.end && this.now() - f.at < RETRY_MS;
  }

  /** the kept recap was written from where the conversation ends now */
  private fresh(key: SessionKey, state: ConversationState): boolean {
    if (this.kept.get(key)?.end !== state.end) return false;
    if (this.old.delete(key)) this.o.onChange();
    return true;
  }

  private read(key: SessionKey): Promise<ConversationState> {
    return this.o.read?.(key) ?? readConversation(key);
  }

  /** the call. null when it failed, timed out or answered anything but the four lines */
  private async ask(row: SessionRow, state: ConversationState): Promise<Recap | null> {
    const prompt = recapPrompt(recapDigest(state, { title: row.title, now: standing(row) }));
    // never a repo: a temp dir skips the workspace trust prompt and loads nobody's CLAUDE.md
    const cwd = path.join(tmpdir(), "grove-recap");
    await mkdir(cwd, { recursive: true });
    const out = await (this.o.run ?? runClaude)(await this.o.claudeBin(), recapArgs(), {
      cwd,
      env: await this.o.env(),
      timeoutMs: TIMEOUT_MS,
      input: prompt,
    });
    const lines = out.code === 0 ? parseRecap(out.stdout) : null;
    // silent to the person, but a warn is the only trace of an expired login or a moved flag
    if (!lines) {
      log.warn(
        "recap:",
        out.code === 0 ? "not the four lines" : `exit ${out.code}`,
        (out.stderr || out.stdout).trim().split("\n")[0] ?? "",
      );
    }
    return lines;
  }

  /** at most CONCURRENCY calls at once. a slot that is given up goes straight to the next in line */
  private async slot(): Promise<void> {
    if (this.running < CONCURRENCY) this.running++;
    else await new Promise<void>((next) => this.waiting.push(next));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }

  private save(): Promise<void> {
    const newest = [...this.kept].sort((a, b) => b[1].at - a[1].at).slice(0, KEEP);
    this.kept = new Map(newest);
    return writeFileAtomic(
      path.join(this.o.stateDir, RECAP_FILE),
      JSON.stringify(Object.fromEntries(newest)),
    ).catch((e) => log.warn("recap cache write:", e));
  }
}
