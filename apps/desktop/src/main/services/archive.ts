import { loadArchived, setArchived } from "@grove/core";
import { AppError } from "../errors.ts";
import { log } from "../log.ts";

export interface ArchiveServiceOptions {
  appRoot: string;
  /** the archived set moved, so the rows have to be rebuilt */
  onChange: (sessionIds: ReadonlySet<string>) => void;
}

/**
 * which sessions someone put away, by session id. the file behind it is a decision record people
 * edit by hand, so this only ever holds what was read back from it - never what we hoped to write.
 */
export class ArchiveService {
  private readonly opts: ArchiveServiceOptions;
  private ids: ReadonlySet<string> = new Set();

  constructor(opts: ArchiveServiceOptions) {
    this.opts = opts;
  }

  list(): ReadonlySet<string> {
    return this.ids;
  }

  /** a broken file means "nothing is archived" until someone fixes it, never a rewrite */
  async load(): Promise<void> {
    const loaded = await loadArchived(this.opts.appRoot);
    if (loaded.message) log.warn("archived.json:", loaded.message);
    this.ids = loaded.ids;
    this.opts.onChange(this.ids);
  }

  async set(sessionIds: readonly string[], archived: boolean): Promise<void> {
    const res = await setArchived(this.opts.appRoot, sessionIds, archived);
    if (!res.ok) throw new AppError(res.error.code, res.error.message);
    this.ids = res.value;
    this.opts.onChange(this.ids);
  }
}
