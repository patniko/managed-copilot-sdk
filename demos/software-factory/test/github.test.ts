import { afterEach, describe, expect, it } from "vitest";
import { GitHubClient, parseRepository, resolveGitHubToken, type GitHubApi, type Repository, type TreeEntry } from "../src/server/github.js";
import { EventHub } from "../src/server/hub.js";
import { Factory } from "../src/server/pipeline/factory.js";
import { branchName, gitBlobSha, parseSnapshot, pullRequestBody, revisionComment, validateChange, workOrderTitle } from "../src/server/pipeline/repo.js";
import { FactoryStore } from "../src/server/store.js";
import type { CommandResult } from "../src/server/platform.js";
import type { IssueDetail, PullRequestView, WorkOrder } from "../src/shared/types.js";
import { FakePlatform, type Script } from "./fakes.js";

const BASE = "a".repeat(40);
const FILE = "export const greet = (name) => `Hello, ${name}!`;\n";

const ISSUE: IssueDetail = {
  number: 7,
  title: "Greeting is missing punctuation",
  state: "open",
  htmlUrl: "https://github.com/octo/app/issues/7",
  labels: [{ name: "bug", color: "d73a4a" }],
  author: "mona",
  comments: 1,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
  body: "It says `Hello, Mona` without an exclamation mark.",
  recentComments: [{ author: "hubot", body: "Confirmed on main.", createdAt: "2026-11-02T00:00:00Z" }],
};

/** In-memory GitHub: one repository, its branches, the factory's commits, pull requests, comments, and uploads. */
class FakeGitHub implements GitHubApi {
  readonly repo: Repository = {
    id: 42,
    owner: "octo",
    name: "app",
    fullName: "octo/app",
    private: true,
    defaultBranch: "main",
    htmlUrl: "https://github.com/octo/app",
    canPush: true,
  };
  readonly branches = new Map<string, string>([["main", BASE]]);
  readonly blobs = new Map<string, Uint8Array>();
  readonly trees: { base: string; entries: readonly TreeEntry[] }[] = [];
  readonly commits: { sha: string; message: string; tree: string; parents: readonly string[] }[] = [];
  readonly pulls: PullRequestView[] = [];
  readonly bodies: string[] = [];
  readonly comments: string[] = [];
  readonly uploads: string[] = [];
  readonly merged: number[] = [];
  #counter = 0;

  async status() {
    return { available: true, login: "octocat" };
  }
  async listRepositories() {
    return [this.repo];
  }
  async repository(owner: string, name: string) {
    if (`${owner}/${name}` !== this.repo.fullName) throw Object.assign(new Error("not found"), { code: "not_found" });
    return this.repo;
  }
  async listIssues() {
    return [ISSUE];
  }
  async issue() {
    return ISSUE;
  }
  async branchHead(_owner: string, _name: string, branch: string) {
    return this.branches.get(branch);
  }
  async downloadTarball(_owner: string, _name: string, ref: string, destination: string) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(destination, `tarball of ${ref}`);
    return 20;
  }
  async commitTree(_owner: string, _name: string, sha: string) {
    return `tree-of-${sha.slice(0, 7)}`;
  }
  async createBlob(_owner: string, _name: string, content: Uint8Array) {
    const sha = gitBlobSha(content);
    this.blobs.set(sha, content);
    return sha;
  }
  async createTree(_owner: string, _name: string, base: string, entries: readonly TreeEntry[]) {
    this.trees.push({ base, entries });
    return `tree-${this.trees.length}`;
  }
  async createCommit(_owner: string, _name: string, commit: { message: string; tree: string; parents: readonly string[] }) {
    const sha = `c${++this.#counter}`.padEnd(40, "0");
    this.commits.push({ sha, ...commit });
    return sha;
  }
  async createBranch(_owner: string, _name: string, branch: string, sha: string) {
    if (this.branches.has(branch)) throw new Error("exists");
    this.branches.set(branch, sha);
  }
  async updateBranch(_owner: string, _name: string, branch: string, sha: string) {
    const parent = this.commits.find((commit) => commit.sha === sha)?.parents[0];
    if (this.branches.get(branch) !== parent) throw new Error("not a fast-forward");
    this.branches.set(branch, sha);
  }
  async createPullRequest(_owner: string, _name: string, request: { title: string; body: string; head: string; base: string }) {
    const pull: PullRequestView = {
      number: 12,
      htmlUrl: "https://github.com/octo/app/pull/12",
      title: request.title,
      state: "open",
      draft: false,
      headSha: this.branches.get(request.head)!,
      headRef: request.head,
      baseRef: request.base,
      mergeable: true,
    };
    this.pulls.push(pull);
    this.bodies.push(request.body);
    return pull;
  }
  async pullRequest(_owner: string, _name: string, number: number) {
    const pull = this.pulls.find((candidate) => candidate.number === number)!;
    return { ...pull, headSha: this.branches.get(pull.headRef)!, state: this.merged.includes(number) ? ("merged" as const) : pull.state };
  }
  async findPullRequest() {
    return undefined;
  }
  async updatePullRequest() {}
  async comment(_owner: string, _name: string, _number: number, body: string) {
    this.comments.push(body);
    return `https://github.com/octo/app/pull/12#issuecomment-${this.comments.length}`;
  }
  async uploadAttachment(repositoryId: number, fileName: string) {
    expect(repositoryId).toBe(42);
    this.uploads.push(fileName);
    return `https://github.com/user-attachments/assets/${fileName}`;
  }
  async merge(_owner: string, _name: string, number: number) {
    this.merged.push(number);
  }
}

/** A sandbox stand-in: the working tree's changed files, answered through the factory's exec scripts. */
class Sandbox {
  files = new Map<string, string>();
  testExit = 0;

  constructor(readonly platform: FakePlatform) {
    platform.execHandler = (sessionId, command) => this.exec(sessionId, command);
  }

  write(sessionId: string, path: string, content: string): void {
    this.files.set(path, content);
    this.platform.workspaces.get(sessionId)!.set(`repo/${path}`, content);
  }

  exec(_sessionId: string, command: string): CommandResult {
    if (command.includes("CHECKED_OUT")) return { state: "completed", exitCode: 0, output: "CHECKED_OUT abc1234 3 files\n" };
    if (command.includes("@@RAW")) {
      const raw = [...this.files].map(([path, content]) => `:100644 100644 ${"b".repeat(40)} ${gitBlobSha(Buffer.from(content))} M\0${path}\0`).join("");
      const numstat = [...this.files].map(([path]) => `1\t1\t${path}\0`).join("");
      return { state: "completed", exitCode: 0, output: `TREE ${"d".repeat(40)}\n@@RAW\n${raw}\n@@NUMSTAT\n${numstat}\n@@END\n` };
    }
    if (command.includes("git diff --no-color")) return { state: "completed", exitCode: 0, output: [...this.files.keys()].map((path) => `diff --git a/${path} b/${path}\n-old\n+new\n`).join("") };
    if (command.startsWith("cd /workspace/repo && npm test")) return { state: "completed", exitCode: this.testExit, output: this.testExit === 0 ? "ok 3 tests\n" : "not ok 1 greets\n" };
    throw new Error(`Unexpected command: ${command}`);
  }
}

let store: FactoryStore;
let hub: EventHub;
afterEach(() => hub?.close());

function setup(scripts: Partial<Record<"developer" | "reviewer", Script>>, github = new FakeGitHub()) {
  store = new FactoryStore(":memory:");
  hub = new EventHub(60_000);
  const platform = new FakePlatform(scripts);
  const sandbox = new Sandbox(platform);
  const factory = new Factory({
    store,
    hub,
    platform,
    github,
    readiness: () => ({ ready: true }),
    account: () => ({ login: "octocat" }),
    config: {
      maxSandboxes: 2,
      turnTimeoutMs: { planner: 5_000, builder: 5_000, reviewer: 5_000, release: 5_000, coordinator: 5_000, developer: 5_000 },
      publicationTimeoutMs: 1_000,
      checkTimeoutMs: 5_000,
    },
    pollMs: 10,
  });
  return { platform, factory, github, sandbox };
}

async function settle(factory: Factory, id: string, timeoutMs = 5_000): Promise<WorkOrder> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const wo = factory.get(id)!;
    if (!factory.isActive(id) && ["completed", "failed", "cancelled"].includes(wo.status)) return wo;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Work order ${id} did not settle: ${factory.get(id)?.status}`);
}

function developer(sandbox: () => Sandbox, options: { media?: boolean } = {}): Script {
  return async (session, prompt, platform) => {
    const revision = /revision (\d+)/.exec(prompt)?.[1] ?? (prompt.includes("requested changes") ? "2" : undefined);
    sandbox().write(session.sessionId, "src/greet.js", revision ? FILE.replace("!", "!!") : FILE);
    if (options.media !== false) platform.publish(session.sessionId, { "media/greeting.png": `PNG ${prompt.length}`, "media/demo.mp4": "MP4" });
    const result = await session.callTool("submit_change", {
      title: revision ? "Use two exclamation marks" : "Add punctuation to the greeting",
      summary: "The greeting now ends with an exclamation mark, and the test covers it.",
      testCommand: "npm test",
      media: options.media === false ? [] : [
        { path: "media/greeting.png", caption: "The greeting in the app" },
        { path: "/workspace/outputs/media/demo.mp4", caption: "Typing a name" },
        { path: "media/missing.png", caption: "Never captured" },
      ],
    });
    expect(String(result)).toMatch(/^Rejected|^Recorded/);
    if (String(result).startsWith("Rejected")) {
      await session.callTool("submit_change", {
        title: "Add punctuation to the greeting",
        summary: "The greeting now ends with an exclamation mark, and the test covers it.",
        testCommand: "npm test",
        media: [{ path: "media/greeting.png", caption: "The greeting in the app" }, { path: "media/demo.mp4", caption: "Typing a name" }],
      });
    }
    session.say("Done.");
  };
}

const approve: Script = async (session) => {
  await session.callTool("submit_review", { verdict: "approve", summary: "Small, focused, and tested.", findings: [] });
};

describe("GitHub work orders", () => {
  it("checks the repository out without a token, reviews the change, pushes a branch, and opens a pull request with media", async () => {
    let box: Sandbox | undefined;
    const { factory, platform, github, sandbox } = setup({ developer: developer(() => box!), reviewer: approve });
    box = sandbox;
    const created = await factory.createGitHub({ title: "", brief: "Fix the greeting and add a test.", github: { repository: "octo/app", issue: 7 } });
    expect(created.title).toBe("Greeting is missing punctuation");
    expect(created.github?.branch).toBe("factory/wo-0001-7-greeting-is-missing-punctuation");
    expect(created.stations.map((station) => station.id)).toEqual(["build:change", "review:change", "release"]);

    const wo = await settle(factory, created.id);
    expect(wo.status).toBe("completed");
    const developerSession = platform.sessionsFor("developer")[0]!;
    // The archive was uploaded as a file; no credential reached the sandbox.
    expect([...platform.uploads.get(developerSession.sessionId)!.keys()]).toEqual([".factory/base.tar.gz"]);
    expect(platform.workspaces.get(developerSession.sessionId)!.get(".factory/REQUEST.md")).toContain("Issue #7: Greeting is missing punctuation");
    expect(developerSession.prompts[0]).toContain("Fix the greeting and add a test.");
    expect(developerSession.config.tools?.map((tool) => tool.name)).toEqual(["submit_change"]);

    const revision = wo.github!.revisions[0]!;
    expect(revision.files).toEqual([{ path: "src/greet.js", status: "modified", additions: 1, deletions: 1 }]);
    expect(revision.check).toMatchObject({ command: "npm test", passed: true, exitCode: 0 });
    expect(revision.media?.map((item) => [item.path, item.kind])).toEqual([["media/greeting.png", "image"], ["media/demo.mp4", "video"]]);
    expect(store.getArtifact(created.id, "build:change", "change.patch")?.content).toContain("diff --git a/src/greet.js");
    expect(factory.media(created.id, "build:change", "media/greeting.png")?.contentType).toBe("image/png");

    expect(github.commits).toHaveLength(1);
    expect(github.commits[0]).toMatchObject({ parents: [BASE], tree: "tree-1" });
    expect(github.commits[0]!.message).toContain("Fixes #7");
    expect(github.trees[0]!.base).toBe(`tree-of-${BASE.slice(0, 7)}`);
    expect(github.trees[0]!.entries).toEqual([{ path: "src/greet.js", mode: "100644", sha: gitBlobSha(Buffer.from(FILE)) }]);
    expect(github.branches.get(created.github!.branch)).toBe(github.commits[0]!.sha);
    expect(github.uploads).toEqual(["greeting.png", "demo.mp4"]);
    expect(github.bodies[0]).toMatch(/^Closes #7/);
    expect(github.bodies[0]).toContain("![The greeting in the app](https://github.com/user-attachments/assets/greeting.png)");
    // Videos play only when their URL stands alone.
    expect(github.bodies[0]).toContain("**Typing a name**\n\nhttps://github.com/user-attachments/assets/demo.mp4");
    expect(github.bodies[0]).toContain("✅ `npm test` passed");
    expect(wo.github!.pullRequest).toMatchObject({ number: 12, state: "open" });
    expect(revision).toMatchObject({ outcome: "pull_request", pushed: true });
    expect(wo.stations.find((station) => station.id === "release")).toMatchObject({ status: "done", detail: "Opened #12" });
    expect(factory.list()[0]!.github).toEqual({ repository: "octo/app", issue: 7, pullRequest: 12, pullRequestState: "open" });
  });

  it("takes more changes in the same sandbox and pushes them to the same pull request after review", async () => {
    let box: Sandbox | undefined;
    let reviews = 0;
    const reviewer: Script = async (session) => {
      reviews++;
      await session.callTool(
        "submit_review",
        reviews === 2
          ? { verdict: "request_changes", summary: "Missing a test.", findings: [{ severity: "major", file: "src/greet.js", message: "Add a test for two marks." }] }
          : { verdict: "approve", summary: "Looks right.", findings: [] },
      );
    };
    const { factory, platform, github, sandbox } = setup({ developer: developer(() => box!), reviewer });
    box = sandbox;
    const created = await factory.createGitHub({ title: "Greeting", brief: "Fix the greeting.", github: { repository: "octo/app" } });
    await settle(factory, created.id);
    await expect(factory.revise(created.id, "x")).rejects.toThrow(/3 to 8,000/);

    await factory.revise(created.id, "Use two exclamation marks instead.");
    const wo = await settle(factory, created.id);
    expect(wo.status).toBe("completed");
    expect(platform.sessionsFor("developer")).toHaveLength(1);
    // The revision resumed the same session (and sandbox): its prompts start with the new request.
    const prompts = platform.sessionsFor("developer")[0]!.prompts;
    expect(prompts[0]).toContain("revision 2");
    expect(prompts[1]).toContain("requested changes");
    expect(github.commits).toHaveLength(2);
    // The second commit builds on the first; the tree is the base plus every change since.
    expect(github.commits[1]!.parents).toEqual([github.commits[0]!.sha]);
    expect(github.trees[1]!.base).toBe(`tree-of-${BASE.slice(0, 7)}`);
    expect(github.pulls).toHaveLength(1);
    expect(github.comments[0]).toContain("### Revision 2: Use two exclamation marks");
    expect(github.comments[0]).toContain("> Use two exclamation marks instead.");
    const revision = wo.github!.revisions[1]!;
    expect(revision).toMatchObject({ number: 2, outcome: "pushed", pushed: true, commentUrl: expect.stringContaining("issuecomment-1") });
    expect(wo.stations.find((station) => station.id === "release")?.detail).toBe("Revision 2 pushed to #12");

    await factory.merge(created.id, "squash");
    expect(github.merged).toEqual([12]);
    expect(factory.get(created.id)!.github!.pullRequest!.state).toBe("merged");
    await expect(factory.revise(created.id, "One more thing, please.")).rejects.toThrow(/is merged/);
  });

  it("asks the developer to fix a failing test run before review", async () => {
    let box: Sandbox | undefined;
    const { factory, platform, sandbox } = setup({ developer: developer(() => box!, { media: false }), reviewer: approve });
    box = sandbox;
    sandbox.testExit = 1;
    const developerScript = platform.scripts.developer!;
    platform.scripts.developer = async (session, prompt, fake) => {
      if (prompt.includes("it failed")) sandbox.testExit = 0;
      await developerScript(session, prompt, fake);
    };
    const created = await factory.createGitHub({ title: "Greeting", brief: "Fix the greeting.", github: { repository: "octo/app" } });
    const wo = await settle(factory, created.id);
    expect(wo.status).toBe("completed");
    expect(platform.sessionsFor("developer")[0]!.prompts[1]).toContain("$ npm test\nnot ok 1 greets");
    expect(wo.github!.revisions[0]!.check?.passed).toBe(true);
  });

  it("opens no pull request when the developer only answers a question", async () => {
    const answering: Script = async (session) => {
      await session.callTool("submit_change", { title: "How the greeting works", summary: "No change was needed for this question.", answer: "It lives in `src/greet.js`." });
    };
    const { factory, github, sandbox } = setup({ developer: answering, reviewer: approve });
    expect(sandbox.files.size).toBe(0);
    const created = await factory.createGitHub({ title: "", brief: "Where does the greeting come from?", github: { repository: "octo/app" } });
    const wo = await settle(factory, created.id);
    expect(wo.status).toBe("completed");
    expect(wo.github!.revisions[0]).toMatchObject({ answer: "It lives in `src/greet.js`.", outcome: "no_changes", files: [] });
    expect(wo.stations.map((station) => station.status)).toEqual(["done", "skipped", "skipped"]);
    expect(github.commits).toHaveLength(0);
    expect(github.pulls).toHaveLength(0);
  });

  it("refuses to overwrite commits someone else pushed to the branch", async () => {
    let box: Sandbox | undefined;
    const { factory, github, sandbox } = setup({ developer: developer(() => box!, { media: false }), reviewer: approve });
    box = sandbox;
    const created = await factory.createGitHub({ title: "Greeting", brief: "Fix the greeting.", github: { repository: "octo/app" } });
    github.branches.set(created.github!.branch, "f".repeat(40));
    const wo = await settle(factory, created.id);
    expect(wo.status).toBe("failed");
    expect(wo.error?.code).toBe("conflict");
    expect(wo.stations.find((station) => station.id === "release")?.status).toBe("failed");
    expect(github.pulls).toHaveLength(0);
  });

  it("rejects repositories the account can't push to", async () => {
    const github = new FakeGitHub();
    (github.repo as { canPush: boolean }).canPush = false;
    const { factory } = setup({}, github);
    await expect(factory.createGitHub({ title: "", brief: "Fix it.", github: { repository: "octo/app" } })).rejects.toThrow(/can't push to octo\/app/);
    await expect(factory.createGitHub({ title: "", brief: "Fix it.", github: { repository: "not a repo" } })).rejects.toThrow(/owner\/name/);
  });
});

describe("GitHub helpers", () => {
  it("parses repositories from names and URLs", () => {
    expect(parseRepository("octo/app")).toEqual({ owner: "octo", name: "app" });
    expect(parseRepository("https://github.com/octo/app.git")).toEqual({ owner: "octo", name: "app" });
    expect(parseRepository("github.com/octo/app/tree/main")).toEqual({ owner: "octo", name: "app" });
    expect(parseRepository("octo")).toBeUndefined();
    expect(parseRepository("octo/..")).toBeUndefined();
  });

  it("resolves the token like the SDK: environment variables first, then gh", async () => {
    expect(await resolveGitHubToken({ GH_TOKEN: " ghp_env " }, async () => "gho_gh")).toBe("ghp_env");
    expect(await resolveGitHubToken({}, async () => "gho_gh")).toBe("gho_gh");
    expect(await resolveGitHubToken({}, async () => undefined)).toBeUndefined();
  });

  it("calls GitHub with the token, skips pull requests in issue lists, and re-reads a rejected token once", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    let tokens = 0;
    const fetchFake = (async (url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("authorization");
      calls.push({ url, auth });
      if (auth === "Bearer stale") return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      if (url.includes("/issues?")) {
        return Response.json([
          { number: 1, title: "Bug", state: "open", html_url: "u", labels: [{ name: "bug", color: "d73a4a" }], user: { login: "a" }, comments: 0, created_at: "t", updated_at: "t" },
          { number: 2, title: "A PR", state: "open", html_url: "u", labels: [], user: null, comments: 0, created_at: "t", updated_at: "t", pull_request: {} },
        ]);
      }
      if (url.startsWith("https://uploads.github.com/user-attachments/assets?")) return Response.json({ url: "https://github.com/user-attachments/assets/1" });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const client = new GitHubClient({ fetch: fetchFake, token: async () => (tokens++ === 0 ? "stale" : "fresh") });
    const issues = await client.listIssues("octo", "app");
    expect(issues.map((issue) => issue.number)).toEqual([1]);
    expect(calls.map((call) => call.auth)).toEqual(["Bearer stale", "Bearer fresh"]);
    expect(await client.uploadAttachment(42, "shot.png", "image/png", new Uint8Array([1, 2]))).toBe("https://github.com/user-attachments/assets/1");
    expect(calls.at(-1)!.url).toContain("name=shot.png&content_type=image%2Fpng&repository_id=42");
    await expect(client.repository("octo", "missing")).rejects.toMatchObject({ code: "not_found" });
  });

  it("parses the sandbox's NUL-separated diff listing", () => {
    const output = [
      "warning: something on stderr",
      `TREE ${"d".repeat(40)}`,
      "@@RAW",
      `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0src/a b.js\0:000000 100755 ${"0".repeat(40)} ${"3".repeat(40)} A\0bin/run\0:100644 000000 ${"4".repeat(40)} ${"0".repeat(40)} D\0old.txt\0:000000 120000 ${"0".repeat(40)} ${"5".repeat(40)} A\0link\0`,
      "@@NUMSTAT",
      "3\t1\tsrc/a b.js\0" + "5\t0\tbin/run\0" + "0\t2\told.txt\0" + "-\t-\tlink\0",
      "@@END",
    ].join("\n");
    const snapshot = parseSnapshot(output);
    expect(snapshot.tree).toBe("d".repeat(40));
    expect(snapshot.entries).toEqual([
      { path: "src/a b.js", status: "modified", mode: "100644", sha: "2".repeat(40) },
      { path: "bin/run", status: "added", mode: "100755", sha: "3".repeat(40) },
      { path: "old.txt", status: "deleted", mode: "100644" },
      { path: "link", status: "added", mode: "120000", sha: "5".repeat(40) },
    ]);
    expect(snapshot.files).toEqual([
      { path: "src/a b.js", status: "modified", additions: 3, deletions: 1 },
      { path: "bin/run", status: "added", additions: 5, deletions: 0 },
      { path: "old.txt", status: "deleted", additions: 0, deletions: 2 },
      { path: "link", status: "added" },
    ]);
    expect(parseSnapshot(`TREE ${"d".repeat(40)}\n@@RAW\n\n@@NUMSTAT\n\n@@END\n`).files).toEqual([]);
    expect(() => parseSnapshot("fatal: not a git repository")).toThrow(/incomplete/);
  });

  it("validates submit_change and normalizes media paths", () => {
    const ok = validateChange({ title: "  Fix   it ", summary: "Fixed the thing properly.", media: [{ path: "/workspace/outputs/media/a.png", caption: "A" }] });
    expect(ok).toEqual({ ok: true, value: { title: "Fix it", summary: "Fixed the thing properly.", media: [{ path: "media/a.png", caption: "A" }] } });
    const bad = validateChange({ title: "x", summary: "short", testCommand: "a\nb", media: [{ path: "outputs/../secret.png", caption: "" }, { path: "media/a.svg", caption: "S" }] });
    expect(bad.ok).toBe(false);
    expect(bad.ok ? [] : bad.problems.join(" ")).toMatch(/title.*summary.*testCommand.*must be under.*caption.*supported type/s);
  });

  it("names branches and titles from the issue or the request", () => {
    expect(branchName(12, "Fix: the Login error!!")).toBe("factory/wo-0012-fix-the-login-error");
    expect(branchName(3, "★★★")).toBe("factory/wo-0003-change");
    expect(workOrderTitle("\n  Add dark mode\nmore", undefined)).toBe("Add dark mode");
    expect(workOrderTitle("Fix it", { number: 1, title: "Crash on start" })).toBe("Crash on start");
  });

  it("writes pull request bodies and revision comments", () => {
    const wo = {
      number: 4,
      title: "Greeting",
      github: { repository: { fullName: "octo/app" }, issue: ISSUE, revisions: [] } as unknown as WorkOrder["github"],
    };
    const revision = {
      number: 2,
      request: "Make it louder.\nMuch louder.",
      requestedAt: "t",
      title: "Louder greeting",
      summary: "Two marks now.",
      files: [{ path: "src/greet.js", status: "modified" as const, additions: 1, deletions: 1 }],
      check: { command: "npm test", passed: false, exitCode: 1, durationMs: 1500, output: "", at: "t" },
      media: [{ stationId: "build:change", path: "media/a.png", version: 1, caption: "Loud [demo]", kind: "image" as const, contentType: "image/png", size: 3 }],
    };
    const text = {
      wo,
      revision,
      reviews: [{ round: 3, verdict: "approve" as const, summary: "Fine.", findings: [{ severity: "minor" as const, message: "Nit." }], at: "t" }],
      acceptedWithFindings: false,
      mediaUrls: { "build:change:media/a.png@1": "https://github.com/user-attachments/assets/x" },
      mediaKey: (item: { stationId: string; path: string; version: number }) => `${item.stationId}:${item.path}@${item.version}`,
      models: { developer: "dev-model", reviewer: "review-model" },
    };
    const body = pullRequestBody(text);
    expect(body).toMatch(/^Closes #7\n\nTwo marks now\./);
    expect(body).toContain("![Loud \\[demo\\]](https://github.com/user-attachments/assets/x)");
    expect(body).toContain("❌ `npm test` failed (exit 1)");
    expect(body).toContain("- [minor] Nit.");
    expect(body).toContain("WO-0004 · developer dev-model, reviewer review-model");
    const comment = revisionComment(text);
    expect(comment).toMatch(/^### Revision 2: Louder greeting\n\n> Make it louder\.\n> Much louder\./);
  });
});
