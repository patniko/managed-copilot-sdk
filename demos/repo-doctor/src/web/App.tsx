import { useEffect } from "react";
import { Header } from "./components/Header.js";
import { Home } from "./components/Home.js";
import { RunPage } from "./components/RunPage.js";
import { Spinner } from "./components/ui/Spinner.js";
import { useRoute } from "./lib/router.js";
import { retryLoad, startStore, useStore } from "./lib/store.js";

export function App() {
  const phase = useStore((state) => state.phase);
  const loadError = useStore((state) => state.loadError);
  const route = useRoute();

  useEffect(() => {
    startStore();
  }, []);

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <Header />
      <main id="main" className="flex-1">
        {phase === "loading" ? (
          <div className="grid place-items-center py-24">
            <Spinner size={32} className="text-fg-muted" label="Loading" />
          </div>
        ) : phase === "error" ? (
          <div className="mx-auto max-w-3xl px-4 py-16">
            <div className="flash flash-error flex items-center gap-3">
              <span className="flex-1">{loadError}</span>
              <button type="button" className="btn btn-sm" onClick={retryLoad}>
                Try again
              </button>
            </div>
          </div>
        ) : route.kind === "run" ? (
          <RunPage key={route.id} id={route.id} />
        ) : (
          <Home />
        )}
      </main>
    </div>
  );
}
