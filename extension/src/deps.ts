import type { Disposable } from "@grove/core";

/**
 * everything the extension needs from VS Code, as plain functions. the logic in this package
 * only talks to this interface, so it runs under vitest without an editor.
 */
export interface Deps {
  appRoot: string;
  projectsDir: string;
  stateDir: string;
  gitPath?: string;
  uriScheme: string;
  settings: { reconcileOnStartup: boolean; syncAdditionalDirectories: boolean };
  /** realpath of workspaceFolders[0] - the folder the Claude Code panel uses as its cwd */
  workspace(): { root?: string; workspaceFile?: string };
  isTrusted(): boolean;
  isFocused(): boolean;
  onDidFocus(cb: () => void): Disposable;
  /** false when the Claude Code extension is not installed */
  activateClaude(): Promise<boolean>;
  executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
  /** asExternalUri first (pins the URI to this window), then openExternal */
  openExternalPinned(uri: string): Promise<boolean>;
  openFolder(target: string, newWindow: boolean): Promise<void>;
  copy(text: string): Promise<void>;
  info(message: string, ...actions: string[]): Promise<string | undefined>;
  warn(message: string, ...actions: string[]): Promise<string | undefined>;
  log(message: string): void;
  memory: { get<T>(key: string): T | undefined; set(key: string, value: unknown): Promise<void> };
  setStatus(status: StatusView): void;
  delay(ms: number): Promise<void>;
}

export interface StatusView {
  combo?: string;
  drift?: string[];
}
