// resources/Grove.icon -> resources/icon.png (1024x1024): the icon of a build made without xcode 26,
// and the picture the docs show. a build with xcode 26 compiles the package itself.
// apple's ictool renders the package with the tile filling the canvas: no margin and no shadow. a
// full-bleed icon looks oversized in the Dock next to everything else, so the render is set at 824px
// in the middle, over the soft shadow macOS icons carry.
// put together with the chromium playwright already installs, so there is no image toolchain to add.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const resources = path.join(import.meta.dirname, "../resources");

// Icon Composer is its own download, and xcode 26 carries a copy
const ictool = [
  "/Applications/Icon Composer.app",
  "/Applications/Xcode.app/Contents/Applications/Icon Composer.app",
]
  .map((app) => path.join(app, "Contents/Executables/ictool"))
  .find((tool) => existsSync(tool));
if (!ictool) {
  console.error("Icon Composer is not installed, and it is what renders resources/Grove.icon");
  process.exit(1);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "grove-icon-"));
const render = path.join(tmp, "render.png");
try {
  // its stdout is an empty json object, so only its errors are shown
  execFileSync(
    ictool,
    [path.join(resources, "Grove.icon"), "--export-image", "--output-file", render]
      .concat(["--platform", "macOS", "--rendition", "Default"])
      .concat(["--width", "1024", "--height", "1024", "--scale", "1"]),
    { stdio: ["ignore", "ignore", "inherit"] },
  );
} catch {
  // ictool has said why
  process.exit(1);
}
const png = readFileSync(render).toString("base64");
rmSync(tmp, { recursive: true });

// the render is 16-bit and tagged display p3. chromium converts a tagged image, and is told to write
// srgb whatever this mac's display is: read as if it were srgb already, the colours come out greyer
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--force-color-profile=srgb"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(
  `<style>html,body{margin:0;background:transparent}
  img{display:block;margin:100px;width:824px;height:824px;filter:drop-shadow(0 12px 14px rgba(0,0,0,.32))}</style>
  <img src="data:image/png;base64,${png}">`,
);
await page.screenshot({ path: path.join(resources, "icon.png"), omitBackground: true });
await browser.close();
console.log(path.join(resources, "icon.png"));
