import { KebabHorizontalIcon, type Icon } from "@primer/octicons-react";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { cx } from "../../lib/cx.js";
import { usePopover } from "../../lib/usePopover.js";
import { IconButton } from "./Button.js";

export interface MenuItem {
  readonly label: string;
  readonly icon?: Icon;
  readonly onSelect: () => void;
  readonly danger?: boolean;
  readonly disabled?: boolean;
}

/** A `KebabHorizontalIcon` button with a Primer action menu: arrow keys move, Enter picks, Escape closes. */
export function OverflowMenu({ label, items, className }: { readonly label: string; readonly items: readonly MenuItem[]; readonly className?: string }) {
  const { open, toggle, close, container } = usePopover();
  const list = useRef<HTMLUListElement>(null);
  const trigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    list.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => trigger.current?.focus();
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div ref={container} className={cx("relative", className)}>
      <IconButton icon={KebabHorizontalIcon} label={label} aria-haspopup="menu" aria-expanded={open} onClick={toggle} />
      {open ? (
        <div className="Overlay absolute top-full right-0 z-40 mt-1 w-60 animate-scale-in">
          <ul ref={list} role="menu" aria-label={label} className="ActionList" onKeyDown={onKeyDown}>
            {items.map((item) => {
              const Glyph = item.icon;
              return (
                <li key={item.label} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    className={cx("ActionList-item", item.danger && "ActionList-item--danger")}
                    onClick={() => {
                      close();
                      item.onSelect();
                    }}
                  >
                    {Glyph ? <Glyph size={16} /> : null}
                    <span className="ActionList-item-label">{item.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
