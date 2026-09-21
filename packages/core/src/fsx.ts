import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** unique tmp + rename. readers never see a half-written file, last writer wins. */
export async function writeFileAtomic(file: string, data: string, mode?: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, mode === undefined ? "utf8" : { encoding: "utf8", mode });
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export type JsonRead<T> =
  | { status: "ok"; value: T; text: string }
  | { status: "missing" }
  | { status: "invalid"; text: string; message: string };

export async function readJsonGuarded<T = unknown>(file: string): Promise<JsonRead<T>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "invalid", text: "", message: String(e) };
  }
  try {
    return { status: "ok", value: JSON.parse(text) as T, text };
  } catch (e) {
    return { status: "invalid", text, message: (e as Error).message };
  }
}

/** strips // and block comments and trailing commas outside strings. enough for .code-workspace files. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      const start = i++;
      while (i < n && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export async function readJsoncTolerant<T = unknown>(file: string): Promise<JsonRead<T>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "invalid", text: "", message: String(e) };
  }
  try {
    return { status: "ok", value: JSON.parse(stripJsonc(text)) as T, text };
  } catch (e) {
    return { status: "invalid", text, message: (e as Error).message };
  }
}

/** indentation of an existing JSON document, so a rewrite does not reformat a hand-edited file */
export function detectIndent(text: string): string | number {
  const m = /^[{[]\r?\n([ \t]+)\S/.exec(text);
  return m ? m[1]! : 2;
}

export function stringifyLike(value: unknown, originalText?: string): string {
  const indent = originalText ? detectIndent(originalText) : 2;
  const nl = originalText === undefined || originalText.endsWith("\n") ? "\n" : "";
  return JSON.stringify(value, null, indent) + nl;
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
