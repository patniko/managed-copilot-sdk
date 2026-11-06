/** A unified diff (`git diff`) as files, hunks, and numbered lines, for the patch view and its stats. */

export interface DiffLine {
  readonly kind: "hunk" | "context" | "add" | "del" | "meta";
  readonly text: string;
  readonly oldNo?: number;
  readonly newNo?: number;
}

export interface DiffFile {
  readonly path: string;
  /** Renames: where the file was. */
  readonly oldPath?: string;
  readonly status: "modified" | "added" | "deleted" | "renamed" | "binary";
  readonly additions: number;
  readonly deletions: number;
  readonly lines: readonly DiffLine[];
}

/** `"a/x y"` (git quotes unusual paths) and `a/x` both become `x`. */
function cleanPath(raw: string): string {
  let path = raw.trim();
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1).replace(/\\(["\\])/g, "$1");
  return path.replace(/^[ab]\//, "");
}

interface Building {
  path: string;
  oldPath?: string;
  status: DiffFile["status"];
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: Building | undefined;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const finish = () => {
    if (!file) return;
    const { oldPath, ...rest } = file;
    files.push(oldPath && oldPath !== rest.path ? { ...rest, oldPath } : rest);
    file = undefined;
  };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      const header = line.slice("diff --git ".length);
      const split = header.lastIndexOf(" b/");
      file = { path: cleanPath(split >= 0 ? header.slice(split + 1) : header), status: "modified", additions: 0, deletions: 0, lines: [] };
      inHunk = false;
      continue;
    }
    if (!file) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      file.lines.push({ kind: "hunk", text: line });
      continue;
    }
    if (inHunk) {
      if (line.startsWith("+")) {
        file.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
        file.additions++;
      } else if (line.startsWith("-")) {
        file.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
        file.deletions++;
      } else if (line.startsWith(" ")) {
        file.lines.push({ kind: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
      } else if (line.startsWith("\\")) {
        file.lines.push({ kind: "meta", text: line });
      } else {
        inHunk = false;
      }
      continue;
    }
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.oldPath = cleanPath(line.slice("rename from ".length));
      file.status = "renamed";
    } else if (line.startsWith("rename to ")) file.path = cleanPath(line.slice("rename to ".length));
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.status = "binary";
    else if (line.startsWith("+++ ") && !line.endsWith("/dev/null")) file.path = cleanPath(line.slice(4));
  }
  finish();
  return files;
}

export function diffTotals(files: readonly Pick<DiffFile, "additions" | "deletions">[]): { readonly additions: number; readonly deletions: number } {
  return files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 });
}
