import { describe, expect, it } from "vitest";
import { attachKind, bytes } from "../../src/renderer/logic/attach.ts";

describe("what grove chat attaches, as vs code decides it", () => {
  it("images, pdfs and text by type, code by its name, the rest as a path", () => {
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
    ).toBe("unsupported");
    expect(attachKind("", "archive.zip")).toBe("unsupported");
  });

  it("says a size the way a chip has room for", () => {
    expect(bytes(900)).toBe("900 B");
    expect(bytes(220 * 1024)).toBe("220 KB");
    expect(bytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
  });
});
