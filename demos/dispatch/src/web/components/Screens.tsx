import { AlertIcon, SyncIcon } from "@primer/octicons-react";
import { useStore } from "../lib/store.js";
import { AppHeaderBar } from "./TopBar.js";
import { Button } from "./ui/Button.js";

export function AppSkeleton() {
  return (
    <div className="flex h-dvh flex-col bg-canvas" aria-busy="true">
      <AppHeaderBar />
      <div className="flex min-h-0 flex-1">
        <div className="w-64 shrink-0 border-r border-line p-4 max-lg:hidden">
          <div className="SkeletonBox mb-4 h-8" />
          <div className="SkeletonBox mb-2 h-12" />
          <div className="SkeletonBox mb-2 h-12" />
        </div>
        <div className="flex-1 p-8">
          <div className="SkeletonBox mb-4 h-8 w-1/3" />
          <div className="SkeletonBox h-40" />
        </div>
      </div>
    </div>
  );
}

export function ErrorScreen() {
  const message = useStore((state) => state.loadError);
  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <AppHeaderBar />
      <main className="mx-auto mt-16 w-full max-w-2xl px-4">
        <div className="blankslate rounded-md border border-line">
          <AlertIcon size={24} className="blankslate-icon" />
          <h1 className="blankslate-heading">Dispatch can't load</h1>
          <p className="blankslate-description">{message ?? "Dispatch's server didn't answer."}</p>
          <div className="blankslate-action">
            <Button icon={SyncIcon} onClick={() => window.location.reload()}>
              Try again
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

/** Says what's wrong when Managed Copilot isn't connected, in plain words. */
export function PlatformBanner() {
  const platform = useStore((state) => state.platform);
  if (!platform || platform.state === "connected") return null;
  const connecting = platform.state === "connecting" || platform.state === "reconnecting";
  return (
    <div className={connecting ? "flash flash-full" : "flash flash-full flash-warn"} role="status">
      <AlertIcon size={16} />
      <span>
        <strong>{connecting ? "Connecting to Managed Copilot…" : "Managed Copilot isn't available."}</strong> {platform.message ?? ""}
      </span>
    </div>
  );
}
