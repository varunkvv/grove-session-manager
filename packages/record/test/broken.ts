// preloaded with `node --import ./test/broken.ts`. it swaps one fs primitive on the shared default
// `fs` object, which is the object publish.ts calls through. the race harness uses it to prove that
// its checks catch a bad publish, and to kill a card writer between its two steps on purpose.
//
//   GROVE_TEST_BROKEN=naive        look, then copy: the "Write tool by hand" way
//   GROVE_TEST_BROKEN=rename       rename over the name: cannot refuse, last writer wins
//   GROVE_TEST_BROKEN=die-after-card-mkdir
//                                  SIGKILL this process right after it makes a card directory,
//                                  before it writes the temp file
//   GROVE_TEST_BROKEN=die-before-card-link
//                                  SIGKILL this process after the directory and the temp file
//                                  exist, just before card.md is linked into the directory
import fs from "node:fs";

const mode = process.env.GROVE_TEST_BROKEN;

if (mode === "naive") {
  fs.linkSync = ((src: fs.PathLike, dst: fs.PathLike) => {
    if (fs.existsSync(dst)) {
      const e = new Error(`EEXIST: ${String(dst)}`) as NodeJS.ErrnoException;
      e.code = "EEXIST";
      throw e;
    }
    fs.copyFileSync(src, dst);
  }) as typeof fs.linkSync;
} else if (mode === "rename") {
  fs.linkSync = ((src: fs.PathLike, dst: fs.PathLike) => {
    fs.renameSync(src, dst);
  }) as typeof fs.linkSync;
} else if (mode === "die-after-card-mkdir") {
  const real = fs.mkdirSync;
  fs.mkdirSync = ((p: fs.PathLike, opts?: fs.MakeDirectoryOptions) => {
    const r = real(p, opts as fs.MakeDirectoryOptions & { recursive: true });
    if (/[/\\]cards[/\\][A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(String(p)))
      process.kill(process.pid, "SIGKILL");
    return r;
  }) as typeof fs.mkdirSync;
} else if (mode === "die-before-card-link") {
  const real = fs.linkSync;
  fs.linkSync = ((src: fs.PathLike, dst: fs.PathLike) => {
    if (/[/\\]cards[/\\][A-Z][A-Z0-9]*-[1-9][0-9]*[/\\]card\.md$/.test(String(dst)))
      process.kill(process.pid, "SIGKILL");
    real(src, dst);
  }) as typeof fs.linkSync;
} else if (mode) {
  throw new Error(`GROVE_TEST_BROKEN=${mode} is not a mode this file knows`);
}
