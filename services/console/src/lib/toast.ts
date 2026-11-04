import { useSyncExternalStore } from "react";

export type ToastTone = "info" | "success" | "error";

export interface Toast {
  readonly id: number;
  readonly tone: ToastTone;
  readonly title: string;
  readonly message?: string;
  readonly durationMs: number;
}

let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  const next = toasts.filter((item) => item.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

/** Pauses auto-dismiss while the pointer or focus is on a toast. */
export function holdToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

export function releaseToast(id: number): void {
  const item = toasts.find((candidate) => candidate.id === id);
  if (!item || timers.has(id)) return;
  timers.set(id, setTimeout(() => dismissToast(id), Math.min(item.durationMs, 4000)));
}

export function showToast(tone: ToastTone, title: string, message?: string): number {
  const id = nextId++;
  const durationMs = tone === "error" ? 9000 : 5000;
  const duplicate = toasts.find((item) => item.tone === tone && item.title === title && item.message === message);
  if (duplicate) dismissToast(duplicate.id);
  toasts = [...toasts.slice(-3), { id, tone, title, message, durationMs }];
  timers.set(id, setTimeout(() => dismissToast(id), durationMs));
  emit();
  return id;
}

export const toast = {
  info: (title: string, message?: string) => showToast("info", title, message),
  success: (title: string, message?: string) => showToast("success", title, message),
  error: (title: string, message?: string) => showToast("error", title, message),
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(subscribe, () => toasts);
}
