import { CheckCircleFillIcon, ContainerIcon, XCircleFillIcon, XIcon } from "@primer/octicons-react";
import { useEffect, useRef, type ReactNode } from "react";
import { jobById } from "../../shared/jobs.js";
import { laneById } from "../../shared/lanes.js";
import { agentCount, cpuMs, elapsedMs, formatBytes, formatClock, formatCount, formatSeconds, formatTokens, hasWorkers, ordinal, partlyMeasured, peakMemoryBytes, premiumRequests, reservedCpuSeconds, sandboxWaitMs } from "../../shared/score.js";
import type { LaneRun, RaceSnapshot, SandboxToken } from "../../shared/types.js";
import { openLane, useStore } from "../lib/store.js";
import { MarkdownView } from "./ui/Markdown.js";

const KIND: Readonly<Record<SandboxToken["kind"], string>> = { own: "Its own sandbox", hands: "Hands, no agent inside", worker: "Worker agent" };
const STATE: Readonly<Record<SandboxToken["state"], string>> = { starting: "Starting", working: "Working", idle: "Idle", failed: "Failed", stopped: "Deleted" };

/** One line about a sandbox: its size, how long it took to start, and what it used. */
function sandboxFacts(token: SandboxToken): string {
  const facts: string[] = [];
  if (token.cpus !== undefined && token.memoryBytes !== undefined) facts.push(`${token.cpus} vCPU, ${formatBytes(token.memoryBytes)}`);
  if (token.appearedAt !== undefined && token.readyAt !== undefined) facts.push(`ready in ${formatSeconds(token.readyAt - token.appearedAt)}`);
  if (token.appearedAt !== undefined && token.endedAt !== undefined) facts.push(`existed ${formatSeconds(token.endedAt - token.appearedAt)}`);
  facts.push(token.usage ? `${formatSeconds(token.usage.cpuMs)} CPU, ${formatBytes(token.usage.peakMemoryBytes)} peak` : "usage not read");
  return facts.join(" · ");
}

/** A lane's details: its answer, how it was judged, its sandboxes, and what it used. */
export function LaneDialog() {
  const open = useStore((current) => current.open);
  const race = useStore((current) => current.app?.race);
  const modelName = useStore((current) => current.app?.model.name);
  const skew = useStore((current) => current.skew);
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
      {race && run ? <Details race={race} run={run} modelName={modelName ?? race.model} now={Date.now() + skew} /> : null}
    </dialog>
  );
}

function Details({ race, run, modelName, now }: { readonly race: RaceSnapshot; readonly run: LaneRun; readonly modelName: string; readonly now: number }) {
  const lane = laneById(run.lane);
  const job = jobById(race.job);
  const elapsed = elapsedMs(race, run, run.finishedAt ?? now);
  const cpu = cpuMs(run);
  const memory = peakMemoryBytes(run);
  const partly = partlyMeasured(run);
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
            <ul className="flex flex-col gap-2">
              {run.sandboxes.map((token) => (
                <li key={token.id} className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <ContainerIcon size={16} className="shrink-0 text-fg-muted" />
                    <span className="shrink-0 font-semibold">{token.kind === "own" ? KIND.own : token.name}</span>
                    <span className="shrink-0 text-fg-muted">{token.kind === "own" ? "" : KIND[token.kind]}</span>
                    <code className="shrink-0 font-mono text-xs">{token.environment}</code>
                    <span className="shrink-0 text-xs text-fg-muted">{STATE[token.state]}</span>
                    <code className="ml-auto truncate font-mono text-xs text-fg-muted" title={token.id}>
                      {token.id}
                    </code>
                  </div>
                  <p className="truncate pl-6 text-xs text-fg-muted tabular-nums">{sandboxFacts(token)}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-fg-muted">None: it ran on the shared runtime only.</p>
          )}
        </Section>
        <Section title="Compute">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
            <Fact label="Sandbox CPU time">{cpu === undefined ? "Not measured" : `${formatSeconds(cpu)}${partly ? "+" : ""}`}</Fact>
            <Fact label="Sandbox peak memory">{memory === undefined ? "Not measured" : `${formatBytes(memory)}${partly ? "+" : ""}`}</Fact>
            <Fact label="vCPU-seconds held">{formatCount(Math.round(reservedCpuSeconds(run, now) * 10) / 10)}</Fact>
            <Fact label="Waiting for sandboxes">{formatSeconds(sandboxWaitMs(run, now))}</Fact>
          </dl>
          <p className="mt-2 text-xs text-fg-muted">
            {run.sandboxes.length
              ? "Read from each sandbox's own counters with managed.exec while it ran; every process in it counts (setup, any agent inside, and every command). vCPU-seconds held is each sandbox's vCPUs times how long it existed, busy or idle."
              : "It had no sandbox. Its agent ran on the shared runtime, which every shared session shares, so its share isn't measured."}
            {partly ? " Some sandboxes ended before they could be read, so the totals are at least these." : ""}
          </p>
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
            <Fact label="Time in model calls">{run.modelMs === undefined ? "–" : formatSeconds(run.modelMs)}</Fact>
            <Fact label="Tool calls">{run.toolCalls ?? "–"}</Fact>
            <Fact label="Input tokens">
              {run.tokens ? formatTokens(run.tokens.input) : "–"}
              {run.tokens?.cacheRead ? <span className="text-fg-muted"> ({formatTokens(run.tokens.cacheRead)} cached)</span> : null}
            </Fact>
            <Fact label="Output tokens">{run.tokens ? formatTokens(run.tokens.output) : "–"}</Fact>
            <Fact label="Auto-approved">{run.approvals}</Fact>
            <Fact label="Model">{modelName}</Fact>
          </dl>
          {hasWorkers(run) ? <p className="mt-2 text-xs text-fg-muted">Tokens and model calls are its own session's; each worker is a session of its own, which the race doesn't attach to.</p> : null}
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
