import {
  ArrowRightIcon,
  CheckCircleFillIcon,
  ClockIcon,
  CodeIcon,
  CodeReviewIcon,
  FileCodeIcon,
  InfoIcon,
  PackageIcon,
  TableIcon,
  TasklistIcon,
  TerminalIcon,
  ToolsIcon,
  type Icon,
} from "@primer/octicons-react";
import { useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { formatWorkOrderNumber, type WorkOrderTemplate } from "../../shared/types.js";
import { toErrorInfo, type ErrorInfo } from "../lib/api.js";
import { confirmAction } from "../lib/confirm.js";
import { cx } from "../lib/cx.js";
import { runsBlockedReason } from "../lib/platform.js";
import { navigate, workOrderHref } from "../lib/router.js";
import { createWorkOrder, useStore } from "../lib/store.js";
import { toast } from "../lib/toast.js";
import { Button } from "./ui/Button.js";
import { Callout } from "./ui/Feedback.js";

interface Draft {
  readonly title: string;
  readonly brief: string;
  readonly rounds: number;
}

const EMPTY_DRAFT: Draft = { title: "", brief: "", rounds: 2 };
/** Survives navigating away and back within the session. */
let savedDraft: Draft = EMPTY_DRAFT;

const MAX_TITLE = 120;

export function NewWorkOrder() {
  const templates = useStore((state) => state.templates);
  const platform = useStore((state) => state.platform);
  const [draft, setDraftState] = useState<Draft>(savedDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ErrorInfo>();
  const form = useRef<HTMLFormElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);

  const setDraft = (next: Draft): void => {
    savedDraft = next;
    setDraftState(next);
  };

  const matchingTemplate = useMemo(
    () => templates.find((template) => template.brief.trim() === draft.brief.trim()),
    [templates, draft.brief],
  );

  const blocked = runsBlockedReason(platform);
  const missingFields = !draft.title.trim() || !draft.brief.trim();
  const canSubmit = !blocked && !missingFields && !submitting;

  const applyTemplate = async (template: WorkOrderTemplate): Promise<void> => {
    const custom = draft.brief.trim() && !matchingTemplate;
    if (custom) {
      const ok = await confirmAction({
        title: `Replace your brief with "${template.title}"?`,
        message: "The title and brief you've written will be replaced by the template.",
        confirmLabel: "Use template",
      });
      if (!ok) return;
    }
    setDraft({ ...draft, title: template.title, brief: template.brief });
    setError(undefined);
    form.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSubmit) {
      if (missingFields) titleInput.current?.focus();
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const workOrder = await createWorkOrder({
        title: draft.title.trim(),
        brief: draft.brief.trim(),
        templateId: matchingTemplate?.id,
        maxReviewRounds: draft.rounds,
      });
      savedDraft = EMPTY_DRAFT;
      toast.success(`${formatWorkOrderNumber(workOrder.number)} is on the floor`, "The planner is picking it up now.");
      navigate(workOrderHref(workOrder.id));
    } catch (caught) {
      setError(toErrorInfo(caught));
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1012px] px-4 py-6 md:px-6 lg:px-8 lg:py-8">
      <Intro />

      {templates.length > 0 ? (
        <section aria-labelledby="templates-heading" className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="templates-heading" className="text-base font-semibold">
              Start from a template
            </h2>
            <p className="text-xs text-fg-muted">Pick one to fill in the form below.</p>
          </div>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            {templates.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                selected={matchingTemplate?.id === template.id}
                onSelect={() => void applyTemplate(template)}
              />
            ))}
          </div>
        </section>
      ) : null}

      <form
        ref={form}
        onSubmit={(event) => void submit(event)}
        noValidate
        aria-labelledby="new-work-order-heading"
        className="mt-10 scroll-mt-6"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-line-muted pb-2">
          <h2 id="new-work-order-heading" className="text-base font-semibold">
            New work order
          </h2>
          {matchingTemplate ? <span className="Label Label--accent">Template · {matchingTemplate.title}</span> : null}
        </div>

        <div className="mt-4 space-y-5">
          <div className="FormControl">
            <label htmlFor="wo-title" className="FormControl-label">
              Title
              <span className="FormControl-required" aria-hidden>
                *
              </span>
            </label>
            <input
              id="wo-title"
              ref={titleInput}
              value={draft.title}
              maxLength={MAX_TITLE}
              autoComplete="off"
              aria-required="true"
              placeholder="e.g. CSV ⇄ JSON toolkit"
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              className="form-control input-block"
            />
          </div>

          <div className="FormControl">
            <label htmlFor="wo-brief" className="FormControl-label">
              Brief
              <span className="FormControl-required" aria-hidden>
                *
              </span>
            </label>
            <BriefInput value={draft.brief} onChange={(brief) => setDraft({ ...draft, brief })} />
            <span id="wo-brief-help" className="FormControl-caption">
              Markdown welcome. Be specific about inputs, outputs, and tests.
            </span>
          </div>

          <ReviewRounds value={draft.rounds} onChange={(rounds) => setDraft({ ...draft, rounds })} />
        </div>

        <div className="mt-6 flex flex-col gap-3 border-t border-line-muted pt-4 sm:flex-row sm:items-center sm:justify-end">
          {blocked || missingFields ? (
            <p id="wo-submit-help" className="flex items-start gap-1.5 text-xs text-fg-muted sm:mr-auto">
              <InfoIcon size={16} className="shrink-0" />
              {blocked ?? "Add a title and a brief to start."}
            </p>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            loading={submitting}
            disabled={!canSubmit}
            aria-describedby={blocked || missingFields ? "wo-submit-help" : undefined}
          >
            {submitting ? "Starting…" : "Start work order"}
          </Button>
        </div>

        {error ? (
          <Callout tone="danger" role="alert" title="The factory couldn't start this work order" className="mt-4">
            {error.message}
          </Callout>
        ) : null}
      </form>
    </div>
  );
}

function Intro() {
  const steps: readonly { readonly icon: Icon; readonly label: string }[] = [
    { icon: TasklistIcon, label: "Plan" },
    { icon: ToolsIcon, label: "Build in parallel sandboxes" },
    { icon: CodeReviewIcon, label: "Review" },
    { icon: PackageIcon, label: "Release" },
  ];
  return (
    <header className="Subhead mb-0">
      <h1 className="Subhead-heading">What should the factory build?</h1>
      <div className="Subhead-description">
        <p className="max-w-2xl">
          Describe the software you need. Copilot agents plan it, build each task in its own sandbox, review the work with a
          second model, and ship a tested release.
        </p>
        <ol className="mt-3 mb-1 flex flex-wrap items-center gap-x-2 gap-y-1.5" aria-label="Pipeline">
          {steps.map((step, index) => (
            <li key={step.label} className="flex items-center gap-2">
              <span className="Label Label--large">
                <step.icon size={12} className="text-fg-muted" />
                {step.label}
              </span>
              {index < steps.length - 1 ? <ArrowRightIcon size={12} className="text-fg-muted" /> : null}
            </li>
          ))}
        </ol>
      </div>
    </header>
  );
}

function templateIcon(template: WorkOrderTemplate): Icon {
  if (template.tags.includes("Library")) return CodeIcon;
  if (template.tags.includes("Text")) return TableIcon;
  if (template.tags.includes("CLI")) return TerminalIcon;
  return FileCodeIcon;
}

/** A selectable template card, like GitHub's template choosers. */
function TemplateCard({
  template,
  selected,
  onSelect,
}: {
  readonly template: WorkOrderTemplate;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const Glyph = templateIcon(template);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cx(
        "Box flex h-full flex-col p-4 text-left transition-colors duration-100",
        selected ? "border-line-accent ring-1 ring-line-accent" : "hover:bg-canvas-muted",
      )}
    >
      <div className="flex w-full items-start gap-2">
        <Glyph size={16} className="mt-0.5 shrink-0 text-fg-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-semibold">{template.title}</h3>
            {template.featured ? <span className="Label Label--accent">Scripted demo</span> : null}
          </div>
          <p className="mt-1 text-fg-muted">{template.tagline}</p>
        </div>
        {selected ? <CheckCircleFillIcon size={16} className="mt-0.5 shrink-0 text-fg-accent" /> : null}
      </div>
      <div className="mt-auto flex w-full flex-wrap items-center gap-1 pt-4 pl-6">
        {template.tags.map((tag) => (
          <span key={tag} className="topic-tag">
            {tag}
          </span>
        ))}
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-fg-muted">
          <ClockIcon size={12} />
          {template.estimate}
        </span>
      </div>
    </button>
  );
}

function BriefInput({ value, onChange }: { readonly value: string; readonly onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight + 2, 640)}px`;
  }, [value]);
  return (
    <textarea
      id="wo-brief"
      ref={ref}
      rows={10}
      value={value}
      spellCheck
      aria-required="true"
      aria-describedby="wo-brief-help"
      placeholder={"Build a zero-dependency Node.js CLI that…\n\n- Inputs and outputs\n- Edge cases to handle\n- How it should be tested"}
      onChange={(event) => onChange(event.target.value)}
      className="form-control input-block resize-y"
    />
  );
}

function ReviewRounds({ value, onChange }: { readonly value: number; readonly onChange: (value: number) => void }) {
  return (
    <fieldset>
      <legend className="FormControl-label">Review rounds</legend>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="SegmentedControl">
          {[1, 2, 3].map((rounds) => (
            <label key={rounds} className="SegmentedControl-item w-11">
              <input
                type="radio"
                name="review-rounds"
                value={rounds}
                checked={value === rounds}
                onChange={() => onChange(rounds)}
                className="sr-only"
              />
              {rounds}
            </label>
          ))}
        </div>
        <p className="FormControl-caption">How many times the reviewer can send a task back before it's accepted.</p>
      </div>
    </fieldset>
  );
}
