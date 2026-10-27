import { BroadcastIcon, ClockIcon, ContainerIcon, GraphIcon, type Icon, ShieldCheckIcon, ShieldIcon, TerminalIcon, VersionsIcon, ZapIcon } from "@primer/octicons-react";
import { useRef, useState, type CSSProperties } from "react";
import { BLUEPRINT_LABELS } from "../../shared/catalog.js";
import type { ApprovalMode, Blueprint, Template } from "../../shared/types.js";
import { errorMessage } from "../lib/api.js";
import { KIND_ICON, KIND_LANE, networkSummary, sizeSummary } from "../lib/blueprints.js";
import { conversationHref, navigate } from "../lib/router.js";
import { createConversation, useStore } from "../lib/store.js";
import { Composer, type ComposerHandle } from "./Composer.js";
import { Callout } from "./ui/Feedback.js";

export function ApprovalChoice({ value, onChange, disabled }: { readonly value: ApprovalMode; readonly onChange: (mode: ApprovalMode) => void; readonly disabled?: boolean }) {
  return (
    <div className="SegmentedControl SegmentedControl--sm" role="group" aria-label="New sandboxes">
      <button type="button" className="SegmentedControl-item" aria-current={value === "ask"} disabled={disabled} onClick={() => onChange("ask")} title="The agent asks you before each new sandbox">
        <ShieldIcon size={14} />
        Ask before new sandboxes
      </button>
      <button type="button" className="SegmentedControl-item" aria-current={value === "auto"} disabled={disabled} onClick={() => onChange("auto")} title="The agent creates sandboxes as it decides">
        <ZapIcon size={14} />
        Create freely
      </button>
    </div>
  );
}

export function Home() {
  const platform = useStore((state) => state.platform);
  const blueprints = useStore((state) => state.blueprints);
  const templates = useStore((state) => state.templates);
  const defaults = useStore((state) => state.defaults);
  const coordinator = useStore((state) => state.coordinator);
  const [text, setText] = useState("");
  const [approvals, setApprovals] = useState<ApprovalMode>(defaults.approvals);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const composer = useRef<ComposerHandle>(null);
  const ready = platform?.state === "connected" && blueprints.length > 0;

  const submit = async (): Promise<void> => {
    setSending(true);
    setError(undefined);
    try {
      const view = await createConversation(text, approvals);
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

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:py-10">
      <section aria-labelledby="home-title">
        <h1 id="home-title" className="text-2xl font-semibold tracking-tight">
          What should the agent work on?
        </h1>
        <p className="mt-1 max-w-3xl text-fg-muted">
          You talk to one coordinator. For every message it decides whether to create a new sandbox for the work, or to send it to a sandbox it already has. You watch each
          decision happen.
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
              <ApprovalChoice value={approvals} onChange={setApprovals} disabled={sending} />
              <span className="max-md:hidden">Work sent to existing sandboxes never asks.</span>
            </>
          }
        />
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
          <p className="mt-0.5 text-sm text-fg-muted">Each starts a conversation. Its follow-ups show the agent reusing the sandboxes it made.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {templates.map((template) => (
              <TemplateCard key={template.id} template={template} onUse={() => useTemplate(template)} disabled={!ready} />
            ))}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="blueprints-title" className="mt-10">
        <h2 id="blueprints-title" className="text-base font-semibold">
          Sandboxes it can create
        </h2>
        <p className="mt-0.5 text-sm text-fg-muted">
          {coordinator ? (
            <>
              The <span className="font-mono text-xs">{coordinator.environment}</span> environment's coordinator ({coordinator.model}) creates workers from these blueprints, up
              to {coordinator.maxWorkers} at once. Each worker gets its own sandbox.
            </>
          ) : (
            "The coordinator creates workers from the blueprints its environment declares. Each worker gets its own sandbox."
          )}
        </p>
        {blueprints.length ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {blueprints.map((blueprint) => (
              <BlueprintCard key={blueprint.name} blueprint={blueprint} />
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

function TemplateCard({ template, onUse, disabled }: { readonly template: Template; readonly onUse: () => void; readonly disabled: boolean }) {
  const Glyph = TEMPLATE_ICONS[template.icon] ?? ContainerIcon;
  const uses = template.uses.map((use) => `${use.count} × ${BLUEPRINT_LABELS[use.kind]}`).join(" · ");
  return (
    <button type="button" onClick={onUse} disabled={disabled} className="Box flex flex-col gap-1.5 p-3 text-left transition-colors hover:bg-canvas-muted disabled:cursor-not-allowed disabled:opacity-60">
      <span className="flex items-center gap-2 font-semibold">
        <Glyph size={16} className="text-fg-muted" />
        {template.title}
      </span>
      <span className="text-sm text-fg-muted">{template.description}</span>
      <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-fg-muted">
        <span className="inline-flex items-center gap-1">
          <ContainerIcon size={12} />
          {uses}
        </span>
        <span className="inline-flex items-center gap-1">
          <ClockIcon size={12} />
          about {template.minutes} min
        </span>
      </span>
    </button>
  );
}

export function BlueprintCard({ blueprint }: { readonly blueprint: Blueprint }) {
  const Glyph = KIND_ICON[blueprint.kind];
  return (
    <div className="Box lane flex flex-col gap-1 p-3" style={{ "--lane": KIND_LANE[blueprint.kind] } as CSSProperties}>
      <div className="flex items-center gap-2">
        <Glyph size={16} className="lane-icon" />
        <span className="font-semibold">{blueprint.label}</span>
        <span className="font-mono text-xs text-fg-muted">{blueprint.name}</span>
        {blueprint.isDefault ? <span className="Label Label--secondary ml-auto">default</span> : null}
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
