// prints the electron-builder flag that makes resources/Grove.icon the app icon, when this mac can
// compile it, and nothing when it cannot. `pnpm package` puts the answer on its command line.
// electron-builder compiles the package with xcode's actool, and throws when there is none or it is
// older than 26. without the flag the build keeps resources/icon.png from electron-builder.yml.
// CI does not ask here. it passes the flag itself, so a runner that cannot compile the package fails.
import { execFileSync } from "node:child_process";

let version = "";
try {
  // a plist, with the version under short-bundle-version
  const plist = execFileSync("xcrun", ["actool", "--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  version = /<key>short-bundle-version<\/key>\s*<string>([^<]*)</.exec(plist)?.[1] ?? "";
} catch {
  // no xcode: the command line tools alone have no actool
}

if (Number.parseInt(version, 10) >= 26) console.log("-c.mac.icon=resources/Grove.icon");
else {
  const found = version ? `actool ${version}` : "no actool";
  console.error(
    `${found} here, and Grove.icon needs xcode 26: the app icon is resources/icon.png, without the glass`,
  );
}
