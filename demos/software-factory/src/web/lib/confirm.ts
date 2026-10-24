import { useSyncExternalStore } from "react";

export interface ConfirmOptions {
  readonly title: string;
  readonly message?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly tone?: "danger" | "default";
}

export interface ConfirmRequest extends ConfirmOptions {
  readonly id: number;
  readonly resolve: (confirmed: boolean) => void;
}

let current: ConfirmRequest | undefined;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Opens the confirm dialog and resolves with the user's choice. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  current?.resolve(false);
  return new Promise<boolean>((resolve) => {
    const id = nextId++;
    current = {
      ...options,
      id,
      resolve: (confirmed) => {
        if (current?.id === id) {
          current = undefined;
          emit();
        }
        resolve(confirmed);
      },
    };
    emit();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConfirmRequest(): ConfirmRequest | undefined {
  return useSyncExternalStore(subscribe, () => current);
}
