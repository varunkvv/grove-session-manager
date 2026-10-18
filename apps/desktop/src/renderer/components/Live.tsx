// what a turn is doing while it runs, said quietly: the clock in a header, and the live line under
// what it has said. the chat window and the main window's session card both draw them.
import { formatDuration, toolLabel } from "@grove/core/pure";
import { useEffect, useState } from "react";
import type { ChatStatus } from "../../shared/ipc.ts";
import { Mono, Spinner } from "./ui.tsx";

/** a second or more, as a step's time says it */
const took = (ms: number) => (ms >= 1000 ? formatDuration(ms) : "");

/** now, once a second, for as long as it is drawn: only what shows a running time redraws */
export function useTick(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** how long the turn has run, as a clock: 0:42, 12:05 */
export function Clock({ since }: { since: number }) {
  const s = Math.max(0, Math.floor((useTick() - since) / 1000));
  return (
    <span className="text-sm tabular-nums text-fg-4" data-testid="chat-elapsed">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

/**
 * what the turn is doing right now, under what it has said: waiting to retry, compacting, or the
 * tool it is in with what it acts on and for how long. quiet: the answer is what is read
 */
export function LiveLine({
  status: s,
  className = "mt-2",
}: {
  status: ChatStatus;
  className?: string;
}) {
  const now = useTick();
  if (!s.activity && !s.tool && !s.thinking) return null;
  return (
    <p
      className={`flex min-w-0 items-center gap-1.5 text-sm text-fg-4 ${className}`}
      data-testid="chat-live"
    >
      <Spinner size={10} />
      {s.activity ? (
        <span className="truncate">{s.activity}…</span>
      ) : !s.tool && s.thinking ? (
        <span data-testid="chat-thinking">
          Thinking
          <span className="tabular-nums">
            {took(now - s.thinking.since) && ` · ${took(now - s.thinking.since)}`}
          </span>
        </span>
      ) : (
        s.tool && (
          <>
            <span className="shrink-0 font-medium text-fg-3" data-testid="chat-tool">
              {toolLabel(s.tool.name)}
            </span>
            {s.tool.target && (
              <Mono className="min-w-0 truncate" title={s.tool.target}>
                {s.tool.target}
              </Mono>
            )}
            <span className="shrink-0 tabular-nums">
              {formatDuration(Math.max(0, now - s.tool.since))}
            </span>
          </>
        )
      )}
    </p>
  );
}
