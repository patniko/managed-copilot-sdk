import { Factory, RotateCcw, Unplug } from "lucide-react";
import { useState } from "react";
import { reloadState, useStore } from "../lib/store.js";
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
    <div className="grid min-h-dvh place-items-center bg-zinc-950 px-6">
      <div className="w-full max-w-md animate-rise-in text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-rose-400/10 text-rose-300 ring-1 ring-inset ring-rose-400/25">
          <Unplug className="size-6" aria-hidden />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-zinc-50">Can't reach the factory server</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-zinc-400">
          The factory floor needs its server to show work orders. Check that it's running, then try again.
        </p>
        {detail ? (
          <p className="mt-4 inline-block max-w-full rounded-lg bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400 ring-1 ring-inset ring-white/10">
            {detail}
          </p>
        ) : null}
        <div className="mt-6">
          <Button variant="primary" size="lg" icon={RotateCcw} loading={retrying} onClick={() => void retry()}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}

/** First paint while `/api/state` loads. */
export function AppSkeleton() {
  return (
    <div className="flex h-dvh flex-col" role="status" aria-label="Loading the factory floor">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-zinc-800/80 px-4">
        <span className="grid size-8 place-items-center rounded-lg bg-amber-400/15 text-amber-300 ring-1 ring-inset ring-amber-400/30">
          <Factory className="size-[18px]" aria-hidden />
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-zinc-100">Software Factory</span>
        <div className="ml-auto w-36">
          <Skeleton className="h-7 w-full rounded-full" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-[17rem] shrink-0 space-y-3 border-r border-zinc-800/80 p-3 lg:block xl:w-72">
          <Skeleton className="h-8 w-full rounded-lg" />
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="space-y-2 px-1 py-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3.5 w-48" />
              <Skeleton className="h-3 w-24" />
            </div>
          ))}
        </div>
        <div className="flex-1 px-6 py-10">
          <div className="mx-auto max-w-5xl space-y-4">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-8 w-96 max-w-full" />
            <Skeleton className="h-4 w-[36rem] max-w-full" />
            <div className="grid gap-3 pt-6 md:grid-cols-2">
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="h-32 rounded-xl" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
