/** an error with a code the renderer can branch on. anything else crossing ipc becomes "internal". */
export class AppError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    if (detail) this.detail = detail;
  }
}

export function toOutcomeError(e: unknown): { code: string; message: string; detail?: string } {
  if (e instanceof AppError) {
    return { code: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) };
  }
  if (e instanceof Error) return { code: "internal", message: e.message };
  return { code: "internal", message: String(e) };
}
