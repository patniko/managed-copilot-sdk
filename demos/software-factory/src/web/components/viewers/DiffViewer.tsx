import { ChevronDown, ChevronRight, FileDiff } from "lucide-react";
import { useMemo, useState } from "react";
import { cx } from "../../lib/cx.js";
import { pluralize } from "../../lib/format.js";
import { Chip } from "../ui/Chip.js";
import { CodeViewer } from "./CodeViewer.js";

type LineKind = "add" | "del" | "ctx" | "meta";

interface DiffLine {
  readonly kind: LineKind;
  readonly text: string;
  readonly oldNo?: number;
  readonly newNo?: number;
}

interface DiffHunk {
  readonly header: string;
  readonly lines: DiffLine[];
}

interface DiffFile {
  oldPath: string;
  newPath: string;
  status: "modified" | "added" | "deleted" | "renamed";
  binary: boolean;
  additions: number;
  deletions: number;
  readonly hunks: DiffHunk[];
}

function stripPrefix(path: string): string {
  const trimmed = path.trim().replace(/\t.*$/, "");
  if (trimmed === "/dev/null") return trimmed;
  return trimmed.replace(/^"|"$/g, "").replace(/^[ab]\//, "");
}

/** Parses a unified diff (git or plain). Hunk line counts decide where a hunk ends. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;

  const startFile = (): DiffFile => {
    const created: DiffFile = { oldPath: "", newPath: "", status: "modified", binary: false, additions: 0, deletions: 0, hunks: [] };
    files.push(created);
    hunk = undefined;
    return created;
  };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const marker = line[0];
      if (marker === "+") {
        hunk.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
        newLeft -= 1;
        if (file) file.additions += 1;
        continue;
      }
      if (marker === "-") {
        hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
        oldLeft -= 1;
        if (file) file.deletions += 1;
        continue;
      }
      if (marker === " " || line === "") {
        hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
      if (marker === "\\") {
        hunk.lines.push({ kind: "meta", text: line });
        continue;
      }
      // Malformed hunk: fall through and treat the line as a header.
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith("\\") && hunk) {
      hunk.lines.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("diff --git ")) {
      file = startFile();
      const match = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      if (match) {
        file.oldPath = match[1] ?? "";
        file.newPath = match[2] ?? "";
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      if (!file || file.hunks.length > 0) file = startFile();
      file.oldPath = stripPrefix(line.slice(4));
      if (file.oldPath === "/dev/null") file.status = "added";
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (!file) file = startFile();
      file.newPath = stripPrefix(line.slice(4));
      if (file.newPath === "/dev/null") file.status = "deleted";
      continue;
    }
    const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkHeader) {
      if (!file) file = startFile();
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      oldNo = Number(hunkHeader[1]);
      oldLeft = hunkHeader[2] === undefined ? 1 : Number(hunkHeader[2]);
      newNo = Number(hunkHeader[3]);
      newLeft = hunkHeader[4] === undefined ? 1 : Number(hunkHeader[4]);
      continue;
    }
    if (!file) continue;
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.newPath = line.slice("rename to ".length);
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) file.binary = true;
  }
  return files.filter((candidate) => candidate.hunks.length > 0 || candidate.binary || candidate.status !== "modified");
}

const STATUS_CHIP: Readonly<Record<DiffFile["status"], { readonly label: string; readonly tone: "success" | "danger" | "active" } | undefined>> = {
  modified: undefined,
  added: { label: "Added", tone: "success" },
  deleted: { label: "Deleted", tone: "danger" },
  renamed: { label: "Renamed", tone: "active" },
};

function displayPath(file: DiffFile): string {
  if (file.status === "deleted") return file.oldPath;
  if (file.status === "renamed" && file.oldPath && file.oldPath !== file.newPath) return `${file.oldPath} → ${file.newPath}`;
  return file.newPath || file.oldPath;
}

export function DiffViewer({ text }: { readonly text: string }) {
  const files = useMemo(() => parseUnifiedDiff(text), [text]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const totals = useMemo(
    () => files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 }),
    [files],
  );

  if (files.length === 0) {
    return <CodeViewer code={text} language="diff" />;
  }

  const toggle = (index: number): void =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <div className="space-y-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
        <span className="inline-flex items-center gap-1.5">
          <FileDiff className="size-3.5 text-zinc-500" aria-hidden />
          {pluralize(files.length, "file")} changed
        </span>
        <span className="font-mono text-emerald-300">+{totals.additions}</span>
        <span className="font-mono text-rose-300">−{totals.deletions}</span>
      </div>
      {files.map((file, index) => {
        const open = !collapsed.has(index);
        const chip = STATUS_CHIP[file.status];
        return (
          <section key={index} className="overflow-clip rounded-lg border border-zinc-800 bg-zinc-950/60">
            <button
              type="button"
              onClick={() => toggle(index)}
              aria-expanded={open}
              className="sticky top-0 z-[1] flex w-full items-center gap-2 border-b border-zinc-800 bg-zinc-900/95 px-3 py-2 text-left backdrop-blur hover:bg-zinc-800/80"
            >
              {open ? (
                <ChevronDown className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-200">{displayPath(file)}</span>
              {chip ? <Chip tone={chip.tone}>{chip.label}</Chip> : null}
              <span className="shrink-0 font-mono text-[11px] text-emerald-300">+{file.additions}</span>
              <span className="shrink-0 font-mono text-[11px] text-rose-300">−{file.deletions}</span>
            </button>
            {open ? (
              file.binary ? (
                <p className="px-4 py-3 text-xs text-zinc-500">Binary file — no preview.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse font-mono text-[12px] leading-[1.6]">
                    <tbody>
                      {file.hunks.map((hunk, hunkIndex) => (
                        <HunkRows key={hunkIndex} hunk={hunk} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

const ROW_CLASSES: Readonly<Record<LineKind, string>> = {
  add: "bg-emerald-400/[0.09] text-zinc-100",
  del: "bg-rose-400/[0.09] text-zinc-100",
  ctx: "text-zinc-300",
  meta: "text-zinc-500 italic",
};

const SIGNS: Readonly<Record<LineKind, string>> = { add: "+", del: "−", ctx: " ", meta: " " };

function HunkRows({ hunk }: { readonly hunk: DiffHunk }) {
  const numberCell = "w-px select-none border-r border-zinc-800/80 px-2 text-right align-top text-zinc-600 tabular";
  return (
    <>
      <tr className="bg-sky-400/[0.06]">
        <td colSpan={4} className="px-3 py-1 text-[11.5px] whitespace-pre text-sky-300/80">
          {hunk.header}
        </td>
      </tr>
      {hunk.lines.map((line, index) => (
        <tr key={index} className={ROW_CLASSES[line.kind]}>
          <td className={numberCell}>{line.oldNo ?? ""}</td>
          <td className={numberCell}>{line.newNo ?? ""}</td>
          <td
            className={cx(
              "w-px select-none pr-1 pl-2 align-top",
              line.kind === "add" && "text-emerald-400",
              line.kind === "del" && "text-rose-400",
            )}
            aria-hidden
          >
            {SIGNS[line.kind]}
          </td>
          <td className="whitespace-pre pr-6">{line.text || " "}</td>
        </tr>
      ))}
    </>
  );
}
