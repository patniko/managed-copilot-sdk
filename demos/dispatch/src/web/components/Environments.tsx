import { CheckCircleFillIcon, CircleSlashIcon, ContainerIcon, ShieldIcon, TerminalIcon, XCircleFillIcon } from "@primer/octicons-react";
import type { CSSProperties } from "react";
import type { Approval, Blueprint, Command, ConversationView, WorkerView } from "../../shared/types.js";
import { KIND_ICON, KIND_LANE, networkSummary, sizeSummary, WORKER_STATE } from "../lib/blueprints.js";
import { kindOf } from "../lib/conversation.js";
import { cx } from "../lib/cx.js";
import { between, formatDuration, oneLine, plural, shortId } from "../lib/format.js";
import { conversationHref, navigate } from "../lib/router.js";
import { answerApproval } from "../lib/store.js";
import { useNow } from "../lib/useNow.js";
import { Spinner } from "./ui/Spinner.js";

export function WorkerStateIcon({ worker, size = 16 }: { readonly worker: Pick<WorkerView, "state">; readonly size?: number }) {
  switch (worker.state) {
    case "starting":
      return <Spinner size={size} className="text-fg-attention" label="Starting" />;
    case "working":
      return <Spinner size={size} className="text-fg-accent" label="Working" />;
    case "idle":
      return <CheckCircleFillIcon size={size} className="text-fg-success" aria-label="Idle" />;
    case "failed":
      return <XCircleFillIcon size={size} className="text-fg-danger" aria-label="Failed" />;
    case "stopped":
      return <CircleSlashIcon size={size} className="text-fg-muted" aria-label="Stopped" />;
  }
}

/** When a worker last changed state (for the live timer while it works). */
function lastChange(worker: WorkerView): string {
  return worker.timeline.at(-1)?.at ?? worker.updatedAt;
}

export function MessageChips({ worker }: { readonly worker: WorkerView }) {
  if (worker.createdBy === undefined && worker.sentWorkBy.length === 0) return null;
  const hands = worker.role === "hands";
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {worker.createdBy !== undefined ? (
        <span className="Label Label--success" title={`Created while handling message #${worker.createdBy}`}>
          #{worker.createdBy} created
        </span>
      ) : null}
      {worker.sentWorkBy.map((index) => (
        <span key={index} className="Label Label--accent" title={hands ? `Message #${index} ran more commands in it` : `Message #${index} sent it more work`}>
          #{index} {hands ? "used" : "reused"}
        </span>
      ))}
    </div>
  );
}

function WorkerCard({ view, worker, selected, now }: { readonly view: ConversationView; readonly worker: WorkerView; readonly selected: boolean; readonly now: number }) {
  const conversationId = view.id;
  const meta = WORKER_STATE[worker.state];
  const active = worker.state === "starting" || worker.state === "working";
  const hands = worker.role === "hands";
  const ran = hands ? commandsIn(view, worker).length : 0;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => navigate(conversationHref(conversationId, { ...(selected ? {} : { worker: worker.id }) }), { replace: true })}
      className={cx(
        "w-56 rounded-lg border p-2 text-left text-xs transition-shadow",
        worker.state === "stopped" ? "border-line bg-canvas-muted" : "border-line bg-canvas hover:shadow-sm",
        hands && worker.state !== "stopped" && "border-dashed",
        selected && "border-transparent shadow-[0_0_0_2px_var(--bgColor-accent-emphasis)]",
        active && !selected && "border-[var(--borderColor-accent-emphasis)]",
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-semibold">
        {hands ? <TerminalIcon size={14} className="shrink-0 text-fg-muted" /> : <WorkerStateIcon worker={worker} size={14} />}
        <span className="min-w-0 truncate">{hands ? handsTitle(view, worker) : worker.name}</span>
        <span className="ml-auto shrink-0 font-mono text-xs font-normal text-fg-muted tabular-nums">
          {hands ? plural(ran, "command") : active ? formatDuration(between(lastChange(worker), undefined, now)) : plural(worker.tasks, "task")}
        </span>
      </span>
      <span className={cx("mt-0.5 block font-medium", hands ? "text-fg-muted" : worker.state === "idle" ? "text-fg-success" : worker.state === "failed" ? "text-fg-danger" : "text-fg-muted")}>
        {hands ? (worker.state === "stopped" ? "Deleted · no agent in it" : "No agent in it · the coordinator works here") : `${meta.label} · ${meta.sandbox}`}
      </span>
      {worker.sandbox ? (
        <span className="mt-1 flex items-center gap-1 text-fg-muted">
          <ContainerIcon size={12} />
          <span className="truncate font-mono">{shortId(worker.sandbox.id, 16)}</span>
        </span>
      ) : null}
      <MessageChips worker={worker} />
    </button>
  );
}

/** A hands sandbox's title: the coordinator's own, or one sub-agent's (`subagents: "own"`). */
export function handsTitle(view: Pick<ConversationView, "agents">, worker: WorkerView): string {
  if (!worker.agentId) return "Coordinator's sandbox";
  return `${view.agents[worker.agentId] ?? "Sub-agent"}'s sandbox`;
}

/** The commands run in a hands sandbox, from the conversation's messages. */
export function commandsIn(view: ConversationView, worker: WorkerView): Command[] {
  const own = view.workers.some((candidate) => candidate.role === "hands" && candidate.agentId !== undefined);
  return view.messages.flatMap((message) => (message.commands ?? []).filter((command) => command.kind === "run" && command.status !== "denied" && command.status !== "asking" && (!own || command.agentId === worker.agentId)));
}

function AskingCard({ conversationId, approval }: { readonly conversationId: string; readonly approval: Approval }) {
  return (
    <div className="asking-card w-56 rounded-lg p-2 text-xs">
      <div className="flex items-center gap-1.5 text-sm font-semibold">
        <ShieldIcon size={14} className="text-fg-attention" />
        <span className="min-w-0 truncate">{approval.worker}</span>
      </div>
      <div className="mt-0.5 font-medium text-fg-attention">Asking to be created</div>
      {approval.task ? (
        <p className="mt-1 line-clamp-2 text-fg-muted" title={approval.task}>
          {oneLine(approval.task, 140)}
        </p>
      ) : null}
      <div className="mt-1.5 flex items-center gap-1">
        {approval.messageIndex !== undefined ? <span className="Label Label--attention">#{approval.messageIndex} asked for</span> : null}
        <span className="ml-auto flex gap-1">
          <button type="button" className="btn btn-sm btn-primary px-2" onClick={() => void answerApproval(conversationId, approval.id, true)}>
            Approve
          </button>
          <button type="button" className="btn btn-sm px-2" onClick={() => void answerApproval(conversationId, approval.id, false)}>
            Deny
          </button>
        </span>
      </div>
    </div>
  );
}

function BlueprintRow({
  view,
  blueprint,
  workers,
  approvals,
  selected,
  now,
}: {
  readonly view: ConversationView;
  readonly blueprint: Pick<Blueprint, "name" | "kind" | "label" | "size" | "cpus" | "memoryGiB" | "network"> & { readonly description?: string };
  readonly workers: readonly WorkerView[];
  readonly approvals: readonly Approval[];
  readonly selected?: string;
  readonly now: number;
}) {
  const Glyph = KIND_ICON[blueprint.kind];
  const used = workers.length > 0 || approvals.length > 0;
  return (
    <section
      aria-label={`${blueprint.name} sandboxes`}
      className={cx("lane grid gap-3 rounded-lg border border-line bg-canvas p-3 md:grid-cols-[11rem_minmax(0,1fr)]", !used && "opacity-80")}
      style={{ "--lane": used ? KIND_LANE[blueprint.kind] : "var(--borderColor-default)" } as CSSProperties}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-semibold" title={blueprint.description}>
          <Glyph size={16} className="lane-icon shrink-0" />
          <span className="truncate font-mono text-[13px]">{blueprint.name}</span>
        </div>
        <div className="mt-1 flex flex-col gap-0.5 text-xs text-fg-muted">
          <span>{blueprint.label}</span>
          <span>{sizeSummary(blueprint)}</span>
          <span title={blueprint.network.hosts.join(", ") || undefined}>{networkSummary(blueprint.network, blueprint.kind)}</span>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {workers.map((worker) => (
          <WorkerCard key={worker.id} view={view} worker={worker} selected={worker.id === selected} now={now} />
        ))}
        {approvals.map((approval) => (
          <AskingCard key={approval.id} conversationId={view.id} approval={approval} />
        ))}
        {!used ? <div className="flex min-h-14 flex-1 items-center justify-center rounded-lg border border-dashed border-line text-xs text-fg-muted">Not used in this conversation yet</div> : null}
      </div>
    </section>
  );
}

export function Environments({ view, blueprints, selected }: { readonly view: ConversationView; readonly blueprints: readonly Blueprint[]; readonly selected?: string }) {
  const active = view.workers.some((worker) => worker.state === "starting" || worker.state === "working");
  const now = useNow(active);
  const known = new Set(blueprints.map((blueprint) => blueprint.name));
  // Workers from environments that aren't (or are no longer) among the coordinator's blueprints.
  const others = [...new Set(view.workers.map((worker) => worker.environment).filter((environment) => !known.has(environment)))];
  return (
    <div className="flex flex-col gap-2.5">
      {blueprints.map((blueprint) => (
        <BlueprintRow
          key={blueprint.name}
          view={view}
          blueprint={blueprint}
          workers={view.workers.filter((worker) => worker.environment === blueprint.name)}
          approvals={view.approvals.filter((approval) => approval.environment === blueprint.name)}
          selected={selected}
          now={now}
        />
      ))}
      {others.map((environment) => {
        const kind = kindOf(environment, blueprints);
        return (
          <BlueprintRow
            key={environment}
            view={view}
            blueprint={{ name: environment, kind, label: "Sandbox", size: "", network: { access: "disabled", hosts: [] } }}
            workers={view.workers.filter((worker) => worker.environment === environment)}
            approvals={view.approvals.filter((approval) => approval.environment === environment)}
            selected={selected}
            now={now}
          />
        );
      })}
    </div>
  );
}
