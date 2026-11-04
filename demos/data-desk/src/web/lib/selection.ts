import { useSyncExternalStore } from "react";

// Which table the grid shows for each analysis: one of the tools' results, or the dataset (undefined).
const selections = new Map<string, string | undefined>();
const listeners = new Set<() => void>();

export function selectResult(analysisId: string, resultId: string | undefined): void {
  if (selections.get(analysisId) === resultId) return;
  selections.set(analysisId, resultId);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSelectedResult(analysisId: string): string | undefined {
  return useSyncExternalStore(subscribe, () => selections.get(analysisId));
}
