import { AlertIcon, BroadcastIcon, ContainerIcon, GraphIcon, type Icon, TerminalIcon, VerifiedIcon, VersionsIcon } from "@primer/octicons-react";
import { useEffect, useRef, useState } from "react";
import { BLUEPRINT_LABELS, blueprintKind } from "../../shared/catalog.js";
import type { ApprovalMode, Blueprint, ExecutionStyle, StyleInfo, Template } from "../../shared/types.js";
import { errorMessage } from "../lib/api.js";
import { networkSummary, sizeSummary } from "../lib/blueprints.js";
import { cx } from "../lib/cx.js";
import { conversationHref, navigate } from "../lib/router.js";
import { createConversation, setDraft, useStore } from "../lib/store.js";
import { STYLE_META } from "../lib/styles.js";
import { BlueprintIcon } from "./BlueprintIcon.js";
import { Composer, type ComposerHandle } from "./Composer.js";
import { ApprovalChoice, StyleChoice, StyleDiagram, useNewConversationStyle } from "./Styles.js";
import { Callout } from "./ui/Feedback.js";
import { Tooltip } from "./ui/Tooltip.js";

export function Home() {
  const platform = useStore((state) => state.platform);
  const blueprints = useStore((state) => state.blueprints);
  const templates = useStore((state) => state.templates);
  const defaults = useStore((state) => state.defaults);
  const styles = useStore((state) => state.styles);
  const carried = useStore((state) => state.draft.text);
  const style = useNewConversationStyle();
  const info = styles.find((candidate) => candidate.style === style);
  const [text, setText] = useState(carried ?? "");
  const [approvals, setApprovals] = useState<ApprovalMode>(defaults.approvals);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const composer = useRef<ComposerHandle>(null);
  const ready = platform?.state === "connected" && blueprints.length > 0 && info?.available !== false;

  // A message carried from elsewhere fills the box once.
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
    // A template written for one style picks it, when this deployment has it.
    const opens = templateStyle(template, styles);
    if (opens) setDraft({ style: opens });
    composer.current?.focus();
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:py-10">
      <section aria-labelledby="home-title">
        <h1 id="home-title" className="text-2xl font-semibold tracking-tight">
          What should the agent work on?
        </h1>
        <Composer
          ref={composer}
          className="mt-4"
          value={text}
          onChange={setText}
          onSubmit={() => void submit()}
          label="Your first message"
          placeholder={ready ? "Describe the job, or try one below" : "Waiting for Managed Copilot…"}
          sending={sending}
          disabled={!ready}
          minRows={3}
          autoFocus
          footer={
            <>
              <StyleChoice value={style} onChange={(next) => setDraft({ style: next })} styles={styles} disabled={sending} />
              <ApprovalChoice value={approvals} onChange={setApprovals} style={style} disabled={sending} />
            </>
          }
        />
        <StyleDiagram style={style} className="mt-3 px-1" />
        {info && !info.available ? (
          <Callout tone="warning" compact className="mt-3">
            {info.reason ?? "This deployment doesn't declare an environment for this style."}
          </Callout>
        ) : null}
        {error ? (
          <Callout tone="danger" compact className="mt-3" role="alert">
            {error}
          </Callout>
        ) : null}
      </section>

      {templates.length ? (
        <section aria-labelledby="templates-title" className="mt-8">
          <h2 id="templates-title" className="text-base font-semibold">
            Try one
          </h2>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((template) => (
              <TemplateCard key={template.id} template={template} onUse={() => useTemplate(template)} disabled={!ready} style={style} styles={styles} />
            ))}
          </div>
        </section>
      ) : null}

      <BlueprintChips style={style} info={info} blueprints={blueprints} message={platform?.state === "connected" ? undefined : platform?.message} />
    </div>
  );
}

/** The Octicons templates name (`Template.icon`). */
const TEMPLATE_ICONS: Readonly<Record<string, Icon>> = { versions: VersionsIcon, broadcast: BroadcastIcon, graph: GraphIcon, terminal: TerminalIcon, verified: VerifiedIcon };

/** The style a template switches to: the one it was written for, when this deployment has it. */
function templateStyle(template: Template, styles: readonly StyleInfo[]): ExecutionStyle | undefined {
  return template.style && styles.some((candidate) => candidate.style === template.style && candidate.available) ? template.style : undefined;
}

function TemplateCard({
  template,
  onUse,
  disabled,
  style,
  styles,
}: {
  readonly template: Template;
  readonly onUse: () => void;
  readonly disabled: boolean;
  readonly style: ExecutionStyle;
  readonly styles: readonly StyleInfo[];
}) {
  const Glyph = TEMPLATE_ICONS[template.icon] ?? ContainerIcon;
  // A template written for another style switches to it; otherwise it runs in the style picked now.
  const opens = templateStyle(template, styles);
  const runs = opens ?? style;
  // Working directly, everything happens in one sandbox without network: say so where a template needs more.
  const needsWeb = runs === "direct" && template.uses.some((use) => use.kind === "web");
  const StyleGlyph = STYLE_META[runs].icon;
  return (
    <button
      type="button"
      onClick={onUse}
      disabled={disabled}
      className="Box flex min-w-0 flex-col gap-1 px-3 py-2.5 text-left transition-colors hover:bg-canvas-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-outlineColor)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Glyph size={16} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 truncate font-semibold">{template.title}</span>
        <span className="ml-auto shrink-0 text-xs text-fg-muted tabular-nums">~{template.minutes} min</span>
      </span>
      <span className="truncate text-sm text-fg-muted" title={template.description}>
        {template.description}
      </span>
      <span className="mt-1 flex min-h-5 items-center gap-1.5">
        <UsesGlyphs template={template} style={runs} info={styles.find((candidate) => candidate.style === runs)} own={opens === "mixed"} />
        {needsWeb ? (
          <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-fg-attention" title="Working directly, it has no network. Delegate or mix for this one.">
            <AlertIcon size={12} />
            Needs web
          </span>
        ) : opens ? (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-fg-muted" title={`Opens in ${STYLE_META[opens].label}`}>
            <StyleGlyph size={12} />
            {STYLE_META[opens].short}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * What a template uses, as sandbox glyphs: one per sandbox it usually creates (one in all, working directly). `own`:
 * written for Mixed, its first part of the coordinator's sandbox kind runs in that sandbox (dashed).
 */
function UsesGlyphs({ template, style, info, own: ownSandbox }: { readonly template: Template; readonly style: ExecutionStyle; readonly info: StyleInfo | undefined; readonly own: boolean }) {
  const handsKind = info?.handsEnvironment ? blueprintKind(info.handsEnvironment) : "python";
  if (style === "direct") {
    return (
      <span className="inline-flex" title="All of it in its own sandbox, split across sub-agents">
        <SandboxGlyph kind={handsKind} own />
      </span>
    );
  }
  const glyphs = template.uses.flatMap((use) => Array.from({ length: use.count }, (_, index) => ({ key: `${use.kind}-${index}`, kind: use.kind })));
  const own = ownSandbox ? glyphs.findIndex((glyph) => glyph.kind === handsKind) : -1;
  const others = glyphs.filter((_, index) => index !== own).map((glyph) => BLUEPRINT_LABELS[glyph.kind].toLowerCase());
  const title =
    own >= 0
      ? `Its own ${BLUEPRINT_LABELS[handsKind].toLowerCase()} sandbox, plus ${others.length === 1 ? "a " : ""}${others.join(", ")} worker${others.length === 1 ? "" : "s"}`
      : template.uses.map((use) => `${use.count} × ${BLUEPRINT_LABELS[use.kind]}`).join(" · ");
  return (
    <span className="inline-flex items-center gap-1" title={title}>
      {glyphs.map((glyph, index) => (
        <SandboxGlyph key={glyph.key} kind={glyph.kind} own={index === own} />
      ))}
    </span>
  );
}

function SandboxGlyph({ kind, own = false }: { readonly kind: Blueprint["kind"]; readonly own?: boolean }) {
  return (
    <span className={cx("grid size-5 place-items-center rounded border", own ? "border-dashed border-line-accent bg-accent-muted" : "border-line bg-canvas")} aria-hidden>
      <BlueprintIcon kind={kind} size={12} />
    </span>
  );
}

/** The sandboxes this style can use, as chips; their size and network are in the tooltip. */
function BlueprintChips({ style, info, blueprints, message }: { readonly style: ExecutionStyle; readonly info: StyleInfo | undefined; readonly blueprints: readonly Blueprint[]; readonly message?: string }) {
  const own = info?.handsEnvironment;
  const shown =
    style === "direct" ? blueprints.filter((blueprint) => blueprint.name === own) : info?.workers.length ? blueprints.filter((blueprint) => info.workers.includes(blueprint.name)) : blueprints;
  return (
    <section aria-label="Sandboxes" className="mt-8 flex flex-wrap items-center gap-2 border-t border-line-muted pt-4">
      <span className="mr-1 inline-flex items-center gap-1.5 text-xs font-semibold text-fg-muted">
        <ContainerIcon size={14} />
        Sandboxes
      </span>
      {shown.length ? (
        shown.map((blueprint) => <BlueprintChip key={blueprint.name} blueprint={blueprint} own={blueprint.name === own} />)
      ) : (
        <span className="text-xs text-fg-muted">{message ?? "They appear once Dispatch connects to Managed Copilot."}</span>
      )}
    </section>
  );
}

function BlueprintChip({ blueprint, own }: { readonly blueprint: Blueprint; readonly own: boolean }) {
  const details = `${blueprint.name} · ${sizeSummary(blueprint)} · ${networkSummary(blueprint.network, blueprint.kind)}${own ? " · its own sandbox" : ""}`;
  return (
    <Tooltip content={details}>
      <span
        tabIndex={0}
        className={cx(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium outline-none focus-visible:shadow-[0_0_0_2px_var(--focus-outlineColor)]",
          own ? "border-dashed border-line-accent bg-accent-muted" : "border-line bg-canvas",
        )}
      >
        <BlueprintIcon kind={blueprint.kind} size={12} />
        {blueprint.label}
      </span>
    </Tooltip>
  );
}
