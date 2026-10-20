// the scorer: an electron utility process, so a model's memory and a crash in llama.cpp or metal
// stay out of the main process (already ~300 MB, and the menu bar lives there). main starts it when
// there is something to judge and stops it when it has been idle a while (main/services/scorer.ts).
import { scorerHandler } from "./handler.ts";
import type { ToScorer } from "./protocol.ts";

const port = process.parentPort;
const handle = scorerHandler((m) => port.postMessage(m));
port.on("message", (e) => void handle(e.data as ToScorer));
