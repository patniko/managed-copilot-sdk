import { ArrowRightIcon, ContainerIcon, CopilotIcon, CpuIcon, ShieldIcon, ZapIcon } from "@primer/octicons-react";
import type { ApprovalMode, ExecutionStyle, StyleInfo } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { useStore } from "../lib/store.js";
import { APPROVAL_LABELS, STYLE_META, STYLE_ORDER } from "../lib/styles.js";
import { Tooltip } from "./ui/Tooltip.js";

/** The style a new conversation gets: the person's pick if the deployment has it, else the default. */
export function useNewConversationStyle(): ExecutionStyle {
  const styles = useStore((state) => state.styles);
  const defaults = useStore((state) => state.defaults);
  const picked = useStore((state) => state.draft.style);
  if (picked && (styles.length === 0 || styles.some((style) => style.style === picked && style.available))) return picked;
  return defaults.style;
}

/** The execution style switch for a new conversation: which orchestrator environment it is created in. */
export function StyleChoice({
  value,
  onChange,
  styles,
  disabled,
}: {
  readonly value: ExecutionStyle;
  readonly onChange: (style: ExecutionStyle) => void;
  readonly styles: readonly StyleInfo[];
  readonly disabled?: boolean;
}) {
  return (
    <div className="SegmentedControl SegmentedControl--sm" role="group" aria-label="How the agent works">
      {STYLE_ORDER.map((style) => {
        const meta = STYLE_META[style];
        const info = styles.find((candidate) => candidate.style === style);
        const unavailable = info !== undefined && !info.available;
        const Glyph = meta.icon;
        return (
          <Tooltip key={style} content={unavailable ? `Not available: ${info?.reason ?? "this deployment doesn't declare it."}` : meta.caption}>
            <button
              type="button"
              className="SegmentedControl-item"
              aria-current={value === style}
              aria-label={meta.label}
              disabled={disabled || unavailable}
              onClick={() => onChange(style)}
            >
              <Glyph size={14} />
              <span className="max-sm:sr-only">{meta.label}</span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** Ask first or run freely: the same two labels for every style; the tooltip says what each covers in this one. */
export function ApprovalChoice({
  value,
  onChange,
  style,
  disabled,
}: {
  readonly value: ApprovalMode;
  readonly onChange: (mode: ApprovalMode) => void;
  readonly style: ExecutionStyle;
  readonly disabled?: boolean;
}) {
  const meaning = STYLE_META[style].approvals;
  const item = (mode: ApprovalMode) => {
    const Glyph = mode === "ask" ? ShieldIcon : ZapIcon;
    return (
      <Tooltip content={meaning[mode]}>
        <button type="button" className="SegmentedControl-item" aria-current={value === mode} aria-label={`${APPROVAL_LABELS[mode]}: ${meaning[mode]}`} disabled={disabled} onClick={() => onChange(mode)}>
          <Glyph size={14} className={mode === "auto" && value === "auto" ? "text-fg-attention" : undefined} />
          <span className="max-sm:sr-only">{APPROVAL_LABELS[mode]}</span>
        </button>
      </Tooltip>
    );
  };
  return (
    <div className="SegmentedControl SegmentedControl--sm" role="group" aria-label="Approvals">
      {item("ask")}
      {item("auto")}
    </div>
  );
}

const DIAGRAM_LABEL: Readonly<Record<ExecutionStyle, string>> = {
  delegate: "The coordinator sends each part to a worker agent in a sandbox of its own.",
  direct: "The coordinator and its sub-agents run commands in one sandbox with no agent in it.",
  mixed: "The coordinator works in its own sandbox and starts worker agents in sandboxes of their own.",
};

/** The coordinator: an agent on the shared runtime (its brain). */
function Brain({ subagents = 0 }: { readonly subagents?: number }) {
  return (
    <span className="flex items-center">
      <span className="grid size-7 place-items-center rounded-full border border-line-accent-muted bg-accent-muted text-fg-accent" title="The coordinator, on the shared runtime">
        <CopilotIcon size={16} />
      </span>
      {Array.from({ length: subagents }, (_, index) => (
        <span key={index} className="-ml-1.5 grid size-5 place-items-center rounded-full border border-line-accent-muted bg-accent-muted text-fg-accent ring-2 ring-canvas" title="A sub-agent">
          <CopilotIcon size={10} />
        </span>
      ))}
    </span>
  );
}

/** A sandbox: a worker agent's own (`agent`), or the coordinator's hands, with no agent in it. */
function Box({ agent = false }: { readonly agent?: boolean }) {
  return (
    <span
      className={cx(
        "relative grid size-7 place-items-center rounded-md border",
        agent ? "border-line bg-canvas-muted text-fg-muted" : "border-dashed border-line-accent bg-accent-muted text-fg-accent",
      )}
      title={agent ? "A worker agent in its own sandbox" : "Its own sandbox: no agent inside, its commands run here"}
    >
      <ContainerIcon size={14} />
      {agent ? (
        <span className="absolute -right-1.5 -bottom-1.5 grid size-4 place-items-center rounded-full bg-done-emphasis text-fg-on-emphasis ring-2 ring-canvas">
          <CopilotIcon size={10} />
        </span>
      ) : null}
    </span>
  );
}

/** One line that shows a style: the coordinator, an arrow, and the sandboxes it works through, with a caption (below it, `stacked`). */
export function StyleDiagram({ style, className, stacked = false }: { readonly style: ExecutionStyle; readonly className?: string; readonly stacked?: boolean }) {
  return (
    <div className={cx("flex min-w-0", stacked ? "flex-col items-start gap-2" : "items-center gap-3", className)} aria-live="polite">
      <span role="img" aria-label={DIAGRAM_LABEL[style]} className="flex shrink-0 items-center gap-2">
        <Brain subagents={style === "direct" ? 2 : 0} />
        <ArrowRightIcon size={16} className="text-fg-muted" />
        <span className="flex items-center gap-2.5">
          {style === "delegate" ? (
            <>
              <Box agent />
              <Box agent />
              <Box agent />
            </>
          ) : style === "direct" ? (
            <Box />
          ) : (
            <>
              <Box />
              <Box agent />
              <Box agent />
            </>
          )}
        </span>
      </span>
      <span className="min-w-0 text-sm text-fg-muted">{STYLE_META[style].caption}</span>
    </div>
  );
}

/** Where the coordinator's brain runs, for popovers: always the shared runtime. */
export function SharedRuntime() {
  return (
    <span className="inline-flex items-center gap-1">
      <CpuIcon size={14} className="text-fg-muted" />
      Shared runtime
    </span>
  );
}
