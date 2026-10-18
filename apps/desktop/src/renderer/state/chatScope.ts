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
}

export const ChatScopeContext = createContext<ChatScope | null>(null);

export const useChatScope = (): ChatScope | null => useContext(ChatScopeContext);
