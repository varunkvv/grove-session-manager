// every screen as the real app draws it, light and dark, against fixture projects written with the
// record's own library. `pnpm --filter @grove/desktop build` first, then
//   node scripts/screenshots.ts <outDir>     ->  <outDir>/{light,dark}/*.png
// it also prints the tray menu, which is native and cannot be photographed.
// every launch runs under a temp GROVE_ROOT, CLAUDE_CONFIG_DIR and HOME, with a fake `code` and `claude`.
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mock } from "node:test";
import type { Page } from "@playwright/test";
import { writeFakeClaude } from "../e2e/helpers/fakeClaude.ts";
import {
  type Fixture,
  hookEvent,
  makeFixture,
  makeRepo,
  writeAgent,
  writeSession,
} from "../e2e/helpers/fixture.ts";
import { groveTest, launchApp, stubDirectoryPicker } from "../e2e/helpers/launchApp.ts";
import {
  asAgent,
  asPerson,
  interrupted,
  liveSession,
  writeProject,
} from "../e2e/helpers/project.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: node scripts/screenshots.ts <outDir>");

const MIN = 60_000;
// an avatar's colour is hashed from the session id. these are picked so each agent gets its own,
// as real ids mostly do
const SID = {
  idp: "aaaaaaaa-0000-4000-8000-000000000002",
  callback: "bbbbbbbb-0000-4000-8000-000000000002",
  store: "cccccccc-0000-4000-8000-000000000003",
  research: "dddddddd-0000-4000-8000-000000000003",
  login: "eeeeeeee-0000-4000-8000-000000000009",
  tab: "ffffffff-0000-4000-8000-000000000006",
  threads: "abababab-0000-4000-8000-000000000004",
};

/** a hook event that happened `minutes` ago: the app reads when from the file */
function event(fx: Fixture, sessionId: string, minutes: number, extra: Record<string, unknown>) {
  const dir = path.join(fx.root, ".grove", "events");
  const had = new Set(readdirSyncOr(dir));
  hookEvent(fx, sessionId, "Stop", extra);
  const when = new Date(Date.now() - minutes * MIN);
  for (const f of readdirSyncOr(dir)) if (!had.has(f)) utimesSync(path.join(dir, f), when, when);
}
const readdirSyncOr = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * three projects. auth-sso has a card in every status, a row of every inbox kind and conclusions
 * of every kind, one of them replaced. billing-export is empty. chat-features has one question
 */
function build(scheme: string) {
  const fx = makeFixture({ withCompanion: true });
  writeFileSync(
    path.join(fx.root, "settings.json"),
    JSON.stringify({ editor: "vscode", appearance: scheme }),
  );
  const api = makeRepo(fx, "api");
  const web = makeRepo(fx, "web");
  const runbooks = makeRepo(fx, "runbooks");
  const auth = writeProject(fx, {
    name: "auth-sso",
    prefix: "AUTH",
    goal: "Single sign-on for the dashboard through okta, staging first.",
    folders: [
      { path: api, mode: "worktree", branch: { kind: "detach" } },
      { path: web, mode: "worktree", branch: { kind: "new", name: "auth-sso" } },
      { path: runbooks, mode: "reference" },
    ],
  });
  writeProject(fx, {
    name: "billing-export",
    prefix: "BILL",
    goal: "Monthly invoice exports for finance, as csv.",
  });
  const chat = writeProject(fx, {
    name: "chat-features",
    prefix: "CHAT",
    goal: "Threads and reactions in team chat.",
  });

  // the record stamps what it writes with the clock, so the clock is what the fixture moves
  const now = Date.now();
  mock.timers.enable({ apis: ["Date"], now });
  const ago = (minutes: number) => mock.timers.setTime(now - minutes * MIN);

  const you = asPerson(auth.root);
  const agent = (sessionId: string, name: string) => asAgent(fx, auth.root, { sessionId, name });
  const research = agent(SID.research, "okta research");
  const callback = agent(SID.callback, "callback route");
  const idp = agent(SID.idp, "idp config");
  const store = agent(SID.store, "session store");
  const login = agent(SID.login, "login page");

  // AUTH-1, done yesterday
  ago(26 * 60);
  you("card_create", {
    title: "Find out how okta wants the app registered",
    body: "We have never registered an OIDC app with okta. Find out what it needs from us before anyone writes code:\n\n- the grant type and the scopes for a server-side web app\n- what a redirect URI may look like\n- whether one app can serve staging and production",
  });
  ago(25 * 60);
  research("card_claim", { card: "AUTH-1" });
  ago(24 * 60 + 20);
  research("conclusion_record", {
    kind: "finding",
    what: "Okta matches redirect URIs exactly. A wildcard host is refused for a web app.",
    why: "Tried `https://*.dash.example.com/auth/callback` in a developer org: the app could not be saved.",
    card: "AUTH-1",
    by: "agent",
    area: "infra",
  });
  ago(24 * 60);
  research("conclusion_record", {
    kind: "decision",
    what: "Authorization code flow with PKCE, scopes `openid profile email`.",
    why: "It is what okta recommends for a server-side web app, and the dashboard needs nothing but the email.",
    card: "AUTH-1",
    by: "agent",
    area: "api",
  });
  ago(23 * 60 + 40);
  research("card_done", {
    card: "AUTH-1",
    summary:
      "Okta wants a **web** app with the authorization code flow and PKCE (D-1). Redirect URIs are matched exactly (F-1), so staging and production each need their own entry.\n\nNot done: nothing was registered. That is AUTH-4.\n\nChecked against a developer org, not ours.",
    artifacts: [{ type: "file", ref: "artifacts/okta-app-registration.md" }],
  });

  // AUTH-2, held by an agent in a terminal. the person's first answer, later replaced
  ago(23 * 60);
  you("card_create", {
    title: "Callback route and session cookie",
    body: "The `/auth/callback` route: exchange the code, set the session cookie, redirect to where the person was going.",
    from: "AUTH-1",
  });
  ago(22 * 60);
  callback("card_claim", { card: "AUTH-2" });
  callback("conclusion_record", {
    kind: "decision",
    what: "Keep sessions in the existing signed cookie.",
    why: "No new infrastructure.",
    card: "AUTH-2",
    by: "person",
    area: "api",
  });
  // AUTH-3, made by an agent, nobody on it
  ago(4 * 60 + 30);
  callback("card_create", {
    title: "Rate limit the callback endpoint",
    body: "Found while doing AUTH-2. The callback takes a code from anyone. It needs the same limit as `/login`.",
    from: "AUTH-2",
  });

  // AUTH-4, held and waiting on the person
  ago(4 * 60);
  you("card_create", {
    title: "Point staging at okta",
    body: "Register the dashboard with okta for **staging** and wire the settings in, so AUTH-2 can be tried end to end.\n\n- one okta app, redirect URIs per D-1 and F-1\n- client id and secret into the staging secrets, never into the repo\n- done when a login on staging reaches the callback route",
    from: "AUTH-1",
    needs: ["AUTH-2"],
  });
  ago(3 * 60 + 10);
  idp("card_claim", { card: "AUTH-4" });

  // AUTH-5, its agent stopped mid-turn. the person changed their mind here
  ago(3 * 60 + 5);
  you("card_create", {
    title: "Keep sessions in redis",
    body: "Sessions live in process memory today, so a deploy logs everyone out. Move them to the redis the API already has.",
  });
  ago(3 * 60);
  store("card_claim", { card: "AUTH-5" });
  store("conclusion_record", {
    kind: "decision",
    what: "Sessions move to redis, on the server.",
    why: "A cookie cannot be revoked, and SSO logout needs revoke.",
    card: "AUTH-5",
    by: "person",
    area: "api",
    replaces: "D-2",
  });

  ago(2 * 60 + 50);
  idp("conclusion_record", {
    kind: "finding",
    what: "Staging has no okta tenant in terraform state.",
    why: "`terraform state list | grep okta` is empty in staging and lists 14 resources in production.",
    card: "AUTH-4",
    by: "agent",
    changes_plan: true,
    area: "infra",
  });
  ago(2 * 60 + 30);
  idp("question_ask", {
    card: "AUTH-4",
    to: "AUTH-2",
    text: "Which redirect URI does the callback route expect? I need the exact path for the okta app.",
  });
  ago(2 * 60 + 5);
  callback("question_answer", {
    card: "AUTH-4",
    question: 1,
    text: "`/auth/callback` on the dashboard host, no trailing slash. Staging is `https://staging.dash.example.com/auth/callback`.",
  });
  ago(110);
  callback("conclusion_record", {
    kind: "finding",
    what: "The api suite takes 11 minutes on CI.",
    why: "Median of the last 20 runs on main.",
    by: "agent",
    area: "tests",
  });
  ago(95);
  idp("conclusion_record", {
    kind: "decision",
    what: "One okta app with a redirect URI per environment, no wildcard.",
    why: "F-1: okta matches them exactly. A second app per environment would double the secrets to rotate.",
    card: "AUTH-4",
    by: "agent",
    area: "infra",
  });

  // AUTH-6, held by a background agent
  ago(90);
  you("card_create", {
    title: "Login page with the SSO button",
    body: "An email-first login: the SSO button shows for an org that has it on.",
  });
  ago(80);
  login("card_claim", { card: "AUTH-6" });

  ago(48);
  store("conclusion_record", {
    kind: "decision",
    what: "Sessions expire after 8 hours without activity.",
    why: "It matches the okta session policy, so the two never disagree.",
    card: "AUTH-5",
    by: "agent",
    area: "api",
    related: ["D-3"],
  });
  ago(40);
  idp("comment_add", {
    card: "AUTH-4",
    text: "The okta app settings per environment are written up, and the terraform for the app is on a branch. AUTH-3 should use the same host list.",
    artifacts: [
      { type: "file", ref: "artifacts/okta-app-settings.md" },
      { type: "branch", ref: "feat/okta-staging" },
      { type: "pr", ref: "https://github.com/acme/dashboard/pull/412" },
      { type: "link", ref: "https://developer.okta.com/docs/guides/sign-into-web-app-redirect/" },
    ],
  });
  ago(35);
  login("conclusion_record", {
    kind: "verdict",
    what: "The SAML strategy cannot be reused for OIDC: it validates a signed assertion on every request, and OIDC needs a place where the code is traded in once.",
    why: "Read passport-saml's strategy and our wrapper around it.",
    card: "AUTH-6",
    by: "agent",
    area: "web",
  });
  ago(31);
  store("comment_add", {
    card: "AUTH-5",
    text: "The store is written and its tests pass. Wiring it into the middleware is next.",
    artifacts: [{ type: "branch", ref: "feat/redis-sessions" }],
  });
  ago(3);
  idp("question_ask", {
    card: "AUTH-4",
    to: "person",
    text: "Staging has no okta tenant (F-2). Create a dev tenant, or point staging at the production tenant with its own app? I would create a dev tenant: a mistake there cannot lock anyone out.",
  });

  // the backlog and a card the person dropped
  ago(22 * 60);
  you("card_create", { title: "Log out everywhere when the okta session ends" });
  you("card_create", {
    title: "Move SSO settings into the admin panel",
    body: "Org admins edit their okta settings themselves.",
  });
  ago(21 * 60);
  you("card_cancel", { card: "AUTH-8", reason: "Out of scope. Support configures SSO per org." });

  // another project asks too: the switcher and the tray say so
  ago(20);
  const threads = asAgent(fx, chat.root, { sessionId: SID.threads, name: "thread composer" });
  threads("card_create", { title: "Thread replies in the composer" });
  threads("card_claim", { card: "CHAT-1" });
  threads("question_ask", {
    card: "CHAT-1",
    to: "person",
    text: "Should a reply in a thread also post to the channel, or only when the box is ticked?",
  });
  mock.timers.reset();

  // the research's own decision was looked at yesterday
  writeFileSync(
    path.join(fx.root, "reviewed.json"),
    JSON.stringify({ "AUTH/conclusion:D-1": { at: now - 20 * 60 * MIN } }),
  );
  // the files the artifacts name, so Finder has something to show
  mkdirSync(path.join(auth.root, "artifacts"), { recursive: true });
  for (const f of ["okta-app-registration.md", "okta-app-settings.md"]) {
    writeFileSync(path.join(auth.root, "artifacts", f), "# notes\n");
  }

  const session = (sessionId: string, title: string, minutes: number, more: object = {}) =>
    writeSession(fx, { cwd: auth.root, sessionId, title, ageMs: minutes * MIN, ...more });
  session(SID.idp, "idp config", 3, { reply: "The okta app settings are written up." });
  session(SID.callback, "callback route", 9);
  session(SID.store, "session store", 25, {
    lastPrompt: "Wire the redis store into the session middleware and run the api suite",
  });
  session(SID.research, "okta research", 23 * 60);
  session(SID.login, "login page", 12);
  session(SID.tab, "auth-sso-12", 1, { prompt: "Create the okta app in the dev tenant" });
  writeSession(fx, {
    cwd: chat.root,
    sessionId: SID.threads,
    title: "thread composer",
    ageMs: 20 * MIN,
  });
  // sessions in repos no project has: the form suggests their folders
  for (const [i, name] of ["infra", "design-system", "pipelines"].entries()) {
    writeSession(fx, {
      cwd: makeRepo(fx, name),
      sessionId: `12121212-0000-4000-8000-00000000000${i}`,
      title: `${name} cleanup`,
      ageMs: (i + 2) * 60 * MIN,
    });
  }
  // idp config's subagents. they spent more than it did, on another model
  writeAgent(fx, {
    cwd: auth.root,
    sessionId: SID.idp,
    id: "a1b2c3",
    agentType: "Explore",
    description: "Find the okta resources in terraform",
    prompt: "List every okta resource in the terraform state of staging and production.",
    startedAgoMs: 170 * MIN,
    steps: [{ tool: "Bash", input: { command: "terraform state list" }, result: "", at: 5 }],
    result: { text: "Staging has none. Production has 14.", at: 60 },
  });
  writeAgent(fx, {
    cwd: auth.root,
    sessionId: SID.idp,
    id: "d4e5f6",
    agentType: "general-purpose",
    description: "Draft the terraform for the okta app",
    prompt: "Write the okta_app_oauth resource for the dashboard.",
    startedAgoMs: 45 * MIN,
    steps: [{ tool: "Write", input: { file_path: "infra/okta.tf" }, result: "ok", at: 30 }],
    result: { text: "Written to infra/okta.tf.", at: 300 },
  });

  // where each one runs: idp config and the tab in the editor, both waiting. callback route in a
  // terminal. login page in the background. session store was mid-turn when its process went.
  // okta research is long closed
  liveSession(fx, { sessionId: SID.idp, kind: "interactive", entrypoint: "claude-vscode" });
  liveSession(fx, { sessionId: SID.tab, kind: "interactive", entrypoint: "claude-vscode" });
  liveSession(fx, { sessionId: SID.threads, kind: "interactive", entrypoint: "claude-vscode" });
  liveSession(fx, {
    sessionId: SID.callback,
    kind: "interactive",
    entrypoint: "cli",
    status: "busy",
  });
  liveSession(fx, { sessionId: SID.login, kind: "bg", status: "busy" });
  event(fx, SID.idp, 3, { cwd: auth.root });
  event(fx, SID.tab, 1, {
    cwd: auth.root,
    last_assistant_message:
      "The okta app is created in the dev tenant. Want me to open the PR now, or wait for the callback route to land first?",
  });
  interrupted(fx, { [SID.store]: Date.now() - 25 * MIN });
  return { fx, api, runbooks };
}

/** the built app on the fixture, every project read, checked and with its working copies made */
async function launch(fx: Fixture) {
  const fake = writeFakeClaude(path.join(fx.dir, "bin"), []);
  // HOME is the fixture's, so paths read ~/src/api and nothing reaches the real home
  const app = await launchApp(fx, { HOME: fx.dir, GROVE_CLAUDE_BIN: fake.bin });
  const { page } = app;
  page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  await page.evaluate(() => window.grove.repairProject("auth-sso"));
  await page.waitForFunction(
    async () => {
      const b = await window.grove.bootstrap();
      return (
        b.projects.every((p) => p.server.state !== "unknown" && !!b.record[p.id]?.readAt) &&
        b.projects[0]?.folders.every((f) => f.state === "ok" || f.state === "reference") &&
        (await window.grove.frequentFolders()).length >= 3
      );
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.getByTestId("inbox-row").nth(8).waitFor();
  return app;
}

for (const scheme of ["light", "dark"]) {
  const dir = path.join(out, scheme);
  mkdirSync(dir, { recursive: true });
  let page: Page;
  /** the pointer out of the way, the last transition over */
  const shot = async (name: string, rest = true) => {
    if (rest) await page.mouse.move(640, 22);
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(dir, `${name}.png`) });
    // anything wider than its box that does not say so with an ellipsis or a scrollbar
    const spills = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("#root *")]
        .filter(
          (e) =>
            // a side panel row reaches 6px into its section's padding on purpose
            e.scrollWidth > e.clientWidth + 6 &&
            getComputedStyle(e).textOverflow !== "ellipsis" &&
            getComputedStyle(e).overflowX === "visible",
        )
        .map((e) => `${e.tagName}.${String(e.className).slice(0, 60)}`),
    );
    console.log(scheme, name, spills.length ? `SPILLS ${JSON.stringify(spills)}` : "ok");
  };
  const card = (id: string) => page.locator(`[data-testid="card-page"][data-id="${id}"]`).waitFor();
  const project = async (id: string) => {
    await page.getByTestId("project-switcher").click();
    await page.locator(`[data-testid="project-item"][data-id="${id}"]`).click();
  };

  // ---------- every screen of a project in use ----------
  {
    const { fx, api, runbooks } = build(scheme);
    const app = await launch(fx);
    page = app.page;
    const g = groveTest(app.app);
    if (scheme === "light") {
      console.log("tray title:", JSON.stringify(await g.trayTitle()));
      console.log("tray menu:", JSON.stringify(await g.trayMenu(), null, 2));
    }

    await shot("inbox");
    await page.locator('[data-testid="inbox-row"][data-kind="decided"]').first().hover();
    await shot("inbox-hover", false);

    await page.getByTestId("nav-cards").click();
    await page.getByTestId("card-row").nth(7).waitFor();
    await shot("cards");
    // the keyboard's row, right under a group's header
    await page.keyboard.press("ArrowDown");
    await shot("cards-keyboard", false);

    // where a click on the question's notification lands
    await g.reveal(SID.idp);
    await card("AUTH-4");
    await page.getByTestId("card-side").waitFor();
    await shot("card-held");
    await g.reveal(SID.store);
    await card("AUTH-5");
    await shot("card-stopped");
    await page.getByTestId("nav-cards").click();
    await page.locator('[data-testid="card-row"][data-id="AUTH-1"]').click();
    await card("AUTH-1");
    await page.getByTestId("card-side").waitFor();
    await shot("card-done");

    await page.getByTestId("nav-conclusions").click();
    await page.getByTestId("conclusion-row").nth(8).waitFor();
    await shot("conclusions");
    await page.locator('[data-testid="conclusion-row"][data-id="D-5"]').click();
    await shot("conclusions-open");

    await page.getByTestId("nav-inbox").click();
    await page.keyboard.press("Meta+k");
    await page.getByTestId("palette").waitFor();
    await shot("palette");
    await page.getByTestId("palette-input").fill("okta");
    await page.locator('[data-testid="palette-item"][data-id^="session:"]').first().waitFor();
    await shot("palette-search");
    await page.keyboard.press("Escape");

    await page.getByTestId("nav-cards").click();
    await page.getByTestId("edit-project").click();
    await page.getByTestId("repo-row").getByRole("radiogroup").nth(2).waitFor();
    await shot("project-edit");
    await page.getByTestId("form-cancel").click();

    await project("billing-export");
    await page.getByTestId("start-state").waitFor();
    await shot("start-state");

    await stubDirectoryPicker(app.app, [api, runbooks]);
    await page.keyboard.press("Meta+n");
    await page.getByTestId("project-name").fill("Search relevance");
    await page
      .getByTestId("project-goal")
      .fill("Exact title matches rank first in dashboard search.");
    await page.getByTestId("add-folder").click();
    const rows = page.getByTestId("repo-row");
    await rows.getByRole("radiogroup").nth(1).waitFor();
    await rows.nth(1).getByTestId("mode-reference").click();
    await page.getByTestId("form-submit").and(page.locator(":enabled")).waitFor();
    await shot("project-new");
    await app.close();
  }

  // ---------- the record server cannot start: the banner, and what Edit project says ----------
  {
    const { fx } = build(scheme);
    // a bundle that says it is newer than the app's, so the install leaves it, and that dies on
    // start the way a half-written one would: node's own words on stderr
    const bin = path.join(fx.root, ".grove", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, "record.cjs"),
      '// grove-record app=99.0.0\nrequire("./tools.cjs");\n',
    );
    const app = await launch(fx);
    page = app.page;
    await page.getByTestId("banner").waitFor();
    await shot("banner");
    await page.getByTestId("banner-action").click();
    await page.getByTestId("record-check").waitFor();
    // the section is below the repos: the bottom of the form, down to its buttons
    await page.getByTestId("project-form").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await shot("project-edit-record-failed");
    await app.close();
  }
}
console.log(out);
