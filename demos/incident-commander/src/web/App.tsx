import { useEffect } from "react";
import { Board } from "./components/Board.js";
import { Header } from "./components/Header.js";
import { IncidentPage } from "./components/IncidentPage.js";
import { Spinner } from "./components/ui.js";
import { useRoute } from "./lib/router.js";
import { connect, useStore } from "./lib/store.js";

export function App() {
  useEffect(() => connect(), []);
  const route = useRoute();
  const connection = useStore((state) => state.connection);
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <Header />
      {connection === "reconnecting" ? (
        <div role="status" className="flash flash-warn flash-full flex items-center justify-center gap-2 text-sm">
          <Spinner size={14} /> Reconnecting to Incident Commander…
        </div>
      ) : null}
      {route.page === "incident" ? <IncidentPage key={route.id} id={route.id} /> : <Board />}
    </div>
  );
}
