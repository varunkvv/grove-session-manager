// dev only: screenshots of the renderer against mock data, in the system Chrome. no Electron needed.
//   node scripts/preview-shots.mjs [outDir]
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const scheme = process.env.GROVE_PREVIEW_SCHEME === "light" ? "light" : "dark";
const out =
  process.argv[2] ?? path.join(import.meta.dirname, `../e2e/screenshots/preview-${scheme}`);
mkdirSync(out, { recursive: true });
const server = await createServer({
  configFile: path.join(import.meta.dirname, "../vite.config.ts"),
  server: { port: 5199 },
  logLevel: "error",
});
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1180, height: 760 },
  deviceScaleFactor: 2,
  colorScheme: scheme,
});
const shot = async (name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
};
const open = async (variant) => {
  await page.goto(`http://localhost:5199/?mock=${variant}`);
  await page.getByTestId("app-ready").waitFor();
};

await open("full");
await shot("01-all-sessions");
await page.getByTestId("search").fill("queue");
await shot("02-search");
await page.getByTestId("search").fill("");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await shot("03-action-menu");
await page.keyboard.press("Escape");
await page.getByTestId("combo-row").first().locator("button").first().click();
await shot("04-combo-selected");
await open("drift");
await page.getByTestId("combo-row").nth(1).locator("button").first().click();
await shot("05-drift");
await page.getByTestId("new-combo").click();
await page.getByTestId("combo-name").fill("feature-x");
await page.getByTestId("add-folder").click();
await page.getByTestId("mode-worktree").first().click();
await shot("06-combo-dialog");
await open("empty");
await shot("07-first-run");
await open("banner");
await shot("08-banner");
await open("nosessions");
await shot("09-no-sessions");
await open("agents");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Meta+i");
await shot("10-inspector");
await page.getByTestId("agent-row").first().click();
await shot("11-agent-detail");

await browser.close();
await server.close();
console.log(out);
