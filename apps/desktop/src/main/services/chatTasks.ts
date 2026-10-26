import { leftRunning, type SessionTask } from "@grove/core";

/**
 * what a grove chat's claude left running, from its own stream (probe 2026-10-26): background
 * commands and Monitors from `background_tasks_changed`, wake-ups from ScheduleWakeup's result and
 * each Stop's `session_crons`. exact to the frame, where the hook path waits for a Stop
 */
export interface ChatTask extends SessionTask {
  /** a Monitor: claude reads its output as it comes */
  monitor?: true;
  /** a wake-up ScheduleWakeup set: when it fires, ms */
  wakesAt?: number;
}

type Use = { name: string; input: Record<string, unknown> };

/** past this many tool calls the oldest are forgotten: a task's start comes within a frame of its call */
const USES_KEPT = 200;

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** a one-off cron for this local minute, the way claude code writes a wake-up's */
const cronAt = (ms: number) => {
  const d = new Date(ms);
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
};

/** a one-off cron that fires at this local minute */
function firesAt(schedule: string | undefined, ms: number): boolean {
  const [minute, hour] = schedule?.split(/\s+/) ?? [];
  const d = new Date(ms);
  return Number(minute) === d.getMinutes() && Number(hour) === d.getHours();
}

/**
 * one session's list. each call says whether the list changed. the stream says nothing at
 * startup, so a new process starts with none
 */
export class ChatTasks {
  private list: ChatTask[] = [];
  private uses = new Map<string, Use>();
  /** task id to the tool call that started it, from task_started, which may come first */
  private calls = new Map<string, string>();

  get tasks(): readonly ChatTask[] {
    return this.list;
  }

  /** one frame of the stream, any kind: the ones that say something about tasks do */
  take(frame: unknown, now: number): boolean {
    const m = frame as Record<string, unknown> | null;
    if (!m || typeof m !== "object") return false;
    if (m.type === "command_lifecycle") {
      // not in the sdk's types. a wake-up's turn starting is its firing
      return m.state === "started" &&
        typeof m.wakeup_source === "string" &&
        typeof m.scheduled_for === "number"
        ? this.woke(m.scheduled_for)
        : false;
    }
    if (m.type === "assistant") {
      const content = (m.message as { content?: unknown } | undefined)?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string")
          this.toolUse(b.id, b.name, b.input);
      }
      return false;
    }
    if (m.type === "user") {
      const r = m.tool_use_result as { scheduledFor?: unknown } | undefined;
      if (typeof r?.scheduledFor !== "number") return false;
      const content = (m.message as { content?: unknown } | undefined)?.content;
      const result = Array.isArray(content)
        ? content.find((b) => b?.type === "tool_result" && typeof b.tool_use_id === "string")
        : undefined;
      return result ? this.scheduled(result.tool_use_id, r.scheduledFor, now) : false;
    }
    if (m.type !== "system") return false;
    if (m.subtype === "background_tasks_changed" && Array.isArray(m.tasks))
      return this.changed(m.tasks, now);
    if (m.subtype === "task_started" && typeof m.task_id === "string")
      return this.started(m.task_id, str(m.tool_use_id));
    return false;
  }

  /** the Stop hook's input: its `session_crons`. its `background_tasks` the stream already said */
  stop(input: unknown, now: number): boolean {
    if (!input || typeof input !== "object") return false;
    const all = leftRunning(input as Record<string, unknown>);
    // a payload with neither array is unknown, never none
    if (!all || !Array.isArray((input as { session_crons?: unknown }).session_crons)) return false;
    return this.crons(
      all.filter((t) => t.kind === "schedule"),
      now,
    );
  }

  /** a tool call the assistant made: what a task it starts runs, and whether it is a Monitor */
  toolUse(id: string, name: string, input: unknown): void {
    if (name !== "Bash" && name !== "Monitor" && name !== "ScheduleWakeup") return;
    this.uses.set(id, { name, input: input && typeof input === "object" ? (input as never) : {} });
    if (this.uses.size > USES_KEPT) this.uses.delete(this.uses.keys().next().value!);
  }

  /** task_started: fills in an entry the set has, or one it will have. never adds one */
  started(taskId: string, toolUseId: string | undefined): boolean {
    if (!toolUseId) return false;
    this.calls.set(taskId, toolUseId);
    const at = this.list.findIndex((t) => t.id === taskId);
    if (at < 0) return false;
    const next = this.withCall(this.list[at]!);
    if (next === this.list[at]) return false;
    this.list = this.list.map((t, i) => (i === at ? next : t));
    return true;
  }

  /**
   * every live background task, whole (REPLACE, the sdk's types say): the commands are these. a
   * subagent or a workflow has its own rows. what is not in it has ended, and never comes back
   */
  changed(
    tasks: ReadonlyArray<{ task_id: string; task_type: string; description: string }>,
    now: number,
  ): boolean {
    const was = new Map(this.list.filter((t) => t.kind === "command").map((t) => [t.id, t]));
    const commands = tasks
      .filter((t) => t.task_type === "local_bash")
      .map(
        (t) =>
          was.get(t.task_id) ??
          this.withCall({
            id: t.task_id,
            kind: "command",
            description: t.description || "Background command",
            since: now,
          }),
      );
    for (const id of was.keys()) if (!commands.some((c) => c.id === id)) this.calls.delete(id);
    const same = commands.length === was.size && commands.every((c) => was.get(c.id) === c);
    if (same) return false;
    this.list = [...commands, ...this.list.filter((t) => t.kind === "schedule")];
    return true;
  }

  /** ScheduleWakeup's result: the wake-up is set, for then */
  scheduled(toolUseId: string, scheduledFor: number, now: number): boolean {
    const use = this.uses.get(toolUseId);
    if (use?.name !== "ScheduleWakeup") return false;
    const id = `wakeup-${toolUseId}`;
    if (this.list.some((t) => t.id === id)) return false;
    this.list = [
      ...this.list,
      {
        id,
        kind: "schedule",
        description: str(use.input.prompt) ?? "",
        schedule: cronAt(scheduledFor),
        wakesAt: scheduledFor,
        since: now,
      },
    ];
    return true;
  }

  /**
   * a wake-up fired (command_lifecycle started, with its wakeup_source and scheduled_for): the
   * one-off one for then is gone. a repeating cron stays
   */
  woke(scheduledFor: number): boolean {
    const gone = (t: ChatTask) =>
      t.kind === "schedule" &&
      !t.recurring &&
      (t.wakesAt !== undefined ? t.wakesAt === scheduledFor : firesAt(t.schedule, scheduledFor));
    if (!this.list.some(gone)) return false;
    this.list = this.list.filter((t) => !gone(t));
    return true;
  }

  /**
   * a turn's Stop: `session_crons` is every wake-up and cron there is (CronCreate, CronDelete and
   * /loop too). one it had keeps when it was first seen, and when it fires, by its prompt
   */
  crons(crons: ReadonlyArray<Omit<SessionTask, "since">>, now: number): boolean {
    const had = this.list.filter((t) => t.kind === "schedule");
    const taken = new Set<ChatTask>();
    const next = crons.map((c): ChatTask => {
      const prior =
        had.find((t) => t.id === c.id) ??
        had.find((t) => !taken.has(t) && t.description === c.description);
      if (prior) taken.add(prior);
      return {
        ...c,
        since: prior?.since ?? now,
        ...(prior?.wakesAt !== undefined && !c.recurring ? { wakesAt: prior.wakesAt } : {}),
      };
    });
    const key = (l: readonly ChatTask[]) => JSON.stringify(l);
    if (key(next) === key(had)) return false;
    this.list = [...this.list.filter((t) => t.kind === "command"), ...next];
    return true;
  }

  /** the process is gone, and all it ran with it */
  clear(): boolean {
    this.calls.clear();
    this.uses.clear();
    if (!this.list.length) return false;
    this.list = [];
    return true;
  }

  private withCall(t: ChatTask): ChatTask {
    const call = this.calls.get(t.id);
    const use = call ? this.uses.get(call) : undefined;
    if (!use) return t;
    const command = str(use.input.command);
    const monitor = use.name === "Monitor";
    if (t.command === command && !!t.monitor === monitor) return t;
    return { ...t, ...(command ? { command } : {}), ...(monitor ? { monitor: true } : {}) };
  }
}
