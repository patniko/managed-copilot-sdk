import type { LucideIcon } from "lucide-react";
import { Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import type { Tone } from "../../lib/tone.js";
import { CountBadge } from "./Chip.js";
import { Link } from "./Link.js";

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly count?: number;
  readonly countTone?: Tone;
  readonly icon?: LucideIcon;
}

/** Page tabs. Each tab is a link, so tabs are bookmarkable and work with back/forward. */
export function Tabs({ items, active, hrefFor, label }: { readonly items: readonly TabItem[]; readonly active: string; readonly hrefFor: (id: string) => string; readonly label: string }) {
  return (
    <nav aria-label={label} className="-mb-px flex gap-1 overflow-x-auto">
      {items.map((item) => {
        const selected = item.id === active;
        const Icon = item.icon;
        return (
          <Link
            key={item.id}
            href={hrefFor(item.id)}
            replace
            aria-current={selected ? "page" : undefined}
            className={cx(
              "inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-[13px] font-medium whitespace-nowrap transition-colors",
              selected ? "border-amber-400 text-zinc-50" : "border-transparent text-zinc-400 hover:border-zinc-600 hover:text-zinc-200",
            )}
          >
            {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
            {item.label}
            {item.count !== undefined && item.count > 0 ? <CountBadge value={item.count} tone={item.countTone} /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly count?: number;
  readonly icon?: LucideIcon;
}

/** A single-choice filter shown as a row of toggle buttons. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  readonly label: string;
  readonly options: readonly SegmentOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cx("inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-zinc-900 p-0.5 ring-1 ring-inset ring-white/10", className)}>
      {options.map((option) => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cx(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors",
              selected ? "bg-zinc-700/80 text-zinc-50 shadow-sm ring-1 ring-inset ring-white/10" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
            )}
          >
            {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
            {option.label}
            {option.count !== undefined ? <span className={cx("tabular", selected ? "text-zinc-300" : "text-zinc-500")}>{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  allLabel,
  className,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  /** The empty choice ("All environments"). */
  readonly allLabel?: string;
  readonly className?: string;
}) {
  const id = useId();
  return (
    <div className={cx("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={id} className="text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-500">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 min-w-0 rounded-lg bg-zinc-900 px-2.5 text-[13px] text-zinc-200 ring-1 ring-inset ring-white/10 hover:ring-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70"
      >
        {allLabel !== undefined ? <option value="">{allLabel}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  /** Wait this long after typing stops before reporting the value. */
  readonly debounceMs?: number;
  readonly icon?: LucideIcon;
  readonly className?: string;
  readonly list?: string;
  readonly hideLabel?: boolean;
  readonly mono?: boolean;
}

/** A text filter with a clear button; reports changes after a short pause. */
export function TextField({ label, value, onChange, placeholder, debounceMs = 250, icon: Icon = Search, className, list, hideLabel = false, mono = false }: TextFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(onChange);
  latest.current = onChange;

  // The address changed outside this field (Clear, back/forward): show it, and drop any edit still waiting to apply.
  useEffect(() => {
    clearTimeout(timer.current);
    setDraft(value);
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const update = (next: string, immediate = false): void => {
    setDraft(next);
    clearTimeout(timer.current);
    if (immediate || debounceMs <= 0) latest.current(next);
    else timer.current = setTimeout(() => latest.current(next), debounceMs);
  };

  return (
    <div className={cx("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={id} className={cx("text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-500", hideLabel && "sr-only")}>
        {label}
      </label>
      <div className="relative">
        <Icon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-500" aria-hidden />
        <input
          id={id}
          type="text"
          value={draft}
          list={list}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          onChange={(event) => update(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") update(draft, true);
            if (event.key === "Escape" && draft) {
              event.stopPropagation();
              update("", true);
            }
          }}
          className={cx(
            "h-8 w-full min-w-0 rounded-lg bg-zinc-900 pr-8 pl-8 text-[13px] text-zinc-200 ring-1 ring-inset ring-white/10 placeholder:text-zinc-600 hover:ring-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70",
            mono && "font-mono text-[12px]",
          )}
        />
        {draft ? (
          <button
            type="button"
            onClick={() => update("", true)}
            aria-label={`Clear ${label.toLowerCase()}`}
            className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X className="size-3" aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A row of filters above a table. */
export function FilterBar({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <div className={cx("flex flex-wrap items-end gap-3", className)}>{children}</div>;
}
