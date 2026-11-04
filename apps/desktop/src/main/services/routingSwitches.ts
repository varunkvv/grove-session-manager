import path from "node:path";
import { loadMarks, setMarks } from "@grove/core";
import { AppError } from "../errors.ts";
import { log } from "../log.ts";

/**
 * which chat sessions have the routing agents on. a choice the person made for that session, so
 * it lives beside reviewed.json and combos.json, not in `.grove/`, and it outlives the app: a
 * session that was on is on again when it is next opened. off is no entry.
 *
 * ```json
 * { "<session id>": { "at": 1758600000000 } }
 * ```
 */
export class RoutingSwitches {
  private readonly file: string;
  private on: ReadonlySet<string> = new Set();

  constructor(appRoot: string) {
    this.file = path.join(appRoot, "routing.json");
  }

  async load(): Promise<void> {
    const loaded = await loadMarks(this.file);
    if (loaded.message) log.warn("routing.json:", loaded.message);
    this.on = loaded.keys;
  }

  has(id: string): boolean {
    return this.on.has(id);
  }

  async set(id: string, on: boolean): Promise<void> {
    const res = await setMarks(this.file, [id], on);
    if (!res.ok) throw new AppError(res.error.code, res.error.message);
    this.on = res.value;
  }
}
