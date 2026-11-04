import type { OperatorActionResult } from "@managed-copilot/protocol/operator";
import { useSyncExternalStore, type ReactNode } from "react";

/**
 * A guarded operator action (stop a sandbox, check the backend, pause or resume a schedule, retry a delivery). The
 * dialog states exactly what will happen, runs it on confirmation, and stays open with the error if it fails.
 */
export interface GuardedAction {
  readonly title: string;
  /** Exactly what will happen. */
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly tone?: "danger" | "default";
  /** An optional free-text reason recorded with the action. */
  readonly reason?: { readonly label: string; readonly placeholder?: string; readonly maxLength?: number };
  readonly run: (reason: string | undefined) => Promise<OperatorActionResult | undefined>;
  /** Toast title on success; the toast body is the gateway's message. */
  readonly successTitle: string;
  /** Toast body when the gateway answers without a message. */
  readonly fallbackMessage?: string;
  /** Toast title on failure; the toast body is the gateway's error message. */
  readonly failureTitle: string;
  readonly onDone?: () => void;
}

export interface GuardedActionRequest extends GuardedAction {
  readonly id: number;
}

let current: GuardedActionRequest | undefined;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function requestGuardedAction(action: GuardedAction): void {
  current = { ...action, id: nextId++ };
  emit();
}

export function closeGuardedAction(id?: number): void {
  if (!current || (id !== undefined && current.id !== id)) return;
  current = undefined;
  emit();
}

export function useGuardedAction(): GuardedActionRequest | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
