import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeProjectSlug } from "../../src/slug.ts";

/**
 * realpath'd straight away: os.tmpdir() is /var/folders/... which resolves to /private/var/...,
 * and every slug, membership and git porcelain assertion depends on real paths.
 */
export function makeSandbox(prefix = "grove-"): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

type Block = { type: string; text?: string; [k: string]: unknown };

export const text = (t: string): Block => ({ type: "text", text: t });

let counter = 0;
const BASE_TIME = Date.parse("2026-09-01T10:00:00.000Z");

export function envelope(extra: Record<string, unknown> = {}): Record<string, unknown> {
  counter++;
  return {
    parentUuid: null,
    isSidechain: false,
    uuid: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    timestamp: new Date(BASE_TIME + counter * 1000).toISOString(),
    userType: "external",
    entrypoint: "claude-vscode",
    cwd: "/Users/you/src/api",
    sessionId: "e4c21fe2-66d7-4dda-b9e9-556afffba8e4",
    version: "2.1.278",
    gitBranch: "main",
    ...extra,
  };
}

export function userEntry(content: string | Block[], extra: Record<string, unknown> = {}) {
  return { type: "user", message: { role: "user", content }, ...envelope(extra) };
}

export function assistantEntry(reply: string, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: reply }] },
    ...envelope(extra),
  };
}

export const record = (type: string, fields: Record<string, unknown>) => ({
  type,
  sessionId: "e4c21fe2-66d7-4dda-b9e9-556afffba8e4",
  ...fields,
});

export const aiTitle = (t: string) => record("ai-title", { aiTitle: t });
export const customTitle = (t: string) => record("custom-title", { customTitle: t });
export const agentName = (t: string) => record("agent-name", { agentName: t });
export const lastPrompt = (t: string | null) =>
  record("last-prompt", { lastPrompt: t, leafUuid: "x" });
export const summary = (t: string) => ({ type: "summary", summary: t, leafUuid: "x" });

/** an attachment line of exactly `bytes` bytes, used to push records past the 64KiB chunks */
export function padding(bytes: number): string {
  const shell = JSON.stringify({ type: "attachment", attachment: { type: "pad", data: "" } });
  return JSON.stringify({
    type: "attachment",
    attachment: { type: "pad", data: "x".repeat(Math.max(0, bytes - shell.length)) },
  });
}

export function toJsonl(lines: Array<object | string>): string {
  return `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`;
}

export function writeTranscript(
  projectsDir: string,
  cwd: string,
  sessionId: string,
  lines: Array<object | string>,
): string {
  const dir = path.join(projectsDir, claudeProjectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  // in real transcripts the session id inside the entries always equals the filename stem
  const stamped = lines.map((l) =>
    typeof l === "object" && "sessionId" in l ? { ...l, sessionId } : l,
  );
  writeFileSync(file, toJsonl(stamped));
  return file;
}

export const SID = {
  a: "11111111-1111-4111-8111-111111111111",
  b: "22222222-2222-4222-8222-222222222222",
  c: "33333333-3333-4333-8333-333333333333",
  d: "44444444-4444-4444-8444-444444444444",
};
