import { useEffect } from "react";
import type { MenuCommandId } from "../shared/ipc.ts";
import { Toasts } from "./components/Chrome.tsx";
import { ComboDialog } from "./components/ComboDialog.tsx";
import { DeleteComboDialog, SettingsDialog, TeardownDialog } from "./components/Dialogs.tsx";
import { Rail } from "./components/Rail.tsx";
import { SessionActionMenu } from "./components/SessionActionMenu.tsx";
import { listRef, SessionsPane } from "./components/SessionsPane.tsx";
import { type Intent, interpret } from "./logic/keyboard.ts";
import {
  activate,
  activateDefault,
  focusSearch,
  openCombo,
  openMenu,
  refresh,
  repairSelected,
} from "./state/actions.ts";
import { applyAppearance } from "./state/appearance.ts";
import { connect, useStore } from "./state/store.ts";

function perform(intent: Intent): void {
  const s = useStore.getState();
  const keys = listRef.current.keys;
  const at = s.activeKey ? keys.indexOf(s.activeKey) : -1;
  switch (intent.type) {
    case "move":
      if (keys.length)
        s.set({
          activeKey: keys[Math.min(keys.length - 1, Math.max(0, at + intent.delta))] ?? null,
        });
      break;
    case "move-to":
      s.set({ activeKey: (intent.where === "first" ? keys[0] : keys[keys.length - 1]) ?? null });
      break;
    case "activate":
      if (s.activeKey) void activate(s.activeKey);
      break;
    case "activate-default":
      if (s.activeKey) void activateDefault(s.activeKey);
      break;
    case "menu":
      if (s.activeKey) void openMenu(s.activeKey);
      break;
    case "copy-resume":
      if (s.activeKey)
        void window.grove
          .runSessionAction(s.activeKey, "copy-command")
          .then(() => s.toast({ level: "info", title: "Resume command copied" }));
      break;
    case "focus-search":
    case "type-through":
      focusSearch(intent.type === "focus-search");
      break;
    case "clear-query":
      s.set({ query: "" });
      focusSearch(false);
      break;
    case "close-overlay":
      s.set({ menu: null, dialog: null });
      focusSearch(false);
      break;
    case "scope":
      s.setScope(intent.scope);
      break;
    case "combo-step": {
      const names = s.combos.map((c) => c.name);
      if (names.length === 0) break;
      const i = s.selectedCombo
        ? names.indexOf(s.selectedCombo)
        : intent.delta > 0
          ? -1
          : names.length;
      s.selectCombo(names[Math.min(names.length - 1, Math.max(0, i + intent.delta))] ?? null);
      break;
    }
    case "new-combo":
      s.set({ dialog: { kind: "combo" } });
      break;
    case "edit-combo":
      if (s.selectedCombo) s.set({ dialog: { kind: "combo", editing: s.selectedCombo } });
      break;
    case "open-combo":
      if (s.selectedCombo) void openCombo(s.selectedCombo);
      break;
    case "repair-combo":
      void repairSelected();
      break;
    case "refresh":
      void refresh();
      break;
    case "settings":
      s.set({ dialog: { kind: "settings" } });
      break;
  }
}

const MENU_INTENTS: Record<MenuCommandId, Intent> = {
  "new-combo": { type: "new-combo" },
  "open-combo": { type: "open-combo" },
  "edit-combo": { type: "edit-combo" },
  "repair-combo": { type: "repair-combo" },
  refresh: { type: "refresh" },
  "focus-search": { type: "focus-search" },
  "scope-combo": { type: "scope", scope: "combo" },
  "scope-all": { type: "scope", scope: "all" },
  settings: { type: "settings" },
};

export function App() {
  const ready = useStore((s) => s.ready);
  const appearance = useStore((s) => s.settings?.appearance);

  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void connect().then((o) => {
      // strict mode mounts twice in dev. the first connection must not outlive its effect.
      if (cancelled) o();
      else off = o;
    });
    const offMenu = window.grove.on("menu:command", ({ id }) => perform(MENU_INTENTS[id]));
    return () => {
      cancelled = true;
      off?.();
      offMenu();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const target = e.target as HTMLElement | null;
      const inSearch = target?.id === "search";
      const inText =
        !inSearch &&
        (target?.tagName === "INPUT" ||
          target?.tagName === "TEXTAREA" ||
          target?.tagName === "SELECT");
      const intent = interpret(
        {
          overlay: Boolean(s.menu || s.dialog),
          query: s.query,
          inOtherTextField: inText,
          inSearch,
          pageSize: listRef.pageSize,
        },
        {
          key: e.key,
          meta: e.metaKey,
          alt: e.altKey,
          shift: e.shiftKey,
          ctrl: e.ctrlKey,
          composing: e.isComposing,
        },
      );
      if (!intent) return;
      // a dialog closes itself through the platform's cancel event
      if (intent.type === "close-overlay" && s.dialog) return;
      // let the character land in the search field it is being redirected to
      if (intent.type !== "type-through") e.preventDefault();
      perform(intent);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // one clock for every "2d ago". paused while the window is hidden.
  useEffect(() => {
    const tick = () =>
      document.visibilityState === "visible" && useStore.getState().set({ now: Date.now() });
    const t = setInterval(tick, 30_000);
    let blurredAt = 0;
    const onBlur = () => {
      blurredAt = Date.now();
    };
    const onFocus = () => {
      tick();
      // coming back after a while means "i am looking for something": put the cursor in search
      const s = useStore.getState();
      if (blurredAt && Date.now() - blurredAt > 30_000 && !s.menu && !s.dialog) focusSearch();
    };
    const onCsp = (e: SecurityPolicyViolationEvent) =>
      void window.grove.reportCspViolation(`${e.violatedDirective} ${e.blockedURI}`);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", tick);
    document.addEventListener("securitypolicyviolation", onCsp);
    return () => {
      clearInterval(t);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", tick);
      document.removeEventListener("securitypolicyviolation", onCsp);
    };
  }, []);

  if (!ready) return <div className="drag h-full bg-canvas" />;

  return (
    <div className="flex h-full min-h-0 overflow-hidden" data-testid="app-ready">
      <Rail />
      <SessionsPane />
      <SessionActionMenu />
      <ComboDialog />
      <TeardownDialog />
      <DeleteComboDialog />
      <SettingsDialog />
      <Toasts />
    </div>
  );
}
