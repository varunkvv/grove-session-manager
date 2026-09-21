// stands in for anthropic.claude-code: records what the companion asked it to open
const fs = require("node:fs");
const vscode = require("vscode");

exports.activate = (context) => {
  context.subscriptions.push(
    vscode.commands.registerCommand("claude-vscode.primaryEditor.open", (session, prompt) => {
      fs.writeFileSync(
        process.env.GROVE_SMOKE_OUT,
        JSON.stringify({ session, prompt: prompt ?? null }),
      );
    }),
  );
};
