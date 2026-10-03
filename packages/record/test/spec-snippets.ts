// prints the generated texts the spec quotes, so the spec is pasted from the code, not retyped.
//   node test/spec-snippets.ts > /tmp/snippets.md
import {
  allowRules,
  hookGroup,
  mcpServerEntry,
  renderCliHelp,
  renderInstructions,
  renderLauncher,
  renderRules,
} from "../src/render.ts";
import { mcpToolList, TOOLS } from "../src/tools.ts";

const L = "/Users/<you>/claude-ws/.grove/bin/record";
const R = "/Users/<you>/claude-ws/auth-sso";
const out: string[] = [];
out.push(
  "<!--RULES-->",
  renderRules({
    launcher: "/Users/me/claude-ws/.grove/bin/record",
    prefix: "AUTH",
    root: "/Users/me/claude-ws/auth-sso",
  }),
  "<!--/RULES-->",
);
const i = renderInstructions();
out.push("<!--INSTR-->", i, `(${i.length} characters)`, "<!--/INSTR-->");
out.push("<!--TOOLS-->");
for (const t of mcpToolList()) {
  const def = TOOLS.find((x) => x.name === t.name)!;
  const flags = [
    def.alwaysLoad ? "alwaysLoad" : "",
    def.readOnly ? "readOnlyHint" : "",
    def.writes ? "writes" : "reads",
  ]
    .filter(Boolean)
    .join(", ");
  out.push(
    `### \`${t.name}\``,
    "",
    `${flags}. ${(t.description as string).length} characters of description.${
      def.input.aliases
        ? ` accepts ${Object.entries(def.input.aliases)
            .map(([a, r]) => `\`${a}\` for \`${r}\``)
            .join(", ")}.`
        : ""
    }`,
    "",
    "```text",
    t.description as string,
    "```",
    "",
    "```json",
    JSON.stringify(t.inputSchema),
    "```",
    "",
    `example: \`${JSON.stringify(def.input.example)}\``,
    "",
  );
}
out.push("<!--/TOOLS-->");
out.push("<!--HELP-->", renderCliHelp(), "<!--/HELP-->");
out.push(
  "<!--LAUNCHER-->",
  renderLauncher({
    execPath: "/Applications/Grove.app/Contents/MacOS/Grove",
    bundle: "/Users/<you>/claude-ws/.grove/bin/record.cjs",
  }).trimEnd(),
  "<!--/LAUNCHER-->",
);
out.push(
  "<!--MCP-->",
  JSON.stringify({ mcpServers: { grove: mcpServerEntry({ launcher: L, root: R }) } }, null, 2),
  "<!--/MCP-->",
);
out.push(
  "<!--SETTINGS-->",
  JSON.stringify(
    {
      enabledMcpjsonServers: ["grove"],
      permissions: { allow: allowRules(L) },
      hooks: { SessionStart: [hookGroup({ launcher: L, root: R })] },
    },
    null,
    2,
  ),
  "<!--/SETTINGS-->",
);
out.push(
  "<!--SIZE-->",
  String(JSON.stringify(mcpToolList()).length),
  String(
    JSON.stringify(
      mcpToolList().filter(
        (t) => (t._meta as Record<string, boolean> | undefined)?.["anthropic/alwaysLoad"],
      ),
    ).length,
  ),
  "<!--/SIZE-->",
);
console.log(out.join("\n"));
