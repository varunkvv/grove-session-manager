// resources/icon.svg -> resources/icon.png (1024x1024). electron-builder turns that into the .icns.
// rendered with the chromium playwright already installs, so there is no image toolchain to add.
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const resources = path.join(import.meta.dirname, "../resources");
const svg = readFileSync(path.join(resources, "icon.svg"), "utf8");

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
// an svg opened directly has no body to style, so it goes inside a page instead
await page.setContent(
  `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`,
);
await page.screenshot({ path: path.join(resources, "icon.png"), omitBackground: true });
await browser.close();
console.log(path.join(resources, "icon.png"));
