import { describe, expect, it } from "vitest";
import { attachKind, bytes, fileWord } from "../../src/renderer/logic/attach.ts";

describe("what grove chat attaches, as vs code decides it", () => {
  it("images, pdfs and text by type, code by its name, the rest as a file by its path", () => {
    expect(attachKind("image/png", "shot.png")).toBe("image");
    expect(attachKind("IMAGE/JPEG", "a.jpg")).toBe("image");
    // an svg is text to claude, not an image the api takes
    expect(attachKind("image/svg+xml", "logo.svg")).toBe("text");
    expect(attachKind("application/pdf", "spec.pdf")).toBe("pdf");
    expect(attachKind("text/csv", "data.csv")).toBe("text");
    expect(attachKind("application/json", "x")).toBe("text");
    // chromium gives code files an empty type, and .ts a video one
    expect(attachKind("", "retry.py")).toBe("text");
    expect(attachKind("video/mp2t", "retry.ts")).toBe("text");
    expect(attachKind("", "Dockerfile")).toBe("text");
    expect(attachKind("", "LICENSE")).toBe("text");
    expect(
      attachKind(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "report.docx",
      ),
    ).toBe("file");
    expect(attachKind("", "archive.zip")).toBe("file");
    expect(attachKind("application/zip", "archive.zip")).toBe("file");
    expect(attachKind("video/mp4", "clip.mp4")).toBe("file");
    expect(attachKind("video/quicktime", "Screen Recording.mov")).toBe("file");
    expect(attachKind("audio/mpeg", "memo.mp3")).toBe("file");
    // an image the api takes no block for goes by its path too
    expect(attachKind("image/heic", "IMG_0001.HEIC")).toBe("file");
    // no type and a name chromium does not know
    expect(attachKind("", "blob")).toBe("file");
  });

  it("calls a file by its path a video, an audio file, or a file", () => {
    expect(fileWord("video/mp4")).toBe("Video");
    expect(fileWord("VIDEO/QUICKTIME")).toBe("Video");
    expect(fileWord("audio/mpeg")).toBe("Audio");
    expect(fileWord("application/zip")).toBe("File");
    expect(fileWord("")).toBe("File");
  });

  it("says a size the way a chip has room for", () => {
    expect(bytes(900)).toBe("900 B");
    expect(bytes(220 * 1024)).toBe("220 KB");
    expect(bytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
  });
});
