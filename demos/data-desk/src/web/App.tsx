import { AlertIcon } from "@primer/octicons-react";
import { useEffect } from "react";
import { Header } from "./components/Header.js";
import { Home } from "./components/Home.js";
import { Toasts } from "./components/ui/Toasts.js";
import { Spinner } from "./components/ui/Spinner.js";
import { Workspace } from "./components/Workspace.js";
import { useRoute } from "./lib/router.js";
import { startDesk, useStore } from "./lib/store.js";

export function App() {
  const phase = useStore((state) => state.phase);
  const loadError = useStore((state) => state.loadError);
  const route = useRoute();

  useEffect(() => {
    startDesk();
  }, []);

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
      <Header {...(route.kind === "analysis" ? { analysisId: route.id } : {})} />
      <main id="main" tabIndex={-1} className={route.kind === "analysis" ? "flex min-h-0 flex-1 flex-col outline-none" : "min-h-0 flex-1 overflow-y-auto outline-none"}>
        {phase === "loading" ? (
          <div className="flex h-full items-center justify-center gap-2 text-fg-muted" role="status">
            <Spinner size={16} /> Loading…
          </div>
        ) : phase === "error" ? (
          <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3 px-4 text-center">
            <AlertIcon size={24} className="text-fg-muted" />
            <p>{loadError ?? "Data Desk's server isn't answering."}</p>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        ) : route.kind === "analysis" ? (
          <Workspace key={route.id} id={route.id} />
        ) : (
          <Home />
        )}
      </main>
      <Toasts />
    </div>
  );
}
