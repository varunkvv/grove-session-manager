import { describe, expect, it } from "vitest";
import {
  assignPrefixes,
  derivePrefix,
  projectIdOf,
  validatePrefix,
} from "../../src/project/ids.ts";
import type { Combo } from "../../src/types.ts";

const combo = (name: string, prefix?: string, root = `/ws/${name}`): Combo => ({
  name,
  root,
  folders: [],
  ...(prefix ? { prefix } : {}),
});

describe("project ids and card prefixes", () => {
  it("a project's id is its root's last segment", () => {
    expect(projectIdOf({ root: "/Users/you/claude-ws/chat-features" })).toBe("chat-features");
  });

  it("derives a prefix from the first four letters and digits", () => {
    // stand-ins for the nine combos on the owner's machine, in their file order. same prefixes
    const names = [
      "prod-debug",
      "data-tests",
      "cd-id-tool",
      "pq-help",
      "chat-features",
      "cd-it-deploy",
      "brazil-trip",
      "data-model",
      "cd-ia",
    ];
    expect(names.map(derivePrefix)).toEqual([
      "PROD",
      "DATA",
      "CDID",
      "PQHE",
      "CHAT",
      "CDIT",
      "BRAZ",
      "DATA",
      "CDIA",
    ]);
    expect(derivePrefix("1password")).toBe("PASS");
    expect(derivePrefix("d")).toBe("DP");
    expect(derivePrefix("v 2")).toBe("V2");
    expect(derivePrefix("!!!")).toBe("P");
    expect(derivePrefix("2024")).toBe("P");
    expect(derivePrefix("Écoute ça")).toBe("ECOU");
  });

  it("says what is wrong with a prefix, and nothing when it is free", () => {
    const combos = [combo("auth", "AUTH"), combo("billing", "BILL")];
    expect(validatePrefix("", combos)).toBe("Give the project a card prefix.");
    for (const bad of ["9AB", "AB-C", "ABCDEFGHI"]) {
      expect(validatePrefix(bad, combos)).toBe(
        "A card prefix is 1 to 8 letters and digits, starting with a letter.",
      );
    }
    expect(validatePrefix("f", combos)).toBe(
      "F is taken by conclusion ids (D-1, F-1, V-1). Pick another prefix.",
    );
    expect(validatePrefix("auth", combos)).toBe('"auth" already uses the prefix AUTH.');
    expect(validatePrefix("AUTH", combos, "/ws/auth")).toBeUndefined();
    expect(validatePrefix("SSO", combos)).toBeUndefined();
  });

  it("assigns a prefix to every combo without one, in file order", () => {
    const out = assignPrefixes(
      [
        combo("data-tests"),
        combo("auth", "AUTH"),
        combo("data-model"),
        combo("legacy"),
        combo("v"),
        combo("d"),
      ],
      // a project file's prefix wins over a derived one. a reserved one never does
      new Map([
        ["/ws/legacy", "OLD"],
        ["/ws/d", "D"],
      ]),
    );
    expect(Object.fromEntries(out)).toEqual({
      "/ws/data-tests": "DATA",
      "/ws/data-model": "DAT2",
      "/ws/legacy": "OLD",
      "/ws/v": "VP",
      "/ws/d": "DP",
    });
  });

  it("a stored prefix wins, even one stored further down the file", () => {
    const out = assignPrefixes(
      [combo("data-tests"), combo("legacy"), combo("other", "OLD"), combo("x", "DATA")],
      new Map([["/ws/legacy", "OLD"]]),
    );
    expect(Object.fromEntries(out)).toEqual({ "/ws/data-tests": "DAT2", "/ws/legacy": "LEGA" });
  });

  it("runs through DAT2 to DAT9, then DA10", () => {
    const combos = Array.from({ length: 11 }, (_, n) => combo(`data-${n}`));
    expect([...assignPrefixes(combos, new Map()).values()]).toEqual([
      "DATA",
      "DAT2",
      "DAT3",
      "DAT4",
      "DAT5",
      "DAT6",
      "DAT7",
      "DAT8",
      "DAT9",
      "DA10",
      "DA11",
    ]);
  });
});
