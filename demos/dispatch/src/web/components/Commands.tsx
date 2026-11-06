import {
  CheckCircleFillIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  CopilotIcon,
  EyeIcon,
  FileAddedIcon,
  PaperAirplaneIcon,
  ListUnorderedIcon,
  PencilIcon,
  SearchIcon,
  ShieldIcon,
  SquareIcon,
  TerminalIcon,
  XCircleFillIcon,
  type Icon,
} from "@primer/octicons-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import type { Approval, Command, ConversationView, SubAgent } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { between, formatDuration, oneLine, plural, shortId } from "../lib/format.js";
import { answerApproval } from "../lib/store.js";
import { Button } from "./ui/Button.js";
import { Spinner } from "./ui/Spinner.js";

/** Colors that tell sub-agents apart, in the order they first appeared in the conversation. */
const AGENT_COLORS = ["var(--fgColor-accent)", "var(--fgColor-done)", "var(--fgColor-success)", "var(--fgColor-severe)", "var(--fgColor-sponsors)", "var(--fgColor-attention)"];
const SHOWN = 12;

export function agentColor(view: Pick<ConversationView, "agents">, agentId: string): string {
  const index = Object.keys(view.agents).indexOf(agentId);
  return AGENT_COLORS[(index < 0 ? 0 : index) % AGENT_COLORS.length]!;
}

/** Who ran a command: the coordinator itself, or one of its sub-agents (named, with its color). */
export function AgentChip({ view, agentId, className }: { readonly view: Pick<ConversationView, "agents">; readonly agentId?: string; readonly className?: string }) {
  if (!agentId) {
    return (
      <span className={cx("inline-flex max-w-full items-center gap-1 text-xs font-medium text-fg-muted", className)} title="The coordinator itself">
        <CopilotIcon size={12} className="shrink-0" />
        <span className="truncate">coordinator</span>
      </span>
    );
  }
  const name = view.agents[agentId] ?? `sub-agent ${shortId(agentId, 8)}`;
  return (
    <span className={cx("inline-flex max-w-full items-center gap-1 text-xs font-medium", className)} style={{ color: agentColor(view, agentId) } as CSSProperties} title={`Sub-agent ${name} (${agentId})`}>
      <span className="size-2 shrink-0 rounded-full bg-current" aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  );
}

const KIND_ICON: Readonly<Record<Command["kind"], Icon>> = {
  run: TerminalIcon,
  input: PaperAirplaneIcon,
  output: TerminalIcon,
  stop: SquareIcon,
  list: ListUnorderedIcon,
  view: EyeIcon,
  create: FileAddedIcon,
  edit: PencilIcon,
  search: SearchIcon,
};

const Mono = ({ children, title }: { readonly children: ReactNode; readonly title?: string }) => (
  <span className="font-mono text-xs" title={title}>
    {children}
  </span>
);

/** The workspace-relative form of a path, which is how people read them. */
const short = (path: string | undefined) => (path ? path.replace(/^\/workspace\/?/, "") || "/workspace" : "a file");

function describe(command: Command): ReactNode {
  switch (command.kind) {
    case "run":
      return <Mono title={command.command}>$ {oneLine(command.command ?? "", 140)}</Mono>;
    case "input":
      return (
        <>
          Sent <Mono>{oneLine(command.command ?? "", 60) || "input"}</Mono> to a running command
        </>
      );
    case "output":
      return <>Read the output of a running command</>;
    case "stop":
      return <>Stopped a running command</>;
    case "list":
      return <>Listed its commands</>;
    case "view":
      return (
        <>
          Read <Mono>{short(command.path)}</Mono>
        </>
      );
    case "create":
      return (
        <>
          Created <Mono>{short(command.path)}</Mono>
        </>
      );
    case "edit":
      return (
        <>
          Edited <Mono>{short(command.path)}</Mono>
        </>
      );
    case "search":
      return (
        <>
          Searched for <Mono>{oneLine(command.pattern ?? "", 60)}</Mono>
          {command.path ? (
            <>
              {" "}
              in <Mono>{short(command.path)}</Mono>
            </>
          ) : null}
        </>
      );
  }
}

function Outcome({ command, now }: { readonly command: Command; readonly now: number }) {
  switch (command.status) {
    case "asking":
      return <span className="Label Label--attention shrink-0">asking you</span>;
    case "running":
      return (
        <span className="inline-flex shrink-0 items-center gap-1 font-mono text-xs text-fg-muted tabular-nums">
          <Spinner size={12} className="text-fg-accent" />
          {formatDuration(between(command.approvedAt ?? command.at, undefined, now))}
        </span>
      );
    case "denied":
      return <span className="Label Label--secondary shrink-0">declined</span>;
    case "failed":
      return (
        <span className="Label Label--danger shrink-0" title={command.outcome}>
          {command.outcome && command.outcome.length <= 24 ? command.outcome : "failed"}
        </span>
      );
    case "done": {
      // How long it ran (from its approval, when it asked); file changes and reads take no time worth showing.
      const took = command.endedAt && command.kind === "run" ? formatDuration(between(command.approvedAt ?? command.at, command.endedAt, now)) : undefined;
      if (command.exitCode !== undefined) {
        return (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs">
            {took ? <span className="font-mono text-fg-muted tabular-nums">{took}</span> : null}
            <span className={command.exitCode === 0 ? "Label Label--success" : "Label Label--danger"}>exit {command.exitCode}</span>
          </span>
        );
      }
      if (command.outcome === "still running" || command.outcome === "started in the background") return <span className="Label Label--accent shrink-0">{command.outcome}</span>;
      return took ? <span className="shrink-0 font-mono text-xs text-fg-muted tabular-nums">{took}</span> : <span />;
    }
  }
}

function CommandRow({ conversationId, view, command, approval, primary, now }: { readonly conversationId: string; readonly view: ConversationView; readonly command: Command; readonly approval?: Approval; readonly primary: boolean; readonly now: number }) {
  const [open, setOpen] = useState(false);
  const [denying, setDenying] = useState(false);
  const Glyph = KIND_ICON[command.kind];
  const multiline = (command.command ?? "").includes("\n");
  const details = Boolean(command.output || multiline || command.description || (command.outcome && command.status !== "done") || command.shellId);
  return (
    <li className={cx("border-t border-line-muted first:border-t-0", command.status === "asking" && "bg-attention-muted")}>
      <div className="flex min-w-0 items-center">
        <button
          type="button"
          disabled={!details}
          aria-expanded={details ? open : undefined}
          onClick={() => setOpen((value) => !value)}
          className="grid min-w-0 flex-1 grid-cols-[12px_16px_minmax(0,7.5rem)_minmax(0,1fr)_auto] items-center gap-2 py-1.5 pr-3 pl-3 text-left text-sm enabled:hover:bg-canvas-muted disabled:cursor-default"
          title={command.description}
        >
          {details ? open ? <ChevronDownIcon size={12} className="text-fg-muted" /> : <ChevronRightIcon size={12} className="text-fg-muted" /> : <span />}
          <Glyph size={14} className={cx(command.status === "failed" ? "text-fg-danger" : command.status === "asking" ? "text-fg-attention" : "text-fg-muted")} />
          <AgentChip view={view} agentId={command.agentId} />
          <span className={cx("min-w-0 truncate", command.status === "denied" && "text-fg-muted line-through")}>{describe(command)}</span>
          {approval ? <span /> : <Outcome command={command} now={now} />}
        </button>
        {approval && !denying ? <CommandApproval conversationId={conversationId} approval={approval} primary={primary} onDeny={() => setDenying(true)} /> : null}
      </div>
      {open && details ? (
        <div className="flex flex-col gap-1.5 px-3 pb-2 pl-[3.25rem] text-xs">
          {command.description ? <p className="text-fg-muted">{command.description}</p> : null}
          {multiline ? <pre className="max-h-48 overflow-auto rounded-md border border-line-muted bg-canvas-inset p-2 font-mono whitespace-pre-wrap">{command.command}</pre> : null}
          {command.output ? (
            <pre className="max-h-64 overflow-auto rounded-md border border-line-muted bg-canvas-inset p-2 font-mono whitespace-pre-wrap" aria-label="Output">
              {command.output}
            </pre>
          ) : null}
          {command.outcome && command.status !== "done" ? <p className={command.status === "failed" ? "text-fg-danger" : "text-fg-muted"}>{command.outcome}</p> : null}
          {command.shellId ? <p className="font-mono text-fg-muted">shellId {command.shellId}</p> : null}
        </div>
      ) : null}
      {approval && denying ? <DenyForm conversationId={conversationId} approval={approval} onCancel={() => setDenying(false)} /> : null}
    </li>
  );
}

/** Approve or deny one command; "the rest of this message" is in the card's header. */
function CommandApproval({ conversationId, approval, primary, onDeny }: { readonly conversationId: string; readonly approval: Approval; readonly primary: boolean; readonly onDeny: () => void }) {
  const [busy, setBusy] = useState(false);
  const approve = async (): Promise<void> => {
    setBusy(true);
    await answerApproval(conversationId, approval.id, true);
    setBusy(false);
  };
  return (
    <span className="flex shrink-0 items-center gap-1 pr-3">
      <Button size="sm" variant={primary ? "primary" : "default"} loading={busy} onClick={() => void approve()}>
        Approve
      </Button>
      <Button size="sm" variant="invisible" onClick={onDeny} disabled={busy}>
        Deny…
      </Button>
    </span>
  );
}

function DenyForm({ conversationId, approval, onCancel }: { readonly conversationId: string; readonly approval: Approval; readonly onCancel: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-[3.25rem]"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void answerApproval(conversationId, approval.id, false, reason).finally(() => setBusy(false));
      }}
    >
      <input
        className="form-control input-sm min-w-0 flex-1"
        value={reason}
        maxLength={1000}
        autoFocus
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why? (optional) For example: don't delete files"
        aria-label="Why you're declining (optional)"
      />
      <Button size="sm" variant="danger" type="submit" loading={busy}>
        Deny
      </Button>
      <Button size="sm" variant="invisible" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
    </form>
  );
}

function SubAgents({ view, subagents, now }: { readonly view: ConversationView; readonly subagents: readonly SubAgent[]; readonly now: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-muted px-3 py-1.5 text-xs">
      <span className="text-fg-muted">Sub-agents</span>
      {subagents.map((subagent) => (
        <span key={subagent.toolCallId} className="inline-flex items-center gap-1" title={[subagent.description, subagent.type ? `type: ${subagent.type}` : "", subagent.detail ?? ""].filter(Boolean).join("\n")}>
          {subagent.status === "running" ? (
            <Spinner size={12} className="text-fg-accent" />
          ) : subagent.status === "failed" ? (
            <XCircleFillIcon size={12} className="text-fg-danger" />
          ) : (
            <CheckCircleFillIcon size={12} className="text-fg-success" />
          )}
          {subagent.id ? <AgentChip view={view} agentId={subagent.id} /> : <span className="font-medium">{subagent.name}</span>}
          <span className="font-mono text-fg-muted tabular-nums">{formatDuration(between(subagent.at, subagent.endedAt, now))}</span>
        </span>
      ))}
    </div>
  );
}

/** What the coordinator and its sub-agents ran in their own sandbox for one message (direct and mixed). */
export function CommandsCard({
  view,
  commands,
  subagents,
  took,
  now,
}: {
  readonly view: ConversationView;
  readonly commands: readonly Command[];
  readonly subagents: readonly SubAgent[];
  /** How long the message took, when no other card shows it. */
  readonly took?: string;
  readonly now: number;
}) {
  const [all, setAll] = useState(false);
  const approvals = new Map(view.approvals.filter((approval) => approval.kind === "command" && approval.decisionId).map((approval) => [approval.decisionId!, approval]));
  const asking = commands.filter((command) => command.status === "asking" && approvals.has(command.id));
  const ran = commands.filter((command) => command.kind === "run" && command.status !== "asking" && command.status !== "denied").length;
  const changed = new Set(commands.filter((command) => (command.kind === "create" || command.kind === "edit") && command.status === "done").map((command) => command.path)).size;
  const failed = commands.filter((command) => command.status === "failed" || (command.exitCode !== undefined && command.exitCode !== 0)).length;
  const hidden = !all && commands.length > SHOWN ? commands.length - SHOWN : 0;
  const shown = hidden ? commands.filter((command, index) => index >= hidden || approvals.has(command.id)) : commands;
  const first = asking[0] ? approvals.get(asking[0].id) : undefined;
  const summary =
    [ran ? plural(ran, "command") : "", changed ? plural(changed, "file changed", "files changed") : "", failed ? `${failed} failed` : "", asking.length ? `${asking.length} asking you` : ""].filter(Boolean).join(" · ") ||
    "nothing run yet";
  return (
    <section aria-label="What it ran in its sandbox" className={cx("overflow-hidden rounded-lg border bg-canvas", asking.length ? "border-line-attention" : "border-line")}>
      <header className={cx("flex min-h-9 items-center gap-2 px-3 py-1 text-xs font-semibold", asking.length ? "bg-attention-muted text-fg-attention" : "bg-canvas-muted text-fg-muted")}>
        {asking.length ? <ShieldIcon size={14} /> : <TerminalIcon size={14} />}
        <span className="truncate">{asking.length ? "Needs your approval" : "What it ran in its sandbox"}</span>
        <span className="ml-auto shrink-0 font-normal tabular-nums">
          {summary}
          {took ? ` · ${took}` : ""}
        </span>
        {first?.messageIndex !== undefined ? (
          <button
            type="button"
            className={cx("btn btn-sm", asking.length > 1 && "btn-primary")}
            onClick={() => void answerApproval(view.id, first.id, true, undefined, true)}
            title={`Approve these and every later command and file change for message #${first.messageIndex}`}
          >
            Approve the rest of #{first.messageIndex}
          </button>
        ) : null}
      </header>
      {subagents.length ? <SubAgents view={view} subagents={subagents} now={now} /> : null}
      {commands.length ? (
        <ul>
          {hidden ? (
            <li>
              <button type="button" className="Link--muted w-full px-3 py-1 text-left text-xs" onClick={() => setAll(true)}>
                Show {plural(hidden, "earlier step", "earlier steps")}
              </button>
            </li>
          ) : null}
          {shown.map((command) => (
            <CommandRow key={command.id} conversationId={view.id} view={view} command={command} approval={approvals.get(command.id)} primary={asking.length === 1} now={now} />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-2 text-sm text-fg-muted">
          <CircleSlashIcon size={14} className="mr-1 inline" />
          Nothing run yet.
        </p>
      )}
      {asking.length ? <footer className="border-t border-line-muted px-3 py-1.5 text-xs text-fg-muted">Each approval covers one command or file change; reading never asks.</footer> : null}
    </section>
  );
}
