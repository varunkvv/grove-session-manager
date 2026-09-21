// dev only: the icon at the sizes it is really seen at, on a light and a dark desktop
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const resources = path.join(import.meta.dirname, "../resources");
const svg = readFileSync(path.join(resources, "icon.svg"), "utf8");
const data = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const row = (bg) =>
  `<div style="background:${bg};padding:28px;display:flex;align-items:flex-end;gap:28px">${[
    256, 128, 64, 32, 16,
  ]
    .map((s) => `<img src="${data}" width="${s}" height="${s}">`)
    .join("")}</div>`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 720, height: 640 }, deviceScaleFactor: 2 });
await page.setContent(`<body style="margin:0">${row("#E9E6DF")}${row("#2A2B30")}</body>`);
const out = path.join(import.meta.dirname, "../e2e/screenshots/icon-sheet.png");
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(out);
