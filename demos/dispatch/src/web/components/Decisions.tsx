import {
  CircleSlashIcon,
  CommentIcon,
  FileIcon,
  FileMovedIcon,
  HourglassIcon,
  ListUnorderedIcon,
  PlusIcon,
  ShieldIcon,
  TrashIcon,
  WorkflowIcon,
  XCircleIcon,
  type Icon,
} from "@primer/octicons-react";
import { useState, type ReactNode } from "react";
import type { Approval, Decision } from "../../shared/types.js";
import { BLUEPRINT_LABELS, blueprintKind } from "../../shared/catalog.js";
import { retriedSteps } from "../lib/conversation.js";
import { cx } from "../lib/cx.js";
import { between, formatDuration, oneLine, plural } from "../lib/format.js";
import { answerApproval } from "../lib/store.js";
import { BlueprintIcon } from "./BlueprintIcon.js";
import { Button } from "./ui/Button.js";
import { Spinner } from "./ui/Spinner.js";

type TagTone = "new" | "reused" | "asking" | "muted" | "danger";

const TAG: Readonly<Record<TagTone, string>> = {
  new: "Label Label--success",
  reused: "Label Label--accent",
  asking: "Label Label--attention",
  muted: "Label Label--secondary",
  danger: "Label Label--danger",
};

function Tag({ tone, children }: { readonly tone: TagTone; readonly children: ReactNode }) {
  return <span className={cx(TAG[tone], "shrink-0")}>{children}</span>;
}

const Name = ({ children }: { readonly children: ReactNode }) => <strong className="font-semibold">{children}</strong>;

/** A blueprint as its glyph and short name; the environment's name is in the tooltip. */
function Env({ children: name }: { readonly children?: string }) {
  if (!name) return null;
  const kind = blueprintKind(name);
  return (
    <span className="ml-0.5 inline-flex items-center gap-1 align-[-2px] text-xs text-fg-muted" title={name}>
      <BlueprintIcon kind={kind} size={12} />
      {BLUEPRINT_LABELS[kind]}
    </span>
  );
}

interface RowParts {
  readonly icon: Icon;
  readonly iconClass: string;
  readonly spin?: boolean;
  readonly text: ReactNode;
  readonly tag?: ReactNode;
  readonly title?: string;
}

function describe(decision: Decision, now: number): RowParts {
  const worker = decision.worker ?? "a worker";
  const failed = decision.status === "failed";
  const running = decision.status === "running";
  const detail = decision.detail ? `: ${decision.detail}` : "";
  switch (decision.kind) {
    case "create":
      if (decision.status === "asking")
        return { icon: ShieldIcon, iconClass: "text-fg-attention", text: <>Asked to create <Name>{worker}</Name> <Env>{decision.environment}</Env></>, tag: <Tag tone="asking">asking you</Tag>, ...(decision.task ? { title: decision.task } : {}) };
      if (decision.status === "denied") {
        const reason = /declined this sandbox: (.+)$/.exec(decision.detail ?? "")?.[1];
        return {
          icon: CircleSlashIcon,
          iconClass: "text-fg-muted",
          text: (
            <>
              Didn't create <Name>{worker}</Name> <Env>{decision.environment}</Env>: you declined{reason ? <span className="text-fg-muted"> ({reason})</span> : null}
            </>
          ),
          tag: <Tag tone="muted">declined</Tag>,
          ...(reason ? { title: `You declined: ${reason}` } : {}),
        };
      }
      if (failed) return { icon: XCircleIcon, iconClass: "text-fg-danger", text: <>Couldn't create <Name>{worker}</Name>{detail}</>, tag: <Tag tone="danger">failed</Tag> };
      return {
        icon: PlusIcon,
        iconClass: "text-fg-success",
        spin: running,
        text: <>{running ? "Creating" : "Created"} <Name>{worker}</Name> <Env>{decision.environment}</Env></>,
        tag: <Tag tone="new">new</Tag>,
        ...(decision.task ? { title: decision.task } : {}),
      };
    case "message":
      if (failed) return { icon: XCircleIcon, iconClass: "text-fg-danger", text: <>Couldn't send work to <Name>{worker}</Name>{detail}</>, tag: <Tag tone="danger">failed</Tag> };
      return { icon: CommentIcon, iconClass: "text-fg-accent", text: <>Sent the follow-up to <Name>{worker}</Name></>, tag: <Tag tone="reused">reused</Tag>, ...(decision.task ? { title: decision.task } : {}) };
    case "copy": {
      const what = decision.paths?.length ? decision.paths.join(", ") : "files";
      // A mixed coordinator calls its own sandbox `self`.
      const from = decision.from === "self" ? "its own sandbox" : decision.from;
      const to = decision.to === "self" ? "its own sandbox" : decision.to;
      if (failed) return { icon: XCircleIcon, iconClass: "text-fg-danger", text: <>Couldn't copy {what}{detail}</>, tag: <Tag tone="danger">failed</Tag> };
      return {
        icon: FileMovedIcon,
        iconClass: "text-fg-done",
        spin: running,
        text: (
          <>
            Copied <span className="font-mono text-xs">{oneLine(what, 60)}</span> from <Name>{from}</Name> to <Name>{to}</Name>
          </>
        ),
      };
    }
    case "stop":
      if (failed) return { icon: XCircleIcon, iconClass: "text-fg-danger", text: <>Couldn't stop <Name>{worker}</Name>{detail}</>, tag: <Tag tone="danger">failed</Tag> };
      return { icon: TrashIcon, iconClass: "text-fg-danger", spin: running, text: <>Stopped <Name>{worker}</Name>; its sandbox is deleted</>, tag: <Tag tone="muted">done with it</Tag> };
    case "wait": {
      const names = decision.workers?.length ? decision.workers : undefined;
      const took = formatDuration(between(decision.at, decision.endedAt, now));
      return {
        icon: HourglassIcon,
        iconClass: "text-fg-muted",
        spin: running,
        text: (
          <>
            {running ? "Waiting for" : "Waited for"}{" "}
            {names ? (
              names.map((name, index) => (
                <span key={name}>
                  {index > 0 ? ", " : ""}
                  <Name>{name}</Name>
                </span>
              ))
            ) : (
              "its workers"
            )}
          </>
        ),
        tag: <span className="shrink-0 font-mono text-xs text-fg-muted" title="The coordinator uses no model time while it waits">{took}</span>,
      };
    }
    case "read":
      return { icon: FileIcon, iconClass: "text-fg-muted", spin: running, text: <>Read <span className="font-mono text-xs">{decision.path}</span> from <Name>{decision.worker === "self" ? "its own sandbox" : worker}</Name></> };
    case "list":
      return { icon: ListUnorderedIcon, iconClass: "text-fg-muted", spin: running, text: <>Checked on its workers</> };
  }
}

export function DecisionCard({ decisions, took, now }: { readonly decisions: readonly Decision[]; readonly took: string; readonly now: number }) {
  const created = decisions.filter((decision) => decision.kind === "create" && (decision.status === "done" || decision.status === "running")).length;
  const askingCount = decisions.filter((decision) => decision.status === "asking").length;
  const asking = askingCount > 0;
  const retried = retriedSteps(decisions);
  const summary = [created > 0 ? plural(created, "new sandbox", "new sandboxes") : asking ? "" : "No new sandboxes", asking ? `${askingCount} asking you` : ""].filter(Boolean).join(", ");
  return (
    <section aria-label="What the agent did" className={cx("overflow-hidden rounded-lg border bg-canvas", asking ? "border-line-attention" : "border-line")}>
      <header className={cx("flex items-center gap-2 px-3 py-1.5 text-xs font-semibold", asking ? "bg-attention-muted text-fg-attention" : "bg-canvas-muted text-fg-muted")}>
        <WorkflowIcon size={14} />
        What the agent did
        <span className="ml-auto font-normal tabular-nums">
          {summary} · {took}
        </span>
      </header>
      <ul>
        {decisions.map((decision) => {
          const redone = retried.has(decision.id);
          // A failure the coordinator fixed by trying again reads as a note, not an alarm.
          const row = redone
            ? { ...describe(decision, now), iconClass: "text-fg-muted", tag: <Tag tone="muted">retried</Tag>, title: decision.detail ? `Retried after: ${decision.detail}` : "Retried" }
            : describe(decision, now);
          const Glyph = row.icon;
          return (
            <li
              key={decision.id}
              className={cx("grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 border-t border-line-muted px-3 py-1.5 text-sm first:border-t-0", redone && "text-fg-muted")}
              title={row.title}
            >
              {row.spin ? <Spinner size={14} className={row.iconClass} /> : <Glyph size={14} className={row.iconClass} />}
              <span className="min-w-0 truncate">{row.text}</span>
              {row.tag ?? <span />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Sandboxes the coordinator asked for, waiting for the person's decision. */
export function ApprovalCard({ conversationId, approvals, now }: { readonly conversationId: string; readonly approvals: readonly Approval[]; readonly now: number }) {
  if (approvals.length === 0) return null;
  const oldest = approvals.reduce((first, approval) => (approval.requestedAt < first ? approval.requestedAt : first), approvals[0]!.requestedAt);
  const many = approvals.length > 1;
  return (
    <section aria-label="Needs your approval" className="overflow-hidden rounded-lg border border-line-attention bg-canvas">
      <header className="flex min-h-9 items-center gap-2 bg-attention-muted px-3 py-1 text-xs font-semibold text-fg-attention">
        <ShieldIcon size={14} />
        Needs your approval
        <span className="ml-auto font-mono font-normal tabular-nums">{formatDuration(between(oldest, undefined, now))}</span>
        {many ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => approvals.forEach((approval) => void answerApproval(conversationId, approval.id, true))}>
            Approve all {approvals.length}
          </button>
        ) : null}
      </header>
      <ul>
        {approvals.map((approval) => (
          <ApprovalRow key={approval.id} conversationId={conversationId} approval={approval} primary={!many} />
        ))}
      </ul>
      <footer className="border-t border-line-muted px-3 py-1.5 text-xs text-fg-muted">Approving a sandbox also covers what its worker does there.</footer>
    </section>
  );
}

function ApprovalRow({ conversationId, approval, primary }: { readonly conversationId: string; readonly approval: Approval; readonly primary: boolean }) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const answer = async (approve: boolean): Promise<void> => {
    setBusy(true);
    await answerApproval(conversationId, approval.id, approve, approve ? undefined : reason);
    setBusy(false);
  };
  return (
    <li className="flex flex-col gap-1 border-t border-line-muted px-3 py-2 text-sm first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <PlusIcon size={14} className="shrink-0 text-fg-success" />
        <span className="min-w-0 flex-1 truncate">
          Create <Name>{approval.worker}</Name> <Env>{approval.environment}</Env>
        </span>
        {approval.messageIndex !== undefined ? <span className="Label Label--secondary shrink-0 tabular-nums">#{approval.messageIndex}</span> : null}
        {denying ? null : (
          <span className="flex shrink-0 gap-1.5">
            <Button size="sm" variant={primary ? "primary" : "default"} loading={busy} onClick={() => void answer(true)}>
              Approve
            </Button>
            <Button size="sm" onClick={() => setDenying(true)} disabled={busy}>
              Deny…
            </Button>
          </span>
        )}
      </div>
      {approval.task ? (
        <p className="truncate pl-[22px] text-fg-muted" title={approval.task}>
          {approval.task}
        </p>
      ) : null}
      {denying ? (
        <form
          className="flex flex-wrap items-center gap-2 pl-[22px]"
          onSubmit={(event) => {
            event.preventDefault();
            void answer(false);
          }}
        >
          <input
            className="form-control input-sm min-w-0 flex-1"
            value={reason}
            maxLength={1000}
            autoFocus
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why? (optional) For example: use the Node workshop"
            aria-label="Why you're declining (optional)"
          />
          <Button size="sm" variant="danger" type="submit" loading={busy}>
            Deny
          </Button>
          <Button size="sm" variant="invisible" onClick={() => setDenying(false)} disabled={busy}>
            Cancel
          </Button>
        </form>
      ) : null}
    </li>
  );
}
