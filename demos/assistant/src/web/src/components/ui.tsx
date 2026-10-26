/** Small building blocks on top of the GitHub theme's Primer classes: spinner, anchored menus, and modal focus. */
import { CheckIcon, type Icon } from "@primer/octicons-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** Primer's spinner. Pass a label when it is the only sign of progress. */
export function Spinner({ size = 16, className, label }: { size?: number; className?: string; label?: string }) {
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

export interface MenuItem {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: Icon;
  readonly danger?: boolean;
  /** Single-select menus (like the theme picker) mark the current choice. */
  readonly checked?: boolean;
  readonly disabled?: boolean;
  /** Why the item is disabled. */
  readonly title?: string;
  onSelect(): void;
}

export type MenuEntry = MenuItem | "divider";

export interface MenuTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  onClick(): void;
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
}

const ITEM_SELECTOR = '[role^="menuitem"]';

/**
 * A Primer ActionList menu in an Overlay, anchored under its trigger (flipped above when there's no room). It renders
 * in a portal with fixed positioning, so scrolling side panels never clip it.
 */
export function Menu({
  label,
  heading,
  items,
  align = "end",
  width = "w-56",
  renderTrigger,
}: {
  label: string;
  heading?: string;
  items: readonly MenuEntry[];
  align?: "start" | "end";
  width?: string;
  renderTrigger(props: MenuTriggerProps): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const selectable = items.some((item) => item !== "divider" && item.checked !== undefined);

  const close = (focusTrigger: boolean) => {
    setOpen(false);
    setPosition(undefined);
    if (focusTrigger) trigger.current?.focus();
  };

  /**
   * Anchors the overlay under its trigger (above it when there's more room there), inside the viewport. When neither
   * side fits the whole menu, it takes the larger side and scrolls.
   */
  const place = () => {
    if (!trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = menu.current.offsetWidth;
    const natural = menu.current.scrollHeight;
    const margin = 8;
    const left = Math.max(margin, Math.min(align === "end" ? rect.right - width : rect.left, window.innerWidth - width - margin));
    const spaceBelow = window.innerHeight - rect.bottom - 4 - margin;
    const spaceAbove = rect.top - 4 - margin;
    const above = natural > spaceBelow && spaceAbove > spaceBelow;
    const maxHeight = Math.max(0, Math.floor(above ? spaceAbove : spaceBelow));
    const height = Math.min(natural, maxHeight);
    const top = above ? rect.top - 4 - height : rect.bottom + 4;
    setPosition((current) => (current?.top === top && current.left === left && current.maxHeight === maxHeight ? current : { top, left, maxHeight }));
  };

  useLayoutEffect(() => {
    if (open) place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, align]);

  const placed = position !== undefined;
  useEffect(() => {
    if (!open || !placed) return;
    // Once per opening: the checked item, or the first one that can be chosen.
    const items = [...(menu.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])];
    (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items.find((item) => item.getAttribute("aria-disabled") !== "true") ?? items[0])?.focus();
  }, [open, placed]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    // Scrolling and resizing keep the menu anchored to its trigger, like Primer's anchored overlays.
    const onMove = () => place();
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = [...(menu.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])];
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      event.preventDefault();
      list[(next + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape") {
      // Handled here, so a dialog around the menu stays open.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      // Back on the trigger before the browser moves focus, so Tab continues from where the menu was opened (and a
      // surrounding dialog's focus trap sees focus inside it).
      close(true);
    }
  };

  return (
    <>
      {renderTrigger({
        ref: trigger,
        onClick: () => (open ? close(false) : setOpen(true)),
        onKeyDown: (event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        },
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": open ? id : undefined,
      })}
      {open &&
        createPortal(
          <div
            ref={menu}
            className={cx("Overlay fixed z-[60] animate-scale-in overflow-y-auto", width)}
            style={{ ...position, visibility: position ? "visible" : "hidden" }}
            onKeyDown={onMenuKeyDown}
          >
            <div id={id} role="menu" aria-label={label} className="ActionList">
              {heading && (
                <div className="ActionList-sectionHeading" aria-hidden>
                  {heading}
                </div>
              )}
              {items.map((item, index) =>
                item === "divider" ? (
                  <div key={`divider-${index}`} role="separator" className="ActionList-sectionDivider" />
                ) : (
                  <button
                    key={item.key}
                    type="button"
                    role={selectable ? "menuitemradio" : "menuitem"}
                    aria-checked={selectable ? Boolean(item.checked) : undefined}
                    aria-disabled={item.disabled || undefined}
                    title={item.title}
                    tabIndex={-1}
                    className={cx("ActionList-item", item.danger && "ActionList-item--danger")}
                    onClick={() => {
                      if (item.disabled) return;
                      close(true);
                      item.onSelect();
                    }}
                  >
                    {item.icon && <item.icon />}
                    <span className="ActionList-item-label">
                      {item.label}
                      {item.description && <span className="ActionList-item-description">{item.description}</span>}
                    </span>
                    {selectable && <span className="ActionList-item-trailing w-4">{item.checked && <CheckIcon />}</span>}
                  </button>
                ),
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal behavior for dialogs and drawers: moves focus in (to `[data-autofocus]` or the first control), keeps Tab
 * inside, closes on Escape, locks page scroll, and returns focus to where it was.
 */
export function useModal<T extends HTMLElement>(open: boolean, onClose: () => void): RefObject<T | null> {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const container = ref.current;
    if (!container) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
    (container.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0] ?? container).focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0]!;
      const last = list[list.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  return ref;
}
