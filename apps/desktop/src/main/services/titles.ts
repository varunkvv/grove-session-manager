// a title and a one-line description per session: haiku writes both from the digest a recap is
// written from, through the person's own `claude -p`.
//
// a name is looked at again only as the session grows: when its prompts have doubled, and after a
// compaction. never while a turn runs. and a name the person gave it themselves always wins.
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ConversationState,
  isObject,
  nameDue,
  nameLook,
  namePrompt,
  parseName,
  readConversation,
  readJsonGuarded,
  type SessionName,
  type TitleSource,
  writeFileAtomic,
} from "@grove/core";
import type { SessionKey, SessionRow } from "../../shared/ipc.ts";
import { log } from "../log.ts";
import { type RunClaude, runClaude } from "./background.ts";
import { recapArgs, type Slots } from "./recaps.ts";

/** in grove's state dir. safe to delete: a session whose title grove gave it then reads as named by the person */
export const TITLE_FILE = "titles.v1.json";
/** the newest ones kept */
const KEEP = 2000;
const TIMEOUT_MS = 30_000;
/** sessions this recent are named on their own. an older one when its row comes into sight */
export const RECENT_MS = 7 * 24 * 3_600_000;

interface Kept extends SessionName {
  /** when it was last looked at */
  at: number;
  /** how many prompts the session had then, and compactions */
  prompts: number;
  compacts: number;
  /** every title grove gave it, oldest first. a custom title that is none of these is the person's */
  titles: string[];
}

/** what Claude Code calls a session, and where that came from */
export type Named = { sessionId: string; title?: string; titleSource?: TitleSource };

const custom = (r: Named) => r.titleSource === "customTitle" || r.titleSource === "agentName";

/** the person named it, with `/rename` or the tab's menu: a custom title grove never gave it */
export const theirs = (r: Named, k?: Pick<Kept, "titles">): boolean =>
  custom(r) && !k?.titles.includes(r.title ?? "");

export interface TitlesOptions {
  stateDir: string;
  claudeBin: () => Promise<string>;
  env: () => Promise<NodeJS.ProcessEnv>;
  /** titles and descriptions are written, and there is a claude this may run. read fresh */
  enabled: () => boolean;
  /** a title or a description changed */
  onChange: () => void;
  /** shared with the recaps, which go first */
  slots: Slots;
  /** the row as it is now: a look waits for a slot, and the session may have started a turn */
  row?: (key: SessionKey) => SessionRow | undefined;
  read?: (key: SessionKey) => Promise<ConversationState>;
  run?: RunClaude;
  now?: () => number;
}

export class TitleService {
  private readonly o: TitlesOptions;
  private kept = new Map<string, Kept>();
  /** by transcript: the activity it was last looked at with. one that has not moved is left */
  private seen = new Map<SessionKey, number>();
  private looking = new Set<string>();

  constructor(o: TitlesOptions) {
    this.o = o;
  }

  async load(): Promise<void> {
    const read = await readJsonGuarded(path.join(this.o.stateDir, TITLE_FILE));
    if (read.status === "ok" && isObject(read.value)) {
      for (const [id, v] of Object.entries(read.value)) {
        if (!isObject(v) || typeof v.title !== "string" || typeof v.description !== "string")
          continue;
        if (typeof v.at !== "number" || typeof v.prompts !== "number" || !Array.isArray(v.titles))
          continue;
        this.kept.set(id, {
          title: v.title,
          description: v.description,
          at: v.at,
          prompts: v.prompts,
          compacts: typeof v.compacts === "number" ? v.compacts : 0,
          titles: v.titles.filter((t): t is string => typeof t === "string"),
        });
      }
    }
  }

  /**
   * what a row is called: grove's title unless the person named it, and the description. undefined
   * leaves Claude Code's title alone
   */
  named(r: Named): { title?: string; description: string } | undefined {
    if (!this.o.enabled()) return undefined;
    const k = this.kept.get(r.sessionId);
    if (!k) return undefined;
    return theirs(r, k)
      ? { description: k.description }
      : { title: k.title, description: k.description };
  }

  /**
   * a look at a session's name, when it is due: once it has done some work, then each time its
   * prompts have doubled, and after a compaction. never while it runs, and a session that has not
   * moved since its last look is not read again. `siblings` is what the project's other sessions
   * of the last week are called, asked for only when a call is made
   */
  async want(row: SessionRow, siblings: () => readonly string[]): Promise<void> {
    const { key, sessionId: id } = row;
    if (!this.o.enabled() || row.live?.state === "running" || this.looking.has(id)) return;
    if (this.seen.get(key) === row.activityMs) return;
    this.seen.set(key, row.activityMs);
    this.looking.add(id);
    // before the read: two at a time is also as many transcripts as are folded at once
    await this.o.slots.take();
    try {
      const now = this.o.row?.(key) ?? row;
      if (now.live?.state === "running" || !this.o.enabled()) {
        // its Stop brings it back
        this.seen.delete(key);
        return;
      }
      const state = await this.read(key);
      const look = nameLook(state);
      const k = this.kept.get(id);
      if (!nameDue(k, look)) return;
      const mine = theirs(now, k);
      const answer = await this.ask(now, state, siblings(), k);
      const title = answer?.title ?? k?.title;
      const description = answer?.description ?? k?.description;
      // a first look that says "same" has nothing to keep
      if (!title || !description) return;
      // the person's own name stays: grove's is kept, and never shown or handed over
      const moved = title !== k?.title && !mine;
      const titles = k?.titles ?? [];
      const next: Kept = {
        title,
        description,
        at: this.now(),
        prompts: look.prompts,
        compacts: look.compacts,
        titles: moved ? [...titles.filter((t) => t !== title), title] : titles,
      };
      this.kept.set(id, next);
      await this.save();
      if (title !== k?.title || description !== k?.description) this.o.onChange();
    } catch (e) {
      // the transcript is gone or cannot be read: what is kept stays
      log.warn("title of", key, e instanceof Error ? e.message : e);
    } finally {
      this.o.slots.release();
      this.looking.delete(id);
    }
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private read(key: SessionKey): Promise<ConversationState> {
    return this.o.read?.(key) ?? readConversation(key);
  }

  /** the call. null when it failed, timed out or answered anything but the two lines or "same" */
  private async ask(
    row: SessionRow,
    state: ConversationState,
    siblings: readonly string[],
    k: Kept | undefined,
  ): Promise<Partial<SessionName> | null> {
    const prompt = namePrompt(state, {
      // the person's own title, when they named it: the description is still grove's to write
      current: k && { title: row.title ?? k.title, description: k.description },
      project: row.comboName ?? row.cwdBase,
      branch: row.gitBranch,
      siblings,
    });
    // never a repo: a temp dir skips the workspace trust prompt and loads nobody's CLAUDE.md
    const cwd = path.join(tmpdir(), "grove-recap");
    await mkdir(cwd, { recursive: true });
    const out = await (this.o.run ?? runClaude)(await this.o.claudeBin(), recapArgs(), {
      cwd,
      env: await this.o.env(),
      timeoutMs: TIMEOUT_MS,
      input: prompt,
    });
    const name = out.code === 0 ? parseName(out.stdout) : null;
    if (!name) {
      log.warn(
        "title:",
        out.code === 0 ? "not the two lines" : `exit ${out.code}`,
        (out.stderr || out.stdout).trim().split("\n")[0] ?? "",
      );
    }
    return name;
  }

  private save(): Promise<void> {
    const newest = [...this.kept].sort((a, b) => b[1].at - a[1].at).slice(0, KEEP);
    this.kept = new Map(newest);
    return writeFileAtomic(
      path.join(this.o.stateDir, TITLE_FILE),
      JSON.stringify(Object.fromEntries(newest)),
    ).catch((e) => log.warn("titles write:", e));
  }
}
