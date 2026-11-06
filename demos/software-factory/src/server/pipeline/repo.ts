import { createHash } from "node:crypto";
import { z } from "zod";
import {
  formatWorkOrderNumber,
  mediaTypeOf,
  type ChangeCheck,
  type ChangedFile,
  type ChangeRevision,
  type GitHubWork,
  type IssueDetail,
  type MediaItem,
  type ReviewFinding,
  type ReviewRecord,
  type WorkOrder,
} from "../../shared/types.js";

/** Where the factory checks the repository out inside the sandbox (workspace-relative). */
export const REPO_DIR = "repo";
/** The tag on the checked-out base commit: every diff is against it. */
export const BASE_TAG = "factory-base";
export const MAX_MEDIA = 8;
/** Media the factory keeps and attaches (GitHub takes images up to 10 MB and videos up to 100 MB; keep it reasonable). */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
/** One file the factory pushes, and all of them together. */
export const MAX_PUSH_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_PUSH_BYTES = 200 * 1024 * 1024;
export const MAX_PUSH_FILES = 2_000;
const REVIEW_PATCH_BUDGET = 80_000;
const CHECK_OUTPUT_TAIL = 4_000;

/** New untracked files under these never become part of the change (tracked files there still do). */
const UNTRACKED_EXCLUDES = [
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  ".cache",
  ".gradle",
  "target",
];

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `fix-the-login-error` from "Fix the login error!" (at most 40 characters). */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "change"
  );
}

export function branchName(number: number, title: string): string {
  return `factory/wo-${String(number).padStart(4, "0")}-${slugify(title)}`;
}

/** A title for the work order: the issue's, or the request's first line. */
export function workOrderTitle(request: string, issue?: Pick<IssueDetail, "number" | "title">): string {
  const text = issue ? issue.title : (request.split("\n").find((line) => line.trim())?.trim() ?? "Change");
  const clipped = text.replace(/\s+/g, " ").trim();
  return clipped.length > 100 ? `${clipped.slice(0, 99).trimEnd()}…` : clipped.length >= 3 ? clipped : `Change: ${clipped}`;
}

// ─── Sandbox scripts ─────────────────────────────────────────────────────────────────────────────────────────

const GIT_IDENTITY = "-c user.name='Software Factory' -c user.email='software-factory@users.noreply.github.com'";

/**
 * Unpacks the base archive (and, for a replacement sandbox, the pushed head on top) into `repo/` as a git repository
 * whose one commit, tagged `factory-base`, is the base. Idempotent: it starts from scratch every time.
 */
export function checkoutScript(options: { readonly branch: string; readonly baseArchive: string; readonly headArchive?: string; readonly label: string }): string {
  const lines = [
    "set -e",
    "cd /workspace",
    `rm -rf ${REPO_DIR} && mkdir -p ${REPO_DIR}`,
    `tar -xzf ${shellQuote(options.baseArchive)} -C ${REPO_DIR} --strip-components=1 --no-same-owner`,
    `rm -f ${shellQuote(options.baseArchive)}`,
    `cd ${REPO_DIR}`,
    `git init -q -b ${shellQuote(options.branch)}`,
    `git config user.name 'Software Factory' && git config user.email 'software-factory@users.noreply.github.com'`,
    // Everything in the archive was tracked upstream, including files its own .gitignore would skip.
    "git add -A -f",
    `git ${GIT_IDENTITY} commit -q --no-verify --allow-empty -m ${shellQuote(`Base: ${options.label}`)}`,
    `git tag -f ${BASE_TAG}`,
  ];
  if (options.headArchive) {
    lines.push(
      // The work pushed so far: replace the tracked files with the pushed head's, leaving them uncommitted.
      "git ls-files -z | xargs -0 rm -f",
      `tar -xzf ${shellQuote(`/workspace/${options.headArchive}`)} -C . --strip-components=1 --no-same-owner`,
      `rm -f ${shellQuote(`/workspace/${options.headArchive}`)}`,
    );
  }
  lines.push(`echo "CHECKED_OUT $(git rev-parse --short ${BASE_TAG}) $(git ls-files | wc -l) files"`);
  return lines.join("\n");
}

/**
 * Records the working tree as a git tree through a temporary index, without touching the developer's index, commits,
 * or branches, then lists every change since `factory-base` (NUL-separated).
 */
export function snapshotScript(): string {
  const excludes = UNTRACKED_EXCLUDES.map((dir) => `':(exclude,glob)**/${dir}/**'`).join(" ");
  return [
    "set -e",
    `cd /workspace/${REPO_DIR}`,
    "export GIT_INDEX_FILE=/tmp/factory-snapshot.index",
    'rm -f "$GIT_INDEX_FILE"',
    `git read-tree ${BASE_TAG}`,
    "git add -u",
    `git add -A -- . ${excludes} ':(exclude,glob)**/*.pyc'`,
    "tree=$(git write-tree)",
    'echo "TREE $tree"',
    'printf "@@RAW\\n"',
    `git diff-tree -r -z --no-renames --raw ${BASE_TAG} "$tree"`,
    'printf "\\n@@NUMSTAT\\n"',
    `git diff-tree -r -z --no-renames --numstat ${BASE_TAG} "$tree"`,
    'printf "\\n@@END\\n"',
  ].join("\n");
}

export function patchScript(tree: string): string {
  return `cd /workspace/${REPO_DIR} && git diff --no-color --no-ext-diff --binary ${BASE_TAG} ${shellQuote(tree)}`;
}

export function blobScript(sha: string): string {
  return `cd /workspace/${REPO_DIR} && git cat-file blob ${shellQuote(sha)}`;
}

export function checkScript(command: string): string {
  return `cd /workspace/${REPO_DIR} && ${command}`;
}

export interface SnapshotEntry {
  readonly path: string;
  readonly status: ChangedFile["status"];
  readonly mode: "100644" | "100755" | "120000" | "160000" | "000000";
  /** The new blob, absent for deletions. */
  readonly sha?: string;
}

export interface Snapshot {
  readonly tree: string;
  readonly entries: readonly SnapshotEntry[];
  readonly files: readonly ChangedFile[];
}

const STATUS: Readonly<Record<string, ChangedFile["status"]>> = { A: "added", M: "modified", D: "deleted", T: "type_changed" };

export function parseSnapshot(output: string): Snapshot {
  const tree = /^TREE ([0-9a-f]{40,64})$/m.exec(output)?.[1];
  const raw = /@@RAW\n([\s\S]*?)\n@@NUMSTAT\n/.exec(output)?.[1];
  const numstat = /@@NUMSTAT\n([\s\S]*?)\n@@END/.exec(output)?.[1];
  if (!tree || raw === undefined || numstat === undefined) throw new Error("The sandbox's diff output was incomplete.");
  const entries: SnapshotEntry[] = [];
  const fields = raw.split("\0").filter(Boolean);
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDT])/.exec(fields[index]!);
    const path = fields[index + 1]!;
    if (!meta || !path) continue;
    const status = STATUS[meta[5]!]!;
    const mode = meta[2] as SnapshotEntry["mode"];
    entries.push({ path, status, mode: status === "deleted" ? (meta[1] as SnapshotEntry["mode"]) : mode, ...(status === "deleted" ? {} : { sha: meta[4]! }) });
  }
  const counts = new Map<string, { additions?: number; deletions?: number }>();
  for (const record of numstat.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record.replace(/^\n/, ""));
    if (!match) continue;
    counts.set(match[3]!, match[1] === "-" ? {} : { additions: Number(match[1]), deletions: Number(match[2]) });
  }
  const files = entries
    .filter((entry) => entry.mode !== "160000")
    .map((entry) => ({ path: entry.path, status: entry.status, ...(counts.get(entry.path) ?? {}) }));
  return { tree, entries, files };
}

/** Git's blob ID for `bytes`: GitHub's blob SHA for the same content, so a pushed file can be checked against the snapshot. */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function outputTail(output: string, limit = CHECK_OUTPUT_TAIL): string {
  const trimmed = output.replace(/\s+$/, "");
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}

// ─── submit_change ───────────────────────────────────────────────────────────────────────────────────────────

export const SubmitChangeSchema = z.object({
  title: z.string().describe("Pull request title: imperative, under 72 characters, e.g. 'Show a friendly error when login fails'"),
  summary: z
    .string()
    .describe("Pull request description in Markdown: what changed and why, how you tested it, and anything a reviewer should look at. Don't repeat the diff."),
  testCommand: z
    .string()
    .optional()
    .describe("A command the factory runs from the repository root to verify the change, e.g. 'npm test' or 'pytest -q'. Omit only if the repository has no tests."),
  media: z
    .array(z.object({ path: z.string().describe("Path under /workspace/outputs, e.g. 'media/login-error.png'"), caption: z.string().describe("One line: what it shows") }))
    .optional()
    .describe("Screenshots and recordings you saved under /workspace/outputs/media/, in the order reviewers should see them"),
  answer: z.string().optional().describe("When the request was a question and you changed nothing: your answer, in Markdown"),
});

export interface SubmittedChange {
  readonly title: string;
  readonly summary: string;
  readonly testCommand?: string;
  readonly media: readonly { readonly path: string; readonly caption: string }[];
  readonly answer?: string;
}

export function validateChange(input: unknown): { ok: true; value: SubmittedChange } | { ok: false; problems: string[] } {
  const parsed = SubmitChangeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`) };
  const { title, summary, testCommand, media = [], answer } = parsed.data;
  const problems: string[] = [];
  const cleanTitle = title.replace(/\s+/g, " ").trim();
  if (cleanTitle.length < 3 || cleanTitle.length > 100) problems.push("title: write 3 to 100 characters.");
  if (summary.trim().length < 10 || summary.length > 20_000) problems.push("summary: write 10 to 20,000 characters.");
  if (testCommand !== undefined && (!testCommand.trim() || testCommand.length > 500 || /[\r\n]/.test(testCommand))) problems.push("testCommand: one line, under 500 characters.");
  if (media.length > MAX_MEDIA) problems.push(`media: at most ${MAX_MEDIA} files.`);
  const seen = new Set<string>();
  const cleaned = media.map((item) => {
    const path = item.path.trim().replace(/^\/?workspace\/outputs\//, "").replace(/^outputs\//, "").replace(/^\.\//, "");
    if (!path.startsWith("media/") || path.includes("..") || path.includes("\\")) problems.push(`media: "${item.path}" must be under /workspace/outputs/media/.`);
    else if (!mediaTypeOf(path)) problems.push(`media: "${item.path}" isn't a supported type (png, jpg, gif, webp, mp4, webm, mov).`);
    if (seen.has(path)) problems.push(`media: "${item.path}" is listed twice.`);
    seen.add(path);
    if (!item.caption.trim() || item.caption.length > 300) problems.push(`media: give "${item.path}" a one-line caption.`);
    return { path, caption: item.caption.replace(/\s+/g, " ").trim() };
  });
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      title: cleanTitle,
      summary: summary.trim(),
      ...(testCommand?.trim() ? { testCommand: testCommand.trim() } : {}),
      media: cleaned,
      ...(answer?.trim() ? { answer: answer.trim() } : {}),
    },
  };
}

// ─── Prompts ─────────────────────────────────────────────────────────────────────────────────────────────────

function issueSection(issue: IssueDetail | undefined): string {
  if (!issue) return "";
  const comments = issue.recentComments.map((comment) => `**@${comment.author ?? "ghost"}** (${comment.createdAt.slice(0, 10)}):\n\n${comment.body.trim()}`);
  return [
    `## Issue #${issue.number}: ${issue.title}`,
    "",
    `${issue.htmlUrl} · ${issue.state}${issue.labels.length > 0 ? ` · labels: ${issue.labels.map((label) => label.name).join(", ")}` : ""}${issue.author ? ` · opened by @${issue.author}` : ""}`,
    "",
    issue.body.trim() || "(no description)",
    ...(comments.length > 0 ? ["", `### Latest comments (${comments.length} of ${issue.comments})`, "", comments.join("\n\n---\n\n")] : []),
  ].join("\n");
}

/** `.factory/REQUEST.md`: the request and its issue, in the sandbox for the developer to re-read. */
export function requestMarkdown(wo: Pick<WorkOrder, "number" | "title" | "brief"> & { readonly github?: GitHubWork }): string {
  const github = wo.github!;
  const revisions = github.revisions.slice(1);
  return [
    `# ${formatWorkOrderNumber(wo.number)}: ${wo.title}`,
    "",
    `Repository: ${github.repository.fullName} (${github.repository.htmlUrl}), checked out at ${github.baseSha.slice(0, 12)} of \`${github.repository.defaultBranch}\` into /workspace/${REPO_DIR}.`,
    "",
    "## Request",
    "",
    wo.brief.trim(),
    ...(revisions.length > 0 ? ["", "## Follow-up requests", "", ...revisions.map((revision) => `${revision.number}. ${revision.request.trim()}`)] : []),
    ...(github.issue ? ["", issueSection(github.issue)] : []),
    "",
  ].join("\n");
}

export function developPrompt(wo: Pick<WorkOrder, "number" | "title" | "brief"> & { readonly github?: GitHubWork }): string {
  const github = wo.github!;
  return `Work order ${formatWorkOrderNumber(wo.number)} for ${github.repository.fullName}.

The repository is checked out in /workspace/${REPO_DIR} at \`${github.repository.defaultBranch}\` (${github.baseSha.slice(0, 12)}), tagged \`${BASE_TAG}\`. The request and the issue are also in /workspace/.factory/REQUEST.md.

## Request

${wo.brief.trim()}
${github.issue ? `\n${issueSection(github.issue)}\n` : ""}
Make the change, run the repository's tests, capture screenshots or a recording of anything visible with the pr-media skill, then call submit_change.`;
}

export function revisionPrompt(revision: Pick<ChangeRevision, "number" | "request">, pullRequest: GitHubWork["pullRequest"]): string {
  return `More changes were requested${pullRequest ? ` on pull request #${pullRequest.number}` : ""} (revision ${revision.number}). Keep your earlier work in /workspace/${REPO_DIR} and build on it:

${revision.request.trim()}

Make the change, re-run the tests, refresh the screenshots or recording if what they show changed (keep the ones that are still accurate), then call submit_change again. Its summary should describe this revision's changes.`;
}

function formatFinding(finding: ReviewFinding, index: number): string {
  const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}: ` : "";
  return `${index + 1}. [${finding.severity}] ${location}${finding.message}`;
}

export function changeFixPrompt(round: number, maxRounds: number, findings: readonly ReviewFinding[], reviewSummary: string): string {
  const blocking = findings.filter((finding) => finding.severity !== "minor");
  const minor = findings.filter((finding) => finding.severity === "minor");
  return `The reviewer requested changes (round ${round} of ${maxRounds}).

Reviewer's summary: ${reviewSummary}

Fix every finding below:

${blocking.map(formatFinding).join("\n")}
${minor.length > 0 ? `\nOptional minor findings:\n\n${minor.map(formatFinding).join("\n")}\n` : ""}
Re-run the tests, refresh the media if what it shows changed, and call submit_change again. Its summary is still the whole pull request's description: describe the complete change, not just this round's fixes.`;
}

export function submitChangeRetryPrompt(): string {
  return "You didn't call submit_change. Call it now with the pull request title, the description, the test command, and your media (or, if you were asked a question, your answer). The factory can't continue without it.";
}

export function changeCheckFailedPrompt(check: ChangeCheck): string {
  return `The factory re-ran your test command in /workspace/${REPO_DIR} and it failed (${check.exitCode === undefined ? "it didn't finish" : `exit ${check.exitCode}`}):

\`\`\`text
$ ${check.command}
${check.output}
\`\`\`

Fix the change so the tests pass. If a failure was already there before your change, or the command was wrong, call submit_change again with a command that tests your change and explain the pre-existing failure in the summary.`;
}

export function changeRetryPrompt(reason: string): string {
  return `The factory is retrying this work. The previous attempt stopped: ${reason}

Commands from that attempt may have been stopped partway, so check /workspace/${REPO_DIR}'s current state before relying on earlier results. Then finish the request, re-run the tests, and call submit_change.`;
}

export function changeContinuePrompt(): string {
  return `Your previous turn was interrupted before it finished, and the commands it was running may have been stopped partway. Check /workspace/${REPO_DIR}'s current state before relying on earlier results, then finish the request, re-run the tests, and call submit_change.`;
}

export interface ChangeReviewMaterial {
  readonly patch: string;
  readonly files: readonly ChangedFile[];
  readonly revision: ChangeRevision;
  readonly developerSummary?: string;
}

function patchSection(patch: string): string {
  if (!patch.trim()) return "(empty)";
  if (patch.length <= REVIEW_PATCH_BUDGET) return `\`\`\`diff\n${patch}\n\`\`\``;
  return `\`\`\`diff\n${patch.slice(0, REVIEW_PATCH_BUDGET)}\n\`\`\`\n\n(The diff is ${Math.round(patch.length / 1024)} KB; the rest is not shown. Judge the files listed above that it leaves out from their names and the developer's summary.)`;
}

export function changeReviewPrompt(
  wo: Pick<WorkOrder, "brief"> & { readonly github?: GitHubWork },
  round: number,
  maxRounds: number,
  material: ChangeReviewMaterial,
  previous?: readonly ReviewFinding[],
): string {
  const github = wo.github!;
  const { revision } = material;
  const intro =
    previous === undefined
      ? `Review this change to ${github.repository.fullName} (round ${round}; up to ${maxRounds} rounds) before the factory opens a pull request.`
      : `The developer resubmitted the change to ${github.repository.fullName} (round ${round} of ${maxRounds}). Check whether each earlier finding is fixed and approve once blockers and majors are resolved.\n\nYour earlier findings:\n\n${previous.map(formatFinding).join("\n")}`;
  const check = revision.check;
  const checkText = check
    ? `\`${check.command}\` ${check.passed ? "passed" : `failed (${check.exitCode === undefined ? "didn't finish" : `exit ${check.exitCode}`})`} in ${Math.round(check.durationMs / 1000)} s. End of its output:\n\n\`\`\`text\n${check.output.slice(-2_000)}\n\`\`\``
    : "The developer gave no test command, so the factory ran no tests.";
  const media = revision.media ?? [];
  return `${intro}

## Request

${wo.brief.trim()}
${github.revisions.length > 1 ? `\n## Follow-up requests\n\n${github.revisions.slice(1).map((item) => `${item.number}. ${item.request.trim()}`).join("\n")}\n` : ""}${github.issue ? `\n${issueSection(github.issue)}\n` : ""}
## The developer's description

**${revision.title ?? "(no title)"}**

${revision.summary?.trim() || material.developerSummary?.trim() || "(none)"}

## Tests (re-run by the factory)

${checkText}

## Media

${media.length > 0 ? media.map((item) => `- ${item.path} (${item.kind}): ${item.caption}`).join("\n") : "None captured."}

## Changed files (${material.files.length})

${material.files.map((file) => `- ${file.status} ${file.path}${file.additions !== undefined ? ` (+${file.additions} −${file.deletions})` : " (binary)"}`).join("\n")}

## Diff against ${github.repository.defaultBranch}

${patchSection(material.patch)}

Call submit_review with your verdict.`;
}

// ─── Pull request text ───────────────────────────────────────────────────────────────────────────────────────

function mediaMarkdown(media: readonly MediaItem[], urls: Readonly<Record<string, string>>, key: (item: MediaItem) => string): string {
  const blocks: string[] = [];
  for (const item of media) {
    const url = urls[key(item)];
    if (!url) continue;
    // GitHub plays a video only when its URL stands alone in a paragraph.
    blocks.push(item.kind === "video" ? `**${item.caption}**\n\n${url}` : `**${item.caption}**\n\n![${item.caption.replace(/[[\]\\]/g, "\\$&")}](${url})`);
  }
  return blocks.join("\n\n");
}

function checkMarkdown(check: ChangeCheck | undefined): string {
  if (!check) return "No test command was given, so the factory didn't run tests.";
  const icon = check.passed ? "✅" : "❌";
  return `${icon} \`${check.command}\` ${check.passed ? "passed" : `failed (${check.exitCode === undefined ? "didn't finish" : `exit ${check.exitCode}`})`} in the factory's sandbox (${Math.max(1, Math.round(check.durationMs / 1000))} s).`;
}

function reviewMarkdown(reviews: readonly ReviewRecord[], acceptedWithFindings: boolean): string {
  const last = reviews.at(-1);
  if (!last) return "";
  const rounds = reviews.length;
  const verdict = acceptedWithFindings
    ? `Accepted after ${rounds} review rounds with findings still open`
    : `Approved by the reviewer${rounds > 1 ? ` after ${rounds - 1} round${rounds > 2 ? "s" : ""} of requested changes` : ""}`;
  const open = acceptedWithFindings ? last.findings : last.findings.filter((finding) => finding.severity === "minor");
  return [
    `**${verdict}.** ${last.summary}`,
    ...(open.length > 0 ? ["", ...open.map((finding) => `- [${finding.severity}] ${finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ""}\`: ` : ""}${finding.message}`)] : []),
  ].join("\n");
}

function filesMarkdown(files: readonly ChangedFile[]): string {
  const shown = files.slice(0, 30).map((file) => `- \`${file.path}\` (${file.status.replace("_", " ")}${file.additions !== undefined ? `, +${file.additions} −${file.deletions}` : ""})`);
  return [...shown, ...(files.length > 30 ? [`- … and ${files.length - 30} more`] : [])].join("\n");
}

export interface PullRequestText {
  readonly wo: Pick<WorkOrder, "number" | "title"> & { readonly github?: GitHubWork };
  readonly revision: ChangeRevision;
  readonly reviews: readonly ReviewRecord[];
  readonly acceptedWithFindings: boolean;
  readonly mediaUrls: Readonly<Record<string, string>>;
  readonly mediaKey: (item: MediaItem) => string;
  readonly models: { readonly developer: string; readonly reviewer: string };
}

function footer(text: PullRequestText): string {
  return `<sub>Made by the AI software factory on Managed Copilot · ${formatWorkOrderNumber(text.wo.number)} · developer ${text.models.developer}, reviewer ${text.models.reviewer}. Ask for more changes from the factory's work order page.</sub>`;
}

export function pullRequestBody(text: PullRequestText): string {
  const github = text.wo.github!;
  const media = mediaMarkdown(text.revision.media ?? [], text.mediaUrls, text.mediaKey);
  const review = reviewMarkdown(text.reviews, text.acceptedWithFindings);
  return [
    ...(github.issue ? [`Closes #${github.issue.number}`, ""] : []),
    text.revision.summary?.trim() ?? "",
    ...(media ? ["", "## Screenshots and recordings", "", media] : []),
    "",
    "## Checks",
    "",
    checkMarkdown(text.revision.check),
    ...(review ? ["", "## Review", "", review] : []),
    "",
    "<details><summary>Files changed</summary>",
    "",
    filesMarkdown(text.revision.files ?? []),
    "",
    "</details>",
    "",
    footer(text),
    "",
  ].join("\n");
}

export function revisionComment(text: PullRequestText): string {
  const media = mediaMarkdown(text.revision.media ?? [], text.mediaUrls, text.mediaKey);
  const review = reviewMarkdown(text.reviews, text.acceptedWithFindings);
  const quoted = text.revision.request.trim().split("\n").map((line) => `> ${line}`).join("\n");
  return [
    `### Revision ${text.revision.number}: ${text.revision.title ?? "more changes"}`,
    "",
    quoted,
    "",
    text.revision.summary?.trim() ?? "",
    ...(media ? ["", "#### Screenshots and recordings", "", media] : []),
    "",
    checkMarkdown(text.revision.check),
    ...(review ? ["", review] : []),
    "",
    footer(text),
    "",
  ].join("\n");
}

export function commitMessage(wo: Pick<WorkOrder, "number">, revision: ChangeRevision, issue?: Pick<IssueDetail, "number">): string {
  const subject = revision.number === 1 ? (revision.title ?? "Change") : `Revision ${revision.number}: ${revision.title ?? "more changes"}`;
  const body = revision.number === 1 && issue ? `\n\nFixes #${issue.number}` : "";
  return `${subject.slice(0, 100)}${body}\n\nMade by the AI software factory (${formatWorkOrderNumber(wo.number)}).`;
}
