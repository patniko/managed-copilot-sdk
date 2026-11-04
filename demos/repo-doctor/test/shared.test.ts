import { describe, expect, it } from "vitest";
import { diffTotals, parseDiff } from "../src/shared/diff.js";
import { cloneUrl, parseRepoInput, repoUrl } from "../src/shared/repo.js";
import { SAMPLE_DIFF } from "./fakes.js";

describe("parseRepoInput", () => {
  it("reads URLs, host paths, and owner/repo", () => {
    for (const input of ["octo/tools", " octo/tools ", "github.com/octo/tools", "https://github.com/octo/tools", "https://github.com/octo/tools.git", "http://www.github.com/octo/tools/", "git@github.com:octo/tools.git"]) {
      expect(parseRepoInput(input), input).toEqual({ owner: "octo", repo: "tools" });
    }
    expect(parseRepoInput("https://github.com/octo/tools/pull/12")).toEqual({ owner: "octo", repo: "tools" });
  });

  it("keeps a branch or tag from a tree URL", () => {
    expect(parseRepoInput("https://github.com/octo/tools/tree/release/2.x")).toEqual({ owner: "octo", repo: "tools", ref: "release/2.x" });
    expect(parseRepoInput("github.com/octo/tools/tree/v1.2.0")).toEqual({ owner: "octo", repo: "tools", ref: "v1.2.0" });
  });

  it("explains what it can't use", () => {
    expect(parseRepoInput("")).toEqual({ error: "Paste a GitHub repository, like github.com/owner/repo." });
    expect(parseRepoInput("https://gitlab.com/octo/tools")).toEqual({ error: "Repo Doctor clones public repositories from github.com." });
    expect(parseRepoInput("octo")).toEqual({ error: "Include the owner and the repository, like owner/repo." });
    expect(parseRepoInput("octo/../etc")).toMatchObject({ error: expect.stringContaining("isn't a valid GitHub repository name") });
    expect(parseRepoInput("-octo/tools")).toMatchObject({ error: expect.stringContaining("isn't a valid") });
    expect(parseRepoInput("octo/tools/tree/--upload-pack=x")).toMatchObject({ error: expect.stringContaining("isn't a branch or tag") });
    expect(parseRepoInput("octo/tools/tree/a..b")).toMatchObject({ error: expect.stringContaining("isn't a branch or tag") });
    expect(parseRepoInput("https://github.com/%E0%A4%A")).toEqual({ error: "That isn't a URL Repo Doctor can read." });
  });

  it("builds clone and page URLs", () => {
    expect(cloneUrl({ owner: "octo", repo: "tools" })).toBe("https://github.com/octo/tools.git");
    expect(repoUrl({ owner: "octo", repo: "tools", ref: "main" })).toBe("https://github.com/octo/tools/tree/main");
  });
});

describe("parseDiff", () => {
  it("numbers lines and counts changes", () => {
    const [file, ...rest] = parseDiff(SAMPLE_DIFF);
    expect(rest).toEqual([]);
    expect(file).toMatchObject({ path: "src/next-version.js", status: "modified", additions: 1, deletions: 1 });
    expect(file!.lines.map((line) => [line.kind, line.oldNo, line.newNo])).toEqual([
      ["hunk", undefined, undefined],
      ["context", 13, 13],
      ["context", 14, 14],
      ["del", 15, undefined],
      ["add", undefined, 15],
      ["context", 16, 16],
      ["context", 17, 17],
      ["context", 18, 18],
    ]);
  });

  it("reads new, deleted, renamed, and binary files", () => {
    const diff = [
      "diff --git a/docs/new.md b/docs/new.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/new.md",
      "@@ -0,0 +1,2 @@",
      "+# New",
      "+text",
      "\\ No newline at end of file",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/src/a.js b/src/b.js",
      "similarity index 90%",
      "rename from src/a.js",
      "rename to src/b.js",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    const files = parseDiff(diff);
    expect(files.map(({ path, oldPath, status, additions, deletions }) => ({ path, oldPath, status, additions, deletions }))).toEqual([
      { path: "docs/new.md", oldPath: undefined, status: "added", additions: 2, deletions: 0 },
      { path: "old.txt", oldPath: undefined, status: "deleted", additions: 0, deletions: 1 },
      { path: "src/b.js", oldPath: "src/a.js", status: "renamed", additions: 0, deletions: 0 },
      { path: "logo.png", oldPath: undefined, status: "binary", additions: 0, deletions: 0 },
    ]);
    expect(files[0]!.lines.at(-1)).toEqual({ kind: "meta", text: "\\ No newline at end of file" });
    expect(diffTotals(files)).toEqual({ additions: 2, deletions: 1 });
  });

  it("returns nothing for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });
});
