import { BroadcastIcon, ClockIcon, ContainerIcon, GraphIcon, type Icon, InfoIcon, ShieldCheckIcon, ShieldIcon, TerminalIcon, VersionsIcon, ZapIcon } from "@primer/octicons-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { BLUEPRINT_LABELS } from "../../shared/catalog.js";
import type { ApprovalMode, Blueprint, ExecutionStyle, StyleInfo, Template } from "../../shared/types.js";
import { errorMessage } from "../lib/api.js";
import { KIND_ICON, KIND_LANE, networkSummary, sizeSummary } from "../lib/blueprints.js";
import { conversationHref, navigate } from "../lib/router.js";
import { createConversation, setDraft, useStore } from "../lib/store.js";
import { STYLE_META, STYLE_ORDER } from "../lib/styles.js";
import { Composer, type ComposerHandle } from "./Composer.js";
import { Callout } from "./ui/Feedback.js";

export function ApprovalChoice({
  value,
  onChange,
  disabled,
  style = "delegate",
}: {
  readonly value: ApprovalMode;
  readonly onChange: (mode: ApprovalMode) => void;
  readonly disabled?: boolean;
  readonly style?: ExecutionStyle;
}) {
  const labels = STYLE_META[style].approvals;
  return (
    <div className="SegmentedControl SegmentedControl--sm" role="group" aria-label="Approvals">
      <button type="button" className="SegmentedControl-item" aria-current={value === "ask"} disabled={disabled} onClick={() => onChange("ask")} title={labels.ask.title}>
        <ShieldIcon size={14} />
        {labels.ask.label}
      </button>
      <button type="button" className="SegmentedControl-item" aria-current={value === "auto"} disabled={disabled} onClick={() => onChange("auto")} title={labels.auto.title}>
        <ZapIcon size={14} />
        {labels.auto.label}
      </button>
    </div>
  );
}

/**
 * The execution style switch: which orchestrator environment a new conversation is created in. A conversation keeps
 * its style; `current` marks the open conversation's.
 */
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
    <div className="SegmentedControl SegmentedControl--sm" role="group" aria-label="How the agent works (new conversations)">
      {STYLE_ORDER.map((style) => {
        const meta = STYLE_META[style];
        const info = styles.find((candidate) => candidate.style === style);
        const unavailable = info !== undefined && !info.available;
        const Glyph = meta.icon;
        return (
          <button
            key={style}
            type="button"
            className="SegmentedControl-item"
            aria-current={value === style}
            disabled={disabled || unavailable}
            onClick={() => onChange(style)}
            title={unavailable ? `Not available: ${info?.reason ?? "this deployment doesn't declare it."}` : `${meta.summary}${info ? ` (${info.environment})` : ""}`}
          >
            <Glyph size={14} />
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}

/** The style a new conversation gets: the person's pick if the deployment has it, else the default. */
export function useNewConversationStyle(): ExecutionStyle {
  const styles = useStore((state) => state.styles);
  const defaults = useStore((state) => state.defaults);
  const picked = useStore((state) => state.draft.style);
  if (picked && (styles.length === 0 || styles.some((style) => style.style === picked && style.available))) return picked;
  return defaults.style;
}

export function Home() {
  const platform = useStore((state) => state.platform);
  const blueprints = useStore((state) => state.blueprints);
  const templates = useStore((state) => state.templates);
  const defaults = useStore((state) => state.defaults);
  const styles = useStore((state) => state.styles);
  const carried = useStore((state) => state.draft.text);
  const style = useNewConversationStyle();
  const info = styles.find((candidate) => candidate.style === style);
  const coordinator = info?.coordinator;
  const [text, setText] = useState(carried ?? "");
  const [approvals, setApprovals] = useState<ApprovalMode>(defaults.approvals);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const composer = useRef<ComposerHandle>(null);
  const ready = platform?.state === "connected" && blueprints.length > 0 && info?.available !== false;
  const meta = STYLE_META[style];

  // A message carried from a conversation ("start a new one in this style") fills the box once.
  useEffect(() => {
    if (carried === undefined) return;
    setText(carried);
    setDraft({ text: undefined });
  }, [carried]);

  const submit = async (): Promise<void> => {
    setSending(true);
    setError(undefined);
    try {
      const view = await createConversation(text, approvals, style);
      navigate(conversationHref(view.id));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSending(false);
    }
  };

  const useTemplate = (template: Template): void => {
    setText(template.prompt);
    composer.current?.focus();
  };

  const own = info?.handsEnvironment;
  const shown = style === "direct" ? blueprints.filter((blueprint) => blueprint.name === own) : info?.workers.length ? blueprints.filter((blueprint) => info.workers.includes(blueprint.name)) : blueprints;
  const MetaIcon = meta.icon;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:py-10">
      <section aria-labelledby="home-title">
        <h1 id="home-title" className="text-2xl font-semibold tracking-tight">
          What should the agent work on?
        </h1>
        <p className="mt-1 max-w-3xl text-fg-muted">
          You talk to one coordinator. Choose how it gets the work done: it can delegate each part to a worker agent in a sandbox of its own, work directly in a sandbox with
          its sub-agents, or mix the two. You watch every step.
        </p>
        <Composer
          ref={composer}
          className="mt-4"
          value={text}
          onChange={setText}
          onSubmit={() => void submit()}
          label="Your first message"
          placeholder={ready ? "Describe the job. For example: benchmark three sorting algorithms in Python and JavaScript, then write it up." : "Waiting for Managed Copilot…"}
          sending={sending}
          disabled={!ready}
          minRows={3}
          autoFocus
          footer={
            <>
              <StyleChoice value={style} onChange={(next) => setDraft({ style: next })} styles={styles} disabled={sending} />
              <ApprovalChoice value={approvals} onChange={setApprovals} disabled={sending} style={style} />
            </>
          }
        />
        <p className="mt-2 flex items-start gap-1.5 text-sm text-fg-muted" aria-live="polite">
          <MetaIcon size={16} className="mt-0.5 shrink-0" />
          <span>
            <strong className="font-semibold text-fg">{meta.label}.</strong> {meta.summary}
            {info?.available ? (
              <>
                {" "}
                New conversations run in <span className="font-mono text-xs">{info.environment}</span>; a conversation keeps its style.
              </>
            ) : null}
            {style === "delegate" ? " Work sent to existing sandboxes never asks." : style === "direct" ? " Reading files and output never asks." : null}
          </span>
        </p>
        {info && !info.available ? (
          <Callout tone="warning" className="mt-3">
            {info.reason ?? "This deployment doesn't declare an environment for this style."}
          </Callout>
        ) : null}
        {error ? (
          <Callout tone="danger" className="mt-3" role="alert">
            {error}
          </Callout>
        ) : null}
      </section>

      {templates.length ? (
        <section aria-labelledby="templates-title" className="mt-10">
          <h2 id="templates-title" className="text-base font-semibold">
            Try one
          </h2>
          <p className="mt-0.5 text-sm text-fg-muted">
            Each starts a conversation.{" "}
            {style === "direct"
              ? "Working directly, the agent does all of it in one Python lab sandbox (Python and Node, no network), splitting parallel parts across sub-agents."
              : "Its follow-ups show the agent reusing the sandboxes it made."}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {templates.map((template) => (
              <TemplateCard key={template.id} template={template} onUse={() => useTemplate(template)} disabled={!ready} style={style} />
            ))}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="blueprints-title" className="mt-10">
        <h2 id="blueprints-title" className="text-base font-semibold">
          {style === "direct" ? "Where it works" : style === "mixed" ? "Its own sandbox, and the sandboxes it can create" : "Sandboxes it can create"}
        </h2>
        <p className="mt-0.5 text-sm text-fg-muted">
          {coordinator ? (
            style === "direct" ? (
              <>
                The <span className="font-mono text-xs">{coordinator.environment}</span> coordinator ({coordinator.model}) and its sub-agents run commands in a sandbox made
                from this blueprint, with no agent inside it. It's created on the first command{info?.subagents === "own" ? "; each sub-agent gets one of its own" : " and shared by its sub-agents"}.
              </>
            ) : style === "mixed" ? (
              <>
                The <span className="font-mono text-xs">{coordinator.environment}</span> coordinator ({coordinator.model}) works in a sandbox of the first blueprint itself, and
                creates workers from any of them, up to {coordinator.maxWorkers} sandboxes at once.
              </>
            ) : (
              <>
                The <span className="font-mono text-xs">{coordinator.environment}</span> environment's coordinator ({coordinator.model}) creates workers from these blueprints,
                up to {coordinator.maxWorkers} at once. Each worker gets its own sandbox.
              </>
            )
          ) : (
            "The coordinator creates workers from the blueprints its environment declares. Each worker gets its own sandbox."
          )}
        </p>
        {shown.length ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {shown.map((blueprint) => (
              <BlueprintCard key={blueprint.name} blueprint={blueprint} badge={own && blueprint.name === own ? "its own sandbox" : !own && blueprint.isDefault ? "default" : undefined} />
            ))}
          </div>
        ) : (
          <p className="mt-3 rounded-md border border-dashed border-line p-4 text-sm text-fg-muted">
            {platform?.message ?? "The blueprints appear once Dispatch connects to Managed Copilot."}
          </p>
        )}
      </section>
    </div>
  );
}

/** The Octicons templates name (`Template.icon`). */
const TEMPLATE_ICONS: Readonly<Record<string, Icon>> = { versions: VersionsIcon, broadcast: BroadcastIcon, graph: GraphIcon, terminal: TerminalIcon };

function TemplateCard({ template, onUse, disabled, style }: { readonly template: Template; readonly onUse: () => void; readonly disabled: boolean; readonly style: ExecutionStyle }) {
  const Glyph = TEMPLATE_ICONS[template.icon] ?? ContainerIcon;
  const uses = template.uses.map((use) => `${use.count} × ${BLUEPRINT_LABELS[use.kind]}`).join(" · ");
  // Working directly, everything happens in one sandbox without network: say so where a template needs more.
  const needsWeb = style === "direct" && template.uses.some((use) => use.kind === "web");
  return (
    <button type="button" onClick={onUse} disabled={disabled} className="Box flex flex-col gap-1.5 p-3 text-left transition-colors hover:bg-canvas-muted disabled:cursor-not-allowed disabled:opacity-60">
      <span className="flex items-center gap-2 font-semibold">
        <Glyph size={16} className="text-fg-muted" />
        {template.title}
      </span>
      <span className="text-sm text-fg-muted">{template.description}</span>
      <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-fg-muted">
        {style === "direct" ? (
          <span className="inline-flex items-center gap-1">
            <TerminalIcon size={12} />
            one sandbox, with sub-agents
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <ContainerIcon size={12} />
            {uses}
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <ClockIcon size={12} />
          about {template.minutes} min
        </span>
        {needsWeb ? (
          <span className="inline-flex items-center gap-1 text-fg-attention">
            <InfoIcon size={12} />
            needs web access: delegate or mix
          </span>
        ) : null}
      </span>
    </button>
  );
}

export function BlueprintCard({ blueprint, badge }: { readonly blueprint: Blueprint; readonly badge?: string }) {
  const Glyph = KIND_ICON[blueprint.kind];
  return (
    <div className="Box lane flex flex-col gap-1 p-3" style={{ "--lane": KIND_LANE[blueprint.kind] } as CSSProperties}>
      <div className="flex items-center gap-2">
        <Glyph size={16} className="lane-icon" />
        <span className="font-semibold">{blueprint.label}</span>
        <span className="font-mono text-xs text-fg-muted">{blueprint.name}</span>
        {badge ? <span className="Label Label--secondary ml-auto">{badge}</span> : null}
      </div>
      <div className="flex flex-wrap gap-x-3 text-xs text-fg-muted">
        <span>{sizeSummary(blueprint)}</span>
        <span className="inline-flex items-center gap-1">
          {blueprint.network.access === "disabled" ? <ShieldCheckIcon size={12} /> : null}
          {networkSummary(blueprint.network, blueprint.kind)}
        </span>
      </div>
      {blueprint.description ? <p className="line-clamp-3 text-sm">{blueprint.description}</p> : null}
    </div>
  );
}
