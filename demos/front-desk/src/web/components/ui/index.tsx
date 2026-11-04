import { AlertIcon, CheckCircleIcon, InfoIcon, StopIcon, XIcon, type Icon } from "@primer/octicons-react";
import { useState, type ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { initials } from "../../lib/format.js";
import { dismissToast, useStore } from "../../lib/store.js";

/** Primer's loading spinner. Give it a `label` when nothing else tells assistive technology that work is in progress. */
export function Spinner({ size = 16, className, label }: { readonly size?: number; readonly className?: string; readonly label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx("shrink-0 animate-spin", className)}
    >
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <path d="M15 8a7.002 7.002 0 00-7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A GitHub avatar, or initials for people who signed in with email. */
export function Avatar({ name, src, size = 32, className }: { readonly name: string; readonly src?: string; readonly size?: number; readonly className?: string }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  if (src && !failed) return <img src={src} alt="" style={style} className={cx("avatar", className)} onError={() => setFailed(true)} />;
  return (
    <span style={{ ...style, fontSize: Math.max(10, Math.round(size * 0.4)) }} className={cx("avatar avatar-initials", className)} aria-hidden>
      {initials(name)}
    </span>
  );
}

export type Tone = "info" | "success" | "warning" | "danger";

const FLASH: Readonly<Record<Tone, string>> = { info: "", success: "flash-success", warning: "flash-warn", danger: "flash-error" };
const ICONS: Readonly<Record<Tone, Icon>> = { info: InfoIcon, success: CheckCircleIcon, warning: AlertIcon, danger: StopIcon };

/** Primer flash banner. */
export function Callout({
  tone = "info",
  title,
  children,
  actions,
  compact = false,
  className,
  role,
}: {
  readonly tone?: Tone;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly compact?: boolean;
  readonly className?: string;
  readonly role?: "alert" | "status";
}) {
  const Glyph = ICONS[tone];
  return (
    <div role={role} className={cx("flash", FLASH[tone], compact && "flash-sm", className)}>
      <Glyph size={16} />
      <div className="flash-content">
        {title ? <div className="flash-title">{title}</div> : null}
        {children ? <div className={title ? "mt-1" : undefined}>{children}</div> : null}
      </div>
      {actions ? <div className="flash-actions">{actions}</div> : null}
    </div>
  );
}

/** Primer toasts, bottom left. */
export function Toasts() {
  const toasts = useStore((state) => state.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-50 flex flex-col gap-2" aria-live="polite">
      {toasts.map((item) => {
        const Glyph = item.tone === "success" ? CheckCircleIcon : item.tone === "info" ? InfoIcon : StopIcon;
        return (
          <div key={item.id} role={item.tone === "danger" ? "alert" : "status"} className={cx("Toast pointer-events-auto animate-slide-up", item.tone === "success" && "Toast--success", item.tone === "danger" && "Toast--error")}>
            <span className="Toast-icon">
              <Glyph size={16} />
            </span>
            <span className="Toast-content text-sm">{item.text}</span>
            <button type="button" className="Toast-dismissButton" aria-label="Dismiss" onClick={() => dismissToast(item.id)}>
              <XIcon size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
