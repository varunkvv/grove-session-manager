function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

/** stderr only. a packaged app has no console, and nothing here is worth a log file yet. */
export const log = {
  info(...args: unknown[]): void {
    console.error(`${stamp()} [grove]`, ...args);
  },
  warn(...args: unknown[]): void {
    console.error(`${stamp()} [grove] warn:`, ...args);
  },
  error(...args: unknown[]): void {
    console.error(`${stamp()} [grove] error:`, ...args);
  },
};

export type Logger = typeof log;
