import { createContext, useContext } from "react";

/**
 * a grove chat window's markdown draws more than words: images from the session's folders, code in
 * colour, diagrams. the main window gives none of this, so its panel draws as it always has
 */
export interface ChatScope {
  session: string;
  /** the folder a relative path is from: the session's for its messages, a file's own for a file */
  base: string;
  /** a file, in the viewer beside the conversation */
  open?: (file: string) => void;
  /** the session's agents, in the drawer. with a call's id, the agent that call started */
  agents?: (call?: string) => void;
  /** what one of the session's edits changed, by its call's id. null: nothing to show */
  diff?: (call: string) => Promise<string[] | null>;
  /** say this again: a turn that ended on an api error, asked once more */
  retry?: (prompt: string) => void;
  /** put the files back as they were before this message (its uuid) */
  rewind?: (uuid: string) => void;
  /** a new session that is this one up to a line (null: none of it), with words in its composer */
  fork?: (upTo: string | null, draft: string) => void;
}

export const ChatScopeContext = createContext<ChatScope | null>(null);

export const useChatScope = (): ChatScope | null => useContext(ChatScopeContext);
