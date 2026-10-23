// grove chat's uploads: where an attached file is put for claude to read, and when it goes
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cloneInto,
  freePath,
  onPath,
  place,
  sweepUploads,
} from "../../src/main/services/uploads.ts";

const temp = (what: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), `grove-${what}-`)));
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

describe("grove chat's uploads", () => {
  it("finds a name its own place, keeping the name: a clash goes in a numbered folder", async () => {
    const dir = path.join(temp("free"), "s");
    const first = await freePath(dir, "image.png");
    expect(first).toBe(path.join(dir, "image.png"));
    writeFileSync(first, "1");
    expect(await freePath(dir, "image.png")).toBe(path.join(dir, "2", "image.png"));
    writeFileSync(path.join(dir, "2", "image.png"), "2");
    // a file called "3" where the folder would go: the next one
    writeFileSync(path.join(dir, "3"), "x");
    expect(await freePath(dir, "image.png")).toBe(path.join(dir, "4", "image.png"));
    // never out of the folder
    expect(await freePath(dir, "../../.zshrc")).toBe(path.join(dir, ".zshrc"));
    expect(await freePath(dir, "..")).toBe(path.join(dir, "file"));
  });

  it("clones a file, and the clone stays as it was when the original changes or goes", async () => {
    const away = temp("away");
    const file = path.join(away, "report final.pdf");
    writeFileSync(file, "v1");
    const dir = path.join(temp("clone"), A);
    const copy = await cloneInto(dir, file);
    expect(copy).toBe(path.join(dir, "report final.pdf"));
    writeFileSync(file, "v2");
    expect(readFileSync(copy, "utf8")).toBe("v1");
    rmSync(file);
    expect(readFileSync(copy, "utf8")).toBe("v1");
    // apfs: a clone, not a second file's worth of blocks (cp -c, not node's copyFile)
    const big = path.join(away, "big.bin");
    writeFileSync(big, Buffer.alloc(64 * 1024 * 1024, 7));
    /** free KB on the volume: df's last line, its Available */
    const free = () =>
      Number(
        execFileSync("/bin/df", ["-k", dir]).toString().trim().split("\n").at(-1)?.split(/\s+/)[3],
      );
    const before = free();
    const cloned = await cloneInto(dir, big);
    const after = free();
    expect(readFileSync(cloned).equals(readFileSync(big))).toBe(true);
    // free space barely moved: well under the 64MB a copy takes, with room for the machine's own
    expect(before - after).toBeLessThan(32 * 1024);
    await expect(cloneInto(dir, path.join(away, "gone.pdf"))).rejects.toThrow();
  });

  it("puts each file where claude reads it: its own path inside, a clone from elsewhere, a paste written", async () => {
    const cwd = temp("cwd");
    const extra = temp("extra");
    const away = temp("downloads");
    const dir = path.join(temp("uploads"), A);
    const inside = path.join(cwd, "notes.md");
    const other = path.join(extra, "plan.md");
    const outside = path.join(away, "spec.pdf");
    for (const f of [inside, other, outside]) writeFileSync(f, "x");
    // a link in cwd to a file elsewhere is that file: cloned, so a later change there is not read
    const link = path.join(cwd, "linked.pdf");
    symlinkSync(outside, link);
    const file = (p: string, mediaType = "") => ({
      kind: "file" as const,
      name: path.basename(p),
      path: p,
      mediaType,
      size: 1,
    });
    const png = { kind: "image" as const, mediaType: "image/png" as const, data: "iVBORw0KGgo=" };
    const placed = await place(
      [
        file(inside),
        file(other),
        file(outside, "application/pdf"),
        file(link),
        png,
        { kind: "data", name: "paste.txt", mediaType: "text/plain", data: "aGk=" },
      ],
      { roots: [cwd, extra], dir, queued: false },
    );
    expect(placed).toEqual([
      file(inside),
      file(other),
      { ...file(path.join(dir, "spec.pdf"), "application/pdf"), copyOf: outside },
      { ...file(path.join(dir, "linked.pdf")), copyOf: link },
      // not typed mid-turn: an image stays inline
      png,
      {
        kind: "file",
        name: "paste.txt",
        path: path.join(dir, "paste.txt"),
        mediaType: "text/plain",
        size: 2,
      },
    ]);
    expect(readFileSync(path.join(dir, "paste.txt"), "utf8")).toBe("hi");
  });

  it("writes an image typed mid-turn to disk, by its name or what it is", async () => {
    const dir = path.join(temp("uploads"), A);
    const png = "iVBORw0KGgo=";
    const placed = await place(
      [
        { kind: "image", mediaType: "image/png", data: png, name: "shot.png" },
        { kind: "image", mediaType: "image/webp", data: png },
        { kind: "image", mediaType: "image/png", data: png, name: "shot.png" },
      ],
      { roots: [], dir, queued: true },
    );
    expect(placed.map((p) => (p.kind === "file" ? p.path : p.kind))).toEqual([
      path.join(dir, "shot.png"),
      path.join(dir, "image.webp"),
      path.join(dir, "2", "shot.png"),
    ]);
    expect(placed[0]).toMatchObject({ kind: "file", mediaType: "image/png", size: 8 });
    expect(readFileSync(path.join(dir, "image.webp")).toString("base64")).toBe(png);
  });

  it("sends a file it cannot copy by its own path, as before", async () => {
    const away = temp("away");
    const file = path.join(away, "locked.pdf");
    writeFileSync(file, "x");
    // the uploads folder cannot be made: a file is where it would go
    const blocked = path.join(temp("uploads"), "file");
    writeFileSync(blocked, "");
    const f = { kind: "file" as const, name: "locked.pdf", path: file, mediaType: "", size: 1 };
    expect(await place([f], { roots: [], dir: path.join(blocked, A), queued: false })).toEqual([f]);
  });

  it("finds a program on a PATH the way a shell would", async () => {
    const bin = temp("bin");
    writeFileSync(path.join(bin, "pdftoppm"), "#!/bin/sh\n");
    expect(await onPath("pdftoppm", `/nowhere:${bin}`)).toBe(false);
    chmodSync(path.join(bin, "pdftoppm"), 0o755);
    expect(await onPath("pdftoppm", `/nowhere:${bin}`)).toBe(true);
    expect(await onPath("pdftoppm", "/usr/bin:/bin")).toBe(false);
    expect(await onPath("pdftoppm", undefined)).toBe(false);
  });

  it("lets a session's uploads go once its transcript has, and nothing when transcripts can't be listed", async () => {
    const root = temp("uploads");
    const projects = temp("projects");
    for (const id of [A, B, "not-a-session"]) {
      mkdirSync(path.join(root, id));
      writeFileSync(path.join(root, id, "x.png"), "x");
    }
    mkdirSync(path.join(projects, "-Users-v-proj"));
    writeFileSync(path.join(projects, "-Users-v-proj", `${A}.jsonl`), "");
    // a subagent's transcript is no session's: B's own is gone
    mkdirSync(path.join(projects, "-Users-v-proj", A, "subagents"), { recursive: true });
    writeFileSync(path.join(projects, "-Users-v-proj", A, "subagents", `${B}.jsonl`), "");
    writeFileSync(path.join(projects, ".DS_Store"), "");
    // the config dir moved, or there are no transcripts at all: nothing goes
    expect(await sweepUploads(root, path.join(projects, "moved"))).toEqual([]);
    expect(await sweepUploads(root, temp("empty"))).toEqual([]);
    expect(existsSync(path.join(root, B))).toBe(true);
    expect(await sweepUploads(root, projects)).toEqual([B]);
    expect(existsSync(path.join(root, A, "x.png"))).toBe(true);
    expect(existsSync(path.join(root, B))).toBe(false);
    // a folder grove did not make by a session's id is not its to delete
    expect(existsSync(path.join(root, "not-a-session"))).toBe(true);
    // no uploads yet
    expect(await sweepUploads(path.join(root, "none"), projects)).toEqual([]);
  });
});
