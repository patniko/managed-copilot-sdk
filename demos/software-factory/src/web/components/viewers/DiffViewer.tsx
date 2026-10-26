import { ChevronDownIcon, FileDiffIcon } from "@primer/octicons-react";
import { useMemo, useState } from "react";
import { cx } from "../../lib/cx.js";
import { pluralize } from "../../lib/format.js";
import { languageForPath, PLAIN, tokenizeLines, type Token } from "../../lib/highlight.js";
import type { Tone } from "../../lib/tone.js";
import { Chip } from "../ui/Chip.js";
import { CodeViewer, TokenLine } from "./CodeViewer.js";
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

const STATUS_CHIP: Readonly<Record<DiffFile["status"], { readonly label: string; readonly tone: Tone } | undefined>> = {
  modified: undefined,
  added: { label: "Added", tone: "success" },
  deleted: { label: "Deleted", tone: "danger" },
  renamed: { label: "Renamed", tone: "accent" },
};

function displayPath(file: DiffFile): string {
  if (file.status === "deleted") return file.oldPath;
  if (file.status === "renamed" && file.oldPath && file.oldPath !== file.newPath) return `${file.oldPath} → ${file.newPath}`;
  return file.newPath || file.oldPath;
}

const MAX_HIGHLIGHT_CHARS = 120_000;

/** Syntax tokens per diff line: each side of a hunk is highlighted as one block, then matched back to its lines. */
function highlightFile(file: DiffFile): (readonly Token[] | undefined)[][] | undefined {
  const language = languageForPath(file.newPath && file.newPath !== "/dev/null" ? file.newPath : file.oldPath);
  if (language === PLAIN || language === "diff" || file.binary) return undefined;
  const size = file.hunks.reduce((sum, hunk) => sum + hunk.lines.reduce((lineSum, line) => lineSum + line.text.length + 1, 0), 0);
  if (size > MAX_HIGHLIGHT_CHARS) return undefined;
  return file.hunks.map((hunk) => {
    const oldLines = hunk.lines.filter((line) => line.kind === "del" || line.kind === "ctx");
    const newLines = hunk.lines.filter((line) => line.kind === "add" || line.kind === "ctx");
    // Prism splits on bare carriage returns too; when its lines don't match the diff's, show that side plain.
    const side = (lines: readonly DiffLine[]): Token[][] | undefined => {
      const tokens = tokenizeLines(lines.map((line) => line.text).join("\n"), language);
      return tokens && tokens.length === lines.length ? tokens : undefined;
    };
    const oldSide = side(oldLines);
    const newSide = side(newLines);
    let oldIndex = 0;
    let newIndex = 0;
    return hunk.lines.map((line) => {
      if (line.kind === "del") return oldSide?.[oldIndex++];
      if (line.kind === "add") return newSide?.[newIndex++];
      if (line.kind === "ctx") {
        oldIndex += 1;
        return newSide?.[newIndex++];
      }
      return undefined;
    });
  });
}

/** GitHub's diffstat: five blocks split between additions and deletions. */
function DiffstatBlocks({ additions, deletions }: { readonly additions: number; readonly deletions: number }) {
  const total = additions + deletions;
  const colored = Math.min(5, total);
  const added = total === 0 ? 0 : Math.round((additions / total) * colored);
  const blocks = Array.from({ length: 5 }, (_, index) =>
    index < added ? "bg-success-emphasis" : index < colored ? "bg-danger-emphasis" : "bg-neutral-muted",
  );
  return (
    <span className="inline-flex shrink-0 gap-px" aria-hidden>
      {blocks.map((color, index) => (
        <span key={index} className={cx("size-2 rounded-xs", color)} />
      ))}
    </span>
  );
}

function DiffCounts({ additions, deletions }: { readonly additions: number; readonly deletions: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 font-sans text-xs font-semibold tabular-nums">
      <span className="text-fg-success">+{additions}</span>
      <span className="text-fg-danger">−{deletions}</span>
      <span className="sr-only">
        {pluralize(additions, "addition")} and {pluralize(deletions, "deletion")}
      </span>
    </span>
  );
}

/** A unified diff like github.com's "Files changed": one box per file with a sticky header, line numbers, and hunks. */
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
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <FileDiffIcon size={16} className="text-fg-muted" />
        <span>
          <span className="font-semibold">{pluralize(files.length, "file")}</span> changed
        </span>
        <DiffCounts additions={totals.additions} deletions={totals.deletions} />
      </div>
      {files.map((file, index) => (
        <DiffFileBox key={index} file={file} open={!collapsed.has(index)} onToggle={() => toggle(index)} />
      ))}
    </div>
  );
}

function DiffFileBox({ file, open, onToggle }: { readonly file: DiffFile; readonly open: boolean; readonly onToggle: () => void }) {
  const chip = STATUS_CHIP[file.status];
  const tokens = useMemo(() => (open ? highlightFile(file) : undefined), [file, open]);
  return (
    <section className="Box overflow-clip">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cx("file-header sticky top-0 z-[1] w-full text-left", !open && "rounded-b-md border-b-0")}
      >
        <ChevronDownIcon size={16} className={cx("shrink-0 text-fg-muted transition-transform duration-100", !open && "-rotate-90")} />
        <DiffCounts additions={file.additions} deletions={file.deletions} />
        <DiffstatBlocks additions={file.additions} deletions={file.deletions} />
        <span className="min-w-0 flex-1 truncate">{displayPath(file)}</span>
        {chip ? (
          <Chip tone={chip.tone} className="font-sans">
            {chip.label}
          </Chip>
        ) : null}
      </button>
      {open ? (
        file.binary ? (
          <p className="px-4 py-3 text-xs text-fg-muted">Binary file not shown.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <tbody>
                {file.hunks.map((hunk, hunkIndex) => (
                  <HunkRows key={hunkIndex} hunk={hunk} tokens={tokens?.[hunkIndex]} />
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </section>
  );
}

const NUM_CLASS: Readonly<Record<LineKind, string>> = {
  add: "blob-num blob-num-addition",
  del: "blob-num blob-num-deletion",
  ctx: "blob-num",
  meta: "blob-num",
};

const CODE_CLASS: Readonly<Record<LineKind, string>> = {
  add: "blob-code blob-code-marker blob-code-addition",
  del: "blob-code blob-code-marker blob-code-deletion",
  ctx: "blob-code blob-code-marker",
  meta: "blob-code text-fg-muted",
};

const MARKERS: Readonly<Record<LineKind, string>> = { add: "+", del: "-", ctx: " ", meta: "" };

function HunkRows({ hunk, tokens }: { readonly hunk: DiffHunk; readonly tokens?: readonly (readonly Token[] | undefined)[] }) {
  return (
    <>
      <tr>
        <td className="blob-num blob-num-hunk" aria-hidden />
        <td className="blob-num blob-num-hunk" aria-hidden />
        <td className="blob-code blob-code-hunk">{hunk.header}</td>
      </tr>
      {hunk.lines.map((line, index) => {
        const lineTokens = tokens?.[index];
        return (
          <tr key={index}>
            <td className={NUM_CLASS[line.kind]}>{line.oldNo ?? ""}</td>
            <td className={NUM_CLASS[line.kind]}>{line.newNo ?? ""}</td>
            <td className={CODE_CLASS[line.kind]} data-code-marker={MARKERS[line.kind]}>
              {line.kind === "add" ? <span className="sr-only">Added: </span> : line.kind === "del" ? <span className="sr-only">Removed: </span> : null}
              {lineTokens && line.text ? <TokenLine tokens={lineTokens} /> : line.text || "\n"}
            </td>
          </tr>
        );
      })}
    </>
  );
}