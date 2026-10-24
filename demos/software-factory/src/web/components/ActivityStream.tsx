import {
  Activity,
  BookOpen,
  Check,
  ChevronRight,
  CircleX,
  FlaskConical,
  LoaderCircle,
  Package,
  ScanSearch,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { memo, useState } from "react";
import type { ActivityItem, StationKind, StationRole, ToolActivity, WorkOrder, Station } from "../../shared/types.js";
import { parseSummaryMarker, toolIcon } from "../lib/activity.js";
import { cx } from "../lib/cx.js";
import { formatDuration, formatFullDateTime, formatTimeOfDay, pluralize } from "../lib/format.js";
import { workOrderHref } from "../lib/router.js";
import { KIND_ICONS, ROLE_LABELS } from "../lib/stations.js";
import { ensureActivity, useActivity } from "../lib/store.js";
import { TestBar, testChipLabel } from "./TestBar.js";
import { Button } from "./ui/Button.js";
import { Chip } from "./ui/Chip.js";
import { Callout, EmptyState, InlineCode, Skeleton } from "./ui/Feedback.js";
import { MarkdownView } from "./viewers/MarkdownView.js";

const RENDER_LIMIT = 300;

type Level = NonNullable<ActivityItem["level"]>;

const LEVEL_DOT: Readonly<Record<Level, string>> = {
  info: "bg-zinc-500",
  success: "bg-emerald-400",
  warning: "bg-amber-400",
  error: "bg-rose-400",
};

const LEVEL_TEXT: Readonly<Record<Level, string>> = {
  info: "text-zinc-400",
  success: "text-emerald-300",
  warning: "text-amber-300",
  error: "text-rose-300",
};

export function ActivityStream({ workOrder, station }: { readonly workOrder: WorkOrder; readonly station: Station }) {
  const { resource, drafts } = useActivity(workOrder.id, station.id);
  const [showAll, setShowAll] = useState(false);
  const items = resource?.data;

  if (!items) {
    if (resource?.error) {
      return (
        <Callout
          tone="danger"
          title="Couldn't load this station's activity"
          actions={
            <Button size="xs" onClick={() => ensureActivity(workOrder.id, station.id, true)}>
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
      <EmptyState icon={Activity} title="No activity yet." className="py-10">
        {station.status === "waiting"
          ? "This station starts when the work before it is done."
          : "Messages, tool calls, and test runs stream in here as the agent works."}
      </EmptyState>
    );
  }

  const hidden = showAll ? 0 : Math.max(0, items.length - RENDER_LIMIT);
  const visible = hidden > 0 ? items.slice(hidden) : items;
  return (
    <ol className="space-y-1.5" aria-label={`${station.title} activity`}>
      {hidden > 0 ? (
        <li className="pb-1 text-center">
          <Button size="xs" variant="ghost" onClick={() => setShowAll(true)}>
            Show {hidden.toLocaleString()} earlier {hidden === 1 ? "item" : "items"}
          </Button>
        </li>
      ) : null}
      {visible.map((item) => (
        <li key={item.id}>
          <ActivityRow
            item={item}
            agent={station.agent}
            role={station.role}
            kind={station.kind}
            workOrderId={workOrder.id}
          />
        </li>
      ))}
      {drafts.map((draft) => (
        <li key={`draft:${draft.messageId}`}>
          <MessageCard text={draft.text} agent={station.agent} role={station.role} kind={station.kind} streaming />
        </li>
      ))}
      {resource?.error ? (
        <li className="pt-1 text-center text-[11px] text-rose-300/80">Couldn't refresh activity: {resource.error.message}</li>
      ) : null}
    </ol>
  );
}

function ActivitySkeleton() {
  return (
    <div className="space-y-2.5" aria-label="Loading activity" role="status">
      {[72, 48, 90, 64, 56].map((width, index) => (
        <div key={index} className="flex items-center gap-2.5">
          <Skeleton className="size-4 shrink-0 rounded-full" />
          <div style={{ width: `${width}%` }}>
            <Skeleton className="h-3 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Time({ at }: { readonly at?: string }) {
  if (!at) return null;
  return (
    <time dateTime={at} title={formatFullDateTime(at)} className="shrink-0 pt-px font-mono text-[10.5px] text-zinc-600 tabular">
      {formatTimeOfDay(at)}
    </time>
  );
}

interface RowProps {
  readonly item: ActivityItem;
  readonly agent: string;
  readonly role: StationRole;
  readonly kind: StationKind;
  readonly workOrderId: string;
}

const ActivityRow = memo(function ActivityRow({ item, agent, role, kind, workOrderId }: RowProps) {
  switch (item.kind) {
    case "message":
      return <MessageCard text={item.text ?? ""} at={item.at} agent={item.subagent ?? agent} role={role} kind={kind} />;
    case "intent":
      return (
        <div className="flex items-start gap-2.5 px-1 py-1">
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-violet-300/80" aria-hidden />
          <p className="min-w-0 flex-1 text-[13px] text-zinc-300 italic">{item.text}</p>
          <Time at={item.at} />
        </div>
      );
    case "tool":
      return item.tool ? <ToolRow item={item} tool={item.tool} /> : <StatusRow item={item} />;
    case "test":
      return <TestRunRow item={item} />;
    case "skill":
      return (
        <div className="flex items-center gap-2.5 px-1 py-1 text-[13px]">
          <BookOpen className="size-3.5 shrink-0 text-amber-300/80" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-zinc-400">
            {item.text && /^using skill/i.test(item.text) ? (
              <InlineCode text={item.text} />
            ) : (
              <>
                Using skill <code className="font-mono text-[12px] text-zinc-200">{item.text ?? item.tool?.name ?? "skill"}</code>
              </>
            )}
          </p>
          <Time at={item.at} />
        </div>
      );
    case "review":
      return <ReviewRow item={item} />;
    case "artifact":
      return (
        <div className="flex items-center gap-2.5 rounded-lg bg-zinc-900/60 px-2.5 py-2 text-[13px] ring-1 ring-inset ring-white/5">
          <Package className="size-3.5 shrink-0 text-sky-300/80" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-zinc-300">{item.text ?? "Published artifacts"}</p>
          <a
            href={workOrderHref(workOrderId, "artifacts", { station: item.stationId })}
            className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-amber-300 hover:text-amber-200"
          >
            View artifacts <ChevronRight className="size-3" aria-hidden />
          </a>
          <Time at={item.at} />
        </div>
      );
    case "error":
      return (
        <div className="flex items-start gap-2.5 rounded-lg border border-rose-400/25 bg-rose-400/[0.06] px-2.5 py-2" role="alert">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-rose-300" aria-hidden />
          <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-rose-100">
            <InlineCode text={item.text ?? "Something went wrong."} />
          </p>
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
    <div className="flex items-start gap-2.5 px-1 py-0.5">
      <span className={cx("mt-[7px] ml-[5px] size-1.5 shrink-0 rounded-full", LEVEL_DOT[level])} aria-hidden />
      <p className={cx("min-w-0 flex-1 pl-0.5 text-xs leading-relaxed", level === "info" ? "text-zinc-400" : LEVEL_TEXT[level])}>
        <InlineCode text={item.text ?? ""} />
      </p>
      <Time at={item.at} />
    </div>
  );
}

function MessageCard({
  text,
  at,
  agent,
  role,
  kind,
  streaming = false,
}: {
  readonly text: string;
  readonly at?: string;
  readonly agent: string;
  readonly role: StationRole;
  readonly kind: StationKind;
  readonly streaming?: boolean;
}) {
  const Icon = KIND_ICONS[kind];
  return (
    <article className={cx("my-2 rounded-xl border bg-zinc-900/70 p-3", streaming ? "border-sky-400/25" : "border-zinc-800")}>
      <header className="mb-2 flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-zinc-800 text-zinc-300 ring-1 ring-inset ring-white/10">
          <Icon className="size-3.5" aria-hidden />
        </span>
        <span className="truncate text-xs font-semibold text-zinc-200">@{agent}</span>
        <span className="shrink-0 text-[11px] text-zinc-500">{ROLE_LABELS[role] ?? role}</span>
        <span className="ml-auto flex items-center gap-2">
          {streaming ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-sky-300">
              <LoaderCircle className="size-3 animate-spin" aria-hidden />
              Writing…
            </span>
          ) : null}
          <Time at={at} />
        </span>
      </header>
      <MarkdownView source={text} streaming={streaming} className="text-[13px]" />
    </article>
  );
}

function ToolRow({ item, tool }: { readonly item: ActivityItem; readonly tool: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(tool.name);
  const hasOutput = Boolean(tool.output);
  const marker = tool.status !== "running" ? parseSummaryMarker(tool.output) : undefined;
  const markerChip = marker ? testChipLabel(marker) : undefined;
  const failed = tool.status === "failed" || (tool.exitCode !== undefined && tool.exitCode !== 0);
  return (
    <div
      className={cx(
        "overflow-hidden rounded-lg border bg-zinc-950/50",
        failed ? "border-rose-400/20" : "border-zinc-800/80",
        item.subagent && "ml-4",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={!hasOutput}
        aria-expanded={hasOutput ? open : undefined}
        title={`${tool.name}: ${tool.summary}`}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left enabled:hover:bg-zinc-900/80 disabled:cursor-default"
      >
        <Icon className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-300">{tool.summary || tool.name}</span>
        {markerChip ? <Chip tone={markerChip.tone === "neutral" ? "plain" : markerChip.tone}>{markerChip.label}</Chip> : null}
        {tool.exitCode !== undefined && tool.exitCode !== 0 ? (
          <Chip tone="danger" mono>
            exit {tool.exitCode}
          </Chip>
        ) : null}
        {tool.durationMs !== undefined ? (
          <span className="shrink-0 font-mono text-[10.5px] text-zinc-500 tabular">{formatDuration(tool.durationMs)}</span>
        ) : null}
        {tool.status === "running" ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-sky-300" aria-label="Running" />
        ) : tool.status === "failed" ? (
          <CircleX className="size-3.5 shrink-0 text-rose-400" aria-label="Failed" />
        ) : (
          <Check className="size-3.5 shrink-0 text-emerald-400" aria-label="Succeeded" />
        )}
        <Time at={item.at} />
        {hasOutput ? (
          <ChevronRight className={cx("size-3.5 shrink-0 text-zinc-600 transition-transform", open && "rotate-90")} aria-hidden />
        ) : (
          <span className="w-3.5 shrink-0" aria-hidden />
        )}
      </button>
      {open && tool.output ? (
        <pre className="max-h-72 overflow-auto border-t border-zinc-800/80 bg-black/30 px-3 py-2 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-zinc-300">
          {tool.output}
        </pre>
      ) : null}
    </div>
  );
}

function TestRunRow({ item }: { readonly item: ActivityItem }) {
  const tests = item.tests;
  if (!tests) return <StatusRow item={item} />;
  const ok = tests.failed === 0;
  return (
    <div
      className={cx(
        "my-1.5 rounded-lg border px-3 py-2.5",
        ok ? "border-emerald-400/25 bg-emerald-400/[0.05]" : "border-rose-400/30 bg-rose-400/[0.06]",
      )}
    >
      <div className="flex items-center gap-2">
        <FlaskConical className={cx("size-4 shrink-0", ok ? "text-emerald-300" : "text-rose-300")} aria-hidden />
        <p className="min-w-0 flex-1 truncate text-[13px] text-zinc-400">
          <span className="font-semibold text-zinc-100">Tests</span>
          <span className="mx-1.5 text-zinc-600">·</span>
          <span className="font-medium text-emerald-300">{tests.passed} passed</span>
          <span className="mx-1.5 text-zinc-600">·</span>
          <span className={tests.failed > 0 ? "font-medium text-rose-300" : undefined}>{tests.failed} failed</span>
          {tests.skipped > 0 ? (
            <>
              <span className="mx-1.5 text-zinc-600">·</span>
              {tests.skipped} skipped
            </>
          ) : null}
          {tests.durationMs !== undefined ? (
            <>
              <span className="mx-1.5 text-zinc-600">·</span>
              <span className="font-mono text-[12px]">{formatDuration(tests.durationMs)}</span>
            </>
          ) : null}
        </p>
        <Time at={item.at} />
      </div>
      <TestBar counts={tests} className="mt-2" />
    </div>
  );
}

function ReviewRow({ item }: { readonly item: ActivityItem }) {
  const review = item.review;
  if (!review) return <StatusRow item={item} />;
  const approved = review.verdict === "approve";
  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-zinc-900/60 px-2.5 py-2 ring-1 ring-inset ring-white/5">
      <ScanSearch className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
      <Chip tone={approved ? "success" : "warning"}>{approved ? "Approved" : "Changes requested"}</Chip>
      <p className="min-w-0 flex-1 truncate text-[13px] text-zinc-400">
        Round {review.round} · {pluralize(review.findings, "finding")}
        {item.text ? <span className="text-zinc-500"> · {item.text}</span> : null}
      </p>
      <Time at={item.at} />
    </div>
  );
}
