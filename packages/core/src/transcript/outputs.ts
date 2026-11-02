// what a session made for people: a pull request, a card, a doc, a design, a message. read out of
// the tool calls in its transcript and what they returned, by rules that are data (outputRules.ts
// plus the person's own file). nothing here is sent anywhere. no node: imports.
import { SEED_RULES } from "./outputRules.ts";

export type OutputVerb = "made" | "updated" | "commented";

export interface Output {
  /** the dedupe key. `{site}` is left in it while a jira site is not known yet, see `need` */
  url: string;
  kind: string;
  label: string;
  /** `owner/repo#12`, `CDIT-1462` */
  key?: string;
  title?: string;
  /** what the call said it was for, one line. from its input, cut short */
  description?: string;
  /** the words the call was given (a message, a body), cut short: what a title is written from */
  hint?: string;
  /** a slack channel's id, while its name is not known (`channels` on the record turns it into `#name`) */
  channel?: string;
  verb: OutputVerb;
  first: number;
  last: number;
  touches: number;
  /** the tool's own name, without the server */
  tool: string;
  /** the tool_use id of the first call. a fork copies it, which is how a fork's copy is told apart */
  id?: string;
  /** the tool_use id of the latest touch. a fork whose own calls touched it owns it too */
  lastId?: string;
  /** the transcript line the first call was on */
  uuid?: string;
  /** the jira cloud id `{site}` waits on */
  need?: string;
}

/** a kind of thing by its url. `vendor` words have to be in a tool's name for an unlisted tool to count */
export interface HostRule {
  match: string;
  kind: string;
  label: string;
  /** `$1#$2` from the match's groups */
  key?: string;
  vendor: string[];
}

/**
 * a tool by the end of its name: `createJiraIssue`, or `gdocs__insert_text` with its server, or
 * `gdocs__*` for every tool of a server. never the `mcp__…` prefix, which differs per install.
 * only for what the defaults get wrong
 */
export interface ToolRule {
  tool: string;
  /** only when `input.action` is one of these. `""` is a call with no action */
  actions?: string[];
  /** made, not `verb`, when this input path is there */
  madeIf?: string;
  verb?: OutputVerb;
  /** `{input.a.b}`, `{result.a}`, `{site:input.cloudId}`. without it the result's urls are matched to hosts */
  url?: string;
  kind?: string;
  label?: string;
  key?: string;
  title?: string;
  /** never an output */
  skip?: boolean;
  /** its result is a list of `{id, url}` atlassian sites */
  learn?: "sites";
}

/** a shell command by its head, e.g. `gh pr create`. urls in its output are matched to hosts */
export interface BashRule {
  head: string;
  verb: OutputVerb;
  /** the kinds of thing it makes. a url of another kind in its output was only mentioned */
  kinds?: string[];
  /** the flag its title is in, e.g. `--title` */
  title?: string;
}

export interface OutputRules {
  hosts: HostRule[];
  tools: ToolRule[];
  bash: BashRule[];
  /** jira cloud id -> `https://<site>.atlassian.net`, for self-hosted or when it is never learned */
  sites?: Record<string, string>;
}

/** a call seen, its result not yet */
export interface PendingCall {
  tool: string;
  verb: OutputVerb;
  at: number;
  uuid?: string;
  title?: string;
  description?: string;
  hint?: string;
  channel?: string;
  /** a slack read or search: its result names channels, and nothing here is an output */
  learnChannels?: boolean;
  /** the input as JSON, cut short. a url in it was not made by this call */
  input: string;
  rule?: number;
  bash?: boolean;
}

export interface OutputState {
  outputs?: Output[];
  waiting?: Record<string, PendingCall>;
  /** jira cloud id -> site, learned from results */
  sites?: Record<string, string>;
  /** slack channel id -> name, learned from slack results */
  channels?: Record<string, string>;
}

const CHANNEL_RE = /#([a-z0-9][a-z0-9._-]{0,79}) \((?:ID: )?([CGD][A-Z0-9]{6,})\)/g;

/** the channel's name where a list named it, for a row whose output only has the id */
export function withChannel(o: Output, channels: Record<string, string>): Output {
  if (o.description || !o.channel || !channels[o.channel]) return o;
  return { ...o, description: `#${channels[o.channel]}` };
}

/** the words a call was given, first of the usual names, cut short */
function hintOf(input: Record<string, unknown>): string | undefined {
  for (const k of ["message", "text", "body", "content", "commentBody", "markdown"]) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 300);
  }
  return undefined;
}

interface Compiled {
  hosts: Array<HostRule & { re: RegExp }>;
  tools: Array<ToolRule & { i: number }>;
  bash: Array<BashRule & { re: RegExp }>;
  sites: Record<string, string>;
  key: string;
}

const READ = new Set([
  "get",
  "list",
  "search",
  "fetch",
  "read",
  "query",
  "find",
  "view",
  "lookup",
  "describe",
  "download",
  "export",
  "whoami",
  "check",
  "load",
  "browse",
  "preview",
  "validate",
  "count",
]);
const MADE = new Set([
  "create",
  "new",
  "send",
  "post",
  "publish",
  "copy",
  "duplicate",
  "generate",
  "open",
  "start",
]);
const COMMENT = new Set(["comment", "reply", "react"]);
const WRITE = new Set([
  ...MADE,
  ...COMMENT,
  "update",
  "edit",
  "add",
  "write",
  "append",
  "insert",
  "push",
  "merge",
  "transition",
  "share",
  "batch",
  "replace",
  "set",
  "move",
  "assign",
  "close",
  "resolve",
]);
/** never outputs, whatever their names say: they act on this machine or on Claude itself */
const BUILTIN = new Set([
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  "TaskCreate",
  "TaskUpdate",
  "TaskStop",
  "TodoWrite",
  "SendMessage",
  "Skill",
  "ToolSearch",
  "AskUserQuestion",
  "ExitPlanMode",
  "EnterPlanMode",
  "CronCreate",
  "CronDelete",
  "ScheduleWakeup",
  "Monitor",
  "StructuredOutput",
  "Workflow",
  "EnterWorktree",
  "ExitWorktree",
]);
const WAITING_MAX = 64;
const INPUT_MAX = 8000;
/** long fields (a body, a doc's text) are cut one by one, so the JSON still parses */
const INPUT_FIELD_MAX = 400;
const URL_RE = /https?:\/\/[^\s"'\\<>()[\]{}|^`]+/g;

let compiled = compile(SEED_RULES);

function compile(r: OutputRules): Compiled {
  return {
    hosts: r.hosts.map((h) => ({ ...h, re: new RegExp(h.match, "i") })),
    tools: r.tools.map((t, i) => ({ ...t, i })),
    bash: r.bash.map((b) => ({ ...b, re: new RegExp(`(?:^|[\\s;&|(])${b.head}(?:\\s|$)`) })),
    sites: r.sites ?? {},
    key: hash(JSON.stringify(r)),
  };
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36);
}

/** the seed with the person's own rules on top: theirs come first, and a tool or host of theirs wins */
export function setOutputRules(own?: Partial<OutputRules>): void {
  compiled = compile(mergeRules(SEED_RULES, own));
}

export function mergeRules(seed: OutputRules, own?: Partial<OutputRules>): OutputRules {
  if (!own) return seed;
  const tools = [...(own.tools ?? [])];
  const named = new Set(tools.map((t) => t.tool));
  return {
    hosts: [...(own.hosts ?? []), ...seed.hosts],
    tools: [...tools, ...seed.tools.filter((t) => !named.has(t.tool))],
    bash: [...(own.bash ?? []), ...seed.bash],
    sites: { ...seed.sites, ...own.sites },
  };
}

/** changes when the rules do. a tally counted under other rules is read again */
export function outputRulesKey(): string {
  return compiled.key;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `mcp__claude_ai_Atlassian__atlassian__createJiraIssue` -> `createJiraIssue` */
export function toolName(name: string): string {
  const i = name.lastIndexOf("__");
  return i < 0 ? name : name.slice(i + 2);
}

/** the first rule whose name ends the tool's, at a `__` or whole, and whose action fits */
function toolRule(
  full: string,
  input: Record<string, unknown>,
): (ToolRule & { i: number }) | undefined {
  const action = typeof input.action === "string" ? input.action : "";
  return compiled.tools.find((t) => {
    if (t.actions && !t.actions.includes(action)) return false;
    if (t.tool.endsWith("__*"))
      return full.includes(`__${t.tool.slice(0, -1)}`) || full.startsWith(t.tool.slice(0, -1));
    return full === t.tool || full.endsWith(`__${t.tool}`);
  });
}

/** `createJiraIssue`, `create_issue`, `notion-create-pages` -> its words, lowercase */
export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** what a tool's name says it does: null for a read, or anything that is not a write */
export function verbOf(name: string): OutputVerb | null {
  const w = words(name);
  if (w.some((x) => READ.has(x)) && !w.some((x) => MADE.has(x) || COMMENT.has(x))) return null;
  if (!w.some((x) => WRITE.has(x))) return null;
  if (w.some((x) => COMMENT.has(x))) return "commented";
  if (w.some((x) => MADE.has(x))) return "made";
  return "updated";
}

function pathGet(root: Record<string, unknown>, path: string): unknown {
  let v: unknown = root;
  for (const p of path.split(".")) {
    if (!isObject(v)) return undefined;
    v = v[p];
  }
  return v;
}

/** `{input.a}`, `{result.b}` and `{site:input.c}` (`https://<site>`) filled in. undefined when a field is missing */
function fill(
  tpl: string,
  scope: Record<string, unknown>,
  sites: Record<string, string>,
): { url: string; need?: string } | undefined {
  let need: string | undefined;
  let missing = false;
  // a template that is one field is a url already, and is not encoded
  const whole = /^\{[a-zA-Z0-9_.]+\}$/.test(tpl);
  const url = tpl.replace(
    /\{(site:)?([a-zA-Z0-9_.]+)\}/g,
    (_, site: string | undefined, p: string) => {
      const v = pathGet(scope, p);
      if (typeof v !== "string" && typeof v !== "number") {
        missing = true;
        return "";
      }
      if (!site) return whole ? String(v) : encodeURIComponent(String(v));
      const known = sites[String(v)];
      if (known) return known.replace(/\/+$/, "");
      // some installs take the site's host name where a cloud id goes
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(v))) return `https://${v}`;
      need = String(v);
      return "{site}";
    },
  );
  return missing ? undefined : { url, ...(need ? { need } : {}) };
}

/** the title a call carries in its input, by the usual names. the first line of it */
function titleOf(input: Record<string, unknown>, path?: string): string | undefined {
  for (const p of path ? [path] : ["title", "summary", "name", "subject"]) {
    const v = pathGet(input, p);
    if (typeof v === "string" && v.trim()) return v.trim().split("\n")[0]?.trim().slice(0, 200);
  }
  return undefined;
}

/** what a call says it is for: the description it was given, when it gave one */
function descriptionOf(input: Record<string, unknown>): string | undefined {
  const v = input.description;
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : undefined;
}

/** a claude doc's first heading, from the xml its edit returns: the doc has no title field of its own */
function docHeading(text: string): string | undefined {
  const m = /heading='1'>([^<]{1,200})</.exec(text);
  return m?.[1]?.trim() || undefined;
}

/** `gh pr create --title "x y"` -> `x y` */
function flagValue(cmd: string, flag: string): string | undefined {
  const m = new RegExp(`${flag}[ =](?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)'|(\\S+))`).exec(cmd);
  const v = m?.[1] ?? m?.[2] ?? m?.[3];
  return v?.trim() ? v.trim().slice(0, 200) : undefined;
}

/**
 * every string in a result: the content blocks and the structured result beside them. a text
 * block is often JSON itself, with its slashes escaped (`https:\/\/`)
 */
function resultText(entry: Record<string, unknown>, block: Record<string, unknown>): string {
  const parts: string[] = [];
  const add = (v: unknown, depth: number) => {
    if (typeof v === "string") parts.push(v);
    else if (depth > 6) return;
    else if (Array.isArray(v)) for (const x of v) add(x, depth + 1);
    else if (isObject(v)) for (const x of Object.values(v)) add(x, depth + 1);
  };
  add(block.content, 0);
  add(entry.toolUseResult, 0);
  return parts.join("\n").replace(/\\\//g, "/");
}

function parsedResult(
  entry: Record<string, unknown>,
  block: Record<string, unknown>,
): Record<string, unknown> {
  const tur = entry.toolUseResult;
  if (isObject(tur)) return tur;
  const c = Array.isArray(tur) ? tur : block.content;
  const text =
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.map((b) => (isObject(b) && typeof b.text === "string" ? b.text : "")).join("")
        : "";
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : Array.isArray(v) ? { items: v } : {};
  } catch {
    return {};
  }
}

function hostMatch(
  url: string,
  vendorOf?: string,
): { rule: Compiled["hosts"][number]; m: RegExpExecArray } | undefined {
  for (const rule of compiled.hosts) {
    const m = rule.re.exec(url);
    if (!m || m.index !== 0) continue;
    if (vendorOf !== undefined && !rule.vendor.some((v) => vendorOf.includes(v.toLowerCase())))
      continue;
    return { rule, m };
  }
  return undefined;
}

function keyFrom(tpl: string | undefined, m: RegExpExecArray): string | undefined {
  return tpl ? tpl.replace(/\$(\d)/g, (_, i: string) => m[Number(i)] ?? "") : undefined;
}

/**
 * folds tool calls and their results into the state, in place. a call is remembered when its
 * name or command could make something, and its result is read when it comes. `wants` tells a
 * reader which result lines are worth a parse: the rest are skipped unparsed
 */
export class OutputCollector {
  private readonly s: OutputState;

  constructor(s: OutputState) {
    this.s = s;
  }

  /** a result line for a call it waits on. a substring test, before anything is parsed */
  wants(line: string): boolean {
    const w = this.s.waiting;
    // progress lines name the call too, and are never a result
    if (!w || !line.includes('"tool_result"')) return false;
    for (const id in w) if (line.includes(id)) return true;
    return false;
  }

  /** a call's line: an assistant message with tool_use blocks */
  calls(entry: Record<string, unknown>, at: number): void {
    const msg = entry.message;
    if (!isObject(msg) || !Array.isArray(msg.content)) return;
    for (const b of msg.content) {
      if (
        !isObject(b) ||
        b.type !== "tool_use" ||
        typeof b.id !== "string" ||
        typeof b.name !== "string"
      )
        continue;
      const p = this.pending(b.name, isObject(b.input) ? b.input : {}, at, entry.uuid);
      if (!p) continue;
      this.s.waiting ??= {};
      this.s.waiting[b.id] = p;
      const ids = Object.keys(this.s.waiting);
      // a call whose result never came (an interrupt, a crash) must not keep every line parsed
      for (const id of ids.slice(0, Math.max(0, ids.length - WAITING_MAX)))
        delete this.s.waiting[id];
    }
  }

  private pending(
    full: string,
    input: Record<string, unknown>,
    at: number,
    uuid: unknown,
  ): PendingCall | null {
    const name = toolName(full);
    const base = {
      at,
      ...(typeof uuid === "string" ? { uuid } : {}),
      input: JSON.stringify(input, (_, v) =>
        typeof v === "string" && v.length > INPUT_FIELD_MAX ? v.slice(0, INPUT_FIELD_MAX) : v,
      ).slice(0, INPUT_MAX),
    };
    if (name === "Bash" && full === "Bash") {
      const cmd = typeof input.command === "string" ? input.command : "";
      const i = compiled.bash.findIndex((r) => r.re.test(cmd));
      const rule = compiled.bash[i];
      if (!rule) return null;
      const title = rule.title ? flagValue(cmd, rule.title) : undefined;
      return {
        ...base,
        tool: rule.head,
        verb: rule.verb,
        rule: i,
        bash: true,
        ...(title ? { title } : {}),
        ...(descriptionOf(input) ? { description: descriptionOf(input) } : {}),
      };
    }
    const rule = toolRule(full, input);
    if (rule?.skip) return null;
    if (rule?.learn) return { ...base, tool: full, verb: "updated", rule: rule.i };
    if (!rule && BUILTIN.has(full)) return null;
    // a slack read or search names the channels it is about: learn them, the call is no output
    if (!rule && /slack/i.test(full) && verbOf(name) === null) {
      return { ...base, tool: full, verb: "updated", learnChannels: true };
    }
    const verb =
      rule?.madeIf && pathGet(input, rule.madeIf.replace(/^input\./, "")) !== undefined
        ? "made"
        : (rule?.verb ?? verbOf(name));
    if (!verb) return null;
    const title = titleOf(input, rule?.title?.replace(/^input\./, ""));
    const description = descriptionOf(input);
    const hint = hintOf(input);
    const channel = typeof input.channel_id === "string" ? input.channel_id : undefined;
    // the server is part of the name a vendor word is looked for in: `mcp__linear__create_issue`
    return {
      ...base,
      tool: full,
      verb,
      ...(description ? { description } : {}),
      ...(hint ? { hint } : {}),
      ...(channel ? { channel } : {}),
      ...(rule ? { rule: rule.i } : {}),
      ...(title ? { title } : {}),
    };
  }

  /** a result's line: a user message with tool_result blocks */
  results(entry: Record<string, unknown>, at: number): void {
    const msg = entry.message;
    const w = this.s.waiting;
    if (!w || !isObject(msg) || !Array.isArray(msg.content)) return;
    for (const b of msg.content) {
      if (!isObject(b) || b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      const p = w[b.tool_use_id];
      if (!p) continue;
      delete w[b.tool_use_id];
      if (b.is_error === true) continue;
      this.result(p, entry, b, b.tool_use_id, Number.isFinite(at) ? at : p.at);
    }
    if (!Object.keys(w).length) delete this.s.waiting;
  }

  private result(
    p: PendingCall,
    entry: Record<string, unknown>,
    block: Record<string, unknown>,
    id: string,
    at: number,
  ): void {
    const rule = !p.bash && p.rule !== undefined ? compiled.tools[p.rule] : undefined;
    if (p.learnChannels) {
      for (const m of resultText(entry, block).matchAll(CHANNEL_RE)) {
        this.s.channels ??= {};
        this.s.channels[m[2] ?? ""] = m[1] ?? "";
      }
      return;
    }
    if (rule?.learn === "sites") {
      const r = parsedResult(entry, block);
      const list = Array.isArray(r.items) ? r.items : [];
      for (const s of list) {
        if (isObject(s) && typeof s.id === "string" && typeof s.url === "string") {
          this.s.sites ??= {};
          this.s.sites[s.id] = s.url;
        }
      }
      return;
    }
    let input: Record<string, unknown> = {};
    try {
      const v: unknown = JSON.parse(p.input);
      if (isObject(v)) input = v;
    } catch {
      // cut short: the template fields are near the start, or they are missing
    }
    const result = parsedResult(entry, block);
    const resultTitle = typeof result.title === "string" ? result.title : undefined;
    // a claude doc's edit has no title in its input: its first heading is the nearest thing
    // a title the tool cut short (it ends in an ellipsis) is no title: the titler writes one
    const whole = (t: string | undefined) => (t && !t.endsWith("…") ? t : undefined);
    const title =
      whole(p.title) ??
      whole(resultTitle) ??
      (p.tool.includes("Claude_Docs") ? whole(docHeading(resultText(entry, block))) : undefined);
    const tool = toolName(p.tool);
    // a template with a field this call does not have falls through to the result's urls
    const f = rule?.url
      ? fill(rule.url, { input, result }, { ...compiled.sites, ...this.s.sites })
      : undefined;
    if (rule && f) {
      const scope = { input, result };
      const key = rule.key ? fill(rule.key, scope, {})?.url : undefined;
      const hm = f.need ? undefined : hostMatch(f.url);
      this.add({
        // `…/edit` and the plain url are one doc
        url: hm?.m[0] ?? f.url,
        kind: rule.kind ?? hm?.rule.kind ?? "link",
        label: rule.label ?? hm?.rule.label ?? "link",
        ...(key ? { key } : hm ? { key: keyFrom(hm.rule.key, hm.m) } : {}),
        ...(title ? { title } : {}),
        ...(p.description ? { description: p.description } : {}),
        ...(p.hint ? { hint: p.hint } : {}),
        ...(p.channel ? { channel: p.channel } : {}),
        verb: p.verb,
        first: at,
        last: at,
        touches: 1,
        tool,
        id,
        lastId: id,
        ...(p.uuid ? { uuid: p.uuid } : {}),
        ...(f.need ? { need: f.need } : {}),
      });
      return;
    }
    const text = resultText(entry, block);
    // a command counts for its own kinds of thing, and a tool for its own vendor's
    const vendorOf = p.bash ? undefined : p.tool.toLowerCase();
    const kinds = p.bash && p.rule !== undefined ? compiled.bash[p.rule]?.kinds : undefined;
    const minted: Array<{ url: string; hm: NonNullable<ReturnType<typeof hostMatch>> }> = [];
    const old: typeof minted = [];
    for (const raw of text.match(URL_RE) ?? []) {
      const url = raw.replace(/[.,;:!?'")\]]+$/, "");
      const hm = hostMatch(url, vendorOf);
      if (!hm || (kinds && !kinds.includes(hm.rule.kind))) continue;
      (p.input.includes(hm.m[0]) ? old : minted).push({ url: hm.m[0], hm });
    }
    // a url the call was given was not made by it. an edit or a comment still touched it
    const pick = minted[0] ?? (p.verb === "made" ? undefined : old[0]);
    if (!pick) return;
    const key = keyFrom(pick.hm.rule.key, pick.hm.m);
    this.add({
      url: pick.url,
      kind: pick.hm.rule.kind,
      label: pick.hm.rule.label,
      ...(key ? { key } : {}),
      ...(title ? { title } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(p.hint ? { hint: p.hint } : {}),
      ...(p.channel ? { channel: p.channel } : {}),
      verb: p.verb,
      first: at,
      last: at,
      touches: 1,
      tool,
      id,
      lastId: id,
      ...(p.uuid ? { uuid: p.uuid } : {}),
    });
  }

  /** a `pr-link` line: Claude Code saw the session open or push to a pull request */
  prLink(entry: Record<string, unknown>, at: number): void {
    const url = entry.prUrl;
    if (typeof url !== "string" || !url) return;
    const hm = hostMatch(url);
    const uuid = entry.uuid;
    // a fork copies these lines with their times: the time tells a copy from a new link
    const id = `pr-link:${typeof entry.timestamp === "string" ? entry.timestamp : at}`;
    this.add({
      url: hm?.m[0] ?? url,
      kind: hm?.rule.kind ?? "pr",
      label: hm?.rule.label ?? "pull request",
      ...(hm ? { key: keyFrom(hm.rule.key, hm.m) } : {}),
      verb: "updated",
      first: at,
      last: at,
      touches: 1,
      tool: "pr-link",
      id,
      lastId: id,
      ...(typeof uuid === "string" ? { uuid } : {}),
    });
  }

  private add(o: Output): void {
    if (o.key === undefined) delete o.key;
    this.s.outputs ??= [];
    const list = this.s.outputs;
    // a jira card reached through two site names is one card
    const had = list.find(
      (x) => x.url === o.url || (o.key && x.key === o.key && x.kind === o.kind),
    );
    if (!had) {
      list.push(o);
      return;
    }
    had.touches += 1;
    if (o.last >= had.last && o.lastId) had.lastId = o.lastId;
    had.last = Math.max(had.last, o.last);
    had.first = Math.min(had.first, o.first);
    had.title ??= o.title;
    had.description ??= o.description;
    had.hint ??= o.hint;
    had.channel ??= o.channel;
    if (rank(o.verb) > rank(had.verb)) {
      had.verb = o.verb;
      had.tool = o.tool;
    }
    // the first call that made it keeps its place: that is where "open at the step" goes
    if (!had.id && o.id) {
      had.id = o.id;
      if (o.uuid) had.uuid = o.uuid;
    }
  }
}

function rank(v: OutputVerb): number {
  return v === "made" ? 2 : v === "updated" ? 1 : 0;
}

/** `{site}` filled in from every site any transcript taught, when it is known now */
export function resolveSite(o: Output, sites: Record<string, string>): Output {
  if (!o.need) return o;
  const site = sites[o.need] ?? compiled.sites[o.need];
  if (!site) return o;
  const { need: _, ...rest } = o;
  return { ...rest, url: o.url.replace("{site}", site.replace(/\/+$/, "")) };
}
