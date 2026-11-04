import { AlertIcon } from "@primer/octicons-react";
import { useEffect } from "react";
import { Board } from "./components/Board.js";
import { Header } from "./components/Header.js";
import { LaneDialog } from "./components/LaneDialog.js";
import { Scorecard } from "./components/Scorecard.js";
import { Starter } from "./components/Starter.js";
import { Spinner } from "./components/ui/Spinner.js";
import { connect, useStore } from "./lib/store.js";

export function App() {
  useEffect(() => connect(), []);
  const loaded = useStore((current) => current.app !== undefined);
  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-fg">
      <Header />
      <main className="mx-auto flex w-full max-w-[100rem] flex-col gap-6 px-4 py-6 sm:px-6">
        {loaded ? (
          <>
            <Starter />
            <PlatformNotice />
            <Board />
            <Scorecard />
          </>
        ) : (
          <div role="status" className="flex items-center gap-2 py-24 text-fg-muted">
            <Spinner size={16} />
            Loading the race board…
          </div>
        )}
      </main>
      <LaneDialog />
    </div>
  );
}

/** One line when Managed Copilot isn't there: the platform reconnects by itself. */
function PlatformNotice() {
  const platform = useStore((current) => current.app?.platform);
  if (!platform || platform.state === "connected") return null;
  if (platform.state === "connecting") {
    return (
      <div role="status" className="flash flex items-center py-3">
        <Spinner size={16} className="text-fg-accent" />
        Connecting to Managed Copilot…
      </div>
    );
  }
  return (
    <div role="alert" className="flash flash-warn py-3">
      <AlertIcon size={16} />
      <span>{platform.message ?? "Managed Copilot isn't reachable. Pattern Race keeps trying."}</span>
    </div>
  );
}
