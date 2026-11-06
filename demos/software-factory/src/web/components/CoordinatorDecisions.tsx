import {
  CheckCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  CodeReviewIcon,
  CommentIcon,
  CopyIcon,
  FileCodeIcon,
  ListUnorderedIcon,
  PlusIcon,
  ShieldCheckIcon,
  StopIcon,
  SyncIcon,
  ToolsIcon,
  XCircleIcon,
  type Icon,
} from "@primer/octicons-react";
import { useState } from "react";
import type { ActivityItem, DecisionAction, WorkOrder } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { formatClock, formatFullDateTime } from "../lib/format.js";
import { ensureActivity, useActivity } from "../lib/store.js";
import { Button } from "./ui/Button.js";
import { Callout } from "./ui/Feedback.js";
import { Spinner } from "./ui/Spinner.js";

const ICONS: Readonly<Record<DecisionAction, Icon>> = {
  create: PlusIcon,
  prepare: ToolsIcon,
  message: CommentIcon,
  wait: ClockIcon,
  check: CheckCircleIcon,
  review: CodeReviewIcon,
  copy: CopyIcon,
  read: FileCodeIcon,
  list: ListUnorderedIcon,
  stop: StopIcon,
  status: ToolsIcon,
  declined: XCircleIcon,
};

/** Decision text keeps its **names** bold and `code` monospaced, on one line. */
function InlineText({ text }: { readonly text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
        if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={index} className="font-semibold">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={index} className="font-mono">
              {part.slice(1, -1)}
            </code>
          );
        }
        return part;
      })}
    </>
  );
}

function plain(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
}

function isShown(item: ActivityItem): boolean {
  if (item.kind === "error") return true;
  const decision = item.decision;
  if (!decision) return false;
  if (decision.action === "wait" && decision.status === "done") return false;
  if (decision.action === "prepare" && !decision.workers?.includes("release")) return false;
  return true;
}

/** What the coordinator decided, one line each: an icon, the decision, and when (time since the work order started). */
export function CoordinatorDecisions({ workOrder }: { readonly workOrder: WorkOrder }) {
  const { resource } = useActivity(workOrder.id, "coordinator");
  const [all, setAll] = useState(false);
  if (resource?.error) {
    return (
      <Callout
        tone="danger"
        compact
        title="Couldn't load coordinator decisions"
        actions={
          <Button size="sm" onClick={() => ensureActivity(workOrder.id, "coordinator", true)}>
            Retry
          </Button>
        }
      >
        {resource.error.message}
      </Callout>
    );
  }
  if (!resource?.data) {
    return (
      <p role="status" className="flex items-center gap-2 text-fg-muted">
        <Spinner size={16} /> Loading decisions…
      </p>
    );
  }
  const decisions = resource.data.filter(isShown);
  const visible = all ? decisions : decisions.slice(-100);
  const start = Date.parse(workOrder.startedAt ?? workOrder.createdAt);
  return (
    <>
      <section aria-labelledby="decisions-heading">
        <h3 id="decisions-heading" className="flex items-center gap-2 text-sm font-semibold">
          Decisions
          {decisions.length > 0 ? <span className="Counter">{decisions.length}</span> : null}
        </h3>
        {decisions.length > 0 ? (
          <ol className="mt-2 divide-y divide-line-muted rounded-md border border-line" aria-label="Coordinator decisions">
            {decisions.length > visible.length ? (
              <li className="p-1 text-center">
                <Button size="sm" variant="invisible" onClick={() => setAll(true)}>
                  Show {decisions.length - visible.length} earlier
                </Button>
              </li>
            ) : null}
            {visible.map((item) => (
              <DecisionRow key={item.id} item={item} start={start} />
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-xs text-fg-muted">No decisions yet.</p>
        )}
      </section>
      <Guardrails maxReviewRounds={workOrder.maxReviewRounds} />
    </>
  );
}

function DecisionRow({ item, start }: { readonly item: ActivityItem; readonly start: number }) {
  const decision = item.decision;
  const reused = decision?.tag === "reused";
  const created = decision?.tag === "new";
  const failed = decision?.status === "failed" || item.kind === "error";
  const Glyph = failed ? XCircleIcon : reused ? SyncIcon : decision ? ICONS[decision.action] : XCircleIcon;
  const text = item.text ?? "";
  const elapsed = Math.max(0, Date.parse(item.at) - start);
  return (
    <li className="flex items-center gap-2 px-3 py-2 text-xs" title={plain(text)}>
      {decision?.status === "running" ? (
        <Spinner size={16} className="shrink-0 text-fg-accent" />
      ) : (
        <Glyph
          size={16}
          className={cx("shrink-0", failed ? "text-fg-danger" : created ? "text-fg-success" : reused ? "text-fg-accent" : "text-fg-muted")}
        />
      )}
      <span className="min-w-0 flex-1 truncate">
        <InlineText text={text} />
      </span>
      {failed ? <span className="sr-only">Not completed.</span> : null}
      <time dateTime={item.at} title={formatFullDateTime(item.at)} className="shrink-0 font-mono text-fg-muted tabular-nums">
        {formatClock(elapsed)}
      </time>
    </li>
  );
}

/** The gates the factory keeps however the coordinator decides. */
function Guardrails({ maxReviewRounds }: { readonly maxReviewRounds: number }) {
  const rules = [
    "Plans are validated before any work starts",
    "Builds pass only on a fresh, passing test report",
    `Reviews run on a second model, up to ${maxReviewRounds} ${maxReviewRounds === 1 ? "round" : "rounds"}`,
    "Release inputs are verified against accepted builds",
  ];
  return (
    <details className="group">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-semibold select-none [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon size={16} className="text-fg-muted transition-transform duration-100 group-open:rotate-90" />
        <ShieldCheckIcon size={16} className="text-fg-success" />
        Guardrails
        <span className="Counter">{rules.length}</span>
      </summary>
      <ul className="mt-2 space-y-1.5 pl-6 text-xs">
        {rules.map((rule) => (
          <li key={rule} className="flex items-start gap-2">
            <CheckIcon size={16} className="shrink-0 text-fg-success" />
            <span>{rule}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
