import { CloudOfflineIcon, SyncIcon } from "@primer/octicons-react";
import { useState } from "react";
import { reloadState, useStore } from "../lib/store.js";
import { AppHeaderBar } from "./TopBar.js";
import { Button } from "./ui/Button.js";
import { Skeleton } from "./ui/Feedback.js";

/** Full-page state when the first `/api/state` request fails. */
export function ErrorScreen() {
  const error = useStore((state) => state.loadError);
  const [retrying, setRetrying] = useState(false);
  const retry = async (): Promise<void> => {
    setRetrying(true);
    await reloadState();
    setRetrying(false);
  };
  const detail = error && error.code !== "network_error" ? error.message : undefined;
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeaderBar />
      <main className="flex flex-1 justify-center px-4 py-10 md:py-16">
        <div className="Box blankslate blankslate--spacious h-fit w-full max-w-2xl animate-fade-in">
          <CloudOfflineIcon size={24} className="blankslate-icon" />
          <h1 className="blankslate-heading">Can't reach the factory server</h1>
          <p className="blankslate-description">
            The factory floor needs its server to show work orders. Check that it's running, then try again.
          </p>
          {detail ? (
            <p className="mt-3 max-w-full text-fg-muted">
              <code className="inline-code">{detail}</code>
            </p>
          ) : null}
          <div className="blankslate-action">
            <Button variant="primary" icon={SyncIcon} loading={retrying} onClick={() => void retry()}>
              Try again
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

/** First paint while `/api/state` loads. */
export function AppSkeleton() {
  return (
    <div className="flex h-dvh flex-col" role="status" aria-label="Loading the factory floor">
      <AppHeaderBar
        actions={
          <>
            <Skeleton className="h-7 w-32 rounded-md" />
            <span className="AppHeader-divider max-sm:hidden" aria-hidden />
            <Skeleton className="size-8 rounded-full" />
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-72 shrink-0 border-r border-line p-4 lg:block xl:w-80">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-4 h-8 w-full rounded-md" />
          <div className="mt-4 space-y-4">
            {[70, 85, 60, 75].map((width) => (
              <div key={width} className="flex gap-2">
                <Skeleton className="size-4 shrink-0 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <div className="SkeletonText" style={{ width: `${width}%` }} />
                  <div className="SkeletonText w-1/2" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="min-w-0 flex-1 px-4 py-6 md:px-6 lg:px-8">
          <div className="mx-auto max-w-[1012px]">
            <Skeleton className="h-8 w-96 max-w-full" />
            <div className="SkeletonText mt-3 w-[36rem] max-w-full" />
            <div className="mt-8 grid gap-4 md:grid-cols-2">
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="h-28 rounded-md" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
