import { formatTokens, type ModelUsage, modelLabel } from "@grove/core/pure";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SessionAction } from "../../shared/ipc.ts";
import { focusSearch, runAction } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { optionId } from "./SessionList.tsx";
import { cx, Icon } from "./ui.tsx";

const ICONS = {
  "combo-land": "external",
  "folder-land": "external",
  terminal: "terminal",
  "copy-command": "copy",
  "copy-id": "copy",
  reveal: "reveal",
} as const;

const USAGE_COLUMNS = ["in", "out", "cache read", "cache write"] as const;

/** read-only, under the actions: what the session spent, per model */
function UsageTable({ usage }: { usage: readonly ModelUsage[] }) {
  return (
    <div data-testid="menu-usage" className="px-2.5 pt-1 pb-1.5">
      <div className="grid grid-cols-[minmax(0,1fr)_repeat(4,auto)] gap-x-4 text-meta text-fg-3">
        <span>Tokens</span>
        {USAGE_COLUMNS.map((c) => (
          <span key={c} className="text-right">
            {c}
          </span>
        ))}
        {usage.map((u) => (
          <div key={u.model} className="contents font-mono text-fg-2" title={u.model}>
            <span className="truncate">{modelLabel(u.model)}</span>
            {[u.input, u.output, u.cacheRead, u.cacheWrite].map((n, i) => (
              <span key={USAGE_COLUMNS[i]} className="text-right tabular-nums">
                {formatTokens(n)}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SessionActionMenu() {
  const menu = useStore((s) => s.menu);
  const usage = useStore((s) =>
    s.menu ? s.sessions.find((r) => r.key === s.menu?.key)?.usage : undefined,
  );
  const set = useStore((s) => s.set);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu) return setPos(null);
    const anchor = document.getElementById(optionId(menu.key))?.getBoundingClientRect();
    const height = menu.actions.length * 32 + 24 + (usage?.length ? usage.length * 16 + 40 : 0);
    const width = 380;
    const top = anchor ? Math.min(anchor.bottom - 4, window.innerHeight - height - 12) : 120;
    const left = anchor ? Math.min(anchor.right - width - 8, window.innerWidth - width - 12) : 320;
    setPos({ top: Math.max(60, top), left: Math.max(12, left) });
  }, [menu, usage]);

  useEffect(() => {
    if (menu && pos) ref.current?.focus();
  }, [menu, pos]);

  if (!menu || !pos) return null;

  const close = () => {
    set({ menu: null });
    focusSearch(false);
  };
  const move = (delta: number) => {
    const n = menu.actions.length;
    let i = menu.index;
    for (let step = 0; step < n; step++) {
      i = (i + delta + n) % n;
      if (menu.actions[i]?.enabled) break;
    }
    set({ menu: { ...menu, index: i } });
  };
  const run = (a: SessionAction | undefined) => a?.enabled && void runAction(menu.key, a.id);

  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={close} role="presentation" />
      <div
        ref={ref}
        role="menu"
        tabIndex={-1}
        aria-label="Session actions"
        data-testid="session-menu"
        style={{ top: pos.top, left: pos.left, width: 380 }}
        className="fixed z-50 rounded-lg bg-overlay p-1.5 overlay-shadow outline-none"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
          else if (e.key === "ArrowDown") move(1);
          else if (e.key === "ArrowUp") move(-1);
          else if (e.key === "Enter") run(menu.actions[menu.index]);
          else return;
          e.preventDefault();
        }}
      >
        {menu.actions.map((a, i) => (
          <div key={a.id}>
            {a.secondary && !menu.actions[i - 1]?.secondary && (
              <div className="my-1.5 h-px bg-line" role="separator" />
            )}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={!a.enabled}
              data-testid={`action-${a.id}`}
              data-active={i === menu.index || undefined}
              onMouseEnter={() => a.enabled && set({ menu: { ...menu, index: i } })}
              onClick={() => run(a)}
              className={cx(
                "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-body disabled:opacity-40",
                i === menu.index && a.enabled ? "bg-active text-fg" : "text-fg-2",
              )}
            >
              <Icon name={ICONS[a.id]} className="text-fg-3" />
              <span className="min-w-0 flex-1 truncate">{a.label}</span>
              {a.hint && <span className="shrink-0 text-meta text-fg-3">{a.hint}</span>}
            </button>
          </div>
        ))}
        {usage && usage.length > 0 && (
          <>
            <div className="my-1.5 h-px bg-line" role="separator" />
            <UsageTable usage={usage} />
          </>
        )}
      </div>
    </>
  );
}
