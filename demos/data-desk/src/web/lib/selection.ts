import { useSyncExternalStore } from "react";
import type { TableRef } from "../../shared/types.js";

// What the grid shows and what the person picked in it, per analysis: which table is on screen (one of the tools'
// results, or the dataset), the rows selected in each table (each keeps its own selection when another is shown), and
// how many of the dataset's rows the grid has loaded.
const selections = new Map<string, string | undefined>();
const rowSelections = new Map<string, ReadonlyMap<string, ReadonlySet<number>>>();
/** The row last clicked in each table: a shift-click selects from it. */
const anchors = new Map<string, number>();
const loadedRows = new Map<string, number>();
const listeners = new Set<() => void>();

const EMPTY_ROWS: ReadonlySet<number> = new Set();
const EMPTY_TABLES: ReadonlyMap<string, ReadonlySet<number>> = new Map();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function selectResult(analysisId: string, resultId: string | undefined): void {
  if (selections.get(analysisId) === resultId) return;
  selections.set(analysisId, resultId);
  emit();
}

export function useSelectedResult(analysisId: string): string | undefined {
  return useSyncExternalStore(subscribe, () => selections.get(analysisId));
}

/** A table's key in the selection store. */
export const tableKey = (table: TableRef): string => (table.kind === "dataset" ? "dataset" : `result:${table.resultId}`);

/** The table a key names. */
export const tableOf = (key: string): TableRef => (key.startsWith("result:") ? { kind: "result", resultId: key.slice("result:".length) } : { kind: "dataset" });

function setRows(analysisId: string, key: string, rows: ReadonlySet<number>): void {
  const tables = new Map(rowSelections.get(analysisId) ?? EMPTY_TABLES);
  if (rows.size) tables.set(key, rows);
  else tables.delete(key);
  rowSelections.set(analysisId, tables);
  emit();
}

/**
 * Selects or clears a row. With `range`, every row from the one clicked before to this one takes this row's new state,
 * the way shift-click works in a list.
 */
export function toggleRow(analysisId: string, key: string, index: number, range = false): void {
  const current = rowSelections.get(analysisId)?.get(key) ?? EMPTY_ROWS;
  const select = !current.has(index);
  const next = new Set(current);
  const anchorKey = `${analysisId}\n${key}`;
  const anchor = anchors.get(anchorKey);
  const [from, to] = range && anchor !== undefined ? [Math.min(anchor, index), Math.max(anchor, index)] : [index, index];
  for (let row = from; row <= to; row++) {
    if (select) next.add(row);
    else next.delete(row);
  }
  anchors.set(anchorKey, index);
  setRows(analysisId, key, next);
}

/** Adds a row to the selection (Shift+Arrow): it becomes the anchor for the next shift-click. */
export function addRow(analysisId: string, key: string, index: number): void {
  const current = rowSelections.get(analysisId)?.get(key) ?? EMPTY_ROWS;
  anchors.set(`${analysisId}\n${key}`, index);
  if (!current.has(index)) setRows(analysisId, key, new Set([...current, index]));
}

/** Selects the first `count` rows, or clears them all when they're all selected already. */
export function toggleAllRows(analysisId: string, key: string, count: number): void {
  const current = rowSelections.get(analysisId)?.get(key) ?? EMPTY_ROWS;
  const all = count > 0 && current.size >= count && Array.from({ length: count }, (_, row) => row).every((row) => current.has(row));
  setRows(analysisId, key, all ? EMPTY_ROWS : new Set(Array.from({ length: count }, (_, row) => row)));
}

export function clearRows(analysisId: string, key: string): void {
  anchors.delete(`${analysisId}\n${key}`);
  if (rowSelections.get(analysisId)?.has(key)) setRows(analysisId, key, EMPTY_ROWS);
}

/** The rows selected in one table. */
export function useSelectedRows(analysisId: string, key: string): ReadonlySet<number> {
  return useSyncExternalStore(subscribe, () => rowSelections.get(analysisId)?.get(key) ?? EMPTY_ROWS);
}

/** Every table's selected rows in an analysis, by table key. */
export function useRowSelections(analysisId: string): ReadonlyMap<string, ReadonlySet<number>> {
  return useSyncExternalStore(subscribe, () => rowSelections.get(analysisId) ?? EMPTY_TABLES);
}

/** How many of the dataset's rows the grid has loaded: "the current view" sends those. */
export function setLoadedRows(analysisId: string, count: number): void {
  if (loadedRows.get(analysisId) === count) return;
  loadedRows.set(analysisId, count);
  emit();
}

export function useLoadedRows(analysisId: string): number | undefined {
  return useSyncExternalStore(subscribe, () => loadedRows.get(analysisId));
}
