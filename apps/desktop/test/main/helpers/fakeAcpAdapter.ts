// stands in for claude code's acp adapter behind the proxy: one json object per line on stdio.
// every line it gets goes to FAKE_ACP_LOG, so a test can see what the proxy sent on.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const send = (m: object) => process.stdout.write(`${JSON.stringify(m)}\n`);
const update = (sessionId: string, text: string) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId,
    update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
  },
});

// what it was started with, for a test that needs to know
if (process.env.FAKE_ACP_ENV_LOG) {
  const seen = { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null };
  appendFileSync(process.env.FAKE_ACP_ENV_LOG, JSON.stringify(seen));
}

for await (const line of createInterface({ input: process.stdin })) {
  if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${line}\n`);
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: m.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
  } else if (m.method === "session/new") {
    send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "new-1", modes: {} } });
  } else if (m.method === "session/load") {
    const sid = m.params.sessionId;
    if (process.env.FAKE_LOAD_FAILS) {
      // a little of the history, then the failure: none of it may reach zed
      send(update(sid, "half a replay"));
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32002, message: "Resource not found" } });
    } else {
      send(update(sid, "first"));
      send(update(sid, "second"));
      // no sessionId, which the proxy fills in
      send({ jsonrpc: "2.0", id: m.id, result: { modes: {} } });
      // the real adapter's available_commands_update comes after its answer
      setTimeout(() => send(update(sid, "after")), 20);
    }
  }
}
