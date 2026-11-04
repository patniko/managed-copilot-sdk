import { KebabHorizontalIcon } from "@primer/octicons-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { useDismiss } from "../../lib/useDismiss.js";

export interface MenuItem {
  readonly label: string;
  readonly icon: ReactNode;
  readonly onSelect: () => void;
  readonly danger?: boolean;
  readonly disabled?: boolean;
}

/** An overflow menu behind a kebab button: secondary and destructive actions. */
export function OverflowMenu({ label, items }: { readonly label: string; readonly items: readonly MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(container, open, close);
  return (
    <div ref={container} className="relative">
      <button type="button" className="btn btn-icon" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <KebabHorizontalIcon size={16} />
      </button>
      {open ? (
        <div className="Overlay absolute top-full right-0 z-40 mt-1 w-52 animate-scale-in" role="menu">
          <ul className="ActionList">
            {items.map((item) => (
              <li key={item.label} role="none">
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  className={cx("ActionList-item w-full", item.danger && "ActionList-item--danger")}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  <span className="flex w-4 justify-center">{item.icon}</span>
                  <span className="ActionList-item-label">{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
