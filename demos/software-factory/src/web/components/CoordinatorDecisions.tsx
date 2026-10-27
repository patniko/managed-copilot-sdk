import { CheckCircleFillIcon, ClockIcon, CodeReviewIcon, CommentIcon, CopyIcon, FileCodeIcon, PlusIcon, StopIcon, ToolsIcon, XCircleIcon, type Icon } from "@primer/octicons-react";
import { useState } from "react";
import type { DecisionAction, WorkOrder } from "../../shared/types.js";
import { formatClock, formatFullDateTime } from "../lib/format.js";
import { ensureActivity, useActivity } from "../lib/store.js";
import { Button } from "./ui/Button.js";
import { Chip } from "./ui/Chip.js";
import { Callout } from "./ui/Feedback.js";
import { Spinner } from "./ui/Spinner.js";
import { MarkdownView } from "./viewers/MarkdownView.js";

const ICONS: Readonly<Record<DecisionAction, Icon>> = {
  create: PlusIcon, prepare: ToolsIcon, message: CommentIcon, wait: ClockIcon, check: CheckCircleFillIcon,
  review: CodeReviewIcon, copy: CopyIcon, read: FileCodeIcon, list: ToolsIcon, stop: StopIcon, status: ToolsIcon, declined: XCircleIcon,
};

export function CoordinatorDecisions({ workOrder }: { readonly workOrder: WorkOrder }) {
  const { resource } = useActivity(workOrder.id, "coordinator");
  const [all, setAll] = useState(false);
  if (resource?.error) return (
    <Callout tone="danger" compact title="Couldn't load coordinator decisions" actions={<Button size="sm" onClick={() => ensureActivity(workOrder.id, "coordinator", true)}>Retry</Button>}>
      {resource.error.message}
    </Callout>
  );
  if (!resource?.data) return <p role="status" className="flex items-center gap-2 text-fg-muted"><Spinner size={16} /> Loading decisions…</p>;
  const decisions = resource.data.filter((item) => item.decision || item.kind === "error");
  const visible = all ? decisions : decisions.slice(-100);
  return (
    <>
      {decisions.length ? (
        <ol className="Box divide-y divide-line-muted" aria-label="Coordinator decisions">
          {decisions.length > visible.length ? (
            <li className="p-2 text-center"><Button size="sm" variant="invisible" onClick={() => setAll(true)}>Show {decisions.length - visible.length} earlier decisions</Button></li>
          ) : null}
          {visible.map((item) => {
            const decision = item.decision;
            const Glyph = decision ? ICONS[decision.action] : XCircleIcon;
            const failed = decision?.status === "failed" || item.kind === "error";
            const elapsed = Math.max(0, Date.parse(item.at) - Date.parse(workOrder.startedAt ?? workOrder.createdAt));
            return (
              <li key={item.id} className="flex items-start gap-2 px-3 py-2.5">
                <time dateTime={item.at} title={formatFullDateTime(item.at)} className="mt-0.5 w-10 shrink-0 font-mono text-[11px] text-fg-muted">{formatClock(elapsed)}</time>
                {decision?.status === "running" ? <Spinner size={14} className="mt-1 shrink-0 text-fg-accent" /> : <Glyph size={14} className={`mt-1 shrink-0 ${failed ? "text-fg-attention" : decision?.tag === "new" ? "text-fg-success" : "text-fg-muted"}`} />}
                <div className="min-w-0 flex-1 text-xs">
                  <MarkdownView source={item.text ?? ""} className="[&_p]:mb-0 [&_p]:text-xs" />
                  {decision?.tag ? <span className="mt-1 inline-flex"><Chip tone={decision.tag === "new" ? "success" : "accent"}>{decision.tag}</Chip></span> : null}
                  {failed ? <span className="mt-1 block text-fg-attention">Not completed</span> : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="rounded-md border border-dashed border-line p-4 text-xs text-fg-muted">Decisions appear here as the coordinator creates workers, sends instructions, and asks the factory to check their work.</p>
      )}
      <section className="mt-5" aria-label="Factory quality gates">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">The factory still decides</h3>
        <ul className="mt-2 space-y-2 text-xs">
          {[
            "The plan is validated by submit_plan",
            "A build passes only on a fresh, passing test report",
            `Reviews run on a second model, up to ${workOrder.maxReviewRounds} rounds`,
            "Copied release inputs are verified against accepted outputs",
            "Classic mode stays available for comparison",
          ].map((text) => <li key={text} className="flex items-start gap-2"><CheckCircleFillIcon size={14} className="mt-0.5 shrink-0 text-fg-success" /><span>{text}</span></li>)}
        </ul>
      </section>
    </>
  );
}
