import { ClockIcon, DownloadIcon, KebabHorizontalIcon, SquareFillIcon, SyncIcon, TrashIcon } from "@primer/octicons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Run } from "../../shared/types.js";
import { api, errorMessage } from "../lib/api.js";
import { useDismiss, useNow } from "../lib/hooks.js";
import { isActive, runTime } from "../lib/format.js";
import { homeHref, navigate, runHref } from "../lib/router.js";
import { loadRun, removeRun, startRun, stopRun, useStore } from "../lib/store.js";
import { FanOut } from "./FanOut.js";
import { Report } from "./Report.js";
import { RunStatusBadge } from "./Status.js";
import { ResearcherDialog, SwarmSummary, WhereItRan } from "./Swarm.js";
import { Spinner } from "./ui/Spinner.js";

export function RunPage({ id }: { readonly id: string }) {
  const run = useStore((state) => state.runs[id]);
  const missing = useStore((state) => state.missing[id]);
  const [open, setOpen] = useState<string>();
  const close = useCallback(() => setOpen(undefined), []);

  useEffect(() => {
    void loadRun(id);
  }, [id]);

  if (!run) {
    return missing ? (
      <div className="blankslate blankslate--spacious mx-auto max-w-xl">
        <h2 className="blankslate-heading">{missing}</h2>
        <a href={homeHref()} className="btn btn-primary mt-4">
          New research
        </a>
      </div>
    ) : (
      <div className="grid flex-1 place-items-center p-12 text-fg-muted">
        <Spinner size={24} label="Loading the research" />
      </div>
    );
  }
  const researcher = open ? run.researchers.find((candidate) => candidate.id === open) : undefined;
  return (
    <div className="flex flex-col">
      <RunBar run={run} />
      {run.status === "done" && run.report ? (
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:py-8">
          <Report run={run} />
          <aside className="lg:sticky lg:top-6 lg:self-start">
            <SwarmSummary run={run} onOpen={setOpen} />
          </aside>
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-8">
          {run.error ? <Problem run={run} /> : null}
          <FanOut run={run} onOpen={setOpen} />
          <WhereItRan run={run} className="justify-center" />
        </div>
      )}
      {researcher ? <ResearcherDialog run={run} researcher={researcher} onClose={close} /> : null}
    </div>
  );
}

/** The run's status and time on the left, and what can be done with it on the right. */
function RunBar({ run }: { readonly run: Run }) {
  const active = isActive(run.status);
  const now = useNow(active);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-b border-line-muted bg-canvas">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <RunStatusBadge status={run.status} />
        <span className="inline-flex items-center gap-1 text-sm text-fg-muted tabular-nums" title="Time since the question">
          <ClockIcon size={14} />
          {runTime(run, now)}
        </span>
        {error ? (
          <span className="min-w-0 truncate text-sm text-fg-danger" role="alert" title={error}>
            {error}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {active ? (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act(() => stopRun(run.id))}>
              {busy ? <Spinner size={14} /> : <SquareFillIcon size={16} />}
              Stop
            </button>
          ) : run.report ? (
            <a href={api.reportHref(run.id)} download className="btn btn-sm">
              <DownloadIcon size={16} />
              Export
            </a>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  navigate(runHref((await startRun(run.question)).id));
                })
              }
            >
              <SyncIcon size={16} />
              Try again
            </button>
          )}
          {active ? null : <RunMenu onDelete={() => void act(async () => {
            await removeRun(run.id);
            navigate(homeHref());
          })} />}
        </span>
      </div>
    </div>
  );
}

function RunMenu({ onDelete }: { readonly onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(container, open, close);
  return (
    <div ref={container} className="relative">
      <button type="button" className="btn btn-sm btn-icon" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <KebabHorizontalIcon size={16} />
      </button>
      {open ? (
        <div className="Overlay absolute top-full right-0 z-40 mt-1 w-48 animate-scale-in p-1" role="menu">
          <button
            type="button"
            role="menuitem"
            className="ActionList-item ActionList-item--danger flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            <TrashIcon size={16} />
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Why the run ended without a report, in one line. */
function Problem({ run }: { readonly run: Run }) {
  return (
    <div className={run.status === "stopped" ? "flash" : "flash flash-error"} role="alert">
      {run.error}
    </div>
  );
}
