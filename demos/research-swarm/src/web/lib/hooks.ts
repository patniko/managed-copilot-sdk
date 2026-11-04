import { useEffect, useState, type RefObject } from "react";

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

/** The current time, updated every `ms` while `active`. */
export function useNow(active: boolean, ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}
