/**
 * Dev-only sample data for `vite dev` with `?fixtures` (see server.ts). Realistic shapes for every operator DTO so
 * layouts, empty states, and edge cases can be exercised without a gateway. Never part of a production build.
 */
import type { AccountInfo, ScheduleRun } from "@managed-copilot/protocol";
import type {
  AttentionItem,
  CustomizationFile,
  OperatorAccount,
  OperatorAction,
  OperatorAuditEntry,
  OperatorConnections,
  OperatorEnvironment,
  OperatorEnvironments,
  OperatorEvent,
  OperatorHarness,
  OperatorInfrastructure,
  OperatorLogEntry,
  OperatorOverview,
  OperatorSandbox,
  OperatorSchedule,
  OperatorSessionDetail,
  OperatorSessionSummary,
  OperatorWebhooks,
  TrafficSeries,
} from "@managed-copilot/protocol/operator";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
export const ahead = (ms: number): string => new Date(Date.now() + ms).toISOString();

export const ACCOUNTS = {
  octocat: { id: 583231, login: "octocat", name: "The Octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4" },
  monalisa: { id: 1024025, login: "monalisa", name: "Mona Lisa Octocat" },
  defunkt: { id: 2, login: "defunkt", name: "Chris Wanstrath", avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4" },
  hubot: { id: 480938, login: "hubot", avatarUrl: "https://example.com/not-a-github-avatar.png" },
  // One of an app's own users (spec section 2): not a GitHub account.
  carol: { id: -1, login: "support-site/auth0|5f2c", name: "Carol Danvers", kind: "app-user", app: "support-site", userId: "auth0|5f2c" },
} satisfies Record<string, AccountInfo>;

const RESTRICTED = { access: "restricted", allowedDomains: ["*.pythonhosted.org", "api.github.com", "files.pythonhosted.org", "pypi.org", "registry.npmjs.org"] } as const;

function id(prefix: string, seed: number, length = 24): string {
  let out = "";
  let value = seed * 2654435761;
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  for (let index = 0; index < length; index += 1) {
    value = (value * 1103515245 + 12345) % 2147483648;
    out += alphabet[value % alphabet.length];
  }
  return prefix ? `${prefix}_${out}` : out;
}

function uuid(seed: number): string {
  const hex = id("", seed, 32).replace(/[g-z]/g, (char) => (char.charCodeAt(0) % 16).toString(16));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Environments

const CUSTOMIZATION_FILES: Record<string, string> = {
  "agents/planner.agent.md": `---
name: planner
description: "Breaks work orders into tasks and assigns them"
model: claude-sonnet-4.5
tools:
  - read
  - search
  - schedule_task
---

# Planner

You plan work for the **data science** team. For every request:

1. Read the request and the repository's \`README.md\`.
2. Split the work into tasks of at most a day each.
3. Schedule follow-ups with \`schedule_task\` when work waits on data.

| Step | Owner | Notes |
| --- | --- | --- |
| Plan | planner | Always first |
| Build | builder | In a sandbox |

- [x] Never run code yourself
- [ ] Ask before deleting data

See the [Copilot docs](https://docs.github.com/copilot) or the local [style guide](./STYLE.md).

<script>alert("raw HTML is shown as text, never run")</script>

![architecture diagram](https://example.com/diagram.png)
`,
  "agents/reviewer.agent.md": `---
name: reviewer
description: Reviews notebooks and pull requests
---

Review changes for correctness, data leakage, and reproducibility.
`,
  "skills/notebooks/SKILL.md": `---
name: notebooks
description: Run and summarize Jupyter notebooks
---

# Notebooks

Use \`jupyter nbconvert --execute\` to run a notebook, then summarize its outputs.
`,
  "skills/notebooks/scripts/run.py": `import subprocess, sys\n\nsubprocess.run(["jupyter", "nbconvert", "--execute", sys.argv[1]], check=True)\n`,
  "instructions/data-handling.instructions.md": `# Data handling\n\nNever copy customer data out of \`/workspace\`. Aggregate before you summarize.\n`,
  "assets/logo.png": "",
};

export function customizationFile(environment: string, path: string): CustomizationFile | undefined {
  if (!(path in CUSTOMIZATION_FILES)) return undefined;
  const content = CUSTOMIZATION_FILES[path] ?? "";
  const binary = path.endsWith(".png");
  const kind = path.startsWith("agents/") ? "agent" : path.startsWith("skills/") && path.endsWith("SKILL.md") ? "skill" : path.startsWith("instructions/") ? "instruction" : "other";
  return { environment, path, size: binary ? 48_213 : content.length, kind, content: binary ? "" : content, truncated: false, binary };
}

const DATA_SCIENCE: OperatorEnvironment = {
  name: "data-science",
  type: "isolated",
  description: "Notebooks and data pipelines in a sandbox per session, with PyPI and the GitHub API reachable.",
  models: ["claude-sonnet-4.5", "gpt-5"],
  network: RESTRICTED,
  size: "medium",
  resources: { cpus: 2, memoryMiB: 4096 },
  image: "./sandboxes/data-science",
  packages: { python: ["pandas==2.2.3", "numpy", "matplotlib", "jupyter"], npm: ["typescript@5.9.3"], system: ["graphviz"] },
  setupCommands: ["pip install -e ./tools", "python -m tools.warm_cache --quiet"],
  env: { PIP_DISABLE_PIP_VERSION_CHECK: "1", MPLBACKEND: "Agg", DATASET_BUCKET: "contoso-research" },
  vaults: [
    {
      name: "research-apis",
      credentials: [
        { env: "GITHUB_API_TOKEN", hosts: ["api.github.com"], headers: ["authorization"] },
        { mcpServer: "https://mcp.contoso.com/sse", header: "x-api-key" },
      ],
      configured: true,
    },
    { name: "warehouse", credentials: [{ env: "WAREHOUSE_PASSWORD", hosts: ["warehouse.contoso.com"] }], configured: false },
  ],
  scheduling: true,
  idleTimeoutSeconds: 900,
  warm: 2,
  customizations: {
    source: "./customizations/data-science",
    digest: "sha256:4f0c2b9a1e7d3c5b8a6f9e0d1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a6f7e8d9c0b",
    agents: [
      { name: "planner", description: "Breaks work orders into tasks and assigns them", model: "claude-sonnet-4.5", tools: ["read", "search", "schedule_task"], file: "agents/planner.agent.md" },
      { name: "reviewer", description: "Reviews notebooks and pull requests", file: "agents/reviewer.agent.md" },
    ],
    skills: [{ name: "notebooks", description: "Run and summarize Jupyter notebooks", file: "skills/notebooks/SKILL.md" }],
    instructions: [{ file: "instructions/data-handling.instructions.md" }],
    files: Object.keys(CUSTOMIZATION_FILES).map((path) => customizationFile("data-science", path)!).map(({ path, size, kind }) => ({ path, size, kind })),
  },
  tools: {
    builtins: "all",
    platform: [
      { name: "schedule_task", description: "Schedules a follow-up prompt for this session.", placements: ["shared", "sandbox"] },
      { name: "publish_artifact", description: "Publishes files from /workspace/outputs.", placements: ["sandbox"] },
    ],
    mcp: "any",
    enforced: ["Permission requests are answered by the session's owner", "Outputs are published only from /workspace/outputs", "GitHub tokens never enter the sandbox"],
  },
  webhooks: ["research-events"],
  schedules: ["nightly-report"],
  sessions: { total: 9, live: 3 },
};

export const ENVIRONMENTS: OperatorEnvironments = {
  environments: [
    {
      name: "assistant",
      type: "shared",
      description: "Chat assistant sessions on the shared runtime. No sandbox, no local tools.",
      network: { access: "enabled", allowedDomains: [] },
      vaults: [{ name: "crm", credentials: [{ mcpServer: "https://crm.contoso.com/mcp" }], configured: true }],
      scheduling: false,
      tools: {
        builtins: ["view", "glob", "grep", "web_fetch", "report_intent"],
        platform: [{ name: "schedule_task", description: "Schedules a follow-up prompt for this session.", placements: ["shared", "sandbox"] }],
        mcp: "remote",
        enforced: ["Shell and file-write tools are unavailable on the shared runtime", "Remote MCP servers go through the gateway's adapter"],
      },
      webhooks: [],
      schedules: [],
      sessions: { total: 14, live: 4 },
    },
    DATA_SCIENCE,
    {
      name: "builder",
      type: "promotable",
      description: "Starts on the shared runtime and promotes into a data-science sandbox when it needs to run code.",
      network: { access: "enabled", allowedDomains: [] },
      vaults: [],
      scheduling: false,
      promoteTo: "data-science",
      tools: { builtins: ["view", "glob", "grep"], platform: [{ name: "promote", description: "Moves the session into its sandbox.", placements: ["shared"] }], mcp: "remote", enforced: [] },
      webhooks: ["research-events"],
      schedules: [],
      sessions: { total: 3, live: 1 },
    },
    {
      name: "locked-down",
      type: "isolated",
      description: "Air-gapped analysis: no network at all.",
      network: { access: "disabled", allowedDomains: [] },
      size: "small",
      resources: { cpus: 1, memoryMiB: 2048 },
      vaults: [],
      scheduling: false,
      customizations: {
        source: "./customizations/locked-down",
        problem: 'Agent "auditor" names model "gpt-4" which this environment does not allow.',
        agents: [{ name: "auditor", model: "gpt-4", file: "agents/auditor.agent.md" }],
        skills: [],
        instructions: [],
        files: [{ path: "agents/auditor.agent.md", size: 812, kind: "agent" }],
      },
      tools: { builtins: "all", platform: [], mcp: "any", enforced: ["Network access is disabled"] },
      webhooks: [],
      schedules: [],
      sessions: { total: 0, live: 0 },
    },
  ],
  inline: { types: ["shared", "isolated"], sizes: ["small", "medium"] },
  defaultNetwork: { access: "enabled", allowedDomains: [] },
};

// ---------------------------------------------------------------------------------------------------------------
// Sessions

const SESSION_SPECS: readonly Partial<OperatorSessionSummary>[] = [
  { owner: ACCOUNTS.octocat, environment: "data-science", type: "isolated", placement: "sandbox", state: "running", live: true, attached: 2, model: "claude-sonnet-4.5", agent: "planner", clientName: "research-portal" },
  { owner: ACCOUNTS.monalisa, environment: "assistant", type: "shared", placement: "shared", state: "waiting", live: true, attached: 1, model: "gpt-5", clientName: "support-bot" },
  { owner: ACCOUNTS.defunkt, environment: "data-science", type: "isolated", placement: "sandbox", state: "idle", live: false, attached: 0, model: "gpt-5" },
  { owner: ACCOUNTS.octocat, environment: "builder", type: "promotable", placement: "sandbox", state: "promoting", live: true, attached: 1, generation: 2 },
  { owner: ACCOUNTS.hubot, environment: "assistant", type: "shared", placement: "shared", state: "failed", live: false, attached: 0, model: "gpt-5" },
  { owner: ACCOUNTS.monalisa, environment: "data-science", type: "isolated", placement: "sandbox", state: "stopped", live: false, attached: 0, scheduleId: "sch_nightly" },
  { owner: ACCOUNTS.octocat, environment: "assistant", type: "shared", placement: "shared", state: "ready", live: true, attached: 1, clientName: "copilot-cli" },
  { owner: ACCOUNTS.defunkt, environment: "assistant", type: "shared", placement: "shared", state: "deleted", live: false, attached: 0 },
  { owner: ACCOUNTS.monalisa, environment: "assistant", type: "shared", placement: "shared", state: "creating", live: false, attached: 0 },
  { owner: ACCOUNTS.octocat, environment: "data-science", type: "isolated", placement: "sandbox", state: "running", live: true, attached: 1, model: "claude-sonnet-4.5", id: "custom.session.with.dots" },
  { owner: ACCOUNTS.carol, environment: "assistant", type: "shared", placement: "shared", state: "idle", live: true, attached: 1, model: "gpt-5-mini", clientName: "support-site", inference: { route: "foundry", foundry: "contoso-foundry" } },
];

export const SESSIONS: OperatorSessionSummary[] = SESSION_SPECS.map((spec, index) => {
  const turnStatus = spec.state === "running" ? "running" : spec.state === "failed" ? "failed" : "completed";
  return {
    id: spec.id ?? uuid(index + 11),
    owner: spec.owner ?? ACCOUNTS.octocat,
    environment: spec.environment ?? "assistant",
    type: spec.type ?? "shared",
    placement: spec.placement ?? "shared",
    state: spec.state ?? "idle",
    generation: spec.generation ?? 1,
    model: spec.model,
    inference: spec.inference ?? { route: "copilot" },
    agent: spec.agent,
    clientName: spec.clientName,
    scheduleId: spec.scheduleId,
    lastTurn: spec.state === "creating" ? undefined : { turnId: id("turn", index + 3, 12), status: turnStatus, completedAt: turnStatus === "running" ? undefined : ago((index + 1) * 7 * MINUTE) },
    createdAt: ago((index + 2) * 3 * HOUR),
    updatedAt: ago(index * 4 * MINUTE + 20 * SECOND),
    live: spec.live ?? false,
    attached: spec.attached ?? 0,
  };
});

export const SANDBOXES: OperatorSandbox[] = SESSIONS.filter((session) => session.placement === "sandbox").map((session, index) => {
  const state = (["running", "stopped", "setting_up", "stopped", "running"] as const)[index % 5] ?? "running";
  const failedSetup = index === 2;
  return {
    id: id("sbx", index + 40),
    sessionId: session.id,
    owner: session.owner,
    environment: session.environment,
    size: "medium",
    state: failedSetup ? "failed" : state,
    image: "mcr.microsoft.com/managed-copilot/sandbox:1.0.103-data-science",
    imageId: "sha256:9a1e4f0c2b7d3c5b8a6f9e0d1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a6f7e8d9c0b",
    network: RESTRICTED,
    vaults: ["research-apis"],
    subnet: "10.213.4.0/28",
    idleTimeoutSeconds: 900,
    createdAt: ago((index + 3) * HOUR),
    updatedAt: ago(index * 6 * MINUTE),
    startedAt: ago((index + 2) * HOUR),
    stoppedAt: state === "stopped" ? ago(30 * MINUTE) : undefined,
    error: failedSetup ? { code: "setup_failed", message: "Setup command `pip install -e ./tools` exited with 1." } : undefined,
    setup: {
      state: failedSetup ? "failed" : "succeeded",
      steps: [
        { kind: "python", name: "pip install pandas==2.2.3 numpy matplotlib jupyter", state: "succeeded", startedAt: ago(3 * HOUR), finishedAt: ago(3 * HOUR - 41 * SECOND), exitCode: 0 },
        { kind: "npm", name: "npm install -g typescript@5.9.3", state: "succeeded", startedAt: ago(3 * HOUR - 41 * SECOND), finishedAt: ago(3 * HOUR - 50 * SECOND), exitCode: 0 },
        failedSetup
          ? {
              kind: "command",
              name: "pip install -e ./tools",
              state: "failed",
              startedAt: ago(3 * HOUR - 50 * SECOND),
              finishedAt: ago(3 * HOUR - 58 * SECOND),
              exitCode: 1,
              output: "Obtaining file:///workspace/tools\nERROR: file:///workspace/tools does not appear to be a Python project: neither 'setup.py' nor 'pyproject.toml' found.",
            }
          : { kind: "command", name: "pip install -e ./tools", state: "succeeded", startedAt: ago(3 * HOUR - 50 * SECOND), finishedAt: ago(3 * HOUR - 62 * SECOND), exitCode: 0 },
      ],
      resolved: { python: { pandas: "2.2.3", numpy: "2.1.3", matplotlib: "3.9.2", jupyter: "1.1.1" }, npm: { typescript: "5.9.3" } },
      files: [{ path: "config/settings.toml", size: 412, sha256: "6f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0" }],
      startedAt: ago(3 * HOUR),
      finishedAt: ago(3 * HOUR - 62 * SECOND),
      error: failedSetup ? "Setup command `pip install -e ./tools` exited with 1." : undefined,
    },
    activity: state === "running" ? { runtimes: 1, busy: 1, turnRunning: index === 0, lastActivityAt: ago(12 * SECOND), pending: index === 0 ? 1 : 0 } : undefined,
  };
});

const HARNESS: OperatorHarness = {
  model: "claude-sonnet-4.5",
  allowedModels: ["claude-sonnet-4.5", "gpt-5"],
  agent: "planner",
  reasoningEffort: "medium",
  systemMessage: {
    mode: "customize",
    sections: {
      identity: { action: "replace", content: "You are the Contoso research planner." },
      tone: { action: "append", content: "Be concise. Cite datasets by name." },
      safety: { action: "keep" },
    },
  },
  availableTools: ["view", "edit", "bash", "grep", "query_warehouse"],
  excludedTools: ["web_fetch"],
  tools: [
    {
      name: "query_warehouse",
      description: "Runs a read-only SQL query against the research warehouse.",
      source: "client",
      parameters: { type: "object", properties: { sql: { type: "string", description: "SELECT statement" }, limit: { type: "integer", default: 100 } }, required: ["sql"] },
      skipPermission: true,
    },
    { name: "notify_team", description: "Posts a message to the team channel.", source: "server", parameters: { type: "object", properties: { text: { type: "string" } } } },
    { name: "schedule_task", description: "Schedules a follow-up prompt for this session.", source: "platform", overridesBuiltInTool: false },
  ],
  mcpServers: [
    { name: "contoso-docs", transport: "sse", url: "https://mcp.contoso.com/sse?key=REDACTED", headers: ["x-api-key"], env: [], tools: ["search_docs", "get_doc"], adapter: true },
    { name: "filesystem", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"], headers: [], env: ["NODE_ENV"], agent: "reviewer" },
  ],
  customAgents: [
    {
      name: "reviewer",
      displayName: "Notebook reviewer",
      description: "Reviews notebooks for leakage and reproducibility.",
      model: "gpt-5",
      tools: ["view", "grep"],
      prompt: "Review every changed notebook. Flag data leakage, missing seeds, and unpinned dependencies.\nNever approve your own changes.",
      mcpServers: ["filesystem"],
    },
  ],
  customizations: { agents: true, skills: true, instructions: true },
  skills: { enabled: true, disabled: ["web-research"] },
  callbacks: { tools: ["query_warehouse"], flags: ["requestPermission", "hooks", "userInput"] },
  workingDirectory: "/workspace",
  options: { streaming: true, infiniteSessions: false, maxTurns: 40, clientVersion: "research-portal/2.3.0" },
  enforced: ["workingDirectory is /workspace", "Outputs publish from /workspace/outputs only", "Permission handlers are required for shell tools"],
};

export const ACTIONS: OperatorAction[] = [
  { kind: "permission", state: "pending", tool: "bash", responder: "live", reason: undefined },
  { kind: "tool", state: "needs_reconciliation", tool: "query_warehouse", responder: "webhook", claimedBy: "worker-7", reason: "The gateway restarted while the tool ran; check the warehouse before answering." },
  { kind: "user_input", state: "claimed", responder: "cli", claimedBy: "copilot-cli@octocat" },
  { kind: "tool", state: "completed", tool: "notify_team", responder: "poll" },
  { kind: "elicitation", state: "expired", responder: "live", reason: "No responder answered before the deadline." },
  { kind: "hook", state: "executing", tool: "preToolUse", responder: "platform" },
].map((spec, index) => {
  const session = SESSIONS[index % 3]!;
  return {
    id: id("act", index + 60, 22),
    sessionId: session.id,
    owner: session.owner,
    environment: session.environment,
    kind: spec.kind as OperatorAction["kind"],
    state: spec.state as OperatorAction["state"],
    tool: spec.tool,
    responder: spec.responder,
    claimedBy: spec.claimedBy,
    generation: 1,
    createdAt: ago((index + 1) * 9 * MINUTE),
    updatedAt: ago(index * 2 * MINUTE),
    deadlineAt: index === 1 ? ago(5 * MINUTE) : ahead((index + 1) * 20 * MINUTE),
    leaseExpiresAt: spec.claimedBy ? ahead(4 * MINUTE) : undefined,
    completedAt: spec.state === "completed" || spec.state === "expired" ? ago(MINUTE) : undefined,
    reason: spec.reason,
  };
});

export function sessionDetail(sessionId: string): OperatorSessionDetail | undefined {
  const summary = SESSIONS.find((session) => session.id === sessionId);
  if (!summary) return undefined;
  const index = SESSIONS.indexOf(summary);
  const sandbox = SANDBOXES.find((candidate) => candidate.sessionId === summary.id);
  return {
    ...summary,
    incarnation: uuid(index + 300),
    webhook: summary.environment === "data-science" ? "research-events" : undefined,
    environmentRequest: {
      name: summary.environment,
      network: index === 0 ? ["pypi.org", "files.pythonhosted.org"] : undefined,
      vaults: index === 0 ? ["research-apis"] : undefined,
      packages: index === 0 ? { python: ["scikit-learn"] } : undefined,
      env: index === 0 ? ["EXPERIMENT_ID"] : undefined,
      files: index === 0 ? [{ path: "data/sample.csv", bytes: 18_432 }] : undefined,
    },
    harness: summary.state === "failed" ? undefined : HARNESS,
    harnessProblem: summary.state === "failed" ? "The admitted configuration could not be read: unexpected token at position 412." : undefined,
    attachments:
      summary.attached > 0
        ? [
            { connectionId: `conn_${uuid(index + 500)}`, kind: "sdk", account: summary.owner, clientName: summary.clientName ?? "sdk-app", attachedAt: ago(42 * MINUTE), tools: ["query_warehouse"], callbacks: ["requestPermission", "hooks"] },
            ...(summary.attached > 1 ? [{ connectionId: `cli_${uuid(index + 600)}`, kind: "cli" as const, account: ACCOUNTS.monalisa, attachedAt: ago(5 * MINUTE), tools: [], callbacks: ["userInput"] }] : []),
          ]
        : [],
    runtime: summary.live ? { ready: true, upstream: summary.placement === "shared" ? "shared" : `sandbox:${summary.id}`, restoring: false, cutover: summary.state === "promoting", deleting: false, waits: summary.state === "waiting" ? 1 : 0, presences: summary.attached } : undefined,
    network: {
      policy: summary.placement === "sandbox" ? RESTRICTED : { access: "enabled", allowedDomains: [] },
      vaults: summary.placement === "sandbox" ? ["research-apis"] : [],
      promotedTo: summary.type === "promotable" ? "data-science" : undefined,
      recentBlocks:
        index === 0
          ? [
              { id: 91, sessionId: summary.id, sandboxId: sandbox?.id, at: ago(3 * MINUTE), reason: "host_not_allowed", host: "huggingface.co", port: 443, method: "GET", path: "/api/models", message: "huggingface.co is not in the environment's allowed hosts." },
              { id: 90, sessionId: summary.id, sandboxId: sandbox?.id, at: ago(14 * MINUTE), reason: "credential_misuse", host: "evil.example", port: 443, method: "POST", path: "/collect", message: "A vault placeholder was sent to a host it is not bound to." },
            ]
          : [],
    },
    sandbox,
    actions: ACTIONS.filter((action) => action.sessionId === summary.id),
    promotion:
      summary.type === "promotable"
        ? { id: id("prm", index + 70, 32), state: "copying_state", trigger: "tool", target: "data-science", fromGeneration: 1, sandboxId: sandbox?.id, createdAt: ago(2 * MINUTE), updatedAt: ago(20 * SECOND) }
        : undefined,
    artifacts:
      summary.placement === "sandbox"
        ? {
            count: 3,
            bytes: 2_412_544,
            latest: [
              { path: "report/summary.md", version: 3, size: 8_211, state: "published", publishedAt: ago(9 * MINUTE) },
              { path: "figures/churn.png", version: 1, size: 2_401_002, state: "published", publishedAt: ago(9 * MINUTE) },
              { path: "data/clean.parquet", version: 1, size: 3_331, state: "failed" },
            ],
          }
        : undefined,
    schedules: index === 0 ? [{ id: "sch_followup", name: "Check the model run", state: "active" }] : [],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Schedules, webhooks, accounts, audit

export const SCHEDULES: OperatorSchedule[] = [
  {
    id: "sch_nightly",
    name: "nightly-report",
    cron: "0 2 * * *",
    timeZone: "America/Los_Angeles",
    environment: "data-science",
    state: "active",
    createdBy: "apphost",
    owner: ACCOUNTS.octocat,
    prompt: "Summarize yesterday's experiment results and post the report to /workspace/outputs/report.md.",
    session: { agent: "planner", model: "claude-sonnet-4.5", tools: [{ name: "notify_team", description: "Posts to the team channel" }] },
    webhook: "research-events",
    nextRunAt: ahead(7 * HOUR),
    lastRun: { id: "run_1", scheduleId: "sch_nightly", occurrenceId: "occ_1", scheduledFor: ago(17 * HOUR), startedAt: ago(17 * HOUR), completedAt: ago(16.8 * HOUR), status: "completed", trigger: "cron", sessionId: SESSIONS[5]!.id },
    createdAt: ago(30 * 24 * HOUR),
  },
  {
    id: "sch_followup",
    name: "Check the model run",
    runAt: ahead(25 * MINUTE),
    timeZone: "UTC",
    environment: "data-science",
    state: "active",
    createdBy: "agent",
    owner: ACCOUNTS.octocat,
    target: { sessionId: SESSIONS[0]!.id },
    nextRunAt: ahead(25 * MINUTE),
    createdAt: ago(35 * MINUTE),
  },
  {
    id: "sch_weekly",
    name: "Weekly triage",
    cron: "0 9 * * MON",
    timeZone: "Europe/Amsterdam",
    environment: "assistant",
    state: "paused",
    pausedReason: "monalisa signed out of background work (managed-copilot logout).",
    createdBy: "user",
    owner: ACCOUNTS.monalisa,
    lastRun: { id: "run_9", scheduleId: "sch_weekly", occurrenceId: "occ_9", scheduledFor: ago(6 * 24 * HOUR), startedAt: ago(6 * 24 * HOUR), status: "needs_reconciliation", trigger: "cron", reason: "A restart interrupted delivery; the session history could not settle whether the prompt arrived." },
    createdAt: ago(60 * 24 * HOUR),
  },
];

export function scheduleRuns(scheduleId: string): ScheduleRun[] {
  if (scheduleId === "sch_followup") return [];
  return Array.from({ length: 8 }, (_, index) => {
    const status = index === 2 ? "failed" : index === 5 ? "skipped" : "completed";
    return {
      id: `run_${scheduleId}_${index}`,
      scheduleId,
      occurrenceId: `occ_${index}`,
      scheduledFor: ago((index + 1) * 24 * HOUR),
      startedAt: status === "skipped" ? undefined : ago((index + 1) * 24 * HOUR - 2 * SECOND),
      completedAt: status === "skipped" ? undefined : ago((index + 1) * 24 * HOUR - 4 * MINUTE),
      status,
      sessionId: status === "skipped" ? undefined : SESSIONS[(index + 2) % SESSIONS.length]!.id,
      trigger: index === 4 ? "manual" : "cron",
      reason: status === "failed" ? "The sandbox failed to start: setup_failed." : status === "skipped" ? "The previous run was still in progress." : undefined,
    } satisfies ScheduleRun;
  });
}

export const WEBHOOKS: OperatorWebhooks = {
  subscriptions: [
    { name: "research-events", url: "https://hooks.contoso.com/managed-copilot?token=REDACTED", environments: ["data-science", "builder"], events: ["session.idle", "artifact.published", "schedule.run_completed"], signed: true },
    { name: "audit-sink", url: "https://audit.contoso.com/ingest", environments: ["assistant"], events: ["session.created", "session.deleted"], signed: false },
  ],
  deliveries: [
    ...(["delivered", "delivered", "failed", "pending", "delivering", "failed", "delivered"] as const).map((state, index) => ({
      id: id("whd", index + 80, 22),
      webhook: index % 3 === 2 ? "audit-sink" : "research-events",
      eventId: id("evt", index + 90, 24),
      eventType: index % 3 === 2 ? "session.created" : index % 2 === 0 ? "artifact.published" : "session.idle",
      sessionId: SESSIONS[index % SESSIONS.length]!.id,
      environment: SESSIONS[index % SESSIONS.length]!.environment,
      owner: SESSIONS[index % SESSIONS.length]!.owner,
      state,
      attempts: state === "failed" ? 8 : state === "pending" ? 1 : state === "delivering" ? 2 : 1,
      lastStatus: state === "failed" ? (index === 2 ? 500 : undefined) : state === "delivered" ? 200 : state === "pending" ? 503 : undefined,
      lastError: state === "failed" ? (index === 2 ? "Receiver answered HTTP 500." : "Signing secret AUDIT_SINK_SECRET is not configured.") : undefined,
      nextAttemptAt: state === "pending" ? ahead(40 * SECOND) : undefined,
      createdAt: ago((index + 1) * 11 * MINUTE),
      updatedAt: ago(index * MINUTE),
      deliveredAt: state === "delivered" ? ago((index + 1) * 11 * MINUTE - 3 * SECOND) : undefined,
    })),
  ],
  counts: { pending: 1, delivering: 1, delivered: 3, failed: 2 },
};

export const ACCOUNT_ROWS: OperatorAccount[] = [
  { account: ACCOUNTS.octocat, lastSeenAt: ago(20 * SECOND), sessions: { total: 12, live: 3 }, connections: 2, schedules: { active: 2, paused: 0 }, background: { state: "active", createdAt: ago(9 * 24 * HOUR), lastVerifiedAt: ago(40 * MINUTE) }, operator: true },
  { account: ACCOUNTS.monalisa, lastSeenAt: ago(3 * MINUTE), sessions: { total: 6, live: 1 }, connections: 1, schedules: { active: 0, paused: 1 }, background: { state: "revoked", createdAt: ago(20 * 24 * HOUR), reason: "Signed out with managed-copilot logout." }, operator: false },
  { account: ACCOUNTS.defunkt, lastSeenAt: ago(2 * 24 * HOUR), sessions: { total: 3, live: 0 }, connections: 0, schedules: { active: 0, paused: 0 }, background: { state: "invalid", lastVerifiedAt: ago(3 * 24 * HOUR), reason: "GitHub rejected the stored token (revoked)." }, operator: false },
  { account: ACCOUNTS.hubot, lastSeenAt: ago(45 * 24 * HOUR), sessions: { total: 1, live: 0 }, connections: 0, schedules: { active: 0, paused: 0 }, background: { state: "none" }, operator: false },
];

export const AUDIT: OperatorAuditEntry[] = [
  { id: 8, at: ago(2 * MINUTE), actor: ACCOUNTS.octocat, action: "console.signin", outcome: "succeeded" },
  { id: 7, at: ago(55 * MINUTE), actor: ACCOUNTS.octocat, action: "sandbox.stop", target: SESSIONS[2]!.id, outcome: "succeeded", detail: "Stopped after the current turn drained." },
  { id: 6, at: ago(3 * HOUR), actor: ACCOUNTS.octocat, action: "schedule.pause", target: "sch_weekly", outcome: "succeeded", detail: "Paused during the warehouse migration." },
  { id: 5, at: ago(5 * HOUR), actor: ACCOUNTS.octocat, action: "webhook.retry", target: WEBHOOKS.deliveries[2]!.id, outcome: "failed", detail: "Receiver answered HTTP 500." },
  { id: 4, at: ago(26 * HOUR), actor: ACCOUNTS.octocat, action: "sandboxes.probe", outcome: "succeeded", detail: "Docker 27.3.1 is available." },
  { id: 3, at: ago(27 * HOUR), actor: ACCOUNTS.octocat, action: "console.signout", outcome: "succeeded" },
];

// ---------------------------------------------------------------------------------------------------------------
// Events and logs

const EVENT_TYPES = ["session.created", "session.idle", "session.action_required", "artifact.published", "network.blocked", "schedule.run_started", "schedule.run_completed", "session.failed", "session.promoted", "session.deleted"] as const;

export function makeEvent(index: number, at = ago((60 - index) * 40 * SECOND)): OperatorEvent {
  const session = SESSIONS[index % SESSIONS.length]!;
  const type = EVENT_TYPES[index % EVENT_TYPES.length]!;
  const data: Record<string, unknown> =
    type === "network.blocked"
      ? { host: "huggingface.co", port: 443, reason: "host_not_allowed" }
      : type === "artifact.published"
        ? { path: "report/summary.md", version: 3, size: 8211 }
        : type === "session.action_required"
          ? { kind: "permission", tool: "bash", actionId: ACTIONS[0]!.id }
          : type === "schedule.run_started" || type === "schedule.run_completed"
            ? { scheduleId: "sch_nightly", runId: `run_${index}`, status: type === "schedule.run_completed" ? "completed" : "running" }
            : type === "session.failed"
              ? { code: "setup_failed", message: "Setup command exited with 1." }
              : {};
  return { id: id("evt", index + 1000, 20), type, createdAt: at, owner: session.owner, sessionId: session.id, environment: session.environment, sandboxId: type === "session.promoted" ? SANDBOXES[0]?.id : undefined, data };
}

export const EVENTS: OperatorEvent[] = Array.from({ length: 60 }, (_, index) => makeEvent(index));

const LOG_LINES: readonly [OperatorLogEntry["level"], string, string, Record<string, unknown> | undefined][] = [
  ["info", "gateway:http", "GET /v1/operator/overview 200", { durationMs: 12, requestId: "req_1f2e" }],
  ["debug", "gateway:core", "session event forwarded", { sessionId: "3f2a9c1e", type: "assistant.message_delta" }],
  ["info", "gateway:sandbox", "sandbox started", { sandboxId: "sbx_01jb2q7z", sizeName: "medium", ms: 4210 }],
  ["warn", "gateway:egress", "blocked outbound request", { host: "huggingface.co", reason: "host_not_allowed", token: "****" }],
  ["error", "gateway:webhooks", "delivery failed", { webhook: "audit-sink", status: 500, attempt: 8 }],
  ["info", "gateway:scheduler", "schedule run started", { scheduleId: "sch_nightly" }],
  ["debug", "gateway:rpc", "request session.send", undefined],
  ["info", "gateway:operator", "console sign-in", { login: "octocat" }],
];

export function makeLog(seq: number, at = ago((400 - seq) * 6 * SECOND)): OperatorLogEntry {
  const [level, logger, message, fields] = LOG_LINES[seq % LOG_LINES.length]!;
  return { seq, at, level, logger, message, fields };
}

export const LOGS: OperatorLogEntry[] = Array.from({ length: 400 }, (_, index) => makeLog(index + 1));

// ---------------------------------------------------------------------------------------------------------------
// Overview and infrastructure

function series(base: number, amplitude: number, seed: number): TrafficSeries {
  const perMinute = Array.from({ length: 60 }, (_, index) => Math.max(0, Math.round(base + amplitude * Math.sin((index + seed) / 6) + ((index * seed) % 7))));
  return { total: perMinute.reduce((sum, value) => sum + value, 0), perMinute };
}

const ATTENTION: AttentionItem[] = [
  { id: "a1", severity: "warning", title: "2 webhook deliveries failed", detail: "audit-sink has no signing secret configured, so its deliveries fail.", target: { view: "webhooks" }, at: ago(11 * MINUTE) },
  { id: "a2", severity: "error", title: "An action needs reconciliation", detail: "query_warehouse may or may not have run. Check the warehouse, then answer it.", target: { view: "actions" }, at: ago(9 * MINUTE) },
  { id: "a3", severity: "error", title: "locked-down sessions fail", detail: 'Agent "auditor" names model "gpt-4" which this environment does not allow.', target: { view: "environments", id: "locked-down" }, at: ago(2 * HOUR) },
  { id: "a4", severity: "info", title: "A session has been waiting for 12 minutes", target: { view: "sessions", id: SESSIONS[1]!.id }, at: ago(12 * MINUTE) },
];

export function overview(empty: boolean): OperatorOverview {
  return {
    deployment: {
      name: "copilot",
      version: "0.1.0",
      mode: "local",
      publicUrl: "http://127.0.0.1:7400",
      startedAt: ago(2 * HOUR + 14 * MINUTE),
      capabilities: ["isolated", "promotion", "attach.cli", "schedules", "webhooks", "vaults"],
      sdk: { copilotSdk: "1.0.26", copilotRuntime: "1.0.103" },
    },
    health: INFRASTRUCTURE.health,
    counts: empty
      ? { sessions: { total: 0, live: 0, byState: {}, byPlacement: {}, byEnvironment: {} }, connections: { sdk: 0, cli: 0 }, sandboxes: { total: 0, byState: {} }, schedules: { active: 0, paused: 0 }, actions: { open: 0, needsReconciliation: 0 }, webhooks: { pending: 0, failed: 0 }, accounts: 1 }
      : {
          sessions: { total: 26, live: 8, byState: { running: 2, waiting: 1, idle: 9, ready: 3, failed: 1, stopped: 6, promoting: 1, creating: 1, deleted: 2 }, byPlacement: { shared: 15, sandbox: 11 }, byEnvironment: { assistant: 14, "data-science": 9, builder: 3 } },
          connections: { sdk: 5, cli: 2 },
          sandboxes: { total: 5, byState: { running: 2, stopped: 2, failed: 1 } },
          schedules: { active: 2, paused: 1 },
          actions: { open: 4, needsReconciliation: 1 },
          webhooks: { pending: 1, failed: 2 },
          accounts: 4,
        },
    traffic: empty
      ? {}
      : {
          "http.requests": series(120, 60, 1),
          "http.errors": series(0, 1.4, 3),
          "rpc.requests": series(340, 120, 2),
          "rpc.notifications": series(2200, 700, 4),
          "connections.opened": series(2, 2, 5),
          "sessions.created": series(1, 1.5, 6),
          "events.published": series(18, 9, 7),
          "inference.requests": series(40, 25, 8),
        },
    attention: empty ? [] : ATTENTION,
    generatedAt: new Date().toISOString(),
  };
}

export const INFRASTRUCTURE: OperatorInfrastructure = {
  gateway: {
    version: "0.1.0",
    mode: "local",
    publicUrl: "http://127.0.0.1:7400",
    listen: "127.0.0.1:7400",
    pid: 18244,
    node: "v24.11.0",
    platform: "win32-arm64",
    startedAt: ago(2 * HOUR + 14 * MINUTE),
    uptimeSeconds: 2 * 3600 + 14 * 60 + 9,
    memory: { rssBytes: 312 * 1024 * 1024, heapUsedBytes: 141 * 1024 * 1024, heapTotalBytes: 176 * 1024 * 1024 },
    eventLoopDelayMs: { p50: 0.42, p99: 7.9, max: 31.2 },
    modules: ["core", "auth", "sandbox", "network", "durable", "promotion", "attach", "operator"],
    capabilities: ["isolated", "promotion", "attach.cli", "schedules", "webhooks", "vaults"],
    access: { githubUsers: ["octocat", "monalisa"], githubOrgs: ["contoso"], open: false },
    operators: { githubUsers: ["octocat"], githubOrgs: ["contoso-platform"], localDefault: false },
    facts: [
      { label: "Data directory", value: "C:\\Users\\octocat\\.managed-copilot\\data", mono: true },
      { label: "Lease generation", value: "7" },
      { label: "Instance", value: "gw-local-1" },
    ],
  },
  runtime: { state: "running", external: false, version: "1.0.103", protocolVersion: 3, pid: 18302, generation: 2, connectedAt: ago(2 * HOUR), restarts: 1, sessions: 4 },
  sandboxes: {
    provider: "docker",
    available: true,
    checkedAt: ago(4 * MINUTE),
    defaultIdleSeconds: 900,
    facts: [
      { label: "Docker engine", value: "27.3.1", mono: true },
      { label: "Architecture", value: "linux/arm64", mono: true },
      { label: "Network", value: "managed-copilot-sandboxes", mono: true },
    ],
    counts: { running: 2, stopped: 2, failed: 1 },
  },
  egress: { mode: "docker", connected: true, instanceId: "mc-egress-7f3a", version: "0.1.0", since: ago(2 * HOUR), caFingerprint: "SHA256:5B:9C:0D:4E:2F:71:AA:3B:C4:D5:E6:F7:08:19:2A:3B:4C:5D:6E:7F:80:91:A2:B3:C4:D5:E6:F7:08:19:2A:3B", registrations: 2, blockedLastDay: 17 },
  scheduler: { running: true, tickIntervalMs: 1000, lastTickAt: ago(800), nextDueAt: ahead(25 * MINUTE), queuedRuns: 0, activeRuns: 1 },
  webhooks: { running: true, subscriptions: 2, counts: { pending: 1, delivering: 1, delivered: 3, failed: 2 } },
  storage: { dataDir: "C:\\Users\\octocat\\.managed-copilot\\data", databaseBytes: 18_874_368, walBytes: 4_194_304 },
  health: [
    { id: "gateway", name: "Gateway", status: "healthy", summary: "Up 2 h 14 min · 7 connections", since: ago(2 * HOUR + 14 * MINUTE) },
    { id: "runtime", name: "Shared runtime", status: "healthy", summary: "Running · runtime 1.0.103 · generation 2", since: ago(2 * HOUR) },
    { id: "sandboxes", name: "Sandboxes", status: "degraded", summary: "Docker 27.3.1 · 2 running · 1 failed", detail: "A sandbox failed setup. Open it to read the failing step's output.", since: ago(3 * HOUR) },
    { id: "egress", name: "Egress proxy", status: "healthy", summary: "Connected · 2 sandboxes registered", since: ago(2 * HOUR) },
    { id: "scheduler", name: "Scheduler", status: "healthy", summary: "1 run active · next in 25 min" },
    { id: "webhooks", name: "Webhooks", status: "unavailable", summary: "2 failed deliveries", detail: "audit-sink has no signing secret. Set AUDIT_SINK_SECRET for the gateway, then retry the failed deliveries." },
    { id: "storage", name: "Storage", status: "healthy", summary: "18 MiB database · 4 MiB WAL" },
  ],
  generatedAt: new Date().toISOString(),
};

export const CONNECTIONS: OperatorConnections = {
  connections: [
    { id: `conn_${uuid(900)}`, kind: "sdk", account: ACCOUNTS.octocat, environment: "data-science", clientName: "research-portal", connectedAt: ago(42 * MINUTE), lastActivityAt: ago(3 * SECOND), requests: 1_204, notifications: 48_211, sessions: [SESSIONS[0]!.id, SESSIONS[9]!.id] },
    { id: `cli_${uuid(901)}`, kind: "cli", account: ACCOUNTS.monalisa, environment: "data-science", clientName: "copilot-cli 1.0.103", connectedAt: ago(5 * MINUTE), lastActivityAt: ago(40 * SECOND), requests: 88, notifications: 3_120, sessions: [SESSIONS[0]!.id] },
    { id: `conn_${uuid(902)}`, kind: "sdk", account: ACCOUNTS.monalisa, environment: "assistant", clientName: "support-bot", connectedAt: ago(3 * HOUR), lastActivityAt: ago(12 * MINUTE), requests: 9_311, notifications: 120_442, sessions: SESSIONS.slice(1, 7).map((session) => session.id) },
    { id: `conn_${uuid(903)}`, kind: "sdk", account: ACCOUNTS.octocat, environment: "builder", connectedAt: ago(9 * MINUTE), sessions: [] },
  ],
  upstreams: [
    { id: "shared", kind: "shared", sessions: [SESSIONS[1]!.id, SESSIONS[6]!.id], version: "1.0.103" },
    { id: `sandbox:${SESSIONS[0]!.id}`, kind: "sandbox", sessions: [SESSIONS[0]!.id], version: "1.0.103" },
  ],
  generatedAt: new Date().toISOString(),
};
