// every screen as the real app draws it, light and dark, at the default window and at its smallest,
// against fixture projects. `pnpm --filter @grove/desktop build` first, then
//   node scripts/screenshots.ts <outDir> [light|dark]  ->  <outDir>/{light,dark}/<screen>-{1280,880}.png
// it also prints the tray menu, which is native and cannot be photographed.
// every launch runs under a temp GROVE_ROOT, CLAUDE_CONFIG_DIR and HOME, with a fake `code` and `claude`.
import { appendFileSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { recapSays, setFakeRecaps, writeFakeClaude } from "../e2e/helpers/fakeClaude.ts";
import {
  appendTurn,
  type Fixture,
  hookEvent,
  makeFixture,
  makeRepo,
  writeSession,
} from "../e2e/helpers/fixture.ts";
import { groveTest, launchApp } from "../e2e/helpers/launchApp.ts";
import { interrupted, liveSession, writeProject } from "../e2e/helpers/project.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: node scripts/screenshots.ts <outDir>");

const MIN = 60_000;
const HOUR = 60 * MIN;
const SIZES = [
  [1280, 800],
  // the smallest the window goes: with the sidebar and the panel open the list is 330 wide
  [880, 600],
] as const;

let ids = 0;
const sid = () => `${String(++ids).padStart(8, "0")}-0000-4000-8000-000000000000`;

/** a hook event that happened `minutes` ago: the app reads when from the file */
function event(
  fx: Fixture,
  sessionId: string,
  name: string,
  minutes: number,
  extra: Record<string, unknown> = {},
) {
  const dir = path.join(fx.root, ".grove", "events");
  const had = new Set(names(dir));
  hookEvent(fx, sessionId, name, extra);
  const when = new Date(Date.now() - minutes * MIN);
  for (const f of names(dir)) if (!had.has(f)) utimesSync(path.join(dir, f), when, when);
}
const names = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const REPLY = `The okta app is created in the dev tenant, with one redirect URI per environment:

- \`https://staging.dash.example.com/auth/callback\`
- \`https://dash.example.com/auth/callback\`

The client secret is in 1Password under **okta-dev**, not in the repo. \`terraform plan\` for the app is clean on \`feat/okta-staging\`.

Want me to open the PR now, or wait for the callback route to land first?`;

/**
 * the quiet sessions whose recap never arrives, one for each window size: a call that timed out is
 * not made again for a minute, so the second size cannot photograph the first one's
 */
const SLOW = ["read the SAML strategy", "terraform state for staging"];

const QUIET = [
  "why is the staging deploy red",
  "sketch the login page states",
  "okta research",
  "read the SAML strategy",
  "terraform state for staging",
  "draft the rollout note",
  "rate limit the callback endpoint",
  "log out everywhere when the okta session ends",
  "move SSO settings into the admin panel",
  "compare okta and auth0 pricing for 400 seats, and what each wants for SCIM provisioning",
  "bump passport to 0.7",
  "flaky test in the session middleware",
  "what does the redirect URI check do",
  "rename AUTH_PROVIDER to IDP",
  "audit log for sign-ins",
  "why does the cookie drop on safari",
  "okta group to role mapping",
  "delete the legacy saml routes",
  "docs for the dev tenant",
  "csp header for the login page",
  "review the callback PR",
  "session length for admins",
  "idle timeout copy",
  "seed users for staging",
  "remove the feature flag",
  "trace a 502 on /auth/callback",
  "pkce for the mobile client",
  "runbook for an okta outage",
  "sso for the internal tools",
  "rotate the signing keys",
  "error page for a disabled org",
  "who owns the okta admin account",
  "jwks cache ttl",
  "local login for the e2e suite",
  "state cookie same-site",
  "clean up the env example",
  "logout redirect",
  "backfill okta ids",
];
const BRANCHES = ["feat/okta-staging", "auth-sso", "fix/callback-state", undefined, undefined];

/** what the fake haiku says of a session, found by its title in the digest. the last one is everyone else's */
const RECAPS = [
  {
    when: "title: auth-sso-12",
    say: recapSays(
      "Register one okta app for staging and production in the dev tenant, with the secret kept out of the repo",
      "Created the app with a redirect URI per environment. The client secret is in 1Password under okta-dev, and terraform plan is clean on feat/okta-staging.",
      "Finished. The PR is not open yet.",
      "Say whether to open the PR now or wait for the callback route to land first.",
    ),
  },
  {
    when: "title: callback route",
    say: recapSays(
      "Check the state cookie in the okta callback before it trades the code, test first",
      "Wrote the failing test for a callback with no state cookie.",
      "Waiting to run the callback suite.",
      "Allow pnpm test --filter callback.",
    ),
  },
  {
    when: "title: session store",
    say: recapSays(
      "Wire the redis store into the session middleware and run the api suite",
      "Read the session middleware. Nothing is changed yet.",
      "Stopped mid-turn when its window closed, before the store was wired in.",
      "Open it and tell it to carry on.",
    ),
  },
  {
    when: "title: token rotation",
    say: recapSays(
      "Rotate refresh tokens on every use and revoke the whole family on reuse",
      "Nothing yet. The first request failed before any work.",
      "Stopped on API Error 529 Overloaded.",
      "Send the prompt again.",
    ),
  },
  {
    when: "title: threads backend",
    say: recapSays(
      "Add the reply_to column to messages and backfill it",
      "Wrote the migration and the backfill script. Neither has run.",
      "Waiting on when to run the backfill.",
      "Choose: run the backfill on staging now, or tonight.",
    ),
  },
  // never answer in time: their panels are the ones that show a recap being written
  ...SLOW.map((title) => ({ when: `title: ${title}`, say: "", afterMs: 10 * 60_000 })),
  {
    when: "title: ",
    say: recapSays(
      "Answer one question about the SSO work",
      "Looked it up and answered in a few lines.",
      "Finished.",
      "nothing",
    ),
  },
];

/**
 * seven projects. auth-sso has 44 sessions: one of each kind that needs the person, two working,
 * the rest spread over today, yesterday and the weeks before. billing-export has none
 */
function build(scheme: string) {
  const fx = makeFixture({ withCompanion: true });
  writeFileSync(
    path.join(fx.root, "settings.json"),
    JSON.stringify({ editor: "vscode", appearance: scheme }),
  );
  const api = makeRepo(fx, "api");
  const projects = Object.fromEntries(
    (
      [
        ["auth-sso", "Single sign-on for the dashboard through okta, staging first."],
        ["billing-export", "Monthly invoice exports for finance, as csv."],
        ["chat-features", "Threads and reactions in team chat."],
        ["data-objects", "Custom objects in the public api."],
        ["infra-cleanup", "Retire the old staging cluster."],
        ["mobile-push", "Rich push on android."],
        ["search-relevance", "Exact title matches rank first."],
      ] as const
    ).map(([name, goal]) => [
      name,
      writeProject(fx, {
        name,
        goal,
        ...(name === "auth-sso"
          ? { folders: [{ path: api, mode: "worktree", branch: { kind: "detach" } }] }
          : {}),
      }).root,
    ]),
  );
  const auth = projects["auth-sso"] as string;
  const vscode = (sessionId: string, status: "busy" | "idle" = "idle") =>
    liveSession(fx, { sessionId, kind: "interactive", entrypoint: "claude-vscode", status });

  // ---- auth-sso: the four that need him. the first has a conversation behind it: five turns, a
  // compaction, one it was stopped in, and something typed while it worked
  const turn = sid();
  const talk = writeSession(fx, {
    cwd: auth,
    sessionId: turn,
    title: "auth-sso-12",
    branch: "feat/okta-staging",
    prompt: "what does staging use for sign-in today?",
    reply:
      "Staging signs in with the local password form only. There is no identity provider wired in:\n\n- `api/src/auth/local.ts` is the one strategy passport loads\n- the SAML strategy from last year is still in the tree, and nothing imports it\n\nProduction is the same.",
    ageMs: 3 * HOUR,
  });
  const o = { sessionId: turn, cwd: auth };
  const at = (minutes: number) => new Date(Date.now() - minutes * MIN).toISOString();
  const lines = (...entries: object[]) =>
    appendFileSync(talk, `${entries.map((l) => JSON.stringify(l)).join("\n")}\n`);
  appendTurn(talk, o, {
    prompt: "draft the terraform for an okta app. dev tenant, not prod",
    tools: [
      { name: "Read", input: { file_path: path.join(auth, "infra/main.tf") } },
      { name: "Write", input: { file_path: path.join(auth, "infra/okta.tf") } },
      { name: "Edit", input: { file_path: path.join(auth, "infra/variables.tf") } },
      { name: "Bash", input: { command: "terraform validate" } },
    ],
    reply:
      'The app is drafted in `infra/okta.tf`, pointed at the dev tenant:\n\n```hcl\nresource "okta_app_oauth" "dashboard" {\n  label       = "dashboard"\n  type        = "web"\n  grant_types = ["authorization_code"]\n}\n```\n\n`terraform validate` passes. It has no redirect URIs yet.',
    ageMs: 170 * MIN,
    tookMs: 6 * MIN,
  });
  lines(
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "c0000000-0000-4000-8000-000000000001",
      timestamp: at(120),
      compactMetadata: { trigger: "auto", preTokens: 164_000, postTokens: 31_000 },
    },
    {
      type: "user",
      isCompactSummary: true,
      uuid: "c0000000-0000-4000-8000-000000000002",
      timestamp: at(120),
      message: {
        role: "user",
        content:
          "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Primary Request and Intent: single sign-on for the dashboard through okta, staging first.",
      },
    },
  );
  appendTurn(talk, o, {
    prompt: "add the callback route while you are there",
    tools: [{ name: "Read", input: { file_path: path.join(auth, "api/src/auth/routes.ts") } }],
    ageMs: 110 * MIN,
    tookMs: MIN,
  });
  lines({
    type: "user",
    uuid: "c0000000-0000-4000-8000-000000000003",
    timestamp: at(108),
    message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
  });
  appendTurn(talk, o, {
    prompt:
      "register the okta app for staging and production in the dev tenant. one app, a redirect URI per environment. do not put the secret in the repo",
    tools: [
      { name: "Edit", input: { file_path: path.join(auth, "infra/okta.tf") } },
      { name: "Bash", input: { command: "terraform plan" } },
      { name: "Agent", input: { description: "check the okta admin console" } },
      { name: "Edit", input: { file_path: path.join(auth, "docs/sso.md") } },
      { name: "Bash", input: { command: "terraform apply" } },
    ],
    reply: REPLY,
    ageMs: 13 * MIN,
    tookMs: 12 * MIN,
  });
  // typed while it worked: Claude Code writes it as an attachment, never as a user line
  lines({
    type: "attachment",
    attachment: {
      type: "queued_command",
      commandMode: "prompt",
      origin: { kind: "human" },
      prompt: "and say where the secret went",
    },
    uuid: "c0000000-0000-4000-8000-000000000004",
    timestamp: at(8),
  });
  utimesSync(talk, new Date(Date.now() - MIN), new Date(Date.now() - MIN));
  vscode(turn);
  event(fx, turn, "Stop", 1, { last_assistant_message: REPLY });

  const permission = sid();
  writeSession(fx, {
    cwd: auth,
    sessionId: permission,
    title: "callback route",
    branch: "fix/callback-state",
    prompt:
      "the callback has to check the state cookie before it trades the code. add the test first",
    reply: "The test is written and fails for the right reason. Running the callback suite.",
    ageMs: 3 * MIN,
  });
  vscode(permission, "busy");
  event(fx, permission, "PermissionRequest", 3, {
    tool_name: "Bash",
    tool_input: { command: "pnpm test --filter callback" },
  });

  const stopped = sid();
  writeSession(fx, {
    cwd: auth,
    sessionId: stopped,
    title: "session store",
    branch: "auth-sso",
    prompt: "Wire the redis store into the session middleware and run the api suite",
    reply: "Reading the middleware.",
    lastPrompt: "Wire the redis store into the session middleware and run the api suite",
    ageMs: 25 * MIN,
  });

  const failed = sid();
  writeSession(fx, {
    cwd: auth,
    sessionId: failed,
    title: "token rotation",
    prompt: "rotate refresh tokens on every use, and revoke the family on reuse",
    reply: "API Error: 529 Overloaded",
    ageMs: 40 * MIN,
  });
  liveSession(fx, { sessionId: failed, kind: "interactive", entrypoint: "cli" });
  event(fx, failed, "StopFailure", 40, { message: "API Error: 529 Overloaded" });

  // ---- two working
  const login = sid();
  writeSession(fx, {
    cwd: auth,
    sessionId: login,
    title: "login page",
    branch: "auth-sso",
    prompt: "build the login page with the SSO button, and the error state for a disabled org",
    reply: "The button and the three states are in. Writing the story for the disabled org.",
    ageMs: 20_000,
  });
  liveSession(fx, { sessionId: login, kind: "bg", status: "busy" });
  event(fx, login, "UserPromptSubmit", 12);
  const idp = sid();
  writeSession(fx, {
    cwd: auth,
    sessionId: idp,
    title: "idp config",
    branch: "feat/okta-staging",
    prompt: "point staging at the dev tenant",
    ageMs: 40_000,
  });
  vscode(idp, "busy");
  event(fx, idp, "UserPromptSubmit", 6);

  // ---- the rest: today, yesterday, and further back
  QUIET.forEach((title, i) => {
    const sessionId = sid();
    const ageMs = i < 6 ? (i + 1) * 70 * MIN : i < 13 ? (20 + i) * HOUR : (i - 10) * 26 * HOUR;
    writeSession(fx, {
      cwd: auth,
      sessionId,
      title,
      branch: BRANCHES[i % BRANCHES.length],
      prompt: title,
      reply: `Done: ${title}.`,
      ageMs,
    });
    if (i < 2) vscode(sessionId);
  });

  // ---- the other projects: a few sessions each, two of them waiting
  const chat = projects["chat-features"] as string;
  const threads = sid();
  writeSession(fx, {
    cwd: chat,
    sessionId: threads,
    title: "threads backend",
    branch: "threads",
    prompt: "add the reply_to column and backfill it",
    reply: "The migration is written. Run the backfill on staging now, or tonight?",
    ageMs: 8 * MIN,
  });
  vscode(threads);
  event(fx, threads, "Stop", 8, {
    last_assistant_message:
      "The migration is written. Run the backfill on staging now, or tonight?",
  });
  const data = projects["data-objects"] as string;
  const schema = sid();
  writeSession(fx, {
    cwd: data,
    sessionId: schema,
    title: "schema validation for custom objects",
    prompt: "validate the schema on write",
    ageMs: 14 * MIN,
  });
  vscode(schema, "busy");
  event(fx, schema, "PermissionRequest", 14, {
    cwd: data,
    tool_name: "Edit",
    tool_input: { file_path: path.join(data, "src/objects/schema.ts") },
  });
  for (const [root, titles] of [
    [chat, ["reactions picker", "emoji search", "unread counts"]],
    [data, ["pagination for list objects", "rate limits"]],
    [projects["infra-cleanup"], ["drain the old node pool", "dns cutover plan"]],
    [projects["mobile-push"], ["image attachments on android"]],
    [projects["search-relevance"], ["title boost", "eval set from the support tickets"]],
  ] as const) {
    for (const [i, title] of titles.entries()) {
      writeSession(fx, {
        cwd: root as string,
        sessionId: sid(),
        title,
        prompt: title,
        ageMs: (i + 2) * 5 * HOUR,
      });
    }
  }
  interrupted(fx, { [stopped]: Date.now() - 25 * MIN });
  return { fx, turn };
}

/** the built app on the fixture, with every session indexed and every status read */
async function launch(fx: Fixture) {
  const fake = writeFakeClaude(path.join(fx.dir, "bin"), []);
  setFakeRecaps(fake, RECAPS);
  // HOME is the fixture's, so nothing reaches the real home
  const app = await launchApp(fx, { HOME: fx.dir, GROVE_CLAUDE_BIN: fake.bin });
  const { page } = app;
  page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  await page.evaluate(() => window.grove.repairProject("auth-sso"));
  await page.waitForFunction(
    async () => {
      const b = await window.grove.bootstrap();
      return (
        b.inbox.rows.length === 6 &&
        // each row that says what it needs has its recap. a permission row's is written on a look
        b.inbox.rows.every((r) => r.kind === "permission" || r.recap?.lines) &&
        b.projects[0]?.folders.every((f) => f.state === "ok") &&
        // the sessions are indexed after the page is up
        (await window.grove.listSessions("auth-sso")).length === 44
      );
    },
    undefined,
    { timeout: 30_000 },
  );
  return app;
}

const resize = async (app: ElectronApplication, page: Page, width: number, height: number) => {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) =>
      BrowserWindow.getAllWindows()[0]?.setSize(w as number, h as number),
    [width, height],
  );
  await page.waitForFunction((w) => window.innerWidth === w, width);
};

for (const scheme of process.argv[3] ? [process.argv[3]] : ["light", "dark"]) {
  const dir = path.join(out, scheme);
  mkdirSync(dir, { recursive: true });
  const { fx, turn } = build(scheme);
  const app = await launch(fx);
  const { page } = app;
  const g = groveTest(app.app);
  if (scheme === "light") {
    console.log("tray title:", JSON.stringify(await g.trayTitle()));
    console.log("tray menu:", JSON.stringify(await g.trayMenu(), null, 2));
  }
  let width = 0;
  /** the pointer out of the way, the last transition over */
  const shot = async (name: string, rest = true) => {
    if (rest) await page.mouse.move(width - 200, 22);
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(dir, `${name}-${width}.png`) });
    // anything wider than its box that does not say so with an ellipsis or a scrollbar
    const spills = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("#root *")]
        .filter(
          (e) =>
            e.scrollWidth > e.clientWidth + 1 &&
            getComputedStyle(e).textOverflow !== "ellipsis" &&
            getComputedStyle(e).overflowX === "visible",
        )
        .map((e) => `${e.tagName}.${String(e.className).slice(0, 60)}`),
    );
    console.log(scheme, width, name, spills.length ? `SPILLS ${JSON.stringify(spills)}` : "ok");
  };
  const project = (id: string) =>
    page.locator(`[data-testid="project-item"][data-id="${id}"]`).click();
  const inboxRow = (kind: string) => page.locator(`[data-testid="inbox-row"][data-kind="${kind}"]`);

  for (const [w, h] of SIZES) {
    width = w;
    await resize(app.app, page, w, h);

    await page.getByTestId("nav-inbox").click();
    await page.getByTestId("inbox-row").nth(5).waitFor();
    await shot("inbox");
    await inboxRow("permission").first().hover();
    await shot("inbox-hover", false);
    // where a click on its notification lands: the row, with its panel open
    await g.reveal(turn);
    await page.getByTestId("panel-text").waitFor();
    await page.getByTestId("recap").waitFor();
    await shot("inbox-panel");
    // the conversation, scrolled back to where it starts
    await page.getByTestId("conversation").evaluate((el) => el.scrollTo({ top: 0 }));
    await shot("inbox-panel-conversation-up");
    await page.getByTestId("conversation").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page.keyboard.press("ArrowDown");
    await page.getByTestId("panel-text").waitFor();
    // a permission row's recap is written when its panel opens
    await page.getByTestId("recap").waitFor();
    await shot("inbox-panel-keyboard", false);
    await page.keyboard.press("Escape");

    await project("auth-sso");
    await page.getByTestId("session-row").nth(43).waitFor();
    await shot("sessions");
    await page.locator('[data-testid="session-row"][data-state="turn"]').click();
    await page.getByTestId("panel-text").waitFor();
    await shot("sessions-panel");
    await page.keyboard.press("Escape");
    // a quiet one, from further down the list
    await page.getByTestId("session-row").nth(20).click();
    await page.getByTestId("panel-text").waitFor();
    await page.getByTestId("recap").waitFor();
    await shot("sessions-panel-quiet");
    await page.keyboard.press("Escape");
    // one whose recap is still being written
    await page
      .getByTestId("session-row")
      .filter({ hasText: SLOW[SIZES.findIndex((s) => s[0] === w)] })
      .click();
    await page.getByTestId("recap-writing").waitFor();
    await shot("sessions-panel-writing");
    await page.keyboard.press("Escape");
    await page.getByTestId("session-filter").fill("okta");
    await page.getByTestId("session-row").nth(3).waitFor();
    await shot("sessions-filter");
    await page.getByTestId("session-filter").fill("nothing like it");
    await page.getByTestId("sessions-none").waitFor();
    await shot("sessions-filter-none");
    await page.getByTestId("session-filter").fill("");

    await project("billing-export");
    await page.getByTestId("sessions-empty").waitFor();
    await shot("sessions-empty");

    await page.keyboard.press("Meta+k");
    await page.getByTestId("palette").waitFor();
    await page.getByTestId("palette-input").fill("okta");
    await page.locator('[data-testid="palette-item"][data-id^="session:"]').first().waitFor();
    await shot("palette");
    await page.keyboard.press("Escape");

    await project("auth-sso");
    await page.getByTestId("edit-project").click();
    await page.getByTestId("repo-row").getByRole("radiogroup").first().waitFor();
    await shot("project-edit");
    await page.getByTestId("form-cancel").click();
  }

  // nothing needs him: every row dismissed
  await page.evaluate(async () => {
    const { inbox } = await window.grove.bootstrap();
    for (const r of inbox.rows) await window.grove.review(r.project, r.reviewKeys, true);
  });
  await page.getByTestId("nav-inbox").click();
  await page.getByTestId("inbox-empty").waitFor();
  for (const [w, h] of SIZES) {
    width = w;
    await resize(app.app, page, w, h);
    await shot("inbox-empty");
  }
  await app.close();
}
console.log(out);
