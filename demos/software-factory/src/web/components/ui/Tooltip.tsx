import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/cx.js";

export interface TooltipProps {
  readonly content: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly disabled?: boolean;
  /** Milliseconds a pointer must rest before the tooltip shows; keyboard focus shows it at once. */
  readonly delay?: number;
  /** `start` left-aligns the text, for multi-line details. */
  readonly align?: "center" | "start";
}

/** Hover/focus tooltip rendered in a portal so scroll containers never clip it. */
export function Tooltip({ content, children, className, disabled = false, delay = 0, align = "center" }: TooltipProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const id = useId();
  const show = (target: HTMLElement, wait: number): void => {
    clearTimeout(timer.current);
    if (disabled || !content) return;
    if (wait <= 0) setAnchor(target.getBoundingClientRect());
    else timer.current = setTimeout(() => setAnchor(target.getBoundingClientRect()), wait);
  };
  const hide = useCallback((): void => {
    clearTimeout(timer.current);
    setAnchor(null);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <span
      className={cx("inline-flex min-w-0", className)}
      onMouseEnter={(event) => show(event.currentTarget, delay)}
      onMouseLeave={hide}
      onPointerDown={hide}
      onFocus={(event) => {
        // A click focuses buttons too; only keyboard focus (focus-visible) should open the tooltip.
        if (event.target instanceof HTMLElement && event.target.matches(":focus-visible")) show(event.currentTarget, 0);
      }}
      onBlur={hide}
      aria-describedby={anchor ? id : undefined}
    >
      {children}
      {anchor
        ? createPortal(
            <Bubble id={id} anchor={anchor} onDismiss={hide} align={align}>
              {content}
            </Bubble>,
            document.body,
          )
        : null}
    </span>
  );
}

function Bubble({
  id,
  anchor,
  onDismiss,
  align,
  children,
}: {
  readonly id: string;
  readonly anchor: DOMRect;
  readonly onDismiss: () => void;
  readonly align: "center" | "start";
  readonly children: ReactNode;
}) {
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
    <div
      ref={ref}
      id={id}
      role="tooltip"
      style={{ position: "fixed", left: position?.left ?? -9999, top: position?.top ?? -9999 }}
      className={cx("Tooltip animate-fade-in", align === "start" && "max-w-96 text-left")}
    >
      {children}
    </div>
  );
}
