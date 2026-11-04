import { useCallback, useRef, useState } from "react";
import { useDismiss } from "./useDismiss.js";

/** Open state for a popover or menu anchored in `container`: Escape or a press outside closes it. */
export function usePopover<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const container = useRef<T>(null);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  useDismiss(container, open, close);
  return { open, close, toggle, container };
}