import { useEffect, useState } from "react";
import type { ConversationView, SessionKey } from "../../shared/ipc.ts";
import { applyTurns } from "../logic/conversation.ts";
import { Markdown } from "./Markdown.tsx";

/** the last look at each session, so going back to one draws it at once */
const conversations = new Map<SessionKey, ConversationView>();
const MEMORY = 8;

/** the last reading of a session's conversation, if it has been on screen: the header's numbers */
export function lastConversation(key: SessionKey | null | undefined): ConversationView | null {
  return key ? (conversations.get(key) ?? null) : null;
}

function remember(key: SessionKey, view: ConversationView): void {
  conversations.delete(key);
  conversations.set(key, view);
  while (conversations.size > MEMORY) {
    const oldest = conversations.keys().next().value;
    if (oldest === undefined) break;
    conversations.delete(oldest);
  }
}

/**
 * the session's own conversation on screen, read in main and sent over without its work. while it
 * is here, whatever the session writes arrives as it lands, at most four times a second.
 */
export function useFollowedConversation(
  /** null while something else is on screen: nothing is followed */
  key: SessionKey | null,
  find: string | undefined,
): {
  view: ConversationView | null;
  missing: boolean;
  found: { n: number; step?: number } | undefined;
} {
  const [view, setView] = useState<ConversationView | null>(
    key ? (conversations.get(key) ?? null) : null,
  );
  const [missing, setMissing] = useState(false);
  const [found, setFound] = useState<{ n: number; step?: number } | undefined>(undefined);
  // the search that led here counts when the session is opened, not as it is typed after
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let gen = -1;
    let current = conversations.get(key) ?? null;
    setView(current);
    setMissing(false);
    setFound(undefined);
    const show = (next: ConversationView) => {
      current = next;
      remember(key, next);
      setView(next);
    };
    const off = window.grove.on("conversation:turns", (p) => {
      if (cancelled || p.gen !== gen || p.key !== key || !current) return;
      show(applyTurns(current, p));
    });
    void window.grove
      .followConversation(key, find)
      .then((res) => {
        if (cancelled) return;
        setMissing(!res);
        if (!res) return;
        gen = res.gen;
        show(res.conversation);
        setFound(res.found);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      off();
      void window.grove.followConversation(null).catch(() => {});
    };
  }, [key]);
  return { view, missing, found };
}

/** the newest turns, plainly, until the whole conversation is drawn */
const SHOWN = 40;

export function ConversationPane({
  view,
  missing,
}: {
  view: ConversationView | null;
  missing: boolean;
}) {
  if (missing && !view) {
    return (
      <p className="px-5 pt-4 text-sm text-fg-3" data-testid="conversation-gone">
        Claude Code deletes transcripts after 30 days
      </p>
    );
  }
  const items = view?.items.slice(-SHOWN) ?? [];
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-6"
      data-testid="conversation"
      data-turns={view?.turns}
    >
      {items.map((item) =>
        item.kind === "compact" ? (
          <p key={item.n} className="py-2 text-sm text-fg-3">
            compacted
          </p>
        ) : (
          <div key={item.n} className="py-2" data-testid="turn">
            {item.prompt && (
              <p className="rounded-md bg-raised px-3 py-2 whitespace-pre-wrap text-fg">
                {item.prompt.text}
              </p>
            )}
            {item.answer && <Markdown text={item.answer} className="mt-2 max-w-[68ch]" />}
          </div>
        ),
      )}
    </div>
  );
}
