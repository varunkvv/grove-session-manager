// what one agent did, folded out of its transcript line by line. no node: imports - the types and
// the wording helpers are the renderer's too. reading the file is agentTimeline.ts.
import { squash } from "../transcript/title.ts";

/** bumped when the folded shape changes, so a cached timeline from an older build is not trusted */
export const TIMELINE_VERSION = 2;

/** what a step keeps of a tool's result. the whole of it is read again when someone opens the step. */
export const RESULT_PREVIEW = 300;
export const INPUT_PREVIEW = 400;
/** prose between steps is the agent explaining itself. past this it is a report, cut. */
const TEXT_MAX = 20_000;
const PROMPT_MAX = 50_000;

const INTERRUPTED = "[Request interrupted";
const COORDINATOR = "The coordinator sent a message while you were working:";

/** where a line sits in the agent's own transcript. the file only ever grows, so it stays true. */
export interface LineRef {
  offset: number;
  length: number;
}

export interface ToolStep {
  kind: "tool";
  /** the tool_use id: pairs a call with its result, and an Agent call with the agent it started */
  id: string;
  name: string;
  /** a few words from the input: the file, the command, the pattern */
  target: string;
  /** the input as json, cut short */
  input: string;
  at: number;
  /** from the call to its result. absent while the tool is still running. */
  durationMs?: number;
  /** the start of what came back */
  result?: string;
  isError?: boolean;
  /** "exit 1", "rejected", "error" - only on a failed step */
  failure?: string;
  /** the line holding the call */
  use: LineRef;
  /** the line holding the result */
  ref?: LineRef;
  /** ran on the api side (the advisor): it counts as nothing and there is nothing to open */
  server?: boolean;
}

export interface TextStep {
  kind: "text";
  text: string;
  at: number;
}

export interface ThinkingStep {
  kind: "thinking";
  text: string;
  at: number;
}

/** said to the agent after its prompt: a message from whoever started it, or an interrupt */
export interface MessageStep {
  kind: "message";
  text: string;
  at: number;
  interrupted?: boolean;
}

export type AgentStep = ToolStep | TextStep | ThinkingStep | MessageStep;

/** everything the fold keeps between reads. plain data: it is cached as json. */
export interface TimelineState {
  version: number;
  /** bytes of whole lines read so far. the next read starts here. */
  offset: number;
  cwd?: string;
  prompt?: string;
  steps: AgentStep[];
  /** the model of the last real response */
  model?: string;
  /**
   * the response seen last. one response is written as a line per content block, all with the
   * same message id, and a later line can carry larger usage - so its lines fold into this.
   */
  last?: {
    id: string;
    /** indexes into steps of its text blocks: the result, if nothing comes after it */
    texts: number[];
    /** it called a tool, so it is not the end */
    tool: boolean;
    /** Claude Code wrote this one itself, to say the api call failed */
    error?: string;
  };
  /**
   * usage of the newest line that has any: the final count of the last real response. a line
   * Claude Code writes itself carries none, so an agent that died on an api error keeps the
   * context it had.
   */
  tokens: number;
  toolCount: number;
  startedAt?: number;
  lastAt?: number;
  /** the last thing in the file is an interrupt */
  interrupted?: boolean;
}

/** a timeline as the inspector shows it */
export interface AgentTimeline {
  prompt?: string;
  /** in order. the text of the final message is not here - that is the result. */
  steps: AgentStep[];
  /** what it came back with: every text block of its final message */
  result?: string;
  model?: string;
  /**
   * the context its last response ran with: input, output and both cache counts. this is what
   * Claude Code itself reports for an agent, not a sum over every response.
   */
  tokens: number;
  /** tool calls. the advisor runs on the api side and is not one, same as Claude Code counts. */
  toolCount: number;
  startedAt?: number;
  /** the last timestamp in the file. an end, once the agent is done. */
  lastAt?: number;
  /** the api error Claude Code wrote in as the agent's last word */
  error?: string;
  interrupted?: boolean;
}

export function emptyTimelineState(): TimelineState {
  return { version: TIMELINE_VERSION, offset: 0, steps: [], tokens: 0, toolCount: 0 };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** a path as short as it can be said: inside the agent's folder, under home, or whole */
export function shortPath(p: string, cwd?: string, home?: string): string {
  if (cwd && p === cwd) return ".";
  if (cwd && p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
  if (home && p.startsWith(`${home}/`)) return `~/${p.slice(home.length + 1)}`;
  return p;
}

/** the keys a tool's input says the most in, most specific first */
export const INPUT_HINTS = [
  "file_path",
  "notebook_path",
  "command",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
  "path",
] as const;

export function inputHint(input: unknown, max = 120): string {
  if (!isObject(input)) return "";
  for (const key of INPUT_HINTS) {
    const v = input[key];
    if (typeof v === "string" && v) return squash(v, max);
  }
  return "";
}

/**
 * a few words that say what a call was about: the file, the command, what was searched for.
 * always from `tool_use.input`, never `wireToolInputs` - the wire copy of a Bash command has the
 * `cd <cwd> &&` Claude Code puts in front, which is noise here.
 */
export function toolTarget(name: string, input: unknown, cwd?: string, home?: string): string {
  if (!isObject(input)) return "";
  const path = (p: string | undefined) => (p ? shortPath(p, cwd, home) : "");
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return path(str(input.file_path) ?? str(input.notebook_path));
    case "Bash": {
      // a leading `cd somewhere &&` says nothing the row does not already
      let command = (str(input.command) ?? "").replace(
        /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/,
        "",
      );
      // the agent's own folder and the home directory are most of the length of a command
      if (cwd) command = command.split(`${cwd}/`).join("");
      if (home) command = command.split(`${home}/`).join("~/");
      return squash(command, 200);
    }
    case "Grep":
    case "Glob": {
      const pattern = str(input.pattern) ?? "";
      const where = str(input.path) ?? (name === "Grep" ? str(input.glob) : undefined);
      const what = name === "Grep" ? `"${squash(pattern, 80)}"` : squash(pattern, 80);
      return where ? `${what} in ${path(where)}` : what;
    }
    case "WebFetch":
      return (str(input.url) ?? "").replace(/^https?:\/\//, "");
    case "WebSearch":
      return squash(str(input.query) ?? "", 120);
    case "Agent":
    case "Task":
      return squash(str(input.description) ?? str(input.subagent_type) ?? "", 120);
    case "Skill":
      return str(input.skill) ?? str(input.command) ?? "";
    case "TodoWrite":
      return Array.isArray(input.todos) ? `${input.todos.length} todos` : "";
    case "ToolSearch":
      return squash(str(input.query) ?? "", 120);
  }
  return inputHint(input);
}

/**
 * the name as a column can hold it. an mcp tool is `mcp__<server>__<tool>`, and the server is the
 * least useful part of it.
 */
export function toolLabel(name: string): string {
  const m = /^mcp__.+__([^_].*)$/.exec(name);
  return m ? m[1]! : name;
}

/** how a failed step failed, in a word or two */
export function failureOf(text: string): string {
  const exit = /^(?:Error: )?Exit code (\d+)/.exec(text);
  if (exit) return `exit ${exit[1]}`;
  if (text.startsWith("The user doesn't want to proceed")) return "rejected";
  return "error";
}

/** a tool result's content: a string, or blocks of which only the text says anything */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      isObject(b) && b.type === "text" && typeof b.text === "string"
        ? b.text
        : isObject(b) && b.type === "image"
          ? "[image]"
          : "",
    )
    .filter(Boolean)
    .join("\n");
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  return resultText(content);
}

function usageTotal(u: unknown): number {
  if (!isObject(u)) return 0;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return (
    n(u.input_tokens) +
    n(u.output_tokens) +
    n(u.cache_read_input_tokens) +
    n(u.cache_creation_input_tokens)
  );
}

export interface FoldOptions {
  home?: string;
  /** what a tool step keeps of its input. 0 keeps none: a view that never shows it. */
  inputPreview?: number;
  /** what a tool step keeps of its result. 0 keeps none. */
  resultPreview?: number;
  /**
   * the prompt is someone else's business: every user text is something said part way through.
   * a session's turn is folded this way - its prompt was read before the work started.
   */
  promptless?: boolean;
}

/**
 * folds transcript lines into a timeline, in place. steps are replaced, never mutated, so a
 * step that did not change is the same object before and after - that is how a tail finds the
 * first step worth sending again.
 */
export class TimelineFold {
  readonly state: TimelineState;
  private readonly home: string | undefined;
  private readonly inputPreview: number;
  private readonly resultPreview: number;
  private readonly promptless: boolean;
  /** tool_use id -> index of the step still waiting for its result */
  private readonly pending = new Map<string, number>();

  constructor(state: TimelineState = emptyTimelineState(), opts: FoldOptions = {}) {
    // the array is copied and the steps shared: the caller's copy must not see a change
    this.state = {
      ...state,
      steps: [...state.steps],
      ...(state.last ? { last: { ...state.last, texts: [...state.last.texts] } } : {}),
    };
    this.home = opts.home;
    this.inputPreview = opts.inputPreview ?? INPUT_PREVIEW;
    this.resultPreview = opts.resultPreview ?? RESULT_PREVIEW;
    this.promptless = opts.promptless ?? false;
    this.state.steps.forEach((s, i) => {
      if (s.kind === "tool" && s.durationMs === undefined && !s.ref) this.pending.set(s.id, i);
    });
  }

  /** one whole line, and where it sits in the file */
  line(text: string, offset: number, length: number): void {
    if (text.charCodeAt(0) !== 0x7b) return;
    let entry: unknown;
    try {
      entry = JSON.parse(text);
    } catch {
      // a torn or junk line. the rest of the file still counts.
      return;
    }
    if (isObject(entry)) this.entry(entry, offset, length);
  }

  /** a line already parsed: a session's fold reads every line once and hands its turn the work */
  entry(entry: Record<string, unknown>, offset: number, length: number): void {
    const s = this.state;
    const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    if (Number.isFinite(parsed)) {
      s.startedAt ??= parsed;
      s.lastAt = Math.max(s.lastAt ?? parsed, parsed);
    }
    const at = Number.isFinite(parsed) ? parsed : (s.lastAt ?? 0);
    if (!s.cwd && typeof entry.cwd === "string") s.cwd = entry.cwd;
    if (entry.type === "assistant") this.assistant(entry, at, { offset, length });
    else if (entry.type === "user") this.user(entry, at, { offset, length });
    // attachments are hook results and tool listings: not what the agent did
  }

  private push(step: AgentStep): number {
    this.state.steps.push(step);
    return this.state.steps.length - 1;
  }

  private assistant(entry: Record<string, unknown>, at: number, line: LineRef): void {
    const s = this.state;
    const message = entry.message;
    if (!isObject(message)) return;
    const id = str(message.id) ?? `line@${line.offset}`;
    if (s.last?.id !== id) s.last = { id, texts: [], tool: false };
    const last = s.last;
    // it carried on, so whatever interrupted it was not the end
    s.interrupted = false;
    const content = Array.isArray(message.content) ? message.content : [];
    const model = str(message.model);
    // "<synthetic>" is Claude Code writing in its own words, usually an api error. nothing was billed.
    if (entry.isApiErrorMessage === true || model?.startsWith("<")) {
      const text = content
        .map((b) => (isObject(b) && typeof b.text === "string" ? b.text : ""))
        .join(" ")
        .trim();
      if (entry.isApiErrorMessage === true || text.startsWith("API Error")) {
        last.error = squash(text || "API error", 300);
      }
      return;
    }
    if (model) s.model = model;
    const tokens = usageTotal(message.usage);
    if (tokens > 0) s.tokens = tokens;
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        last.texts.push(this.push({ kind: "text", text: cut(block.text, TEXT_MAX), at }));
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        // a redacted block is only a signature: nothing to show
        if (block.thinking.trim()) {
          this.push({ kind: "thinking", text: cut(block.thinking, TEXT_MAX), at });
        }
      } else if (block.type === "tool_use" || block.type === "server_tool_use") {
        const toolId = str(block.id);
        const name = str(block.name) ?? "tool";
        if (!toolId) continue;
        const server = block.type === "server_tool_use";
        if (!server) {
          s.toolCount++;
          last.tool = true;
        }
        let input = "";
        try {
          if (this.inputPreview > 0) {
            input = cut(JSON.stringify(block.input ?? {}), this.inputPreview);
          }
        } catch {
          // an input that does not serialise has nothing to show
        }
        const step: AgentStep = {
          kind: "tool",
          id: toolId,
          name,
          target: toolTarget(name, block.input, s.cwd, this.home),
          input,
          at,
          use: line,
          ...(server ? { server: true } : {}),
        };
        this.pending.set(toolId, this.push(step));
      } else if (typeof block.tool_use_id === "string" && block.type !== "tool_result") {
        // a server tool's result comes back inside the same response (advisor_tool_result)
        this.settle(block.tool_use_id, at, undefined, line);
      }
    }
  }

  private settle(
    toolUseId: string,
    at: number,
    result: { text: string; isError: boolean } | undefined,
    line: LineRef,
  ): void {
    const i = this.pending.get(toolUseId);
    if (i === undefined) return;
    this.pending.delete(toolUseId);
    const step = this.state.steps[i];
    if (step?.kind !== "tool") return;
    const next: ToolStep = { ...step, durationMs: Math.max(0, at - step.at) };
    if (result) {
      next.ref = line;
      if (result.text && this.resultPreview > 0) {
        next.result = squash(result.text, this.resultPreview);
      }
      if (result.isError) {
        next.isError = true;
        next.failure = failureOf(result.text);
      }
    }
    this.state.steps[i] = next;
  }

  private user(entry: Record<string, unknown>, at: number, line: LineRef): void {
    const s = this.state;
    const message = entry.message;
    if (!isObject(message)) return;
    const content = message.content;
    if (Array.isArray(content) && content.some((b) => isObject(b) && b.type === "tool_result")) {
      for (const b of content) {
        if (!isObject(b) || b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        this.settle(
          b.tool_use_id,
          at,
          { text: resultText(b.content), isError: b.is_error === true },
          line,
        );
      }
      return;
    }
    const text = userText(content).trim();
    if (!text) return;
    // the first thing an agent is given is what it was asked to do
    if (
      !this.promptless &&
      s.prompt === undefined &&
      s.steps.length === 0 &&
      entry.isMeta !== true
    ) {
      s.prompt = cut(text, PROMPT_MAX);
      return;
    }
    if (text.startsWith(INTERRUPTED)) {
      this.push({ kind: "message", text, at, interrupted: true });
      s.interrupted = true;
      return;
    }
    const origin = entry.origin;
    const coordinator = isObject(origin) && origin.kind === "coordinator";
    // other meta lines are Claude Code talking to itself: image sizes, a retry after a cut-off
    if (entry.isMeta === true && !coordinator) return;
    const said = text.startsWith(COORDINATOR) ? text.slice(COORDINATOR.length).trim() : text;
    if (said) this.push({ kind: "message", text: cut(said, TEXT_MAX), at });
  }
}

/** the state as the inspector shows it: the final message's text lifted out as the result */
export function timelineView(state: TimelineState): AgentTimeline {
  const last = state.last;
  const final = last && !last.tool && !last.error && last.texts.length > 0 ? last.texts : null;
  const drop = new Set(final ?? []);
  const texts = (final ?? []).flatMap((i) => {
    const step = state.steps[i];
    return step?.kind === "text" ? [step.text] : [];
  });
  const view: AgentTimeline = {
    steps: drop.size ? state.steps.filter((_, i) => !drop.has(i)) : state.steps,
    tokens: state.tokens,
    toolCount: state.toolCount,
  };
  if (state.prompt !== undefined) view.prompt = state.prompt;
  if (texts.length) view.result = texts.join("\n\n");
  if (state.model) view.model = state.model;
  if (state.startedAt !== undefined) view.startedAt = state.startedAt;
  if (state.lastAt !== undefined) view.lastAt = state.lastAt;
  if (last?.error) view.error = last.error;
  if (state.interrupted) view.interrupted = true;
  return view;
}

/** a sentence shorter than this says nothing on its own ("Done.") and takes the next one along */
const SHORT_SENTENCE = 24;

/**
 * the first sentence of a result, as plain words: the one line a row has room for. markdown
 * syntax is dropped rather than rendered - this is a summary line, not the report.
 */
export function firstSentence(markdown: string, max = 160): string {
  let heading = "";
  let said = "";
  for (const raw of markdown.split("\n")) {
    const isHeading = /^\s*#{1,6}\s/.test(raw);
    let line = raw
      .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "")
      .replace(/[*_`~]+/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .trim();
    // a fence, a rule or a table row is not a sentence
    if (!line || /^(\||-{3,}|={3,})/.test(line)) continue;
    // a heading is a title. only when there is nothing else does it stand in for a sentence.
    if (isHeading) {
      if (said) break;
      heading ||= line;
      continue;
    }
    while (line) {
      const end = /[.!?](\s|$)/.exec(line);
      const sentence = end ? line.slice(0, end.index + 1) : line;
      said = said ? `${said} ${sentence}` : sentence;
      if (said.length >= SHORT_SENTENCE) return squash(said, max);
      line = end ? line.slice(end.index + 1).trim() : "";
    }
  }
  return squash(said || heading, max);
}

/** a workflow journal's result: text as it is, anything structured as json the renderer can show */
export function workflowResultText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (value === undefined || value === null) return undefined;
  try {
    return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  } catch {
    return undefined;
  }
}

/**
 * which agent started which. an Agent call's id is the `toolUseId` in the meta file of the agent
 * it started - for an agent another agent spawned, the same as for one the session spawned.
 */
export function agentParents(
  agents: ReadonlyArray<{ id: string; toolUseId?: string }>,
  stepsByAgent: ReadonlyMap<string, readonly AgentStep[]>,
): Map<string, string> {
  const byCall = new Map<string, string>();
  for (const [id, steps] of stepsByAgent) {
    for (const s of steps) {
      if (s.kind === "tool" && (s.name === "Agent" || s.name === "Task")) byCall.set(s.id, id);
    }
  }
  const parents = new Map<string, string>();
  for (const a of agents) {
    const parent = a.toolUseId ? byCall.get(a.toolUseId) : undefined;
    if (parent && parent !== a.id) parents.set(a.id, parent);
  }
  return parents;
}
