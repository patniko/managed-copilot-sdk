import type { Icon } from "@primer/octicons-react";
import { useId, type ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { TONE_TEXT, type Tone } from "../../lib/tone.js";
import { None } from "./Feedback.js";

export interface CardProps {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  /** A leading Octicon in the header. */
  readonly icon?: Icon;
  readonly iconTone?: Tone;
  /** Extra header content (status labels, buttons). */
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
  readonly id?: string;
  /** Pad the body (tables and lists render edge to edge). */
  readonly padded?: boolean;
  /** `danger` draws the red border of a settings "Danger zone". */
  readonly variant?: "default" | "danger";
}

/** A Primer `Box` with a `Box-header` title, an optional description and actions, and a body. */
export function Card({ title, description, icon: HeaderIcon, iconTone = "neutral", actions, children, className, bodyClassName, id, padded = true, variant = "default" }: CardProps) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={title ? headingId : undefined}
      className={cx("Box min-w-0 scroll-mt-4", !padded && "overflow-hidden", variant === "danger" && "Box--danger", className)}
    >
      {title ? (
        <header className="Box-header flex-wrap">
          <div className="min-w-0 flex-1">
            <h2 id={headingId} className="Box-title flex min-w-0 items-center gap-2">
              {HeaderIcon ? <HeaderIcon size={16} className={TONE_TEXT[iconTone]} /> : null}
              <span className="min-w-0 break-words">{title}</span>
            </h2>
            {description ? <div className="mt-0.5 text-xs text-fg-muted">{description}</div> : null}
          </div>
          {actions ? <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">{actions}</div> : null}
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

/** One fact: a 12px semibold muted label over its value, like the headings in a pull request's sidebar. */
export function Field({ label, children, wide = false, mono = false, hint, className }: FieldProps) {
  return (
    <div className={cx("min-w-0", wide && "sm:col-span-full", className)}>
      <dt className="text-xs font-semibold text-fg-muted">{label}</dt>
      <dd className={cx("mt-1 min-w-0 break-words text-fg", mono && "font-mono text-xs")}>{isEmpty(children) ? <None /> : children}</dd>
      {hint ? <p className="mt-1 text-xs text-fg-muted">{hint}</p> : null}
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
    <div className="Table-container">
      <table className="Table Table--condensed" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">{keyHeader}</th>
            <th scope="col">{valueHeader}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, value]) => (
            <tr key={key} className="align-top">
              <th scope="row" className="font-mono text-xs">
                {key}
              </th>
              <td className={cx("break-all", monoValues && "font-mono text-xs")}>{isEmpty(value) ? <None /> : value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
