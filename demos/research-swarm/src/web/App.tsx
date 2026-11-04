import { useEffect } from "react";
import { Header } from "./components/Header.js";
import { Home } from "./components/Home.js";
import { RunPage } from "./components/RunPage.js";
import { Spinner } from "./components/ui/Spinner.js";
import { useRoute } from "./lib/router.js";
import { startStore, useStore } from "./lib/store.js";

export function App() {
  const phase = useStore((state) => state.phase);
  const loadError = useStore((state) => state.loadError);
  const route = useRoute();

  useEffect(() => {
    startStore();
  }, []);

  return (
    <div className="flex min-h-dvh flex-col bg-canvas-inset">
      <Header newResearch={route.kind === "run"} />
      <main className="flex flex-1 flex-col">
        {phase === "loading" ? (
          <div className="grid flex-1 place-items-center p-12 text-fg-muted">
            <Spinner size={24} label="Loading Research Swarm" />
          </div>
        ) : phase === "error" ? (
          <div className="blankslate blankslate--spacious mx-auto max-w-xl">
            <h2 className="blankslate-heading">Research Swarm isn't reachable</h2>
            <p className="blankslate-description">{loadError}</p>
            <button type="button" className="btn btn-primary mt-4" onClick={() => window.location.reload()}>
              Try again
            </button>
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
