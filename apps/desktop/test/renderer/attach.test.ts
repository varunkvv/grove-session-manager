import { describe, expect, it } from "vitest";
import { bytes, fileWord, isImage } from "../../src/renderer/logic/attach.ts";

describe("what grove chat attaches, as vs code decides it", () => {
  it("sends inline only the image types the api takes: the rest goes by its path", () => {
    expect(isImage("image/png")).toBe(true);
    expect(isImage("IMAGE/JPEG")).toBe(true);
    expect(isImage("image/webp")).toBe(true);
    // an svg is text to claude, and a heic no type the api takes
    expect(isImage("image/svg+xml")).toBe(false);
    expect(isImage("image/heic")).toBe(false);
    expect(isImage("application/pdf")).toBe(false);
    expect(isImage("")).toBe(false);
  });

  it("calls a file by its path a video, an audio file, or a file", () => {
    expect(fileWord("video/mp4")).toBe("Video");
    expect(fileWord("VIDEO/QUICKTIME")).toBe("Video");
    expect(fileWord("audio/mpeg")).toBe("Audio");
    expect(fileWord("application/zip")).toBe("File");
    expect(fileWord("")).toBe("File");
    // an image or a pdf too big to send as one goes by its path as well
    expect(fileWord("image/png")).toBe("Image");
    expect(fileWord("application/pdf")).toBe("PDF");
  });

  it("says a size the way a chip has room for", () => {
    expect(bytes(900)).toBe("900 B");
    expect(bytes(220 * 1024)).toBe("220 KB");
    expect(bytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
  });
});
