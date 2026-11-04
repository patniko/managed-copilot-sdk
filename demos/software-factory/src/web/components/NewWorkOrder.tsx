import {
  ArrowSwitchIcon,
  CheckCircleFillIcon,
  ChevronRightIcon,
  ClockIcon,
  CodeReviewIcon,
  CopilotIcon,
  FileCodeIcon,
  InfoIcon,
  PackageIcon,
  PlugIcon,
  TableIcon,
  TasklistIcon,
  TerminalIcon,
  ToolsIcon,
  VersionsIcon,
  type Icon,
} from "@primer/octicons-react";
import { useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { formatWorkOrderNumber, type WorkOrderMode, type WorkOrderTemplate } from "../../shared/types.js";
import { toErrorInfo, type ErrorInfo } from "../lib/api.js";
import { confirmAction } from "../lib/confirm.js";
import { cx } from "../lib/cx.js";
import { modeLabel, runsBlockedReason } from "../lib/platform.js";
import { navigate, workOrderHref } from "../lib/router.js";
import { createWorkOrder, useStore } from "../lib/store.js";
import { toast } from "../lib/toast.js";
import { Button } from "./ui/Button.js";
import { Callout } from "./ui/Feedback.js";

interface Draft {
  readonly title: string;
  readonly brief: string;
  readonly rounds: number;
  readonly mode: WorkOrderMode;
}

const EMPTY_DRAFT: Draft = { title: "", brief: "", rounds: 2, mode: "agent" };
/** Survives navigating away and back within the session. */
let savedDraft: Draft = EMPTY_DRAFT;

const MAX_TITLE = 120;

const MODES: readonly { readonly mode: WorkOrderMode; readonly icon: Icon; readonly description: string }[] = [
  { mode: "agent", icon: CopilotIcon, description: "A coordinator agent creates sandboxes and reuses them for fixes." },
  { mode: "classic", icon: PlugIcon, description: "The app drives each step, with a fresh sandbox per build." },
];

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

  const blocked = runsBlockedReason(platform, draft.mode);
  const missingFields = !draft.title.trim() || !draft.brief.trim();
  const canSubmit = !blocked && !missingFields && !submitting;
  const selectedMode = MODES.find((item) => item.mode === draft.mode) ?? MODES[0]!;

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
        mode: draft.mode,
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
    <div className="mx-auto w-full max-w-[880px] px-4 py-6 md:px-6 lg:py-10">
      <header>
        <h1 className="text-2xl font-semibold">What should the factory build?</h1>
        <p className="mt-1 text-fg-muted">A work order goes in; a tested, reviewed release comes out.</p>
        <Stepper />
      </header>

      {templates.length > 0 ? (
        <section aria-labelledby="templates-heading" className="mt-8">
          <h2 id="templates-heading" className="text-base font-semibold">
            Start from a template
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
        aria-label="New work order"
        className="Box mt-6 scroll-mt-6"
      >
        <div className="space-y-4 p-4 md:p-6">
          <fieldset>
            <legend className="FormControl-label">Mode</legend>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="SegmentedControl">
                {MODES.map((item) => (
                  <label key={item.mode} className="SegmentedControl-item">
                    <input
                      type="radio"
                      name="execution-mode"
                      value={item.mode}
                      checked={draft.mode === item.mode}
                      onChange={() => setDraft({ ...draft, mode: item.mode })}
                      aria-describedby="wo-mode-help"
                      className="sr-only"
                    />
                    <item.icon size={16} className={item.mode === "agent" && draft.mode === "agent" ? "text-fg-done" : undefined} />
                    {modeLabel(item.mode)}
                  </label>
                ))}
              </div>
              <p id="wo-mode-help" className="min-w-0 text-xs text-fg-muted">
                {selectedMode.description}
              </p>
            </div>
          </fieldset>

          <div className="FormControl">
            <label htmlFor="wo-title" className="FormControl-label">
              Title
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
            </label>
            <BriefInput value={draft.brief} onChange={(brief) => setDraft({ ...draft, brief })} />
          </div>

          <details className="group">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-sm font-semibold select-none [&::-webkit-details-marker]:hidden">
              <ChevronRightIcon size={16} className="text-fg-muted transition-transform duration-100 group-open:rotate-90" />
              Advanced
              <span className="font-normal text-fg-muted">· {draft.rounds} review {draft.rounds === 1 ? "round" : "rounds"}</span>
            </summary>
            <ReviewRounds value={draft.rounds} onChange={(rounds) => setDraft({ ...draft, rounds })} />
          </details>
        </div>

        <div className="flex flex-col gap-3 border-t border-line-muted px-4 py-3 sm:flex-row sm:items-center sm:justify-end md:px-6">
          {blocked || missingFields ? (
            <p id="wo-submit-help" className="flex items-start gap-1.5 text-xs text-fg-muted sm:mr-auto">
              <InfoIcon size={16} className="shrink-0" />
              {blocked ?? "Pick a template or add a title and brief."}
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
          <Callout tone="danger" role="alert" title="The factory couldn't start this work order" className="mx-4 mb-4 md:mx-6">
            {error.message}
          </Callout>
        ) : null}
      </form>
    </div>
  );
}

const STEPS: readonly { readonly icon: Icon; readonly label: string }[] = [
  { icon: TasklistIcon, label: "Plan" },
  { icon: ToolsIcon, label: "Build" },
  { icon: CodeReviewIcon, label: "Review" },
  { icon: PackageIcon, label: "Release" },
];

/** The assembly line every work order runs down, as connected chips. */
function Stepper() {
  return (
    <ol className="mt-4 flex items-center" aria-label="Every work order runs Plan, Build, Review, Release">
      {STEPS.map((step, index) => (
        <li key={step.label} className={cx("flex items-center", index < STEPS.length - 1 && "flex-1 sm:flex-none")}>
          <span className="Label shrink-0 gap-1.5 sm:h-6 sm:px-2.5">
            <step.icon size={14} className="text-fg-muted max-sm:hidden" />
            {step.label}
          </span>
          {index < STEPS.length - 1 ? <span className="mx-1 h-px min-w-2 flex-1 bg-line-emphasis sm:mx-1.5 sm:w-10 sm:flex-none" aria-hidden /> : null}
        </li>
      ))}
    </ol>
  );
}

const TEMPLATE_ICONS: Readonly<Record<string, Icon>> = {
  "csv-json-toolkit": ArrowSwitchIcon,
  "csv-to-json-cli": TerminalIcon,
  "semver-toolkit": VersionsIcon,
  "markdown-table-formatter": TableIcon,
};

function templateIcon(template: WorkOrderTemplate): Icon {
  const known = Object.hasOwn(TEMPLATE_ICONS, template.id) ? TEMPLATE_ICONS[template.id] : undefined;
  if (known) return known;
  if (template.tags.includes("Library")) return VersionsIcon;
  if (template.tags.includes("Text")) return TableIcon;
  if (template.tags.includes("CLI")) return TerminalIcon;
  return FileCodeIcon;
}

/** A template: icon, title, one line, and how long it takes. Selecting one fills in the form. */
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
        "Box flex h-full min-w-0 items-start gap-3 p-3 text-left transition-colors duration-100",
        selected ? "border-line-accent bg-accent-muted/40 ring-1 ring-line-accent" : "hover:bg-canvas-muted",
      )}
    >
      <span
        className={cx(
          "grid size-8 shrink-0 place-items-center rounded-md border",
          selected ? "border-line-accent bg-canvas text-fg-accent" : "border-line bg-canvas-muted text-fg-muted",
        )}
        aria-hidden
      >
        {selected ? <CheckCircleFillIcon size={16} /> : <Glyph size={16} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold">{template.title}</span>
          {template.featured ? <span className="Label Label--success shrink-0">Recommended</span> : null}
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 pl-1 text-xs text-fg-muted tabular-nums max-sm:hidden">
            <ClockIcon size={12} />
            {template.estimate}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-fg-muted" title={template.tagline}>
          {template.tagline}
        </span>
      </span>
    </button>
  );
}

function BriefInput({ value, onChange }: { readonly value: string; readonly onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight + 2, 240)}px`;
  }, [value]);
  return (
    <textarea
      id="wo-brief"
      ref={ref}
      rows={6}
      value={value}
      spellCheck
      aria-required="true"
      placeholder={"Build a zero-dependency Node.js CLI that…\n\n- Inputs and outputs\n- Edge cases to handle\n- How it should be tested"}
      onChange={(event) => onChange(event.target.value)}
      className="form-control input-block resize-y"
    />
  );
}

function ReviewRounds({ value, onChange }: { readonly value: number; readonly onChange: (value: number) => void }) {
  return (
    <fieldset className="mt-3 pl-5">
      <legend className="FormControl-label">Review rounds</legend>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="SegmentedControl SegmentedControl--sm">
          {[1, 2, 3].map((rounds) => (
            <label key={rounds} className="SegmentedControl-item w-10">
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
        <p className="text-xs text-fg-muted">Times a reviewer can send a task back.</p>
      </div>
    </fieldset>
  );
}
