import { useCallback, useEffect, useState } from "react";
import { AppSkeleton, ErrorScreen } from "./components/ErrorScreen.js";
import { NewWorkOrder } from "./components/NewWorkOrder.js";
import { PlatformBanner } from "./components/PlatformBanner.js";
import { Sidebar } from "./components/Sidebar.js";
import { TopBar } from "./components/TopBar.js";
import { ConfirmDialog } from "./components/ui/ConfirmDialog.js";
import { Toasts } from "./components/ui/Toasts.js";
import { WorkOrderView } from "./components/WorkOrderView.js";
import { useRoute } from "./lib/router.js";
import { startFactory, useStore } from "./lib/store.js";

export function App() {
  const phase = useStore((state) => state.phase);
  const route = useRoute();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  useEffect(() => {
    startFactory();
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [route]);

  if (phase === "loading") return <AppSkeleton />;
  if (phase === "error") return <ErrorScreen />;

  return (
    <div className="flex h-dvh flex-col" style={{ paddingBottom: "var(--preview-offset, 0px)" }}>
      <a
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
        className="sr-only z-[90] rounded-lg bg-amber-400 px-3 py-2 text-sm font-semibold text-zinc-950 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <TopBar onOpenMenu={() => setDrawerOpen(true)} />
      <PlatformBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar activeId={route.kind === "workOrder" ? route.id : undefined} drawerOpen={drawerOpen} onCloseDrawer={closeDrawer} />
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto outline-none">
          {route.kind === "workOrder" ? (
            <WorkOrderView key={route.id} id={route.id} tab={route.tab} query={route.query} />
          ) : (
            <NewWorkOrder />
          )}
        </main>
      </div>
      <Toasts />
      <ConfirmDialog />
    </div>
  );
}
