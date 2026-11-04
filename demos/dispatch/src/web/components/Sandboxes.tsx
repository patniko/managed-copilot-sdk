import { CheckIcon, CircleSlashIcon, CopilotIcon, DotFillIcon, HourglassIcon, ShieldIcon, XCircleFillIcon, XIcon } from "@primer/octicons-react";
import type { CSSProperties, ReactNode } from "react";
import type { Approval, Blueprint, Command, ConversationView, StyleInfo, WorkerState, WorkerView } from "../../shared/types.js";
import { networkSummary, sizeSummary } from "../lib/blueprints.js";
import { kindOf } from "../lib/conversation.js";
import { cx } from "../lib/cx.js";
import { between, formatDuration, plural } from "../lib/format.js";
import { conversationHref, navigate } from "../lib/router.js";
import { answerApproval } from "../lib/store.js";
import { useNow } from "../lib/useNow.js";
import { BlueprintIcon } from "./BlueprintIcon.js";
import { agentColor } from "./Commands.js";
import { SharedRuntime } from "./Styles.js";
import { IconButton } from "./ui/Button.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

/** A sandbox's state as an icon and one or two words. */
export const STATE_WORD: Readonly<Record<WorkerState, string>> = { starting: "Starting", working: "Working", idle: "Idle", failed: "Failed", stopped: "Deleted" };
/** The same for the coordinator's own sandbox, which has no agent: it runs commands. */
const HANDS_WORD: Readonly<Record<WorkerState, string>> = { starting: "Starting", working: "Running", idle: "Idle", failed: "Failed", stopped: "Deleted" };

export function StateIcon({ state, size = 12 }: { readonly state: WorkerState; readonly size?: number }) {
  switch (state) {
    case "starting":
      return <Spinner size={size} className="text-fg-attention" />;
    case "working":
      return <Spinner size={size} className="text-fg-accent" />;
    case "idle":
      return <DotFillIcon size={size + 4} className="-mx-1 text-fg-success" />;
    case "failed":
      return <XCircleFillIcon size={size} className="text-fg-danger" />;
    case "stopped":
      return <CircleSlashIcon size={size} className="text-fg-muted" />;
  }
}

/** A hands sandbox's title: the coordinator's own, or one sub-agent's (`subagents: "own"`). */
export function handsTitle(view: Pick<ConversationView, "agents">, worker: WorkerView): string {
  if (!worker.agentId) return "Its own sandbox";
  return `${view.agents[worker.agentId] ?? "Sub-agent"}'s sandbox`;
}

/** The commands run in a hands sandbox, from the conversation's messages. */
export function commandsIn(view: ConversationView, worker: WorkerView): Command[] {
  const own = view.workers.some((candidate) => candidate.role === "hands" && candidate.agentId !== undefined);
  return view.messages.flatMap((message) => (message.commands ?? []).filter((command) => command.kind === "run" && command.status !== "denied" && command.status !== "asking" && (!own || command.agentId === worker.agentId)));
}

/** `#1`-style badges: the message that created a sandbox, and the ones that reused it (the latest two, then a count). */
export function MessageBadges({ worker }: { readonly worker: WorkerView }) {
  const hands = worker.role === "hands";
  const reused = worker.sentWorkBy.slice(-2);
  const earlier = worker.sentWorkBy.slice(0, -2);
  const verb = hands ? "Used again" : "Reused";
  return (
    <span className="flex shrink-0 items-center gap-1">
      {worker.createdBy !== undefined ? (
        <Tooltip content={`Created by message #${worker.createdBy}`}>
          <span className="Label Label--success px-1 tabular-nums">#{worker.createdBy}</span>
        </Tooltip>
      ) : null}
      {earlier.length ? (
        <Tooltip content={`${verb} by messages ${earlier.map((index) => `#${index}`).join(", ")}`}>
          <span className="Label Label--accent px-1 tabular-nums">+{earlier.length}</span>
        </Tooltip>
      ) : null}
      {reused.map((index) => (
        <Tooltip key={index} content={`${verb} by message #${index}`}>
          <span className="Label Label--accent px-1 tabular-nums">#{index}</span>
        </Tooltip>
      ))}
    </span>
  );
}

function select(view: ConversationView, worker: WorkerView, selected: boolean): void {
  navigate(conversationHref(view.id, { ...(selected ? {} : { worker: worker.id }) }), { replace: true });
}

function since(worker: WorkerView): string {
  return worker.timeline.at(-1)?.at ?? worker.updatedAt;
}

/** A worker's sandbox: its name, then its state, tasks, and the messages that created and reused it. */
function SandboxTile({ view, worker, selected, now }: { readonly view: ConversationView; readonly worker: WorkerView; readonly selected: boolean; readonly now: number }) {
  const active = worker.state === "starting" || worker.state === "working";
  const stopped = worker.state === "stopped";
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => select(view, worker, selected)}
      className={cx(
        "flex min-w-0 flex-col gap-1 rounded-md border bg-canvas px-3 py-2 text-left transition-shadow hover:shadow-sm focus-visible:outline-2 focus-visible:outline-[var(--focus-outlineColor)]",
        selected ? "border-transparent shadow-[0_0_0_2px_var(--bgColor-accent-emphasis)]" : active ? "border-line-accent" : "border-line",
        stopped && "bg-canvas-muted opacity-75",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-sm font-semibold" title={worker.name}>
          {worker.name}
        </span>
        {active ? <span className="ml-auto shrink-0 font-mono text-xs text-fg-muted tabular-nums">{formatDuration(between(since(worker), undefined, now))}</span> : null}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <StateIcon state={worker.state} />
        <span className={cx("shrink-0 font-medium", worker.state === "failed" ? "text-fg-danger" : "text-fg-muted")}>{STATE_WORD[worker.state]}</span>
        <span className="truncate text-fg-muted tabular-nums">· {plural(worker.tasks, "task")}</span>
        <span className="ml-auto">
          <MessageBadges worker={worker} />
        </span>
      </span>
    </button>
  );
}

/** A new sandbox the coordinator asked for, waiting for the person. */
function AskingTile({ conversationId, approval }: { readonly conversationId: string; readonly approval: Approval }) {
  return (
    <div className="asking-card flex min-w-0 flex-col gap-1 rounded-md px-3 py-2" title={approval.task}>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-sm font-semibold">{approval.worker}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <ShieldIcon size={12} className="shrink-0 text-fg-attention" />
        <span className="shrink-0 font-medium text-fg-attention">Needs you</span>
        <span className="ml-auto flex shrink-0 gap-1">
          <IconButton icon={CheckIcon} label={`Approve ${approval.worker ?? "this sandbox"}`} size="sm" variant="default" className="btn-primary" onClick={() => void answerApproval(conversationId, approval.id, true)} />
          <IconButton icon={XIcon} label={`Deny ${approval.worker ?? "this sandbox"}`} size="sm" variant="default" onClick={() => void answerApproval(conversationId, approval.id, false)} />
        </span>
      </span>
    </div>
  );
}

/** The sandbox a direct or mixed coordinator works in itself: its hands, drawn inside the coordinator's card. */
function HandsTile({ view, worker, blueprints, selected, now }: { readonly view: ConversationView; readonly worker: WorkerView; readonly blueprints: readonly Blueprint[]; readonly selected: boolean; readonly now: number }) {
  const kind = kindOf(worker.environment, blueprints);
  const label = blueprints.find((blueprint) => blueprint.name === worker.environment)?.label;
  const commands = commandsIn(view, worker);
  const running = commands.filter((command) => command.status === "running").length;
  const agents = [...new Set(commands.flatMap((command) => (command.agentId ? [command.agentId] : [])))];
  const state: WorkerState = worker.state === "idle" && running > 0 ? "working" : worker.state;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => select(view, worker, selected)}
      className={cx(
        "flex w-full min-w-0 flex-col gap-1 rounded-md border border-dashed bg-canvas px-3 py-2 text-left transition-shadow hover:shadow-sm focus-visible:outline-2 focus-visible:outline-[var(--focus-outlineColor)]",
        selected ? "border-transparent shadow-[0_0_0_2px_var(--bgColor-accent-emphasis)]" : "border-line-accent",
        worker.state === "stopped" && "opacity-75",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <BlueprintIcon kind={kind} size={14} />
        <span className="min-w-0 truncate text-sm font-semibold">{handsTitle(view, worker)}</span>
        {label ? <span className="truncate text-xs text-fg-muted max-sm:hidden">{label}</span> : null}
        <span className="ml-auto">
          <MessageBadges worker={worker} />
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <StateIcon state={state} />
        <span className="font-medium text-fg-muted">{HANDS_WORD[state]}</span>
        {agents.length ? (
          <span className="flex min-w-0 items-center gap-2 overflow-hidden pl-1" title="Sub-agents working here">
            {agents.slice(0, 4).map((agentId) => (
              <span key={agentId} className="inline-flex min-w-0 items-center gap-1" style={{ color: agentColor(view, agentId) } as CSSProperties}>
                <span className="size-2 shrink-0 rounded-full bg-current" aria-hidden />
                <span className="truncate">{view.agents[agentId] ?? "sub-agent"}</span>
              </span>
            ))}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-fg-muted tabular-nums">{running ? formatDuration(between(since(worker), undefined, now)) : plural(commands.length, "command")}</span>
      </span>
    </button>
  );
}

function CoordinatorStatus({ view, now }: { readonly view: ConversationView; readonly now: number }) {
  if (view.approvals.length) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-fg-attention">
        <ShieldIcon size={12} />
        Needs you
      </span>
    );
  }
  if (view.waiting) {
    return (
      <Tooltip content="No model time while it waits">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-fg-muted tabular-nums">
          <HourglassIcon size={12} />
          Waiting {formatDuration(between(view.waiting.since, undefined, now))}
        </span>
      </Tooltip>
    );
  }
  if (view.busy) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-fg-muted">
        <Spinner size={12} className="text-fg-accent" />
        Working
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-fg-muted">
      <DotFillIcon size={16} className="-mx-1 text-fg-success" />
      Idle
    </span>
  );
}

/** The coordinator (its brain, on the shared runtime) and, direct and mixed, the sandbox it works in itself. */
function CoordinatorCard({
  view,
  info,
  hands,
  blueprints,
  selected,
  now,
}: {
  readonly view: ConversationView;
  readonly info: StyleInfo | undefined;
  readonly hands: readonly WorkerView[];
  readonly blueprints: readonly Blueprint[];
  readonly selected?: string;
  readonly now: number;
}) {
  const own = view.style !== "delegate";
  const ownBlueprint = info?.handsEnvironment ? blueprints.find((blueprint) => blueprint.name === info.handsEnvironment) : undefined;
  return (
    <section aria-label="Coordinator" className="rounded-lg border border-line bg-canvas p-2.5">
      <div className="flex min-w-0 items-center gap-2 px-0.5">
        <span className="grid size-6 shrink-0 place-items-center rounded-full border border-line-accent-muted bg-accent-muted text-fg-accent">
          <CopilotIcon size={14} />
        </span>
        <span className="text-sm font-semibold">Coordinator</span>
        <span className="truncate text-xs text-fg-muted">
          <SharedRuntime />
        </span>
        <span className="ml-auto shrink-0">
          <CoordinatorStatus view={view} now={now} />
        </span>
      </div>
      {own ? (
        <div className="mt-2 flex flex-col gap-2">
          {hands.length ? (
            hands.map((worker) => <HandsTile key={worker.id} view={view} worker={worker} blueprints={blueprints} selected={worker.id === selected} now={now} />)
          ) : (
            <div className="rounded-md border border-dashed border-line px-3 py-2 text-xs text-fg-muted">
              Its own {ownBlueprint ? `${ownBlueprint.label} ` : ""}sandbox starts with its first command
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function LaneHeading({ blueprint, kind, count }: { readonly blueprint?: Blueprint; readonly kind: Blueprint["kind"]; readonly count: number }) {
  const heading = (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-fg-muted" tabIndex={blueprint ? 0 : undefined}>
      <BlueprintIcon kind={kind} size={14} />
      {blueprint?.label ?? "Sandbox"}
      <span className="font-normal tabular-nums">{count}</span>
    </span>
  );
  return blueprint ? <Tooltip content={`${blueprint.name} · ${sizeSummary(blueprint)} · ${networkSummary(blueprint.network, blueprint.kind)}`}>{heading}</Tooltip> : heading;
}

interface Lane {
  readonly environment: string;
  readonly blueprint?: Blueprint;
  readonly workers: readonly WorkerView[];
  readonly approvals: readonly Approval[];
}

/** The sandboxes a conversation's coordinator created, grouped by the blueprint each came from. */
export function Sandboxes({ view, blueprints, info, selected }: { readonly view: ConversationView; readonly blueprints: readonly Blueprint[]; readonly info: StyleInfo | undefined; readonly selected?: string }) {
  const active = view.busy || view.workers.some((worker) => worker.state === "starting" || worker.state === "working");
  const now = useNow(active);
  const hands = view.workers.filter((worker) => worker.role === "hands");
  const workers = view.workers.filter((worker) => worker.role !== "hands");
  const asking = view.approvals.filter((approval) => approval.kind !== "command");
  const order = [...blueprints.map((blueprint) => blueprint.name), ...workers.map((worker) => worker.environment), ...asking.map((approval) => approval.environment ?? "")];
  const lanes: Lane[] = [...new Set(order)]
    .filter(Boolean)
    .map((environment) => ({
      environment,
      blueprint: blueprints.find((blueprint) => blueprint.name === environment),
      workers: workers.filter((worker) => worker.environment === environment),
      approvals: asking.filter((approval) => approval.environment === environment),
    }))
    .filter((lane) => lane.workers.length > 0 || lane.approvals.length > 0);
  // Worker blueprints this conversation hasn't used: one muted line.
  const workerBlueprints = info?.available ? blueprints.filter((blueprint) => info.workers.includes(blueprint.name)) : view.style === "direct" ? [] : blueprints;
  const unused = workerBlueprints.filter((blueprint) => !lanes.some((lane) => lane.environment === blueprint.name));

  return (
    <div className="flex flex-col gap-4">
      <CoordinatorCard view={view} info={info} hands={hands} blueprints={blueprints} selected={selected} now={now} />
      {lanes.map((lane) => (
        <section key={lane.environment} aria-label={`${lane.blueprint?.label ?? lane.environment} sandboxes`} className="flex flex-col gap-2">
          <LaneHeading blueprint={lane.blueprint} kind={lane.blueprint?.kind ?? kindOf(lane.environment, blueprints)} count={lane.workers.length + lane.approvals.length} />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
            {lane.workers.map((worker) => (
              <SandboxTile key={worker.id} view={view} worker={worker} selected={worker.id === selected} now={now} />
            ))}
            {lane.approvals.map((approval) => (
              <AskingTile key={approval.id} conversationId={view.id} approval={approval} />
            ))}
          </div>
        </section>
      ))}
      {view.style === "delegate" && lanes.length === 0 ? <Muted>No sandboxes yet</Muted> : null}
      {unused.length ? <Muted>Also available: {unused.map((blueprint) => blueprint.label).join(" · ")}</Muted> : null}
    </div>
  );
}

function Muted({ children }: { readonly children: ReactNode }) {
  return <p className="px-0.5 text-xs text-fg-muted">{children}</p>;
}
