import { SearchIcon, XIcon, type Icon } from "@primer/octicons-react";
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
  readonly icon?: Icon;
}

/** Page tabs as a Primer `UnderlineNav`. Each tab is a link, so tabs are bookmarkable and work with back/forward. */
export function Tabs({ items, active, hrefFor, label }: { readonly items: readonly TabItem[]; readonly active: string; readonly hrefFor: (id: string) => string; readonly label: string }) {
  return (
    <nav aria-label={label} className="UnderlineNav">
      <ul className="UnderlineNav-body">
        {items.map((item) => {
          const selected = item.id === active;
          const TabIcon = item.icon;
          return (
            <li key={item.id}>
              <Link href={hrefFor(item.id)} replace aria-current={selected ? "page" : undefined} className="UnderlineNav-item">
                {TabIcon ? <TabIcon size={16} /> : null}
                {item.label}
                {item.count !== undefined && item.count > 0 ? <CountBadge value={item.count} tone={item.countTone} /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly count?: number;
  readonly icon?: Icon;
}

/** A single-choice filter as a Primer `SegmentedControl`. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  size = "md",
  className,
}: {
  readonly label: string;
  readonly options: readonly SegmentOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly size?: "sm" | "md";
  readonly className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cx("SegmentedControl relative max-w-full overflow-x-auto", size === "sm" && "SegmentedControl--sm", className)}>
      {options.map((option) => {
        const selected = option.value === value;
        const OptionIcon = option.icon;
        return (
          <button key={option.value} type="button" aria-pressed={selected} onClick={() => onChange(option.value)} className="SegmentedControl-item shrink-0">
            {OptionIcon ? <OptionIcon size={16} /> : null}
            {option.label}
            {option.count !== undefined ? <span className={cx("tabular-nums", selected ? "text-fg" : "text-fg-muted")}>{option.count}</span> : null}
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

/** A filter select (Primer `form-select`). The label is visually hidden unless `showLabel`: the first option names the filter. */
export function SelectField({
  label,
  value,
  onChange,
  options,
  allLabel,
  showLabel = false,
  className,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  /** The empty choice ("All environments"). */
  readonly allLabel?: string;
  readonly showLabel?: boolean;
  readonly className?: string;
}) {
  const id = useId();
  return (
    <div className={cx("FormControl min-w-0", className)}>
      <label htmlFor={id} className={cx("FormControl-label", !showLabel && "sr-only")}>
        {label}
      </label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className="form-select input-block">
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
  readonly icon?: Icon;
  readonly className?: string;
  readonly list?: string;
  /** Show the label above the field (it is visually hidden otherwise; the placeholder names the filter). */
  readonly showLabel?: boolean;
  readonly mono?: boolean;
}

/** A filter input (Primer `form-control` with a leading Octicon and a clear button); reports changes after a short pause. */
export function TextField({ label, value, onChange, placeholder, debounceMs = 250, icon: LeadingIcon = SearchIcon, className, list, showLabel = false, mono = false }: TextFieldProps) {
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
    <div className={cx("FormControl min-w-0", className)}>
      <label htmlFor={id} className={cx("FormControl-label", !showLabel && "sr-only")}>
        {label}
      </label>
      <div className="relative">
        <LeadingIcon size={16} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-muted" />
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
          className={cx("form-control input-block pr-8 pl-8", mono && "input-monospace")}
        />
        {draft ? (
          <button type="button" onClick={() => update("", true)} aria-label={`Clear ${label.toLowerCase()}`} className="btn-octicon absolute top-1/2 right-0.5 -translate-y-1/2">
            <XIcon size={16} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A row of filters above a list. */
export function FilterBar({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <div className={cx("flex flex-wrap items-center gap-2", className)}>{children}</div>;
}
