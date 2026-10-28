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
import type { Approval, Blueprint, Decision } from "../../shared/types.js";
import { BLUEPRINT_LABELS } from "../../shared/catalog.js";
import { networkSummary, sizeSummary } from "../lib/blueprints.js";
import { cx } from "../lib/cx.js";
import { between, formatDuration, oneLine, plural } from "../lib/format.js";
import { answerApproval } from "../lib/store.js";
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
const Env = ({ children }: { readonly children: ReactNode }) => <span className="font-mono text-xs text-fg-muted">{children}</span>;

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
  const summary = [created > 0 ? plural(created, "new sandbox", "new sandboxes") : asking ? "" : "No new sandboxes", asking ? `${askingCount} asking you` : ""].filter(Boolean).join(", ");
  return (
    <section aria-label="What the agent did" className={cx("overflow-hidden rounded-lg border bg-canvas", asking ? "border-[var(--borderColor-attention-emphasis)]" : "border-line")}>
      <header className={cx("flex items-center gap-2 px-3 py-1.5 text-xs font-semibold", asking ? "bg-attention-muted text-fg-attention" : "bg-canvas-muted text-fg-muted")}>
        <WorkflowIcon size={14} />
        What the agent did
        <span className="ml-auto font-normal tabular-nums">
          {summary} · {took}
        </span>
      </header>
      <ul>
        {decisions.map((decision) => {
          const row = describe(decision, now);
          const Glyph = row.icon;
          return (
            <li key={decision.id} className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 border-t border-line-muted px-3 py-1.5 text-sm first:border-t-0" title={row.title}>
              {row.spin ? <Spinner size={14} className={row.iconClass} /> : <Glyph size={14} className={row.iconClass} />}
              <span className="min-w-0">{row.text}</span>
              {row.tag ?? <span />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Sandboxes the coordinator asked for, waiting for the person's decision. */
export function ApprovalCard({ conversationId, approvals, blueprints, now }: { readonly conversationId: string; readonly approvals: readonly Approval[]; readonly blueprints: readonly Blueprint[]; readonly now: number }) {
  if (approvals.length === 0) return null;
  const oldest = approvals.reduce((first, approval) => (approval.requestedAt < first ? approval.requestedAt : first), approvals[0]!.requestedAt);
  return (
    <section aria-label="Needs your approval" className="overflow-hidden rounded-lg border border-[var(--borderColor-attention-emphasis)] bg-canvas">
      <header className="flex items-center gap-2 bg-attention-muted px-3 py-1.5 text-xs font-semibold text-fg-attention">
        <ShieldIcon size={14} />
        Needs your approval
        <span className="ml-auto font-mono font-normal tabular-nums">{formatDuration(between(oldest, undefined, now))}</span>
        {approvals.length > 1 ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => approvals.forEach((approval) => void answerApproval(conversationId, approval.id, true))}>
            Approve all {approvals.length}
          </button>
        ) : null}
      </header>
      <ul>
        {approvals.map((approval) => (
          <ApprovalRow key={approval.id} conversationId={conversationId} approval={approval} blueprint={blueprints.find((candidate) => candidate.name === approval.environment)} />
        ))}
      </ul>
      <footer className="border-t border-line-muted px-3 py-1.5 text-xs text-fg-muted">Approving a sandbox also covers what its worker does there. Work sent to existing sandboxes never asks.</footer>
    </section>
  );
}

function ApprovalRow({ conversationId, approval, blueprint }: { readonly conversationId: string; readonly approval: Approval; readonly blueprint?: Blueprint }) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const answer = async (approve: boolean): Promise<void> => {
    setBusy(true);
    await answerApproval(conversationId, approval.id, approve, approve ? undefined : reason);
    setBusy(false);
  };
  return (
    <li className="flex flex-col gap-1.5 border-t border-line-muted px-3 py-2 text-sm first:border-t-0">
      <div className="flex items-start gap-2">
        <PlusIcon size={14} className="mt-1 shrink-0 text-fg-success" />
        <div className="min-w-0 flex-1">
          <div>
            Create <Name>{approval.worker}</Name> in <Env>{approval.environment}</Env>
            {blueprint ? (
              <span className="text-fg-muted">
                : {BLUEPRINT_LABELS[blueprint.kind].toLowerCase()}, {sizeSummary(blueprint)}, {networkSummary(blueprint.network, blueprint.kind).toLowerCase()}
              </span>
            ) : null}
          </div>
          {approval.task ? (
            <p className="mt-0.5 line-clamp-3 text-fg-muted" title={approval.task}>
              {approval.task}
            </p>
          ) : null}
        </div>
        {approval.messageIndex !== undefined ? <span className="Label Label--secondary shrink-0">#{approval.messageIndex}</span> : null}
      </div>
      {denying ? (
        <form
          className="flex flex-wrap items-center gap-2 pl-6"
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
            placeholder="Tell the agent why (optional), for example: use the Node environment for this"
            aria-label="Why you're declining (optional)"
          />
          <Button size="sm" variant="danger" type="submit" loading={busy}>
            Deny
          </Button>
          <Button size="sm" variant="invisible" onClick={() => setDenying(false)} disabled={busy}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2 pl-6">
          <Button size="sm" variant="primary" loading={busy} onClick={() => void answer(true)}>
            Approve
          </Button>
          <Button size="sm" onClick={() => setDenying(true)} disabled={busy}>
            Deny…
          </Button>
        </div>
      )}
    </li>
  );
}
