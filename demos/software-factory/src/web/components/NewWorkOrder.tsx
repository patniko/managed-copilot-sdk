import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Braces,
  ClipboardList,
  Clock,
  FileCode,
  Hammer,
  Info,
  PackageCheck,
  Play,
  ScanSearch,
  SquareTerminal,
  Table,
} from "lucide-react";
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
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:py-12">
      <Hero />

      {templates.length > 0 ? (
        <section aria-labelledby="templates-heading" className="mt-10">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="templates-heading" className="text-sm font-semibold text-zinc-200">
              Start from a template
            </h2>
            <p className="text-xs text-zinc-500">Pick one to fill in the form below.</p>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
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
        className="mt-8 scroll-mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 shadow-xl shadow-black/20 sm:p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="new-work-order-heading" className="text-base font-semibold text-zinc-100">
            New work order
          </h2>
          {matchingTemplate ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-400/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-inset ring-amber-400/25">
              Template · {matchingTemplate.title}
            </span>
          ) : null}
        </div>

        <div className="mt-5 space-y-5">
          <div>
            <label htmlFor="wo-title" className="text-[13px] font-medium text-zinc-200">
              Title
            </label>
            <input
              id="wo-title"
              ref={titleInput}
              value={draft.title}
              maxLength={MAX_TITLE}
              autoComplete="off"
              placeholder="e.g. CSV ⇄ JSON toolkit"
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              className="mt-1.5 h-10 w-full rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 text-sm text-zinc-100 transition-colors placeholder:text-zinc-600 hover:border-zinc-700 focus:border-amber-400/60 focus:ring-2 focus:ring-amber-400/15 focus:outline-none"
            />
          </div>

          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <label htmlFor="wo-brief" className="text-[13px] font-medium text-zinc-200">
                Brief
              </label>
              <span id="wo-brief-help" className="text-xs text-zinc-500">
                Markdown welcome. Be specific about inputs, outputs, and tests.
              </span>
            </div>
            <BriefInput value={draft.brief} onChange={(brief) => setDraft({ ...draft, brief })} />
          </div>

          <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <ReviewRounds value={draft.rounds} onChange={(rounds) => setDraft({ ...draft, rounds })} />
            <div className="flex flex-col items-stretch gap-2 sm:items-end">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                icon={Play}
                loading={submitting}
                disabled={!canSubmit}
                aria-describedby={blocked || missingFields ? "wo-submit-help" : undefined}
              >
                {submitting ? "Starting…" : "Start work order"}
              </Button>
            </div>
          </div>

          {blocked || missingFields ? (
            <p id="wo-submit-help" className="flex items-start gap-1.5 text-xs text-zinc-500 sm:justify-end">
              <Info className="mt-px size-3.5 shrink-0" aria-hidden />
              {blocked ?? "Add a title and a brief to start."}
            </p>
          ) : null}

          {error ? (
            <Callout tone="danger" role="alert" title="The factory couldn't start this work order">
              {error.message}
            </Callout>
          ) : null}
        </div>
      </form>
    </div>
  );
}

function Hero() {
  const steps: readonly { readonly icon: LucideIcon; readonly label: string }[] = [
    { icon: ClipboardList, label: "Plan" },
    { icon: Hammer, label: "Build in parallel sandboxes" },
    { icon: ScanSearch, label: "Review" },
    { icon: PackageCheck, label: "Release" },
  ];
  return (
    <header>
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-300/90">Software Factory</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-50 sm:text-3xl">What should the factory build?</h1>
      <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-zinc-400">
        Describe the software you need. Copilot agents plan it, build each task in its own sandbox, review the work with a
        second model, and ship a tested release.
      </p>
      <ol className="mt-5 flex flex-wrap items-center gap-2" aria-label="Pipeline">
        {steps.map((step, index) => (
          <li key={step.label} className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-300 ring-1 ring-inset ring-white/10">
              <step.icon className="size-3.5 text-amber-300/90" aria-hidden />
              {step.label}
            </span>
            {index < steps.length - 1 ? <ArrowRight className="size-3.5 text-zinc-600" aria-hidden /> : null}
          </li>
        ))}
      </ol>
    </header>
  );
}

function templateIcon(template: WorkOrderTemplate): LucideIcon {
  if (template.tags.includes("Library")) return Braces;
  if (template.tags.includes("Text")) return Table;
  if (template.tags.includes("CLI")) return SquareTerminal;
  return FileCode;
}

function TemplateCard({
  template,
  selected,
  onSelect,
}: {
  readonly template: WorkOrderTemplate;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const Icon = templateIcon(template);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cx(
        "group relative flex h-full flex-col overflow-hidden rounded-xl border p-4 text-left transition-all duration-150",
        selected
          ? "border-amber-400/50 bg-amber-400/[0.05] shadow-[0_0_0_1px_rgb(251_191_36/0.15),0_8px_30px_-12px_rgb(251_191_36/0.25)]"
          : "border-zinc-800 bg-zinc-900/50 hover:-translate-y-px hover:border-zinc-700 hover:bg-zinc-900",
      )}
    >
      {template.featured ? (
        <span className="pointer-events-none absolute top-[32px] right-[-38px] w-[168px] rotate-45 bg-amber-400 py-[3px] text-center text-[10px] leading-3 font-bold tracking-[0.08em] text-zinc-950 uppercase shadow-md shadow-black/40">
          Scripted demo
        </span>
      ) : null}
      <div className={cx("flex items-start gap-3", template.featured ? "pr-14" : "pr-2")}>
        <span
          className={cx(
            "grid size-9 shrink-0 place-items-center rounded-lg ring-1 ring-inset",
            template.featured ? "bg-amber-400/10 text-amber-300 ring-amber-400/25" : "bg-zinc-800/80 text-zinc-300 ring-white/10",
          )}
        >
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="font-semibold text-zinc-100">{template.title}</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-zinc-400">{template.tagline}</p>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-4">
        {template.tags.map((tag) => (
          <span key={tag} className="rounded-md bg-zinc-800/70 px-1.5 py-px text-[11px] leading-[18px] text-zinc-400 ring-1 ring-inset ring-white/5">
            {tag}
          </span>
        ))}
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-zinc-500">
          <Clock className="size-3.5" aria-hidden />
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
      rows={12}
      value={value}
      spellCheck
      aria-describedby="wo-brief-help"
      placeholder={"Build a zero-dependency Node.js CLI that…\n\n- Inputs and outputs\n- Edge cases to handle\n- How it should be tested"}
      onChange={(event) => onChange(event.target.value)}
      className="mt-1.5 block w-full resize-y rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2.5 font-mono text-[13px] leading-relaxed text-zinc-100 transition-colors placeholder:text-zinc-600 hover:border-zinc-700 focus:border-amber-400/60 focus:ring-2 focus:ring-amber-400/15 focus:outline-none"
    />
  );
}

function ReviewRounds({ value, onChange }: { readonly value: number; readonly onChange: (value: number) => void }) {
  return (
    <fieldset>
      <legend className="text-[13px] font-medium text-zinc-200">Review rounds</legend>
      <div className="mt-1.5 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg bg-zinc-950/70 p-1 ring-1 ring-inset ring-white/10">
          {[1, 2, 3].map((rounds) => (
            <label key={rounds} className="relative">
              <input
                type="radio"
                name="review-rounds"
                value={rounds}
                checked={value === rounds}
                onChange={() => onChange(rounds)}
                className="peer sr-only"
              />
              <span className="grid h-8 w-11 cursor-pointer place-items-center rounded-md text-sm font-medium text-zinc-400 transition-colors peer-checked:bg-zinc-800 peer-checked:text-zinc-50 peer-checked:shadow-sm peer-focus-visible:outline-2 peer-focus-visible:outline-amber-400 hover:text-zinc-200">
                {rounds}
              </span>
            </label>
          ))}
        </div>
        <p className="max-w-xs text-xs leading-relaxed text-zinc-500">
          How many times the reviewer can send a task back before it's accepted.
        </p>
      </div>
    </fieldset>
  );
}
