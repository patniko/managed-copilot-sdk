import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type {
  GitHubStatus,
  IssueComment,
  IssueDetail,
  IssueLabel,
  IssueSummary,
  PullRequestView,
  RepositorySummary,
} from "../shared/types.js";
import { log } from "./log.js";
import { StationError } from "./pipeline/errors.js";

/** Where the SDK looks for a GitHub token, in order; then `gh auth token`. The factory uses the same account. */
export const TOKEN_ENVS = ["MANAGED_COPILOT_GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

export type Repository = RepositorySummary & { readonly id: number };

export interface TreeEntry {
  readonly path: string;
  readonly mode: "100644" | "100755" | "120000";
  /** A blob SHA, or `null` to delete the path. */
  readonly sha: string | null;
}

/** What the factory needs from GitHub. Implemented by `GitHubClient`; faked in unit tests. */
export interface GitHubApi {
  status(): Promise<GitHubStatus>;
  listRepositories(query?: string): Promise<RepositorySummary[]>;
  repository(owner: string, name: string): Promise<Repository>;
  listIssues(owner: string, name: string, query?: string): Promise<IssueSummary[]>;
  issue(owner: string, name: string, number: number): Promise<IssueDetail>;
  branchHead(owner: string, name: string, branch: string): Promise<string | undefined>;
  /** Streams the repository's files at `ref` (a gzipped tarball) into `destination`; resolves with its size. */
  downloadTarball(owner: string, name: string, ref: string, destination: string): Promise<number>;
  commitTree(owner: string, name: string, sha: string): Promise<string>;
  createBlob(owner: string, name: string, content: Uint8Array): Promise<string>;
  createTree(owner: string, name: string, baseTree: string, entries: readonly TreeEntry[]): Promise<string>;
  createCommit(owner: string, name: string, commit: { readonly message: string; readonly tree: string; readonly parents: readonly string[] }): Promise<string>;
  createBranch(owner: string, name: string, branch: string, sha: string): Promise<void>;
  /** Moves a branch forward; fails rather than force-pushing. */
  updateBranch(owner: string, name: string, branch: string, sha: string): Promise<void>;
  createPullRequest(owner: string, name: string, request: { readonly title: string; readonly body: string; readonly head: string; readonly base: string }): Promise<PullRequestView>;
  pullRequest(owner: string, name: string, number: number): Promise<PullRequestView>;
  /** The open pull request from `branch`, if one exists (to recover one opened just before a restart). */
  findPullRequest(owner: string, name: string, branch: string): Promise<PullRequestView | undefined>;
  updatePullRequest(owner: string, name: string, number: number, update: { readonly body?: string; readonly title?: string }): Promise<void>;
  comment(owner: string, name: string, number: number, body: string): Promise<string>;
  /** Uploads an image or video as a GitHub user attachment; resolves with its URL for Markdown. */
  uploadAttachment(repositoryId: number, fileName: string, contentType: string, bytes: Uint8Array): Promise<string>;
  merge(owner: string, name: string, number: number, method: "merge" | "squash" | "rebase"): Promise<void>;
}

export interface GitHubClientOptions {
  readonly apiUrl?: string;
  readonly uploadsUrl?: string;
  readonly fetch?: typeof fetch;
  /** Resolves the token; defaults to the SDK's order of environment variables, then `gh auth token`. */
  readonly token?: () => Promise<string | undefined>;
  /** Per request (the tarball download gets ten times as long). */
  readonly timeoutMs?: number;
}

function ghAuthToken(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { encoding: "utf8", timeout: 15_000, windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined);
    });
  });
}

export async function resolveGitHubToken(
  env: Readonly<Record<string, string | undefined>> = process.env,
  gh: () => Promise<string | undefined> = ghAuthToken,
): Promise<string | undefined> {
  for (const name of TOKEN_ENVS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return gh().catch(() => undefined);
}

/** `owner/name`, a GitHub URL, or `github.com/owner/name`. */
export function parseRepository(value: string): { owner: string; name: string } | undefined {
  const trimmed = value.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const match = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})(?:\/.*)?$/i.exec(trimmed);
  if (!match || match[2] === "." || match[2] === "..") return undefined;
  return { owner: match[1]!, name: match[2]! };
}

interface RawRepository {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  html_url: string;
  description: string | null;
  language: string | null;
  pushed_at: string | null;
  archived: boolean;
  permissions?: { push?: boolean; admin?: boolean; maintain?: boolean };
}

interface RawIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  labels: (string | { name?: string; color?: string })[];
  user: { login: string } | null;
  comments: number;
  created_at: string;
  updated_at: string;
  body?: string | null;
  pull_request?: unknown;
}

interface RawPull {
  number: number;
  html_url: string;
  title: string;
  state: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merged_by?: { login: string } | null;
  head: { sha: string; ref: string };
  base: { ref: string };
  mergeable?: boolean | null;
  mergeable_state?: string;
  commits?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  updated_at?: string;
}

function toRepository(raw: RawRepository): Repository {
  return {
    id: raw.id,
    owner: raw.owner.login,
    name: raw.name,
    fullName: raw.full_name,
    private: raw.private,
    defaultBranch: raw.default_branch,
    htmlUrl: raw.html_url,
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.language ? { language: raw.language } : {}),
    ...(raw.pushed_at ? { pushedAt: raw.pushed_at } : {}),
    ...(raw.archived ? { archived: true } : {}),
    canPush: Boolean(raw.permissions?.push || raw.permissions?.admin || raw.permissions?.maintain) && !raw.archived,
  };
}

function toLabels(labels: RawIssue["labels"]): IssueLabel[] {
  return labels.flatMap((label) => {
    if (typeof label === "string") return [{ name: label, color: "8b949e" }];
    return label.name ? [{ name: label.name, color: label.color || "8b949e" }] : [];
  });
}

function toIssue(raw: RawIssue): IssueSummary {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state === "closed" ? "closed" : "open",
    htmlUrl: raw.html_url,
    labels: toLabels(raw.labels ?? []),
    ...(raw.user?.login ? { author: raw.user.login } : {}),
    comments: raw.comments ?? 0,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function toPullRequest(raw: RawPull): PullRequestView {
  const merged = Boolean(raw.merged || raw.merged_at);
  return {
    number: raw.number,
    htmlUrl: raw.html_url,
    title: raw.title,
    state: merged ? "merged" : raw.state === "closed" ? "closed" : "open",
    draft: Boolean(raw.draft),
    headSha: raw.head.sha,
    headRef: raw.head.ref,
    baseRef: raw.base.ref,
    ...(raw.mergeable !== undefined ? { mergeable: raw.mergeable } : {}),
    ...(raw.mergeable_state ? { mergeableState: raw.mergeable_state } : {}),
    ...(raw.commits !== undefined ? { commits: raw.commits } : {}),
    ...(raw.additions !== undefined ? { additions: raw.additions } : {}),
    ...(raw.deletions !== undefined ? { deletions: raw.deletions } : {}),
    ...(raw.changed_files !== undefined ? { changedFiles: raw.changed_files } : {}),
    ...(raw.updated_at ? { updatedAt: raw.updated_at } : {}),
    ...(raw.merged_at ? { mergedAt: raw.merged_at } : {}),
    ...(raw.merged_by?.login ? { mergedBy: raw.merged_by.login } : {}),
  };
}

const MAX_ISSUE_BODY = 12_000;
const MAX_COMMENT_BODY = 3_000;
const RECENT_COMMENTS = 10;
const REPO_PAGES = 3;
const REPO_CACHE_MS = 60_000;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n\n… (truncated)` : text;
}

/** GitHub's REST API with the factory's own token. The token never leaves this process: sandboxes get files, not credentials. */
export class GitHubClient implements GitHubApi {
  readonly #apiUrl: string;
  readonly #uploadsUrl: string;
  readonly #fetch: typeof fetch;
  readonly #resolveToken: () => Promise<string | undefined>;
  readonly #timeoutMs: number;
  #token: Promise<string | undefined> | undefined;
  #status: { value: GitHubStatus; at: number } | undefined;
  #repos: { value: RepositorySummary[]; at: number } | undefined;

  constructor(options: GitHubClientOptions = {}) {
    this.#apiUrl = (options.apiUrl ?? process.env.FACTORY_GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
    this.#uploadsUrl = (options.uploadsUrl ?? "https://uploads.github.com").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#resolveToken = options.token ?? (() => resolveGitHubToken());
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async #tokenOrThrow(): Promise<string> {
    this.#token ??= this.#resolveToken();
    const token = await this.#token;
    if (!token) {
      this.#token = undefined;
      throw new StationError("authentication_required", "The factory has no GitHub sign-in. Run `gh auth login`, or set GH_TOKEN, then try again.");
    }
    return token;
  }

  async #request(method: string, url: string, init: { body?: unknown; raw?: Uint8Array; contentType?: string; timeoutMs?: number; retried?: boolean } = {}): Promise<Response> {
    const token = await this.#tokenOrThrow();
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "managed-copilot-software-factory",
    };
    let body: RequestInit["body"] | undefined;
    if (init.raw) {
      headers["content-type"] = init.contentType ?? "application/octet-stream";
      body = init.raw as unknown as RequestInit["body"];
    } else if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    let response: Response;
    try {
      response = await this.#fetch(url.startsWith("http") ? url : `${this.#apiUrl}${url}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: "follow",
        signal: AbortSignal.timeout(init.timeoutMs ?? this.#timeoutMs),
      });
    } catch (error) {
      const timedOut = (error as Error).name === "TimeoutError";
      throw new StationError("upstream_unavailable", timedOut ? "GitHub didn't answer in time. Try again in a moment." : "The factory can't reach GitHub right now. Check its network connection.");
    }
    if (response.status === 401 && !init.retried) {
      // A token from `gh` may have been refreshed since: resolve it once more.
      this.#token = undefined;
      this.#status = undefined;
      return this.#request(method, url, { ...init, retried: true });
    }
    if (!response.ok) throw await this.#error(response);
    return response;
  }

  async #error(response: Response): Promise<StationError> {
    let message = "";
    try {
      const body = (await response.json()) as { message?: string; errors?: { message?: string; code?: string }[] };
      message = [body.message, ...(body.errors ?? []).map((item) => item.message ?? item.code)].filter(Boolean).join(": ");
    } catch {
      message = response.statusText;
    }
    if (response.status === 401) return new StationError("authentication_required", "GitHub rejected the factory's sign-in. Run `gh auth login` again, or update GH_TOKEN.");
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
      return new StationError("rate_limited", "The factory's GitHub account hit its API rate limit. Try again in a few minutes.");
    }
    if (response.status === 403) return new StationError("forbidden", `GitHub refused: ${message || "the account doesn't have access"}.`);
    if (response.status === 404) return new StationError("not_found", "GitHub couldn't find that, or the factory's account can't see it.");
    if (response.status === 409 || response.status === 422) return new StationError("conflict", `GitHub: ${message || "the request conflicts with the repository's state"}.`);
    if (response.status >= 500) return new StationError("upstream_unavailable", `GitHub had a problem (${response.status}). Try again in a moment.`);
    return new StationError("invalid_request", `GitHub: ${message || response.statusText}.`);
  }

  async #json<T>(method: string, url: string, body?: unknown): Promise<T> {
    const response = await this.#request(method, url, body === undefined ? {} : { body });
    return (await response.json()) as T;
  }

  async status(): Promise<GitHubStatus> {
    if (this.#status && Date.now() - this.#status.at < 5 * 60_000) return this.#status.value;
    let value: GitHubStatus;
    try {
      const user = await this.#json<{ login: string; name?: string | null; avatar_url?: string }>("GET", "/user");
      value = { available: true, login: user.login, ...(user.name ? { name: user.name } : {}), ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}) };
    } catch (error) {
      const failure = error instanceof StationError ? error : new StationError("internal", (error as Error).message);
      value = {
        available: false,
        message: failure.code === "authentication_required" ? "Sign in to GitHub to work on your repositories." : failure.message,
        hint: failure.code === "authentication_required" ? "Run `gh auth login`, or set GH_TOKEN, then reload." : "The factory checks again when you reload.",
      };
      log.warn("GitHub isn't available to the factory", { code: failure.code });
      // Retry soon rather than caching a failure for long.
      this.#status = { value, at: Date.now() - 4 * 60_000 };
      return value;
    }
    this.#status = { value, at: Date.now() };
    return value;
  }

  async listRepositories(query?: string): Promise<RepositorySummary[]> {
    const wanted = query?.trim() ?? "";
    const exact = wanted.includes("/") ? parseRepository(wanted) : undefined;
    if (exact) {
      try {
        return [await this.repository(exact.owner, exact.name)];
      } catch (error) {
        if (error instanceof StationError && error.code === "not_found") return [];
        throw error;
      }
    }
    if (!this.#repos || Date.now() - this.#repos.at > REPO_CACHE_MS) {
      const all: RepositorySummary[] = [];
      for (let page = 1; page <= REPO_PAGES; page++) {
        const batch = await this.#json<RawRepository[]>("GET", `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
        all.push(...batch.map(toRepository));
        if (batch.length < 100) break;
      }
      // The account's own repositories first, then its organizations' (each most recently pushed first).
      const login = (await this.status()).login?.toLowerCase();
      const own = all.filter((repo) => repo.owner.toLowerCase() === login);
      this.#repos = { value: [...own, ...all.filter((repo) => repo.owner.toLowerCase() !== login)], at: Date.now() };
    }
    const needle = wanted.toLowerCase();
    const matches = needle ? this.#repos.value.filter((repo) => repo.fullName.toLowerCase().includes(needle) || repo.description?.toLowerCase().includes(needle)) : this.#repos.value;
    return matches.filter((repo) => !repo.archived).slice(0, 50);
  }

  async repository(owner: string, name: string): Promise<Repository> {
    return toRepository(await this.#json<RawRepository>("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`));
  }

  async listIssues(owner: string, name: string, query?: string): Promise<IssueSummary[]> {
    const repo = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const wanted = query?.trim() ?? "";
    const number = /^#?(\d{1,9})$/.exec(wanted)?.[1];
    if (number) {
      try {
        const raw = await this.#json<RawIssue>("GET", `/repos/${repo}/issues/${number}`);
        return raw.pull_request ? [] : [toIssue(raw)];
      } catch (error) {
        if (error instanceof StationError && error.code === "not_found") return [];
        throw error;
      }
    }
    if (wanted) {
      const q = `repo:${owner}/${name} is:issue ${wanted.replace(/[^\p{L}\p{N}\s._:#/-]/gu, " ")}`;
      const result = await this.#json<{ items: RawIssue[] }>("GET", `/search/issues?per_page=30&sort=updated&q=${encodeURIComponent(q)}`);
      return result.items.filter((item) => !item.pull_request).map(toIssue);
    }
    const raw = await this.#json<RawIssue[]>("GET", `/repos/${repo}/issues?state=open&per_page=50&sort=updated`);
    return raw.filter((item) => !item.pull_request).map(toIssue);
  }

  async issue(owner: string, name: string, number: number): Promise<IssueDetail> {
    const repo = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const raw = await this.#json<RawIssue>("GET", `/repos/${repo}/issues/${number}`);
    if (raw.pull_request) throw new StationError("invalid_request", `#${number} is a pull request, not an issue.`);
    let comments: IssueComment[] = [];
    if (raw.comments > 0) {
      const page = Math.max(1, Math.ceil(raw.comments / 100));
      const list = await this.#json<{ user: { login: string } | null; body: string | null; created_at: string }[]>(
        "GET",
        `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
      );
      comments = list.slice(-RECENT_COMMENTS).map((comment) => ({
        ...(comment.user?.login ? { author: comment.user.login } : {}),
        body: truncate(comment.body ?? "", MAX_COMMENT_BODY),
        createdAt: comment.created_at,
      }));
    }
    return { ...toIssue(raw), body: truncate(raw.body ?? "", MAX_ISSUE_BODY), recentComments: comments };
  }

  async branchHead(owner: string, name: string, branch: string): Promise<string | undefined> {
    try {
      const ref = await this.#json<{ object: { sha: string } }>("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
      return ref.object.sha;
    } catch (error) {
      if (error instanceof StationError && error.code === "not_found") return undefined;
      throw error;
    }
  }

  async downloadTarball(owner: string, name: string, ref: string, destination: string): Promise<number> {
    const response = await this.#request("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/tarball/${encodeURIComponent(ref)}`, { timeoutMs: this.#timeoutMs * 10 });
    if (!response.body) throw new StationError("upstream_unavailable", "GitHub sent an empty archive of the repository.");
    let size = 0;
    const counted = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
    counted.on("data", (chunk: Buffer) => (size += chunk.length));
    await pipeline(counted, createWriteStream(destination));
    return size;
  }

  async commitTree(owner: string, name: string, sha: string): Promise<string> {
    const commit = await this.#json<{ tree: { sha: string } }>("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/commits/${sha}`);
    return commit.tree.sha;
  }

  async createBlob(owner: string, name: string, content: Uint8Array): Promise<string> {
    const blob = await this.#json<{ sha: string }>("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/blobs`, {
      content: Buffer.from(content).toString("base64"),
      encoding: "base64",
    });
    return blob.sha;
  }

  async createTree(owner: string, name: string, baseTree: string, entries: readonly TreeEntry[]): Promise<string> {
    const tree = await this.#json<{ sha: string }>("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees`, {
      base_tree: baseTree,
      tree: entries.map((entry) => ({ path: entry.path, mode: entry.mode, type: "blob", sha: entry.sha })),
    });
    return tree.sha;
  }

  async createCommit(owner: string, name: string, commit: { readonly message: string; readonly tree: string; readonly parents: readonly string[] }): Promise<string> {
    const created = await this.#json<{ sha: string }>("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/commits`, {
      message: commit.message,
      tree: commit.tree,
      parents: commit.parents,
    });
    return created.sha;
  }

  async createBranch(owner: string, name: string, branch: string, sha: string): Promise<void> {
    await this.#json("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }

  async updateBranch(owner: string, name: string, branch: string, sha: string): Promise<void> {
    await this.#json("PATCH", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, { sha, force: false });
  }

  async createPullRequest(owner: string, name: string, request: { readonly title: string; readonly body: string; readonly head: string; readonly base: string }): Promise<PullRequestView> {
    return toPullRequest(await this.#json<RawPull>("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`, { ...request, draft: false, maintainer_can_modify: true }));
  }

  async pullRequest(owner: string, name: string, number: number): Promise<PullRequestView> {
    return toPullRequest(await this.#json<RawPull>("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`));
  }

  async findPullRequest(owner: string, name: string, branch: string): Promise<PullRequestView | undefined> {
    const list = await this.#json<RawPull[]>("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`);
    const found = list[0];
    return found ? toPullRequest(found) : undefined;
  }

  async updatePullRequest(owner: string, name: string, number: number, update: { readonly body?: string; readonly title?: string }): Promise<void> {
    await this.#json("PATCH", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`, update);
  }

  async comment(owner: string, name: string, number: number, body: string): Promise<string> {
    const created = await this.#json<{ html_url: string }>("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`, { body });
    return created.html_url;
  }

  async uploadAttachment(repositoryId: number, fileName: string, contentType: string, bytes: Uint8Array): Promise<string> {
    const params = new URLSearchParams({ name: fileName, content_type: contentType, repository_id: String(repositoryId) });
    const response = await this.#request("POST", `${this.#uploadsUrl}/user-attachments/assets?${params.toString()}`, {
      raw: bytes,
      contentType: "application/octet-stream",
      timeoutMs: this.#timeoutMs * 4,
    });
    const body = (await response.json()) as { url?: string; href?: string };
    const url = body.url ?? body.href;
    if (!url?.startsWith("https://")) throw new StationError("upstream_unavailable", `GitHub didn't return a URL for ${fileName}.`);
    return url;
  }

  async merge(owner: string, name: string, number: number, method: "merge" | "squash" | "rebase"): Promise<void> {
    await this.#json("PUT", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/merge`, { merge_method: method });
  }
}
