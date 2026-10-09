import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpQueue } from "../../src/main/opQueue.ts";
import { ComboService } from "../../src/main/services/combos.ts";

describe("archiving a project", () => {
  it("is one key in combos.json: the prefix, the unknown keys, the other entries and the folder are as they were", async () => {
    const app = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-combos-")));
    const file = path.join(app, "combos.json");
    const before = {
      $comment: "hand edited",
      combos: [
        // every project of a 0.10 install still has its card prefix
        { name: "auth-sso", root: `${app}/auth-sso`, prefix: "AUTH", colour: "teal", folders: [] },
        {
          name: "notes",
          root: `${app}/notes`,
          prefix: "NOTE",
          longWork: "foreground",
          folders: [],
        },
        // an entry grove could not load is kept aside and written back
        { name: "broken", folders: [{ mode: "worktree" }] },
      ],
    };
    writeFileSync(file, JSON.stringify(before, null, 2));
    const saved = () => JSON.parse(readFileSync(file, "utf8"));
    const told = { projects: 0, model: 0 };
    const svc = new ComboService({
      appRoot: app,
      queue: new OpQueue({ mutate: 1, read: 4 }),
      onCombosChanged: () => told.projects++,
      onFolders: () => {},
      onToast: () => {},
      onModelChanged: () => told.model++,
    });
    await svc.load();

    await svc.setArchived("auth-sso", true);
    expect(saved()).toEqual({
      ...before,
      combos: [{ ...before.combos[0], archived: true }, before.combos[1], before.combos[2]],
    });
    expect(svc.list().map((c) => c.archived)).toEqual([true, undefined]);
    // the page is told, and the sessions are looked at again: its quiet ones leave the home screen
    expect(told).toEqual({ projects: 1, model: 1 });
    // nothing is made or moved on disk: no project folder, no file in one
    expect(readdirSync(app)).toEqual(["combos.json"]);

    // brought back: the key is gone, not `false`, and the file is what it was
    await svc.setArchived("auth-sso", false);
    expect(saved()).toEqual(before);
    expect(told).toEqual({ projects: 2, model: 2 });
    await expect(svc.setArchived("no-such", true)).rejects.toMatchObject({ code: "no-combo" });
  });
});
