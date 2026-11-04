import type { Icon } from "@primer/octicons-react";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { cx } from "../../lib/cx.js";

export interface PopoverTriggerProps {
  readonly ref: RefObject<HTMLButtonElement | null>;
  readonly "aria-expanded": boolean;
  readonly "aria-haspopup": "dialog" | "menu";
  readonly "aria-controls": string | undefined;
  readonly onClick: () => void;
}

export interface PopoverProps {
  /** Renders the trigger; spread the props onto a `<button>`. */
  readonly trigger: (props: PopoverTriggerProps) => ReactNode;
  readonly children: ReactNode | ((close: () => void) => ReactNode);
  /** Accessible name of the overlay. */
  readonly label: string;
  readonly role?: "dialog" | "menu";
  /** Which edge of the trigger the overlay lines up with. */
  readonly align?: "start" | "end";
  readonly className?: string;
  readonly overlayClassName?: string;
}

const MENU_ITEM = '[role="menuitem"]:not([disabled])';

/** A Primer overlay anchored under its trigger: closes on Escape (returning focus) or a press outside. */
export function Popover({ trigger, children, label, role = "dialog", align = "end", className, overlayClassName }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const id = useId();
  // Choosing something inside returns focus to the trigger first, so a dialog it opens can hand focus back there.
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const element = overlay.current;
    const first = role === "menu" ? element?.querySelector<HTMLElement>(MENU_ITEM) : undefined;
    (first ?? element)?.focus();
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, role]);

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (role !== "menu") return;
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    const items = [...(overlay.current?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? [])];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown" ? (index + 1) % items.length
      : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length
      : event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div ref={container} className={cx("relative min-w-0", className)}>
      {trigger({
        ref: button,
        "aria-expanded": open,
        "aria-haspopup": role,
        "aria-controls": open ? id : undefined,
        onClick: () => setOpen((value) => !value),
      })}
      {open ? (
        <div
          ref={overlay}
          id={id}
          role={role}
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onMenuKey}
          className={cx(
            "Overlay absolute top-full z-40 mt-1 animate-scale-in text-left outline-none",
            align === "end" ? "right-0 origin-top-right" : "left-0 origin-top-left",
            overlayClassName,
          )}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      ) : null}
    </div>
  );
}

/** A Primer ActionList item inside a `role="menu"` popover. */
export function MenuItem({
  icon: Glyph,
  children,
  danger = false,
  onSelect,
}: {
  readonly icon?: Icon;
  readonly children: ReactNode;
  readonly danger?: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button type="button" role="menuitem" tabIndex={-1} onClick={onSelect} className={cx("ActionList-item", danger && "ActionList-item--danger")}>
      {Glyph ? <Glyph size={16} /> : null}
      <span className="ActionList-item-label">{children}</span>
    </button>
  );
}
