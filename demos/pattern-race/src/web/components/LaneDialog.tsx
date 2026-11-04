import { CheckCircleFillIcon, ContainerIcon, XCircleFillIcon, XIcon } from "@primer/octicons-react";
import { useEffect, useRef, type ReactNode } from "react";
import { jobById } from "../../shared/jobs.js";
import { laneById } from "../../shared/lanes.js";
import { agentCount, elapsedMs, formatClock, formatCount, ordinal, premiumRequests } from "../../shared/score.js";
import type { LaneRun, RaceSnapshot, SandboxToken } from "../../shared/types.js";
import { openLane, useStore } from "../lib/store.js";
import { MarkdownView } from "./ui/Markdown.js";

const KIND: Readonly<Record<SandboxToken["kind"], string>> = { own: "Its own sandbox", hands: "Hands, no agent inside", worker: "Worker agent" };
const STATE: Readonly<Record<SandboxToken["state"], string>> = { starting: "Starting", working: "Working", idle: "Idle", failed: "Failed", stopped: "Deleted" };

/** A lane's details: its answer, how it was judged, its sandboxes, and what it used. */
export function LaneDialog() {
  const open = useStore((current) => current.open);
  const race = useStore((current) => current.app?.race);
  const modelName = useStore((current) => current.app?.model.name);
  const run = open ? race?.lanes.find((lane) => lane.lane === open) : undefined;
  const ref = useRef<HTMLDialogElement>(null);
  const shown = Boolean(open && race && run);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (shown && !dialog.open) dialog.showModal();
    if (!shown && dialog.open) dialog.close();
  }, [shown]);
  return (
    <dialog
      ref={ref}
      className="Dialog Dialog--large backdrop:bg-backdrop"
      aria-labelledby="lane-dialog-title"
      onClose={() => openLane(undefined)}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      {race && run ? <Details race={race} run={run} modelName={modelName ?? race.model} /> : null}
    </dialog>
  );
}

function Details({ race, run, modelName }: { readonly race: RaceSnapshot; readonly run: LaneRun; readonly modelName: string }) {
  const lane = laneById(run.lane);
  const job = jobById(race.job);
  const elapsed = elapsedMs(race, run, run.finishedAt ?? Date.now());
  return (
    <>
      <div className="Dialog-header">
        <div className="Dialog-headerContent min-w-0">
          <h2 id="lane-dialog-title" className="Dialog-title">
            {lane.pattern}
            {run.place ? <span className="ml-2 text-fg-success">{ordinal(run.place)}</span> : null}
          </h2>
          <p className="Dialog-subtitle truncate">{lane.summary}</p>
        </div>
        <button type="button" className="btn btn-invisible btn-icon" aria-label="Close" onClick={() => openLane(undefined)}>
          <XIcon size={16} />
        </button>
      </div>
      <div className="Dialog-body flex flex-col gap-5 overflow-y-auto p-4 text-sm">
        <code className="block rounded-md bg-canvas-inset px-3 py-2 font-mono text-xs">
          const client = await managed.client(<span className="text-fg-accent">"{lane.environment}"</span>);
        </code>
        {run.error ? (
          <div className="flash flash-error py-3" role="alert">
            {run.error}
          </div>
        ) : null}
        <Section title="Answer">
          {run.answer ? (
            <div className="rounded-md border border-line-muted px-3 py-2">
              <MarkdownView source={run.answer} />
            </div>
          ) : (
            <p className="text-fg-muted">No answer.</p>
          )}
        </Section>
        {job.checks.length ? (
          <Section title="Checked against">
            <ul className="flex flex-col gap-1.5">
              {job.checks.map((check, index) => {
                const found = run.checks?.[index] ?? false;
                return (
                  <li key={check.label} className="flex min-w-0 items-center gap-2">
                    {found ? <CheckCircleFillIcon size={16} className="shrink-0 text-fg-success" /> : <XCircleFillIcon size={16} className="shrink-0 text-fg-danger" />}
                    <span className="shrink-0">{check.label}</span>
                    <code className="truncate font-mono text-xs text-fg-muted" title={race.expected[index]}>
                      {race.expected[index]}
                    </code>
                  </li>
                );
              })}
            </ul>
          </Section>
        ) : null}
        <Section title="Sandboxes">
          {run.sandboxes.length ? (
            <ul className="flex flex-col gap-1.5">
              {run.sandboxes.map((token) => (
                <li key={token.id} className="flex min-w-0 items-center gap-2">
                  <ContainerIcon size={16} className="shrink-0 text-fg-muted" />
                  <span className="shrink-0 font-semibold">{token.kind === "own" ? KIND.own : token.name}</span>
                  <span className="shrink-0 text-fg-muted">{token.kind === "own" ? "" : KIND[token.kind]}</span>
                  <code className="shrink-0 font-mono text-xs">{token.environment}</code>
                  <span className="shrink-0 text-xs text-fg-muted">{STATE[token.state]}</span>
                  <code className="ml-auto truncate font-mono text-xs text-fg-muted" title={token.id}>
                    {token.id}
                  </code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-fg-muted">None: it ran on the shared runtime only.</p>
          )}
        </Section>
        <Section title="Usage">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
            <Fact label="Time">{formatClock(elapsed)}</Fact>
            <Fact label="Agents">
              {agentCount(run)}
              {run.subagents ? <span className="text-fg-muted"> ({run.subagents} sub-agents)</span> : null}
            </Fact>
            <Fact label="Premium requests">
              {formatCount(premiumRequests(run))}
              {run.premium.workers ? <span className="text-fg-muted"> ({formatCount(run.premium.workers)} by workers)</span> : null}
            </Fact>
            <Fact label="Model calls">{run.modelCalls}</Fact>
            <Fact label="Auto-approved">{run.approvals}</Fact>
            <Fact label="Model">{modelName}</Fact>
          </dl>
        </Section>
        {run.sessionId ? (
          <p className="text-xs text-fg-muted">
            Session <code className="font-mono">{run.sessionId}</code>, deleted with its sandboxes when the lane finished.
          </p>
        ) : null}
      </div>
    </>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold text-fg-muted">{title}</h3>
      {children}
    </section>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="truncate font-semibold tabular-nums">{children}</dd>
    </div>
  );
}
