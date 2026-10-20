// a prompt as the judge reads it: pasted blocks, code, links, paths, quotes of the agent and
// anything that looks like a secret become markers, and a long paste keeps its head and tail.
// the same cleaning the eval set was built with, so a model scores in grove what it was measured on.
// pure. python's \w and \b are unicode-aware and its slices count code points: so are these.

const W = "[\\p{L}\\p{N}_]";
/** python's \b: a word character on one side and not on the other */
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

const PASTED = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/gi;
const PASTED_OPEN = /<pasted_content\b[^>]*>[\s\S]*$/i;
const REMINDER_ANY = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const TASK_NOTE = /<task-notification>[\s\S]*?<\/task-notification>/g;
const IDE = /<ide_(selection|opened_file)>[\s\S]*?<\/ide_\1>/g;
const NEW_MSG = /^The user sent a new message while you were working:\s*/gm;
const NEW_MSG_TAIL = /\n*This is how Claude Code surfaces messages the user sends mid[\s\S]*$/;
const FENCE = /```[\s\S]*?(```|$)/g;
const URL = /https?:\/\/\S+/g;
const PATH = /(?<![\p{L}\p{N}_/])(?:~|\/(?:Users|private|tmp|var|opt|home|etc))\/[^\s'"`)\]]+/gu;
const IMG = /\[Image #\d+\]|\[Image: [^\]]*\]/g;
const WORD = /[A-Za-z0-9']+/g;
const MARKERS =
  /\[(quoted the assistant|pasted text|code|image|link|path|secret|id|\.\.\.cut\.\.\.)\]/g;

const SECRET_KV = new RegExp(
  `${B}(password|passwd|secret|token|api[ _-]?key|client[ _-]?(?:id|secret))(\\s*[:=]\\s*|\\s+is\\s+)\\S+`,
  "giu",
);
const UUIDISH = new RegExp(
  `${B}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${B}`,
  "giu",
);
const SECRET_BLOB = new RegExp(
  `${B}(?=[A-Za-z0-9_\\-]*\\d)(?=[A-Za-z0-9_\\-]*[A-Za-z])[A-Za-z0-9_\\-]{24,}${B}`,
  "gu",
);

/** a whole prompt that starts with a slash command is the command, not something said */
export const isSlashCommand = (text: string): boolean =>
  /^\/[a-z][\p{L}\p{N}_:.-]*(\s|$)/u.test(text.trimStart());

export function redact(t: string): string {
  return t
    .replace(SECRET_KV, (_m, key: string, sep: string) => `${key}${sep}[secret]`)
    .replace(UUIDISH, "[id]")
    .replace(SECRET_BLOB, "[secret]");
}

/** lines starting with `>` are the agent's words quoted back: one marker per run of them */
function quotedToMarker(t: string): string {
  const out: string[] = [];
  let inQuote = false;
  for (const line of t.split("\n")) {
    if (line.trimStart().startsWith(">")) {
      if (!inQuote) out.push("[quoted the assistant]");
      inQuote = true;
    } else {
      inQuote = false;
      out.push(line);
    }
  }
  return out.join("\n");
}

/** code points, as python counts them */
const chars = (t: string): string[] => Array.from(t);

export function cleanForScoring(text: string): string {
  let t = text
    .replace(NEW_MSG, "")
    .replace(NEW_MSG_TAIL, "")
    .replace(REMINDER_ANY, "")
    .replace(TASK_NOTE, "")
    .replace(IDE, "")
    .replace(PASTED, "[pasted text]")
    .replace(PASTED_OPEN, "[pasted text]")
    .replace(FENCE, "[code]")
    .replace(IMG, "[image]")
    .replace(URL, "[link]")
    .replace(PATH, "[path]");
  t = redact(quotedToMarker(t));
  t = t
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const c = chars(t);
  // a long paste with no tag (a log, a stack trace): the tone is in its head and its tail
  if (c.length > 1500) {
    t = `${c.slice(0, 1000).join("").trimEnd()}\n[...cut...]\n${c.slice(-400).join("").trimStart()}`;
  }
  return t;
}

/** the words the person wrote, markers left out */
export function ownWords(t: string): number {
  return t.replace(MARKERS, " ").match(WORD)?.length ?? 0;
}

/** shorter than this, a prompt is not judged: "ok", "go", "yes do it" */
export const MIN_WORDS = 4;

/** the person's previous prompt, as the judge sees it beside the next one */
export function previousText(t: string): string {
  const c = chars(t);
  return c.length > 300 ? `${c.slice(0, 300).join("")} [...]` : t;
}
