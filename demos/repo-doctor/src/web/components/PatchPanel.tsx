import { CopilotIcon, FileDiffIcon } from "@primer/octicons-react";
import { useMemo, useState } from "react";
import { parseDiff, type DiffFile } from "../../shared/diff.js";
import { PATCH_TOO_LARGE, type RunView } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { plural } from "../lib/format.js";
import { Words } from "./Words.js";

function Counts({ additions, deletions }: { readonly additions: number; readonly deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-xs">
      <span className="text-fg-success">+{additions}</span> <span className="text-fg-danger">−{deletions}</span>
    </span>
  );
}

function FileDiff({ file }: { readonly file: DiffFile }) {
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <div className="file-header">
        <span className="min-w-0 truncate" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath ? `${file.oldPath} → ` : ""}
          {file.path}
        </span>
        <span className="ml-auto pr-2">
          <Counts additions={file.additions} deletions={file.deletions} />
        </span>
      </div>
      {file.status === "binary" ? (
        <div className="px-4 py-3 text-sm text-fg-muted">Binary file changed</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <tbody>
              {file.lines.map((line, index) =>
                line.kind === "hunk" ? (
                  <tr key={index}>
                    <td className="blob-num blob-num-hunk" colSpan={2} />
                    <td className="blob-code blob-code-hunk">{line.text}</td>
                  </tr>
                ) : (
                  <tr key={index}>
                    <td className={cx("blob-num", line.kind === "add" && "blob-num-addition", line.kind === "del" && "blob-num-deletion")}>{line.oldNo ?? ""}</td>
                    <td className={cx("blob-num", line.kind === "add" && "blob-num-addition", line.kind === "del" && "blob-num-deletion")}>{line.newNo ?? ""}</td>
                    <td
                      className={cx("blob-code blob-code-marker", line.kind === "add" && "blob-code-addition", line.kind === "del" && "blob-code-deletion", line.kind === "meta" && "text-fg-muted")}
                      data-code-marker={line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                    >
                      {line.text}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Copilot's diagnosis: two lines, with the rest a click away. */
function Diagnosis({ text }: { readonly text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 160;
  return (
    <div className="flex gap-2 text-sm">
      <CopilotIcon size={16} className="mt-0.5 shrink-0 text-fg-muted" />
      <div className="min-w-0">
        <p className={cx("break-words", long && !open && "line-clamp-2")}>
          <Words text={text} />
        </p>
        {long ? (
          <button type="button" className="Link--muted mt-0.5 text-xs" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? "Less" : "More"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** What the panel says when it has no patch to show. */
function emptyText(run: RunView): string {
  if (run.error?.code === PATCH_TOO_LARGE) return "Too large to return.";
  switch (run.steps.find((step) => step.id === "patch")?.status) {
    case "passed":
    case "failed":
      return "No changes.";
    case "skipped":
      return "Nothing to fix.";
    default:
      return "The patch appears after the fix.";
  }
}

/** Copilot's diagnosis and the patch Repo Doctor built from the sandbox. */
export function PatchPanel({ run }: { readonly run: RunView }) {
  const files = useMemo(() => (run.patch ? parseDiff(run.patch.text) : []), [run.patch]);
  return (
    <section className="Box min-w-0" aria-label="Patch">
      <div className="Box-header flex items-center gap-2 py-2">
        <FileDiffIcon size={16} className="text-fg-muted" />
        <h2 className="Box-title text-sm">Patch</h2>
        {run.patch && files.length ? (
          <span className="ml-auto flex items-center gap-2 text-xs text-fg-muted">
            {plural(files.length, "file")}
            <Counts additions={run.patch.additions} deletions={run.patch.deletions} />
          </span>
        ) : null}
      </div>
      <div className="Box-body flex flex-col gap-3">
        {run.diagnosis ? <Diagnosis text={run.diagnosis} /> : null}
        {files.length ? files.map((file) => <FileDiff key={file.path} file={file} />) : <p className="text-sm text-fg-muted">{emptyText(run)}</p>}
      </div>
    </section>
  );
}
