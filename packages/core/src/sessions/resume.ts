const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** transcript content is untrusted and this id ends up in a shell command and an editor command */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && UUID.test(id);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `claude --resume <id>` works from any directory, so the command still works when the
 * original cwd is gone. with a cwd it goes back there first, which is where the session
 * expects to be. claude-cli:// deep links have no resume parameter, so this is the only way.
 */
export function buildResumeCommand(sessionId: string, cwd?: string, claudeBin = "claude"): string {
  if (!isValidSessionId(sessionId)) throw new Error(`not a session id: ${sessionId}`);
  const bin = claudeBin === "claude" ? claudeBin : shellQuote(claudeBin);
  const resume = `${bin} --resume ${sessionId}`;
  return cwd ? `cd ${shellQuote(cwd)} && ${resume}` : resume;
}
