// the rules grove ships with. a person's own file (`<state>/output-rules.json`) goes on top.
//
// hosts are what most of it rides on: any tool whose name says it writes, and whose name has one
// of a host's `vendor` words, makes an output when its result holds a url the host matches. so a
// new tool for a known product needs nothing here. url formats only go in when they are certain.
//
// tools are for calls that return an id and no url, or whose verb the name gets wrong. every one
// is from a real call's input and result (artifacts/outputs/ in the grove combo has the samples).
import type { OutputRules } from "./outputs.ts";

const GOOGLE = ["google", "gdoc", "gdrive", "gsheet", "gslides", "drive", "sheets", "slides"];
const ATLASSIAN = ["atlassian", "jira", "rovo", "confluence"];
const MICROSOFT = [
  "microsoft",
  "sharepoint",
  "onedrive",
  "office",
  "m365",
  "graph",
  "word",
  "excel",
  "powerpoint",
];

export const SEED_RULES: OutputRules = {
  hosts: [
    // code
    {
      match: "^https://github\\.com/([^/\\s]+/[^/\\s]+)/pull/(\\d+)",
      kind: "pr",
      label: "pull request",
      key: "$1#$2",
      vendor: ["github"],
    },
    {
      match: "^https://github\\.com/([^/\\s]+/[^/\\s]+)/issues/(\\d+)",
      kind: "issue",
      label: "github issue",
      key: "$1#$2",
      vendor: ["github"],
    },
    {
      match: "^https://github\\.com/([^/\\s]+/[^/\\s]+)/releases/tag/([^/?#\\s]+)",
      kind: "release",
      label: "github release",
      key: "$1@$2",
      vendor: ["github"],
    },
    {
      match: "^https://gist\\.github\\.com/[^/\\s]+/[0-9a-f]+",
      kind: "gist",
      label: "gist",
      vendor: ["github", "gist"],
    },
    {
      match: "^https://[^/\\s]*gitlab[^/\\s]*/(\\S+?)/-/merge_requests/(\\d+)",
      kind: "mr",
      label: "merge request",
      key: "$1!$2",
      vendor: ["gitlab"],
    },
    {
      match: "^https://[^/\\s]*gitlab[^/\\s]*/(\\S+?)/-/issues/(\\d+)",
      kind: "issue",
      label: "gitlab issue",
      key: "$1#$2",
      vendor: ["gitlab"],
    },
    {
      match: "^https://bitbucket\\.org/([^/\\s]+/[^/\\s]+)/pull-requests/(\\d+)",
      kind: "pr",
      label: "pull request",
      key: "$1#$2",
      vendor: ["bitbucket"],
    },
    {
      match: "^https://dev\\.azure\\.com/[^/\\s]+/[^/\\s]+/_git/([^/\\s]+)/pullrequest/(\\d+)",
      kind: "pr",
      label: "pull request",
      key: "$1#$2",
      vendor: ["azure", "devops"],
    },
    // tracking
    {
      match: "^https://[a-z0-9-]+\\.atlassian\\.net/browse/([A-Z][A-Z0-9_]+-\\d+)",
      kind: "jira",
      label: "jira card",
      key: "$1",
      vendor: ATLASSIAN,
    },
    {
      match: "^https://[a-z0-9-]+\\.atlassian\\.net/wiki/spaces/[^/\\s]+/pages/\\d+",
      kind: "confluence",
      label: "confluence page",
      vendor: ATLASSIAN,
    },
    {
      match: "^https://linear\\.app/[^/\\s]+/issue/([A-Z][A-Z0-9]*-\\d+)",
      kind: "linear",
      label: "linear issue",
      key: "$1",
      vendor: ["linear"],
    },
    {
      match: "^https://linear\\.app/[^/\\s]+/(?:project|document)/[^/?#\\s]+",
      kind: "linear",
      label: "linear doc",
      vendor: ["linear"],
    },
    {
      match: "^https://dev\\.azure\\.com/[^/\\s]+/[^/\\s]+/_workitems/edit/(\\d+)",
      kind: "workitem",
      label: "work item",
      key: "#$1",
      vendor: ["azure", "devops"],
    },
    {
      match: "^https://trello\\.com/c/[A-Za-z0-9]+",
      kind: "trello",
      label: "trello card",
      vendor: ["trello"],
    },
    {
      match: "^https://app\\.clickup\\.com/t/[A-Za-z0-9]+",
      kind: "clickup",
      label: "clickup task",
      vendor: ["clickup"],
    },
    {
      match: "^https://[a-z0-9-]+\\.monday\\.com/boards/\\d+(?:/pulses/\\d+)?",
      kind: "monday",
      label: "monday item",
      vendor: ["monday"],
    },
    {
      match: "^https://app\\.shortcut\\.com/[^/\\s]+/story/(\\d+)",
      kind: "shortcut",
      label: "shortcut story",
      key: "sc-$1",
      vendor: ["shortcut"],
    },
    {
      match: "^https://app\\.asana\\.com/\\d+/[0-9/a-z]+",
      kind: "asana",
      label: "asana task",
      vendor: ["asana"],
    },
    {
      match: "^https://[a-z0-9-]+\\.pagerduty\\.com/incidents/[A-Z0-9]+",
      kind: "pagerduty",
      label: "pagerduty incident",
      vendor: ["pagerduty"],
    },
    // docs and design
    {
      match: "^https://(?:www\\.)?notion\\.so/[^?#\\s]*[0-9a-f]{32}",
      kind: "notion",
      label: "notion page",
      vendor: ["notion"],
    },
    {
      match: "^https://docs\\.google\\.com/document/d/[\\w-]+",
      kind: "gdoc",
      label: "google doc",
      vendor: GOOGLE,
    },
    {
      match: "^https://docs\\.google\\.com/spreadsheets/d/[\\w-]+",
      kind: "gsheet",
      label: "google sheet",
      vendor: GOOGLE,
    },
    {
      match: "^https://docs\\.google\\.com/presentation/d/[\\w-]+",
      kind: "gslides",
      label: "google slides",
      vendor: GOOGLE,
    },
    {
      match: "^https://docs\\.google\\.com/forms/d/[\\w-]+",
      kind: "gform",
      label: "google form",
      vendor: GOOGLE,
    },
    {
      match: "^https://drive\\.google\\.com/file/d/[\\w-]+",
      kind: "gdrive",
      label: "drive file",
      vendor: GOOGLE,
    },
    {
      match: "^https://(?:www\\.)?google\\.com/calendar/event\\?eid=[\\w-]+",
      kind: "gcal",
      label: "calendar event",
      vendor: ["calendar", "gcal"],
    },
    {
      match: "^https://(?:www\\.)?figma\\.com/(?:design|file)/[A-Za-z0-9]+",
      kind: "figma",
      label: "figma design",
      vendor: ["figma"],
    },
    {
      match: "^https://(?:www\\.)?figma\\.com/board/[A-Za-z0-9]+",
      kind: "figma",
      label: "figjam board",
      vendor: ["figma"],
    },
    {
      match: "^https://(?:www\\.)?figma\\.com/slides/[A-Za-z0-9]+",
      kind: "figma",
      label: "figma slides",
      vendor: ["figma"],
    },
    {
      match: "^https://(?:www\\.)?figma\\.com/make/[A-Za-z0-9]+",
      kind: "figma",
      label: "figma make",
      vendor: ["figma"],
    },
    {
      match: "^https://claude\\.ai/artifact/[A-Za-z0-9]+",
      kind: "claude",
      label: "claude artifact",
      vendor: ["claude"],
    },
    {
      match: "^https://miro\\.com/app/board/[\\w=-]+",
      kind: "miro",
      label: "miro board",
      vendor: ["miro"],
    },
    {
      match: "^https://(?:www\\.)?canva\\.com/design/[\\w-]+",
      kind: "canva",
      label: "canva design",
      vendor: ["canva"],
    },
    {
      match: "^https://(?:www\\.)?loom\\.com/share/[0-9a-f]+",
      kind: "loom",
      label: "loom video",
      vendor: ["loom"],
    },
    { match: "^https://coda\\.io/d/[^?#\\s]+", kind: "coda", label: "coda doc", vendor: ["coda"] },
    {
      match: "^https://airtable\\.com/app[A-Za-z0-9]+",
      kind: "airtable",
      label: "airtable base",
      vendor: ["airtable"],
    },
    {
      match: "^https://[a-z0-9-]+\\.sharepoint\\.com/\\S+",
      kind: "microsoft",
      label: "sharepoint file",
      vendor: MICROSOFT,
    },
    // messages
    {
      match: "^https://[a-z0-9-]+\\.slack\\.com/archives/[A-Z0-9]+/p\\d+",
      kind: "slack",
      label: "slack message",
      vendor: ["slack"],
    },
    {
      match: "^https://[a-z0-9-]+\\.slack\\.com/docs/[A-Z0-9]+/F[A-Z0-9]+",
      kind: "slack",
      label: "slack canvas",
      vendor: ["slack"],
    },
    {
      match: "^https://teams\\.microsoft\\.com/l/message/\\S+",
      kind: "teams",
      label: "teams message",
      vendor: ["teams"],
    },
    {
      match: "^https://(?:ptb\\.|canary\\.)?discord\\.com/channels/\\d+/\\d+/\\d+",
      kind: "discord",
      label: "discord message",
      vendor: ["discord"],
    },
    // ops and deploys
    {
      match: "^https://[a-z0-9.]*datadoghq\\.(?:com|eu)/(?:notebook|dashboard)/[\\w-]+",
      kind: "datadog",
      label: "datadog page",
      vendor: ["datadog"],
    },
    {
      match: "^https://[a-z0-9.]*datadoghq\\.(?:com|eu)/monitors/\\d+",
      kind: "datadog",
      label: "datadog monitor",
      vendor: ["datadog"],
    },
    {
      match: "^https://[a-z0-9-]+\\.vercel\\.app",
      kind: "deploy",
      label: "vercel deploy",
      vendor: ["vercel"],
    },
    {
      match: "^https://[a-z0-9-]+\\.netlify\\.app",
      kind: "deploy",
      label: "netlify deploy",
      vendor: ["netlify"],
    },
    {
      match: "^https://[a-z0-9.-]+\\.(?:pages|workers)\\.dev",
      kind: "deploy",
      label: "cloudflare deploy",
      vendor: ["cloudflare", "wrangler"],
    },
  ],
  tools: [
    // slack's message is the title, its channel a description once the channel is named
    { tool: "slack_send_message", title: "input.message" },
    // jira's MCP returns the key and an api.atlassian.com link. the site comes from the cloud id
    { tool: "getAccessibleAtlassianResources", learn: "sites" },
    {
      tool: "createJiraIssue",
      verb: "made",
      url: "{site:input.cloudId}/browse/{result.key}",
      key: "{result.key}",
      kind: "jira",
      label: "jira card",
      title: "input.summary",
    },
    {
      tool: "editJiraIssue",
      verb: "updated",
      url: "{site:input.cloudId}/browse/{input.issueIdOrKey}",
      key: "{input.issueIdOrKey}",
      kind: "jira",
      label: "jira card",
    },
    {
      tool: "transitionJiraIssue",
      verb: "updated",
      url: "{site:input.cloudId}/browse/{input.issueIdOrKey}",
      key: "{input.issueIdOrKey}",
      kind: "jira",
      label: "jira card",
    },
    {
      tool: "addCommentToJiraIssue",
      verb: "commented",
      url: "{site:input.cloudId}/browse/{input.issueIdOrKey}",
      key: "{input.issueIdOrKey}",
      kind: "jira",
      label: "jira card",
    },
    // google docs edits return the document id only
    { tool: "gdocs__*", url: "https://docs.google.com/document/d/{input.document_id}/edit" },
    // claude's own: an Artifact call with no action makes one from a type, publish makes or updates
    { tool: "Artifact", verb: "made", actions: ["", "publish"], url: "{result.url}" },
    {
      tool: "Claude_Docs__batch",
      verb: "updated",
      madeIf: "input.container.create",
      title: "input.container.create.name",
    },
    { tool: "Claude_Docs__create", verb: "commented", actions: [""] },
    // writes to this machine or to a browser tab, whatever the name says
    { tool: "claude-in-chrome__*", skip: true },
    { tool: "Claude_Browser__*", skip: true },
  ],
  bash: [
    { head: "gh pr create", kinds: ["pr"], verb: "made", title: "--title" },
    { head: "gh issue create", kinds: ["issue"], verb: "made", title: "--title" },
    { head: "gh release create", kinds: ["release"], verb: "made", title: "--title" },
    { head: "gh gist create", kinds: ["gist"], verb: "made" },
    { head: "gh pr comment", kinds: ["pr"], verb: "commented" },
    { head: "gh issue comment", kinds: ["issue"], verb: "commented" },
    { head: "gh pr edit", kinds: ["pr"], verb: "updated" },
    { head: "gh pr ready", kinds: ["pr"], verb: "updated" },
    { head: "gh pr merge", kinds: ["pr"], verb: "updated" },
    { head: "glab mr create", kinds: ["mr"], verb: "made", title: "--title" },
    { head: "glab issue create", kinds: ["issue"], verb: "made", title: "--title" },
    { head: "vercel deploy", kinds: ["deploy"], verb: "made" },
    { head: "netlify deploy", kinds: ["deploy"], verb: "made" },
    { head: "wrangler pages deploy", kinds: ["deploy"], verb: "made" },
    { head: "wrangler deploy", kinds: ["deploy"], verb: "made" },
  ],
};
