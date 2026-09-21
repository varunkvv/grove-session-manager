import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseTranscript } from "../../src/transcript/parse.ts";
import { readHeadTail } from "../../src/transcript/reader.ts";
import { pickTitle } from "../../src/transcript/title.ts";
import { aiTitle, makeSandbox, padding, toJsonl, userEntry } from "../helpers/transcript.ts";

const CHUNK = 1024;

describe("readHeadTail", () => {
  const dir = makeSandbox("grove-reader-");

  it("a small file is read once and the tail is null", async () => {
    const file = path.join(dir, "small.jsonl");
    writeFileSync(file, toJsonl([userEntry("hi"), aiTitle("t")]));
    const r = await readHeadTail(file, CHUNK);
    expect(r.tail).toBeNull();
    expect(r.head.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("head is cut at its last newline, the tail's partial first line is dropped", async () => {
    const file = path.join(dir, "big.jsonl");
    const lines = [
      userEntry("first prompt"),
      padding(900),
      padding(900),
      padding(900),
      padding(700),
      aiTitle("tail title"),
    ];
    writeFileSync(file, toJsonl(lines));
    const r = await readHeadTail(file, CHUNK);
    expect(r.tail).not.toBeNull();
    for (const chunk of [r.head, r.tail!]) {
      for (const line of chunk.split("\n").filter(Boolean))
        expect(() => JSON.parse(line)).not.toThrow();
    }
    const meta = parseTranscript(r.head, r.tail);
    expect(meta.firstPrompt).toBe("first prompt");
    expect(meta.aiTitle).toBe("tail title");
  });

  it("a tail that starts exactly on a line boundary keeps its first line", async () => {
    const file = path.join(dir, "boundary.jsonl");
    const last = JSON.stringify(aiTitle("kept"));
    const tailBody = `${padding(CHUNK - last.length - 2)}\n${last}\n`;
    expect(Buffer.byteLength(tailBody)).toBe(CHUNK);
    writeFileSync(file, `${toJsonl([userEntry("p"), padding(CHUNK), padding(CHUNK)])}${tailBody}`);
    const r = await readHeadTail(file, CHUNK);
    expect(r.tail!.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("a multibyte character split by a chunk edge does no harm", async () => {
    const file = path.join(dir, "multibyte.jsonl");
    const first = JSON.stringify(userEntry("prompt"));
    // the 4-byte emoji run straddles byte CHUNK
    const filler = "😀".repeat(400);
    writeFileSync(
      file,
      `${first}\n${JSON.stringify({ type: "attachment", d: filler })}\n${padding(CHUNK)}\n${JSON.stringify(aiTitle("emoji ok 😀"))}\n`,
    );
    const r = await readHeadTail(file, CHUNK);
    expect(r.head).not.toContain("�");
    expect(r.tail).not.toContain("�");
    expect(parseTranscript(r.head, r.tail).aiTitle).toBe("emoji ok 😀");
  });

  it("a head with no newline contributes nothing and nothing throws", async () => {
    const file = path.join(dir, "oneline.jsonl");
    writeFileSync(file, `${padding(CHUNK * 3)}\n${JSON.stringify(aiTitle("still found"))}\n`);
    const r = await readHeadTail(file, CHUNK);
    expect(r.head).toBe("");
    expect(pickTitle(parseTranscript(r.head, r.tail)).title).toBe("still found");
  });

  it("a title in the middle of a big file is unreachable -> falls back to the first prompt", async () => {
    const file = path.join(dir, "middle.jsonl");
    writeFileSync(
      file,
      toJsonl([
        userEntry("what the person asked"),
        padding(CHUNK),
        padding(CHUNK),
        aiTitle("lost in the middle"),
        padding(CHUNK),
        padding(CHUNK),
        padding(CHUNK),
      ]),
    );
    const r = await readHeadTail(file, CHUNK);
    expect(pickTitle(parseTranscript(r.head, r.tail))).toEqual({
      title: "what the person asked",
      titleSource: "firstPrompt",
    });
  });

  it("with the real 64KiB chunks: a title at ~100KB is found through the tail", async () => {
    const file = path.join(dir, "real-size.jsonl");
    writeFileSync(
      file,
      toJsonl([
        userEntry("p"),
        padding(60_000),
        padding(60_000),
        aiTitle("beyond 48KB"),
        padding(30_000),
      ]),
    );
    const r = await readHeadTail(file);
    expect(r.size).toBeGreaterThan(131072);
    expect(parseTranscript(r.head, r.tail).aiTitle).toBe("beyond 48KB");
  });
});
