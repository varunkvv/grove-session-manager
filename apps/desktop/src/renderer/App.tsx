import { useEffect } from "react";
import type { MenuCommandId } from "../shared/ipc.ts";
import { CardPage } from "./components/CardPage.tsx";
import { Cards } from "./components/Cards.tsx";
import { Banner, Toasts } from "./components/Chrome.tsx";
import { Conclusions } from "./components/Conclusions.tsx";
import { ConfirmDialog, DeleteProjectDialog, SettingsDialog } from "./components/Dialogs.tsx";
import { Inbox } from "./components/Inbox.tsx";
import { Palette } from "./components/Palette.tsx";
import { ProjectForm } from "./components/ProjectForm.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { type Intent, interpret } from "./logic/keyboard.ts";
import { focusScreen, perform } from "./state/actions.ts";
import { applyAppearance } from "./state/appearance.ts";
import { connect, useStore } from "./state/store.ts";

// one table for the menu and the keys, so the two cannot disagree and compile
const MENU_INTENTS: Record<MenuCommandId, Intent> = {
  "new-project": { type: "new-project" },
  "open-project": { type: "open-project" },
  "edit-project": { type: "edit-project" },
  "go-inbox": { type: "go", section: "inbox" },
  "go-cards": { type: "go", section: "cards" },
  "go-conclusions": { type: "go", section: "conclusions" },
  palette: { type: "palette" },
  "focus-search": { type: "focus-search" },
  refresh: { type: "refresh" },
  settings: { type: "settings" },
};

function Screen() {
  const view = useStore((s) => s.view);
  const project = useStore((s) => s.project);
  // no projects at all: the form, whatever the view says
  if (!project) return <ProjectForm mode="new" first />;
  switch (view.name) {
    case "inbox":
      return <Inbox />;
    case "cards":
      return <Cards />;
    case "card":
      return <CardPage key={view.cardId} cardId={view.cardId} />;
    case "conclusions":
      return <Conclusions />;
    case "new-project":
      return <ProjectForm mode="new" />;
    case "edit-project":
      return <ProjectForm mode="edit" key={project} />;
  }
}

export function App() {
  const ready = useStore((s) => s.ready);
  const appearance = useStore((s) => s.settings?.appearance);
  const view = useStore((s) => s.view.name);

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
    const offMenu = window.grove.on("menu:command", ({ id }) => {
      // an accelerator still fires under an open dialog. it must not act behind one
      if (!useStore.getState().dialog) perform(MENU_INTENTS[id]);
    });
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
      const intent = interpret(
        {
          overlay: Boolean(s.overlay || s.dialog),
          view: s.view.name,
          inText:
            target?.tagName === "INPUT" ||
            target?.tagName === "TEXTAREA" ||
            target?.tagName === "SELECT",
          inSearch: target?.id === "search",
          inControl: !!target?.closest?.(
            'button, a[href], [role="button"], [role="menuitem"], [role="menuitemradio"], [role="radio"]',
          ),
          query: s.conclusions.query,
          expanded: s.conclusions.open !== null,
          panel: s.peek !== null,
          canGoBack: s.back.length > 0,
          // the form says so itself, on any element: its fields are its own state
          formDirty: !!document.querySelector("[data-form-dirty]"),
          // ponytail: a guess at a row's height. measure the list if a page ever lands badly
          pageSize: Math.floor(window.innerHeight / 48),
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
      // coming back after a while: the keyboard goes where the screen wants it
      const s = useStore.getState();
      if (blurredAt && Date.now() - blurredAt > 30_000 && !s.overlay && !s.dialog) focusScreen();
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="app-ready">
      <TopBar />
      <Banner />
      <main
        className="min-h-0 flex-1 overflow-hidden"
        data-testid="screen"
        data-view={view}
        // the mouse moved: no row looks like the keyboard's until a key says so again
        onPointerMove={() => {
          if (useStore.getState().keys) useStore.getState().set({ keys: false });
        }}
      >
        <Screen />
      </main>
      <Palette />
      <DeleteProjectDialog />
      <SettingsDialog />
      <ConfirmDialog />
      <Toasts />
    </div>
  );
}
