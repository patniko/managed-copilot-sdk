import {
  BookIcon,
  ChevronRightIcon,
  CodeReviewIcon,
  CopilotIcon,
  DotFillIcon,
  PackageIcon,
  PulseIcon,
  StopIcon,
  XCircleFillIcon,
} from "@primer/octicons-react";
import { memo, useState, type ReactNode } from "react";
import type { ActivityItem, Station, StationRole, ToolActivity, WorkOrder } from "../../shared/types.js";
import { parseSummaryMarker, toolIcon } from "../lib/activity.js";
import { cx } from "../lib/cx.js";
import { formatDuration, formatFullDateTime, formatTimeOfDay, pluralize } from "../lib/format.js";
import { workOrderHref } from "../lib/router.js";
import { ROLE_LABELS } from "../lib/stations.js";
import { ensureActivity, useActivity } from "../lib/store.js";
import { ChecksSummary, testChipLabel } from "./TestBar.js";
import { Button } from "./ui/Button.js";
import { Chip } from "./ui/Chip.js";
import { Callout, EmptyState, InlineCode } from "./ui/Feedback.js";
import { Spinner } from "./ui/Spinner.js";
import { MarkdownView } from "./viewers/MarkdownView.js";

const RENDER_LIMIT = 300;

type Level = NonNullable<ActivityItem["level"]>;

const LEVEL_ICON: Readonly<Record<Level, string>> = {
  info: "text-fg-muted",
  success: "text-fg-success",
  warning: "text-fg-attention",
  error: "text-fg-danger",
};

/** A station's activity like a Copilot agent session log: steps that expand to their output, and agent comments. */
export function ActivityStream({ workOrder, station }: { readonly workOrder: WorkOrder; readonly station: Station }) {
  const { resource, drafts } = useActivity(workOrder.id, station.id);
  const [showAll, setShowAll] = useState(false);
  const items = resource?.data;

  if (!items) {
    if (resource?.error) {
      return (
        <Callout
          tone="danger"
          compact
          title="Couldn't load this station's activity"
          actions={
            <Button size="sm" onClick={() => ensureActivity(workOrder.id, station.id, true)}>
              Retry
            </Button>
          }
        >
          {resource.error.message}
        </Callout>
      );
    }
    return <ActivitySkeleton />;
  }

  if (items.length === 0 && drafts.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-line">
        <EmptyState icon={PulseIcon} title="No activity yet" size="sm">
          {station.status === "waiting"
            ? "This station starts when the work before it is done."
            : "Messages, tool calls, and test runs stream in here as the agent works."}
        </EmptyState>
      </div>
    );
  }

  const hidden = showAll ? 0 : Math.max(0, items.length - RENDER_LIMIT);
  const visible = hidden > 0 ? items.slice(hidden) : items;
  return (
    <ol className="space-y-0.5" aria-label={`${station.title} activity`}>
      {hidden > 0 ? (
        <li className="pb-1 text-center">
          <Button size="sm" variant="invisible" onClick={() => setShowAll(true)}>
            Show {hidden.toLocaleString()} earlier {hidden === 1 ? "item" : "items"}
          </Button>
        </li>
      ) : null}
      {visible.map((item) => (
        <li key={item.id}>
          <ActivityRow item={item} agent={station.agent} role={station.role} workOrderId={workOrder.id} />
        </li>
      ))}
      {drafts.map((draft) => (
        <li key={`draft:${draft.messageId}`}>
          <MessageCard text={draft.text} agent={station.agent} role={station.role} streaming />
        </li>
      ))}
      {resource?.error ? (
        <li className="pt-1 text-center text-xs text-fg-danger">Couldn't refresh activity: {resource.error.message}</li>
      ) : null}
    </ol>
  );
}

function ActivitySkeleton() {
  return (
    <div className="space-y-3 px-2" aria-label="Loading activity" role="status">
      {[72, 48, 90, 64, 56].map((width, index) => (
        <div key={index} className="flex items-center gap-2">
          <div className="SkeletonBox size-4 shrink-0 rounded-full" />
          <div className="SkeletonText my-0" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  );
}

function Time({ at }: { readonly at?: string }) {
  if (!at) return null;
  return (
    <time dateTime={at} title={formatFullDateTime(at)} className="shrink-0 font-mono text-xs leading-5 text-fg-muted tabular-nums">
      {formatTimeOfDay(at)}
    </time>
  );
}

/** One line of the log: a leading 16px icon, the text, and the time on the right. */
function LogLine({ icon, children, at, className }: { readonly icon: ReactNode; readonly children: ReactNode; readonly at?: string; readonly className?: string }) {
  return (
    <div className={cx("flex items-start gap-2 rounded-md px-2 py-1", className)}>
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
      <Time at={at} />
    </div>
  );
}

interface RowProps {
  readonly item: ActivityItem;
  readonly agent: string;
  readonly role: StationRole;
  readonly workOrderId: string;
}

const ActivityRow = memo(function ActivityRow({ item, agent, role, workOrderId }: RowProps) {
  switch (item.kind) {
    case "message":
      return <MessageCard text={item.text ?? ""} at={item.at} agent={item.subagent ?? agent} role={role} />;
    case "intent":
      return (
        <LogLine icon={<CopilotIcon size={16} className="text-fg-muted" />} at={item.at}>
          <p className="text-fg-muted">{item.text}</p>
        </LogLine>
      );
    case "tool":
      return item.tool ? <ToolRow item={item} tool={item.tool} /> : <StatusRow item={item} />;
    case "test":
      return <TestRunRow item={item} />;
    case "skill":
      return (
        <LogLine icon={<BookIcon size={16} className="text-fg-muted" />} at={item.at}>
          <p className="truncate text-fg-muted">
            {item.text && /^using skill/i.test(item.text) ? (
              <InlineCode text={item.text} />
            ) : (
              <>
                Using skill <code className="inline-code">{item.text ?? item.tool?.name ?? "skill"}</code>
              </>
            )}
          </p>
        </LogLine>
      );
    case "review":
      return <ReviewRow item={item} />;
    case "artifact":
      return (
        <LogLine icon={<PackageIcon size={16} className="text-fg-muted" />} at={item.at}>
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="min-w-0 truncate">{item.text ?? "Published artifacts"}</span>
            <a href={workOrderHref(workOrderId, "artifacts", { station: item.stationId })} className="Link shrink-0 text-xs">
              View artifacts
            </a>
          </p>
        </LogLine>
      );
    case "error":
      return (
        <div className="flash flash-error flash-sm my-1" role="alert">
          <StopIcon size={16} />
          <div className="flash-content">
            <InlineCode text={item.text ?? "Something went wrong."} />
          </div>
          <Time at={item.at} />
        </div>
      );
    default:
      return <StatusRow item={item} />;
  }
});

function StatusRow({ item }: { readonly item: ActivityItem }) {
  const level = item.level ?? "info";
  return (
    <LogLine icon={<DotFillIcon size={16} className={LEVEL_ICON[level]} />} at={item.at}>
      <p className={cx("text-xs leading-5", level === "info" ? "text-fg-muted" : "text-fg")}>
        <InlineCode text={item.text ?? ""} />
      </p>
    </LogLine>
  );
}

/** An agent message as a timeline comment from Copilot. */
function MessageCard({
  text,
  at,
  agent,
  role,
  streaming = false,
}: {
  readonly text: string;
  readonly at?: string;
  readonly agent: string;
  readonly role: StationRole;
  readonly streaming?: boolean;
}) {
  return (
    <article className="flex gap-3 py-2">
      <span className="avatar avatar--square grid size-8 shrink-0 place-items-center text-fg" aria-hidden>
        <CopilotIcon size={16} />
      </span>
      <div className="timeline-comment timeline-comment--caret min-w-0 flex-1 before:top-2 after:top-2">
        <header className="timeline-comment-header min-h-8 gap-1.5 py-1 pr-2 pl-3">
          <span className="truncate font-semibold text-fg">@{agent}</span>
          <span className="Label Label--secondary">{ROLE_LABELS[role] ?? role}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {streaming ? (
              <span className="inline-flex items-center gap-1 text-xs text-fg-accent">
                <Spinner size={12} />
                Writing…
              </span>
            ) : null}
            <Time at={at} />
          </span>
        </header>
        <div className="px-3 py-2">
          <MarkdownView source={text} streaming={streaming} />
        </div>
      </div>
    </article>
  );
}

/** A tool call as a collapsible step, like a GitHub Actions log step; expanded, it shows its output with line numbers. */
function ToolRow({ item, tool }: { readonly item: ActivityItem; readonly tool: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const Glyph = toolIcon(tool.name);
  const hasOutput = Boolean(tool.output);
  const marker = tool.status !== "running" ? parseSummaryMarker(tool.output) : undefined;
  const markerChip = marker ? testChipLabel(marker) : undefined;
  const exitFailed = tool.exitCode !== undefined && tool.exitCode !== 0;
  const statusText = tool.status === "running" ? "Running" : tool.status === "failed" ? "Failed" : "Succeeded";
  return (
    <div className={cx(item.subagent && "ml-4")}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={!hasOutput}
        aria-expanded={hasOutput ? open : undefined}
        title={`${tool.name}: ${tool.summary}`}
        className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left enabled:hover:bg-control-transparent-hover disabled:cursor-default"
      >
        <span className="flex h-5 w-4 shrink-0 items-center justify-center">
          <ChevronRightIcon
            size={16}
            className={cx("text-fg-muted transition-transform duration-100", open && "rotate-90", !hasOutput && "invisible")}
          />
        </span>
        <span className="flex h-5 w-4 shrink-0 items-center justify-center">
          {tool.status === "running" ? (
            <Spinner size={16} className="text-fg-attention" />
          ) : tool.status === "failed" ? (
            <XCircleFillIcon size={16} className="text-fg-danger" />
          ) : (
            <Glyph size={16} className="text-fg-muted" />
          )}
        </span>
        <span className="sr-only">{statusText}:</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs leading-5">{tool.summary || tool.name}</span>
        {markerChip ? <Chip tone={markerChip.tone === "neutral" ? "plain" : markerChip.tone}>{markerChip.label}</Chip> : null}
        {exitFailed ? (
          <Chip tone="danger" mono>
            exit {tool.exitCode}
          </Chip>
        ) : null}
        {tool.durationMs !== undefined ? (
          <span className="shrink-0 font-mono text-xs leading-5 text-fg-muted tabular-nums">{formatDuration(tool.durationMs)}</span>
        ) : null}
        <Time at={item.at} />
      </button>
      {open && tool.output ? <LogOutput text={tool.output} /> : null}
    </div>
  );
}

/** Terminal output on the inset canvas with muted line numbers, like an Actions log. */
function LogOutput({ text }: { readonly text: string }) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  return (
    <div className="mt-1 mb-2 ml-8 overflow-hidden rounded-md border border-line bg-canvas-inset">
      <pre className="max-h-72 overflow-auto py-2 font-mono text-xs leading-5">
        {lines.map((line, index) => (
          <div key={index} className="flex">
            <span className="w-10 shrink-0 pr-3 text-right text-fg-muted tabular-nums select-none" aria-hidden>
              {index + 1}
            </span>
            <span className="min-w-0 pr-3 break-words whitespace-pre-wrap">{line || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

function TestRunRow({ item }: { readonly item: ActivityItem }) {
  const tests = item.tests;
  if (!tests) return <StatusRow item={item} />;
  return (
    <div className="Box my-2 flex items-start gap-2 px-3 py-2">
      <ChecksSummary
        counts={tests}
        compact
        className="min-w-0 flex-1"
        meta={tests.durationMs !== undefined ? <span className="font-mono">{formatDuration(tests.durationMs)}</span> : undefined}
      />
      <Time at={item.at} />
    </div>
  );
}

function ReviewRow({ item }: { readonly item: ActivityItem }) {
  const review = item.review;
  if (!review) return <StatusRow item={item} />;
  const approved = review.verdict === "approve";
  return (
    <LogLine icon={<CodeReviewIcon size={16} className="text-fg-muted" />} at={item.at}>
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Chip tone={approved ? "success" : "warning"}>{approved ? "Approved" : "Changes requested"}</Chip>
        <span className="min-w-0 truncate text-fg-muted">
          Round {review.round} · {pluralize(review.findings, "finding")}
          {item.text ? ` · ${item.text}` : ""}
        </span>
      </p>
    </LogLine>
  );
}
