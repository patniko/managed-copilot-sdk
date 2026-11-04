import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/cx.js";

/** Hover/focus tooltip rendered in a portal so scroll containers never clip it. */
export function Tooltip({ content, children, className }: { readonly content: ReactNode; readonly children: ReactNode; readonly className?: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const id = useId();
  const hide = useCallback((): void => setAnchor(null), []);
  const show = (target: HTMLElement): void => {
    if (content) setAnchor(target.getBoundingClientRect());
  };
  return (
    <span
      className={cx("inline-flex min-w-0", className)}
      onMouseEnter={(event) => show(event.currentTarget)}
      onMouseLeave={hide}
      onFocus={(event) => show(event.currentTarget)}
      onBlur={hide}
      aria-describedby={anchor ? id : undefined}
    >
      {children}
      {anchor
        ? createPortal(
            <Bubble id={id} anchor={anchor} onDismiss={hide}>
              {content}
            </Bubble>,
            document.body,
          )
        : null}
    </span>
  );
}

function Bubble({ id, anchor, onDismiss, children }: { readonly id: string; readonly anchor: DOMRect; readonly onDismiss: () => void; readonly children: ReactNode }) {
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
    <div ref={ref} id={id} role="tooltip" style={{ position: "fixed", left: position?.left ?? -9999, top: position?.top ?? -9999 }} className="Tooltip animate-fade-in">
      {children}
    </div>
  );
}
