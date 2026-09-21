// runs inside the VS Code extension host. passes when the fake Claude extension was asked to open
// the session that the intent file named - i.e. the whole handoff worked in a real editor.
const fs = require("node:fs");

exports.run = async () => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(process.env.GROVE_SMOKE_OUT)) {
      const got = JSON.parse(fs.readFileSync(process.env.GROVE_SMOKE_OUT, "utf8"));
      if (got.session !== process.env.GROVE_SMOKE_SESSION) throw new Error(`opened ${got.session}`);
      if (got.prompt !== "continue from the app") throw new Error(`prompt was ${got.prompt}`);
      const pending = fs.readdirSync(process.env.GROVE_SMOKE_PENDING);
      if (pending.length) throw new Error(`intent was not consumed: ${pending}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("the companion never asked Claude Code to open the session");
};
