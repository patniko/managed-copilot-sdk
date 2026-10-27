import { useCallback, useEffect, useState } from "react";
import { ConversationPage } from "./components/ConversationView.js";
import { Home } from "./components/Home.js";
import { AppSkeleton, ErrorScreen, PlatformBanner } from "./components/Screens.js";
import { Sidebar } from "./components/Sidebar.js";
import { TopBar } from "./components/TopBar.js";
import { ConfirmDialog } from "./components/ui/ConfirmDialog.js";
import { Toasts } from "./components/ui/Toasts.js";
import { useRoute } from "./lib/router.js";
import { startDispatch, useStore } from "./lib/store.js";

export function App() {
  const phase = useStore((state) => state.phase);
  const route = useRoute();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  useEffect(() => {
    startDispatch();
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [route]);

  if (phase === "loading") return <AppSkeleton />;
  if (phase === "error") return <ErrorScreen />;

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <a
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
        className="btn fixed top-3 left-3 z-[90] -translate-y-24 focus:translate-y-0"
      >
        Skip to content
      </a>
      <TopBar onOpenMenu={() => setDrawerOpen(true)} />
      <PlatformBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar activeId={route.kind === "conversation" ? route.id : undefined} drawerOpen={drawerOpen} onCloseDrawer={closeDrawer} />
        <main id="main" tabIndex={-1} className={route.kind === "conversation" ? "flex min-w-0 flex-1 flex-col outline-none" : "min-w-0 flex-1 overflow-y-auto outline-none"}>
          {route.kind === "conversation" ? <ConversationPage key={route.id} id={route.id} tab={route.tab} worker={route.worker} /> : <Home />}
        </main>
      </div>
      <Toasts />
      <ConfirmDialog />
    </div>
  );
}
