// A line diff with three lines of context per hunk, for the deploy approval: small files, so a plain LCS is enough.
import type { DiffLine, FileChange } from "../shared/types.js";

const CONTEXT = 3;
/** Above this many cells the LCS table is too large; the change is shown as a whole-file replacement. */
const MAX_CELLS = 4_000_000;
const MAX_SHOWN = 400;

const linesOf = (text: string): string[] => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

type Op = { readonly kind: "context" | "add" | "del"; readonly text: string; readonly oldLine?: number; readonly newLine?: number };

function operations(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    return [...a.map((text, i): Op => ({ kind: "del", text, oldLine: i + 1 })), ...b.map((text, j): Op => ({ kind: "add", text, newLine: j + 1 }))];
  }
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: "context", text: a[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)) {
      ops.push({ kind: "add", text: b[j]!, newLine: j + 1 });
      j++;
    } else {
      ops.push({ kind: "del", text: a[i]!, oldLine: i + 1 });
      i++;
    }
  }
  return ops;
}

/** The change from `before` (absent for a new file) to `after`, as hunks separated by `gap` lines. */
export function diffFile(path: string, before: string | undefined, after: string): FileChange {
  const ops = operations(before === undefined ? [] : linesOf(before), linesOf(after));
  const changed = ops.map((op, index) => (op.kind === "context" ? -1 : index)).filter((index) => index >= 0);
  const keep = new Set<number>();
  for (const index of changed) for (let k = Math.max(0, index - CONTEXT); k <= Math.min(ops.length - 1, index + CONTEXT); k++) keep.add(k);
  const hunks: Op[][] = [];
  let previous = -2;
  for (const index of [...keep].sort((x, y) => x - y)) {
    if (index !== previous + 1) hunks.push([]);
    hunks.at(-1)!.push(ops[index]!);
    previous = index;
  }
  const lines: DiffLine[] = [];
  for (const hunk of hunks) {
    const oldCount = hunk.filter((op) => op.kind !== "add").length;
    const newCount = hunk.filter((op) => op.kind !== "del").length;
    const oldStart = hunk.find((op) => op.oldLine !== undefined)?.oldLine ?? 0;
    const newStart = hunk.find((op) => op.newLine !== undefined)?.newLine ?? 0;
    lines.push({ kind: "gap", text: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@` }, ...hunk);
  }
  return {
    path,
    status: before === undefined ? "added" : "modified",
    added: ops.filter((op) => op.kind === "add").length,
    removed: ops.filter((op) => op.kind === "del").length,
    lines: lines.slice(0, MAX_SHOWN),
  };
}
