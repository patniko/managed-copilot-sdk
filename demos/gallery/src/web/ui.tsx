import { CheckIcon, CopyIcon, XIcon } from "@primer/octicons-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export const cx = (...names: readonly (string | false | null | undefined)[]): string => names.filter(Boolean).join(" ");

/** Primer's loading spinner. Give it a `label` when nothing else says that work is in progress. */
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

/** Calls `onDismiss` on Escape or a pointer press outside `ref` while `active`. */
export function useDismiss(ref: RefObject<HTMLElement | null>, active: boolean, onDismiss: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onPointer = (event: PointerEvent): void => {
      const element = ref.current;
      if (element && event.target instanceof Node && !element.contains(event.target)) onDismiss();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, active, onDismiss]);
}

/** Hover and focus tooltip, rendered in a portal so cards never clip it. `block` wraps block content in a div. */
export function Tooltip({
  content,
  children,
  className,
  block,
  wide,
}: {
  readonly content: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly block?: boolean;
  /** Room for a command on one line. */
  readonly wide?: boolean;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const id = useId();
  const show = (target: HTMLElement): void => {
    if (content) setAnchor(target.getBoundingClientRect());
  };
  const hide = useCallback((): void => setAnchor(null), []);
  const Wrapper = block ? "div" : "span";
  return (
    <Wrapper
      className={cx(block ? "min-w-0" : "inline-flex min-w-0", className)}
      onMouseEnter={(event) => show(event.currentTarget)}
      onMouseLeave={hide}
      onFocus={(event) => show(event.currentTarget)}
      onBlur={hide}
      aria-describedby={anchor ? id : undefined}
    >
      {children}
      {anchor
        ? createPortal(
            <Bubble id={id} anchor={anchor} onDismiss={hide} wide={wide}>
              {content}
            </Bubble>,
            document.body,
          )
        : null}
    </Wrapper>
  );
}

function Bubble({ id, anchor, onDismiss, wide, children }: { readonly id: string; readonly anchor: DOMRect; readonly onDismiss: () => void; readonly wide?: boolean; readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ readonly left: number; readonly top: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const gap = 6;
    const above = anchor.top - height - gap >= 4;
    const top = above ? anchor.top - height - gap : anchor.bottom + gap;
    const left = Math.min(Math.max(6, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - width - 6);
    setPosition((current) => (current && current.left === left && current.top === top ? current : { left, top }));
  }, [anchor, children]);
  useEffect(() => {
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    return () => {
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
    };
  }, [onDismiss]);
  return (
    <div ref={ref} id={id} role="tooltip" style={{ position: "fixed", left: position?.left ?? -9999, top: position?.top ?? -9999 }} className={cx("Tooltip animate-fade-in", wide && "max-w-[min(32rem,calc(100vw-1rem))]")}>
      {children}
    </div>
  );
}

type CopyState = "idle" | "copied" | "failed";

/** Copies `text`; shows it in a tooltip first, then whether it worked. */
export function CopyButton({
  text,
  children,
  label,
  tooltip,
  className,
}: {
  readonly text: string;
  /** Visible content; without it the button is icon-only. */
  readonly children?: ReactNode;
  /** Accessible name. */
  readonly label: string;
  readonly tooltip?: ReactNode;
  readonly className?: string;
}) {
  const [copy, setCopy] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const settle = (next: CopyState) => {
    setCopy(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopy("idle"), 1_600);
  };
  const icon =
    copy === "copied" ? <CheckIcon size={16} className="text-fg-success" /> : copy === "failed" ? <XIcon size={16} className="text-fg-danger" /> : <CopyIcon size={16} />;
  return (
    <Tooltip wide content={copy === "copied" ? "Copied" : copy === "failed" ? "Couldn't copy: your browser blocked the clipboard" : (tooltip ?? text)}>
      <button
        type="button"
        className={cx("btn btn-sm", !children && "btn-icon", className)}
        aria-label={copy === "copied" ? `${label}: copied` : label}
        onClick={() => {
          // Absent outside secure contexts (plain http on a host other than localhost).
          const clipboard = navigator.clipboard as Clipboard | undefined;
          if (!clipboard) return settle("failed");
          clipboard.writeText(text).then(
            () => settle("copied"),
            () => settle("failed"),
          );
        }}
      >
        {icon}
        {children}
      </button>
    </Tooltip>
  );
}
