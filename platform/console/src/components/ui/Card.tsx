import type { LucideIcon } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { TONE_TILE, type Tone } from "../../lib/tone.js";
import { None } from "./Feedback.js";

export interface CardProps {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly icon?: LucideIcon;
  readonly iconTone?: Tone;
  /** Extra header content (status badges, buttons). */
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
  readonly id?: string;
  /** Pad the body (tables usually render edge to edge). */
  readonly padded?: boolean;
}

export function Card({ title, description, icon: Icon, iconTone = "neutral", actions, children, className, bodyClassName, id, padded = true }: CardProps) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={title ? headingId : undefined}
      className={cx("min-w-0 scroll-mt-4 rounded-2xl border border-zinc-800/80 bg-zinc-900/40 shadow-sm shadow-black/20", className)}
    >
      {title ? (
        <header className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-zinc-800/70 px-4 py-3">
          {Icon ? (
            <span className={cx("grid size-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset", TONE_TILE[iconTone])}>
              <Icon className="size-4" aria-hidden />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 id={headingId} className="text-[14px] font-semibold leading-8 text-zinc-100">
              {title}
            </h2>
            {description ? <div className="-mt-0.5 text-[12.5px] leading-relaxed text-zinc-500">{description}</div> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2 self-center">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx(padded && "p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

function isEmpty(value: ReactNode): boolean {
  return value === undefined || value === null || value === "" || value === false;
}

export interface FieldGridProps {
  readonly children: ReactNode;
  readonly columns?: 2 | 3 | 4;
  readonly className?: string;
}

/** Label-over-value facts in a responsive grid (a `<dl>`). */
export function FieldGrid({ children, columns = 3, className }: FieldGridProps) {
  return (
    <dl
      className={cx(
        "grid gap-x-6 gap-y-4",
        columns === 2 && "sm:grid-cols-2",
        columns === 3 && "sm:grid-cols-2 xl:grid-cols-3",
        columns === 4 && "sm:grid-cols-2 xl:grid-cols-4",
        className,
      )}
    >
      {children}
    </dl>
  );
}

export interface FieldProps {
  readonly label: ReactNode;
  readonly children?: ReactNode;
  /** Span the whole grid row. */
  readonly wide?: boolean;
  readonly mono?: boolean;
  readonly hint?: ReactNode;
  readonly className?: string;
}

export function Field({ label, children, wide = false, mono = false, hint, className }: FieldProps) {
  return (
    <div className={cx("min-w-0", wide && "sm:col-span-full", className)}>
      <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-zinc-500">{label}</dt>
      <dd className={cx("mt-1 min-w-0 break-words text-[13px] text-zinc-200", mono && "font-mono text-[12px]")}>{isEmpty(children) ? <None /> : children}</dd>
      {hint ? <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-500">{hint}</p> : null}
    </div>
  );
}

/** A plain key/value table (environment variables, options, facts). */
export function KeyValueTable({
  rows,
  label,
  keyHeader = "Name",
  valueHeader = "Value",
  monoValues = true,
}: {
  readonly rows: readonly (readonly [string, ReactNode])[];
  readonly label: string;
  readonly keyHeader?: string;
  readonly valueHeader?: string;
  readonly monoValues?: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800/80">
      <table className="w-full text-left text-[12.5px]" aria-label={label}>
        <thead className="bg-zinc-900/60 text-[11px] uppercase tracking-[0.06em] text-zinc-500">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              {keyHeader}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {valueHeader}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, value]) => (
            <tr key={key} className="border-t border-zinc-800/60 align-top">
              <th scope="row" className="px-3 py-2 font-mono font-normal text-zinc-300">
                {key}
              </th>
              <td className={cx("px-3 py-2 break-all text-zinc-200", monoValues && "font-mono")}>{isEmpty(value) ? <None /> : value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
