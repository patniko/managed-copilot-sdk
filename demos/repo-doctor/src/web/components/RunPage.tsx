import {
  ArrowLeftIcon,
  BeakerIcon,
  ContainerIcon,
  CopilotIcon,
  DownloadIcon,
  LinkExternalIcon,
  RepoIcon,
  StopIcon,
  SyncIcon,
  ToolsIcon,
  TrashIcon,
} from "@primer/octicons-react";
import { useEffect, useState } from "react";
import { repoUrl } from "../../shared/repo.js";
import { STEP_ACTORS, STEP_IDS, STEP_LABELS, type RunView, type SandboxView, type StepId } from "../../shared/types.js";
import { api, errorMessage } from "../lib/api.js";
import { cx } from "../lib/cx.js";
import { between, clock, duration } from "../lib/format.js";
import { homeHref, navigate, runHref } from "../lib/router.js";
import { loadRun, useStore } from "../lib/store.js";
import { useNow } from "../lib/useNow.js";
import { NetworkStrip } from "./NetworkStrip.js";
import { PatchPanel } from "./PatchPanel.js";
import { Pipeline } from "./Pipeline.js";
import { RUN_STATUS, RunStatusIcon } from "./Status.js";
import { StepLog } from "./StepLog.js";
import { TestsPanel } from "./TestsPanel.js";
import { ConfirmDialog } from "./ui/ConfirmDialog.js";
import { OverflowMenu } from "./ui/Menu.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

function SandboxState({ sandbox }: { readonly sandbox: SandboxView }) {
  switch (sandbox.state) {
    case "creating":
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
          <Spinner size={12} className="text-fg-attention" /> Starting
        </span>
      );
    case "ready":
      return <span className="text-xs text-fg-muted">{sandbox.readyMs !== undefined ? `Ready in ${duration(sandbox.readyMs)}` : "Ready"}</span>;
    case "deleting":
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
          <Spinner size={12} /> Deleting
        </span>
      );
    case "deleted":
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
          <TrashIcon size={12} /> Deleted
        </span>
      );
    case "failed":
      return <span className="text-xs text-fg-danger">Not started</span>;
  }
}

/** The pattern, made visible: one sandbox holds Copilot's brain and hands, and every step of the run. */
function SandboxFrame({ run, selected, onSelect, now }: { readonly run: RunView; readonly selected: StepId | undefined; readonly onSelect: (id: StepId | undefined) => void; readonly now: number }) {
  const logs = useStore((state) => state.logs[run.id]);
  const running = run.steps.find((step) => step.status === "running");
  const activity =
    running?.activity ?? (running ? (STEP_ACTORS[running.id] === "copilot" ? "Copilot is working…" : `${STEP_LABELS[running.id]}…`) : run.sandbox.state === "creating" ? "Starting a sandbox…" : "Finishing…");
  const selectedStep = run.steps.find((step) => step.id === selected);
  const details = [run.sandbox.environment, run.sandbox.size, run.sandbox.id].filter(Boolean).join(" · ");
  return (
    <div>
      <section className="rd-frame p-3 sm:p-4" data-state={run.sandbox.state} aria-label="Sandbox">
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Tooltip content={details}>
            <span className="inline-flex items-center gap-2 font-semibold" tabIndex={0}>
              <ContainerIcon size={16} className="text-fg-accent" />
              Sandbox
            </span>
          </Tooltip>
          <SandboxState sandbox={run.sandbox} />
          <Tooltip className="ml-auto" content="Isolated: Copilot's model loop and the tools it acts with both run inside this one sandbox.">
            <span className="inline-flex items-center gap-3 text-xs text-fg-muted" tabIndex={0}>
              <span className="inline-flex items-center gap-1">
                <CopilotIcon size={14} /> Brain
              </span>
              <span className="inline-flex items-center gap-1">
                <ToolsIcon size={14} /> Hands
              </span>
            </span>
          </Tooltip>
        </div>
        <Pipeline steps={run.steps} selected={selected} onSelect={(id) => onSelect(id === selected ? undefined : id)} now={now} />
        {run.status === "running" ? (
          <div className="mt-2 flex min-w-0 items-center gap-2 rounded-md bg-canvas-muted px-3 py-1.5 font-mono text-xs text-fg-muted" aria-live="polite">
            <Spinner size={12} className="text-fg-attention" />
            <span className="truncate" title={activity}>
              {activity}
            </span>
          </div>
        ) : null}
        {selectedStep ? (
          <div className="mt-3">
            <StepLog step={selectedStep} lines={logs?.[selectedStep.id]} now={now} onClose={() => onSelect(undefined)} />
          </div>
        ) : null}
      </section>
      <div className="ml-6 h-4 w-0.5 bg-line" aria-hidden />
      <div className="rounded-lg border border-line bg-canvas-muted px-3 py-2.5">
        <NetworkStrip network={run.network} sandbox={run.sandbox.state} />
      </div>
    </div>
  );
}

function RunHeader({ run, now }: { readonly run: RunView; readonly now: number }) {
  const [busy, setBusy] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);
  const status = RUN_STATUS[run.status];
  const elapsed = between(run.createdAt, run.finishedAt, now) ?? 0;
  const finished = run.status !== "running";
  const github = run.source.kind === "github" ? repoUrl(run.source) : undefined;

  const act = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setProblem(undefined);
    try {
      await action();
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  };
  const again = () =>
    act("again", async () => {
      const created = await api.create(github ? { repo: github } : { sample: true });
      navigate(runHref(created.id));
    });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <a href={homeHref()} className="btn btn-invisible btn-icon" aria-label="All runs">
          <ArrowLeftIcon size={16} />
        </a>
        <h1 className="flex min-w-0 items-center gap-2 text-xl font-semibold">
          {run.source.kind === "sample" ? <BeakerIcon size={20} className="shrink-0 text-fg-muted" /> : <RepoIcon size={20} className="shrink-0 text-fg-muted" />}
          <span className="truncate" title={run.title}>
            {run.title}
          </span>
          <span className="shrink-0 font-normal text-fg-muted">#{run.number}</span>
        </h1>
        <span className={cx("inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold", status.text)}>
          <RunStatusIcon status={run.status} />
          {status.label}
          <span className="font-normal text-fg-muted tabular-nums">{finished ? duration(elapsed) : clock(elapsed)}</span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          {run.status === "running" ? (
            <button type="button" className="btn" disabled={busy !== undefined} onClick={() => void act("stop", () => api.stop(run.id))}>
              <StopIcon size={16} /> Stop
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy !== undefined} onClick={() => void again()}>
              {busy === "again" ? <Spinner size={16} /> : <SyncIcon size={16} />} Run again
            </button>
          )}
          {run.patch?.text && finished ? (
            <a className="btn btn-primary" href={api.patchUrl(run.id)} download aria-label="Download the patch">
              <DownloadIcon size={16} /> Patch
            </a>
          ) : null}
          <OverflowMenu
            label="More actions"
            items={[
              ...(github ? [{ label: "Open on GitHub", icon: <LinkExternalIcon size={16} />, onSelect: () => window.open(github, "_blank", "noopener") }] : []),
              { label: "Delete run", icon: <TrashIcon size={16} />, danger: true, disabled: !finished, onSelect: () => setConfirming(true) },
            ]}
          />
        </div>
      </div>
      {problem ? <div className="flash flash-error py-2 text-sm">{problem}</div> : null}
      {run.error ? (
        <div className={cx("flash py-2 text-sm", run.status === "not_fixed" ? "flash-warn" : "flash-error")} role="status">
          {run.error.message}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={`Delete run #${run.number}?`}
        confirmLabel="Delete"
        onClose={() => setConfirming(false)}
        onConfirm={() => void act("delete", () => api.delete(run.id))}
      >
        Its log and patch go too. Its sandbox is already deleted.
      </ConfirmDialog>
    </div>
  );
}

/** Opens a step's log when it fails, so the reason is on screen without a click. */
function firstFailed(run: RunView): StepId | undefined {
  return STEP_IDS.find((id) => {
    const step = run.steps.find((candidate) => candidate.id === id);
    return step?.status === "failed" && id !== "reproduce";
  });
}

export function RunPage({ id }: { readonly id: string }) {
  const run = useStore((state) => state.views[id]);
  const error = useStore((state) => state.viewErrors[id]);
  const now = useNow(run?.status === "running");
  const [selected, setSelected] = useState<StepId | undefined>();
  const failed = run ? firstFailed(run) : undefined;

  useEffect(() => {
    void loadRun(id);
  }, [id]);

  useEffect(() => {
    if (failed) setSelected((current) => current ?? failed);
  }, [failed]);

  if (!run) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {error ? (
          <div className="flash flash-error flex items-center gap-3">
            <span className="flex-1">{error}</span>
            <a className="btn btn-sm" href={homeHref()}>
              All runs
            </a>
          </div>
        ) : (
          <div className="flex flex-col gap-4" aria-busy>
            <span className="SkeletonBox h-8 w-64" />
            <span className="SkeletonBox h-48 w-full rounded-lg" />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6">
      <RunHeader run={run} now={now} />
      <SandboxFrame run={run} selected={selected} onSelect={setSelected} now={now} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <TestsPanel run={run} />
        <PatchPanel run={run} />
      </div>
    </div>
  );
}
