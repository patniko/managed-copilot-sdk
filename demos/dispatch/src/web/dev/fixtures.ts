/**
 * Fixture data for the UI preview (`?preview`, dev only). Never imported by production code paths: `main.tsx` loads
 * the preview only when `import.meta.env.DEV` is true.
 */
import { BLUEPRINT_LABELS, TEMPLATES } from "../../shared/catalog.js";
import type {
  Approval,
  Blueprint,
  ChatMessage,
  Command,
  ConversationView,
  Decision,
  DispatchState,
  FileView,
  PlatformStatus,
  StyleInfo,
  SubAgent,
  WorkerState,
  WorkerView,
} from "../../shared/types.js";

export interface Fixtures {
  readonly state: Omit<DispatchState, "conversations">;
  readonly conversations: ConversationView[];
  /** File contents by path, for the file dialog. */
  readonly contents: Readonly<Record<string, string>>;
}

const MODEL = "claude-sonnet-5";

export const PREVIEW_BLUEPRINTS: readonly Blueprint[] = [
  blueprint("dispatch-python", "python", "medium", 2, 4, { access: "disabled", hosts: [] }, true),
  blueprint("dispatch-node", "node", "small", 1, 2, { access: "restricted", hosts: ["registry.npmjs.org"] }),
  blueprint("dispatch-web", "web", "small", 1, 2, {
    access: "restricted",
    hosts: ["en.wikipedia.org", "api.github.com", "raw.githubusercontent.com", "nodejs.org", "docs.python.org", "www.python.org", "learn.microsoft.com"],
  }),
  blueprint("dispatch-writer", "writer", "small", 1, 2, { access: "disabled", hosts: [] }),
];

function blueprint(name: string, kind: Blueprint["kind"], size: string, cpus: number, memoryGiB: number, network: Blueprint["network"], isDefault = false): Blueprint {
  return { name, kind, label: BLUEPRINT_LABELS[kind], description: `${BLUEPRINT_LABELS[kind]} (preview fixture).`, size, cpus, memoryGiB, network, agents: [], isDefault };
}

const WORKERS = PREVIEW_BLUEPRINTS.map((entry) => entry.name);

export const PREVIEW_STYLES: readonly StyleInfo[] = [
  { style: "delegate", environment: "dispatch", available: true, coordinator: { environment: "dispatch", model: MODEL, maxWorkers: 6, style: "delegate" }, workers: WORKERS },
  {
    style: "direct",
    environment: "dispatch-direct",
    available: true,
    coordinator: { environment: "dispatch-direct", model: MODEL, maxWorkers: 6, style: "direct" },
    handsEnvironment: "dispatch-python",
    subagents: "shared",
    workers: [],
  },
  {
    style: "mixed",
    environment: "dispatch-mixed",
    available: true,
    coordinator: { environment: "dispatch-mixed", model: MODEL, maxWorkers: 6, style: "mixed" },
    handsEnvironment: "dispatch-python",
    subagents: "shared",
    workers: WORKERS,
  },
];

export function previewPlatform(variant: string): PlatformStatus {
  const account = { login: "monalisa", name: "Mona Lisa Octocat" };
  if (variant === "connecting") return { state: "connecting" };
  if (variant === "unavailable") return { state: "unavailable", url: "http://localhost:7400", message: "Managed Copilot at http://localhost:7400 isn't answering. Is `aspire run` up?" };
  if (variant === "azure") return { state: "connected", url: "https://copilot.bravedesert-123.westus2.azurecontainerapps.io", mode: "azure", deployment: "copilot", account };
  return { state: "connected", url: "http://localhost:7400", mode: "local", deployment: "copilot", account };
}

/** Builds the fixtures relative to `now`, so relative times ("3 min ago") and timers look live. */
export function createFixtures(now: number, variant: string): Fixtures {
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  const offline = variant === "connecting" || variant === "unavailable";
  const state: Fixtures["state"] = {
    platform: previewPlatform(variant),
    ...(offline ? {} : { coordinator: PREVIEW_STYLES[0]!.coordinator }),
    styles: offline ? [] : PREVIEW_STYLES,
    blueprints: offline ? [] : PREVIEW_BLUEPRINTS,
    templates: TEMPLATES,
    defaults: { approvals: "ask", style: "delegate" },
    attachCommand: "npx managed-copilot attach {sessionId}",
    canLaunchTerminal: true,
  };
  const conversations = variant === "empty" || variant === "connecting" ? [] : [radar(ago), primes(ago), fibonacci(ago), pi(ago), sorts(ago)];
  return { state, conversations, contents: CONTENTS };
}

type Ago = (seconds: number) => string;

type ViewFields = Omit<ConversationView, "messageCount" | "sandboxCount" | "liveSandboxes" | "attachCommand" | "approvedRest" | "createdAt" | "agents"> & {
  readonly agents?: ConversationView["agents"];
};

function view(fields: ViewFields): ConversationView {
  const workers = fields.workers;
  return {
    ...fields,
    agents: fields.agents ?? {},
    createdAt: fields.messages[0]?.at ?? fields.updatedAt,
    messageCount: fields.messages.filter((message) => message.role === "user").length,
    sandboxCount: workers.length,
    liveSandboxes: workers.filter((worker) => worker.state !== "stopped").length,
    approvedRest: [],
    attachCommand: `npx managed-copilot attach ${fields.id}`,
  };
}

function user(id: string, index: number, at: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "user", index, at, content, via: "dispatch", messageId: `${id}-runtime`, ...extra };
}

function reply(id: string, at: string, content: string): ChatMessage {
  return { id, role: "assistant", at, content };
}

function worker(fields: Partial<WorkerView> & Pick<WorkerView, "id" | "name" | "environment" | "state" | "createdAt">, timeline: readonly (readonly [WorkerState, string])[]): WorkerView {
  return {
    role: "worker",
    task: "",
    tasks: 1,
    updatedAt: timeline.at(-1)?.[1] ?? fields.createdAt,
    sentWorkBy: [],
    outputs: [],
    model: MODEL,
    timeline: timeline.map(([state, at]) => ({ state, at })),
    ...fields,
  };
}

function files(at: string, entries: readonly (readonly [string, number])[]): Pick<WorkerView, "files" | "filesAt"> {
  return { files: entries.map(([path, size]): FileView => ({ path, size, modifiedAt: at })), filesAt: at };
}

// ─── Delegate: estimate π three ways, then a follow-up that reuses one sandbox and adds a writer ──────────────

function pi(ago: Ago): ConversationView {
  const t = (seconds: number) => ago(420 - seconds);
  const mcTask =
    "Estimate π with a Monte Carlo simulation: sample random points in the unit square and count those inside the quarter circle. Report the estimate and its absolute error after 10, 1,000, and 1,000,000 samples (seed 42), and save the numbers to outputs/estimates.json.";
  const decisions1: Decision[] = [
    { id: "d1", kind: "create", status: "done", at: t(4), endedAt: t(6), worker: "monte-carlo-pi", workerId: "w-mc", environment: "dispatch-python", task: mcTask },
    { id: "d2", kind: "create", status: "done", at: t(4), endedAt: t(6), worker: "leibniz-pi", workerId: "w-lb", environment: "dispatch-python", task: "Estimate π with the Leibniz series after 10, 1,000, and 1,000,000 terms." },
    { id: "d3", kind: "create", status: "done", at: t(5), endedAt: t(7), worker: "nilakantha-pi", workerId: "w-nk", environment: "dispatch-python", task: "Estimate π with the Nilakantha series after 10, 1,000, and 1,000,000 terms." },
    { id: "d4", kind: "wait", status: "done", at: t(8), endedAt: t(39), workers: ["monte-carlo-pi", "leibniz-pi", "nilakantha-pi"] },
  ];
  const decisions2: Decision[] = [
    { id: "d5", kind: "message", status: "done", at: t(96), endedAt: t(97), worker: "monte-carlo-pi", workerId: "w-mc", task: "Run the simulation again with 10,000,000 samples (seed 42) and add the result to outputs/estimates.json." },
    { id: "d6", kind: "wait", status: "done", at: t(98), endedAt: t(118), workers: ["monte-carlo-pi"] },
    {
      id: "d7",
      kind: "create",
      status: "done",
      at: t(120),
      endedAt: t(123),
      worker: "pi-error-chart",
      workerId: "w-ch",
      environment: "dispatch-writer",
      task: "Chart the absolute error of all three methods against the number of steps (log-log), from the data below, and write a short report around it.",
    },
    { id: "d8", kind: "copy", status: "done", at: t(124), endedAt: t(125), from: "monte-carlo-pi", to: "pi-error-chart", paths: ["outputs/estimates.json"] },
    { id: "d9", kind: "wait", status: "done", at: t(126), endedAt: t(171), workers: ["pi-error-chart"] },
  ];
  const messages: ChatMessage[] = [
    user(
      "m1",
      1,
      t(0),
      "Estimate π three ways in parallel: a Monte Carlo simulation, the Leibniz series, and the Nilakantha series. Report each estimate and its error after 10, 1,000, and 1,000,000 steps, and say which converges fastest.",
      { decisions: decisions1 },
    ),
    reply("a1", t(3), "I'll run each method in its own Python sandbox, in parallel."),
    reply(
      "a2",
      t(41),
      [
        "All three finished. **Nilakantha converges fastest**: its error shrinks like O(1/n³).",
        "",
        "| Steps | Monte Carlo | Leibniz | Nilakantha |",
        "| ---: | ---: | ---: | ---: |",
        "| 10 | 3.600000 | 3.041840 | 3.141406 |",
        "| 1,000 | 3.128000 | 3.140593 | 3.141593 |",
        "| 1,000,000 | 3.140592 | 3.141592 | 3.141593 |",
        "",
        "Monte Carlo is the slowest and noisiest (O(1/√n)); Leibniz is steady but slow (O(1/n)).",
      ].join("\n"),
    ),
    user("m2", 2, t(92), "Run the Monte Carlo one again with 10 million samples, then chart the error of all three as the steps grow.", { decisions: decisions2 }),
    reply("a3", t(95), "Sending the rerun to **monte-carlo-pi**, which already has the code, then a writer charts all three."),
    reply(
      "a4",
      t(173),
      [
        "Done. With 10 million samples Monte Carlo's error drops to 7.1×10⁻⁴, still worse than Leibniz at 1,000 terms.",
        "",
        "The chart is in **pi-error-chart**: `outputs/pi_error_chart.svg`, with a short write-up in `outputs/report.md`.",
      ].join("\n"),
    ),
  ];
  const workers: WorkerView[] = [
    worker(
      {
        id: "w-mc",
        name: "monte-carlo-pi",
        environment: "dispatch-python",
        state: "idle",
        createdAt: t(5),
        task: mcTask,
        tasks: 2,
        createdBy: 1,
        sentWorkBy: [2],
        result: "10,000,000 samples (seed 42): π ≈ 3.1408824, absolute error 7.10×10⁻⁴. Added to `outputs/estimates.json`.",
        sandbox: { id: "sbx_37de1510c0c1a94e", state: "running", size: "medium" },
        outputs: ["estimates.json"],
        ...files(t(118), [
          ["monte_carlo.py", 1874],
          ["outputs/estimates.json", 412],
        ]),
      },
      [
        ["starting", t(5)],
        ["working", t(13)],
        ["idle", t(34)],
        ["working", t(97)],
        ["idle", t(117)],
      ],
    ),
    worker(
      {
        id: "w-lb",
        name: "leibniz-pi",
        environment: "dispatch-python",
        state: "idle",
        createdAt: t(5),
        task: "Estimate π with the Leibniz series after 10, 1,000, and 1,000,000 terms.",
        createdBy: 1,
        result: "10 terms: 3.0418396 (error 9.98×10⁻²). 1,000: 3.1405927 (1.00×10⁻³). 1,000,000: 3.1415917 (1.00×10⁻⁶).",
        sandbox: { id: "sbx_c93e4a8b47cb2d10", state: "running", size: "medium" },
        ...files(t(36), [["leibniz.py", 902]]),
      },
      [
        ["starting", t(5)],
        ["working", t(12)],
        ["idle", t(29)],
      ],
    ),
    worker(
      {
        id: "w-nk",
        name: "nilakantha-pi",
        environment: "dispatch-python",
        state: "idle",
        createdAt: t(6),
        task: "Estimate π with the Nilakantha series after 10, 1,000, and 1,000,000 terms.",
        createdBy: 1,
        result: "10 terms: 3.1414067 (error 1.86×10⁻⁴). 1,000: 3.1415927 (2.5×10⁻¹⁰). 1,000,000: machine precision.",
        sandbox: { id: "sbx_48e7e4fea502c771", state: "running", size: "medium" },
        ...files(t(37), [["nilakantha.py", 1120]]),
      },
      [
        ["starting", t(6)],
        ["working", t(14)],
        ["idle", t(31)],
      ],
    ),
    worker(
      {
        id: "w-ch",
        name: "pi-error-chart",
        environment: "dispatch-writer",
        state: "idle",
        createdAt: t(121),
        task: "Chart the absolute error of all three methods against the number of steps (log-log), from the data below, and write a short report around it.",
        createdBy: 2,
        result: "Both files are in `outputs/`: `pi_error_chart.svg` (log-log, one line per method) and `report.md` (tables and a short explanation).",
        sandbox: { id: "sbx_6572141d5ccf3e08", state: "running", size: "small" },
        outputs: ["pi_error_chart.svg", "report.md"],
        ...files(t(170), [
          ["estimates.json", 412],
          ["outputs/pi_error_chart.svg", 3810],
          ["outputs/report.md", 2310],
        ]),
      },
      [
        ["starting", t(121)],
        ["working", t(130)],
        ["idle", t(169)],
      ],
    ),
  ];
  return view({
    id: "c-pi",
    style: "delegate",
    environment: "dispatch",
    title: "Estimate π three ways in parallel",
    updatedAt: t(173),
    status: "idle",
    messages,
    workers,
    approvals: [],
    settings: { approvals: "ask" },
    busy: false,
  });
}

// ─── Direct: two sub-agents benchmark sorts in one sandbox ──────────────────────────────────────────────────

function sorts(ago: Ago): ConversationView {
  const t = (seconds: number) => ago(1500 - seconds);
  const py = "agent-py";
  const js = "agent-js";
  const commands: Command[] = [
    {
      id: "c1",
      tool: "bash",
      kind: "run",
      status: "done",
      at: t(6),
      endedAt: t(9),
      command: "mkdir -p /workspace/outputs /workspace/data && python3 -c \"import random; random.seed(7); print('\\n'.join(str(random.randint(0, 10**6)) for _ in range(100000)))\" > /workspace/data/numbers.txt",
      description: "Generate the shared data set",
      exitCode: 0,
      outcome: "exit code 0",
    },
    { id: "c2", tool: "create", kind: "create", status: "done", at: t(14), endedAt: t(14), agentId: py, path: "/workspace/bench_python.py" },
    { id: "c3", tool: "create", kind: "create", status: "done", at: t(15), endedAt: t(15), agentId: js, path: "/workspace/bench_js.js" },
    {
      id: "c4",
      tool: "bash",
      kind: "run",
      status: "done",
      at: t(18),
      endedAt: t(20),
      agentId: py,
      command: "python3 /workspace/bench_python.py",
      exitCode: 1,
      outcome: "exit code 1",
      output: 'Traceback (most recent call last):\n  File "/workspace/bench_python.py", line 14, in quicksort\nRecursionError: maximum recursion depth exceeded',
    },
    { id: "c5", tool: "edit", kind: "edit", status: "done", at: t(24), endedAt: t(24), agentId: py, path: "/workspace/bench_python.py" },
    {
      id: "c6",
      tool: "bash",
      kind: "run",
      status: "done",
      at: t(26),
      endedAt: t(41),
      agentId: py,
      command: "python3 /workspace/bench_python.py",
      exitCode: 0,
      outcome: "exit code 0",
      output: "quicksort  0.212 s\nmerge sort 0.301 s\nsorted()   0.018 s",
    },
    {
      id: "c7",
      tool: "bash",
      kind: "run",
      status: "done",
      at: t(27),
      endedAt: t(33),
      agentId: js,
      command: "node /workspace/bench_js.js",
      exitCode: 0,
      outcome: "exit code 0",
      output: "quicksort  41 ms\nmerge sort 63 ms\nArray.sort 19 ms",
    },
    { id: "c8", tool: "bash", kind: "run", status: "done", at: t(44), endedAt: t(45), command: "cat /workspace/outputs/python_results.txt /workspace/outputs/js_results.txt", exitCode: 0, outcome: "exit code 0" },
    { id: "c9", tool: "create", kind: "create", status: "done", at: t(48), endedAt: t(48), path: "/workspace/outputs/report.md" },
  ];
  const subagents: SubAgent[] = [
    { id: py, toolCallId: "task-py", name: "python-benchmark", description: "Benchmark the sorts in Python", type: "general-purpose", status: "done", at: t(11), endedAt: t(43) },
    { id: js, toolCallId: "task-js", name: "js-benchmark", description: "Benchmark the sorts in JavaScript", type: "general-purpose", status: "done", at: t(11), endedAt: t(35) },
  ];
  const messages: ChatMessage[] = [
    user(
      "m1",
      1,
      t(0),
      "Benchmark quicksort, merge sort, and the built-in sort in Python and in JavaScript on the same 100,000 random integers (generate the data once and use it in both). Use two sub-agents in parallel, one per language. Then write a one-page report with a results table to outputs/report.md.",
      { commands, subagents },
    ),
    reply("a1", t(4), "Generating the data once, then two sub-agents benchmark each language in parallel."),
    reply(
      "a2",
      t(50),
      [
        "The built-in sorts win in both languages.",
        "",
        "| Sort | Python | JavaScript |",
        "| --- | ---: | ---: |",
        "| quicksort | 0.212 s | 41 ms |",
        "| merge sort | 0.301 s | 63 ms |",
        "| built-in | 0.018 s | 19 ms |",
        "",
        "The report is in `outputs/report.md`.",
      ].join("\n"),
    ),
  ];
  const hands: WorkerView = worker(
    {
      id: "h-sorts",
      role: "hands",
      name: "dispatch-python",
      environment: "dispatch-python",
      state: "idle",
      createdAt: t(6),
      tasks: 0,
      createdBy: 1,
      sandbox: { id: "sbx_eeaf991835acf210", state: "running", size: "medium" },
      outputs: ["report.md", "python_results.txt", "js_results.txt"],
      ...files(t(49), [
        ["bench_js.js", 2618],
        ["bench_python.py", 2130],
        ["data/numbers.txt", 966_120],
        ["outputs/js_results.txt", 70],
        ["outputs/python_results.txt", 70],
        ["outputs/report.md", 3240],
      ]),
    },
    [
      ["working", t(6)],
      ["idle", t(49)],
    ],
  );
  return view({
    id: "c-sorts",
    style: "direct",
    environment: "dispatch-direct",
    title: "Benchmark quicksort, merge sort, and the built-in sort",
    updatedAt: t(50),
    status: "idle",
    messages,
    workers: [hands],
    approvals: [],
    settings: { approvals: "ask" },
    agents: { [py]: "python-benchmark", [js]: "js-benchmark" },
    busy: false,
  });
}

// ─── Mixed: math in its own sandbox, and a web worker for the sources ────────────────────────────────────────

function primes(ago: Ago): ConversationView {
  const t = (seconds: number) => ago(150 - seconds);
  const prime = TEMPLATES.find((template) => template.id === "prime-check")!;
  const wikiTask = "Read https://en.wikipedia.org/wiki/Mersenne_prime and report whether 89 and 97 are among the exponents of known Mersenne primes, with the link.";
  const decisions: Decision[] = [
    { id: "d1", kind: "create", status: "done", at: t(5), endedAt: t(8), worker: "mersenne-sources", workerId: "w-wiki", environment: "dispatch-web", task: wikiTask },
    { id: "d2", kind: "wait", status: "done", at: t(16), endedAt: t(44), workers: ["mersenne-sources"] },
  ];
  const commands: Command[] = [
    {
      id: "c1",
      tool: "bash",
      kind: "run",
      status: "done",
      at: t(7),
      endedAt: t(9),
      command:
        "python3 -c \"\ndef lucas_lehmer(p):\n    m, s = (1 << p) - 1, 4\n    for _ in range(p - 2):\n        s = (s * s - 2) % m\n    return s == 0\nfor p in (89, 97):\n    print(p, 'prime' if lucas_lehmer(p) else 'composite')\n\"",
      description: "Lucas–Lehmer test for 2^89 − 1 and 2^97 − 1",
      exitCode: 0,
      outcome: "exit code 0",
      output: "89 prime\n97 composite",
    },
    { id: "c2", tool: "create", kind: "create", status: "done", at: t(46), endedAt: t(46), path: "/workspace/outputs/primes.md" },
  ];
  const messages: ChatMessage[] = [
    user("m1", 1, t(0), prime.prompt, { decisions, commands }),
    reply("a1", t(4), "I'll run the test here in my own sandbox, and start a web worker for the sources."),
    reply(
      "a2",
      t(48),
      [
        "**They agree.** 2^89 − 1 is prime and 2^97 − 1 is not:",
        "",
        "| Exponent | My Lucas–Lehmer test | Wikipedia |",
        "| ---: | --- | --- |",
        "| 89 | prime | listed (found 1911) |",
        "| 97 | composite | not listed |",
        "",
        "Source: [Mersenne prime](https://en.wikipedia.org/wiki/Mersenne_prime). Saved to `outputs/primes.md`.",
      ].join("\n"),
    ),
  ];
  const workers: WorkerView[] = [
    worker(
      {
        id: "h-primes",
        role: "hands",
        name: "dispatch-python",
        environment: "dispatch-python",
        state: "idle",
        createdAt: t(7),
        tasks: 0,
        createdBy: 1,
        sandbox: { id: "sbx_8edbfe8ff846a113", state: "running", size: "medium" },
        outputs: ["primes.md"],
        ...files(t(47), [["outputs/primes.md", 640]]),
      },
      [
        ["working", t(7)],
        ["idle", t(47)],
      ],
    ),
    worker(
      {
        id: "w-wiki",
        name: "mersenne-sources",
        environment: "dispatch-web",
        state: "idle",
        createdAt: t(6),
        task: wikiTask,
        createdBy: 1,
        result: "Both checked against https://en.wikipedia.org/wiki/Mersenne_prime: 89 is a known exponent (R. E. Powers, 1911); 97 is not.",
        sandbox: { id: "sbx_39911d63a16c5e02", state: "running", size: "small" },
        ...files(t(43), [["notes.md", 1220]]),
      },
      [
        ["starting", t(6)],
        ["working", t(15)],
        ["idle", t(42)],
      ],
    ),
  ];
  return view({
    id: "c-primes",
    style: "mixed",
    environment: "dispatch-mixed",
    title: "Is 2^89 − 1 prime? Test it and cite the source",
    updatedAt: t(48),
    status: "idle",
    messages,
    workers,
    approvals: [],
    settings: { approvals: "auto" },
    busy: false,
  });
}

// ─── Delegate, asking: two new web research sandboxes wait for approval ──────────────────────────────────────

function radar(ago: Ago): ConversationView {
  const t = (seconds: number) => ago(40 - seconds);
  const nodeTask = "Find what's new in the latest Node.js release from nodejs.org (release notes and blog), with links.";
  const pythonTask = "Find what's new in the latest Python release from docs.python.org (What's New), with links.";
  const decisions: Decision[] = [
    { id: "d1", kind: "create", status: "asking", at: t(6), worker: "node-release-notes", environment: "dispatch-web", task: nodeTask },
    { id: "d2", kind: "create", status: "asking", at: t(6), worker: "python-release-notes", environment: "dispatch-web", task: pythonTask },
  ];
  const approvals: Approval[] = [
    { id: "p1", kind: "sandbox", decisionId: "d1", worker: "node-release-notes", environment: "dispatch-web", task: nodeTask, model: MODEL, requestedAt: t(6), messageIndex: 1 },
    { id: "p2", kind: "sandbox", decisionId: "d2", worker: "python-release-notes", environment: "dispatch-web", task: pythonTask, model: MODEL, requestedAt: t(6), messageIndex: 1 },
  ];
  const radarTemplate = TEMPLATES.find((template) => template.id === "release-radar")!;
  return view({
    id: "c-radar",
    style: "delegate",
    environment: "dispatch",
    title: "What's new in the latest Node.js and Python releases?",
    updatedAt: t(6),
    status: "asking",
    messages: [user("m1", 1, t(0), radarTemplate.prompt, { decisions }), reply("a1", t(4), "Each needs web access, so I'll research them in two web research sandboxes, in parallel.")],
    workers: [],
    approvals,
    settings: { approvals: "ask" },
    busy: true,
  });
}

// ─── Direct, asking: two sub-agents each want to run a command ──────────────────────────────────────────────

function fibonacci(ago: Ago): ConversationView {
  const t = (seconds: number) => ago(25 - seconds);
  const commands: Command[] = [
    {
      id: "c1",
      tool: "bash",
      kind: "run",
      status: "asking",
      at: t(9),
      agentId: "agent-primes",
      command: "python3 -c \"n=10**7; s=bytearray([1])*n; s[:2]=b'\\0\\0'\nfor i in range(2,int(n**.5)+1):\n  if s[i]: s[i*i::i]=bytearray(len(s[i*i::i]))\nprint(sum(s))\"",
      description: "Count the primes below 10 million with a sieve",
    },
    {
      id: "c2",
      tool: "bash",
      kind: "run",
      status: "asking",
      at: t(10),
      agentId: "agent-fib",
      command: 'python3 -c "a,b=0,1\nfor _ in range(10000): a,b=b,a+b\nprint(len(str(a)))"',
      description: "Count the digits of the 10,000th Fibonacci number",
    },
  ];
  const subagents: SubAgent[] = [
    { id: "agent-primes", toolCallId: "task-primes", name: "prime-counter", status: "running", at: t(6) },
    { id: "agent-fib", toolCallId: "task-fib", name: "fibonacci-digits", status: "running", at: t(6) },
  ];
  const approvals: Approval[] = commands.map(
    (command, index): Approval => ({
      id: `q${index + 1}`,
      kind: "command",
      decisionId: command.id,
      tool: "bash",
      command: command.command ?? "",
      ...(command.agentId ? { agentId: command.agentId } : {}),
      requestedAt: command.at,
      messageIndex: 1,
    }),
  );
  return view({
    id: "c-fib",
    style: "direct",
    environment: "dispatch-direct",
    title: "Count primes and Fibonacci digits with two sub-agents",
    updatedAt: t(10),
    status: "asking",
    messages: [
      user("m1", 1, t(0), "Use two sub-agents in parallel: one counts the primes below 10 million, the other the digits of the 10,000th Fibonacci number. Then tell me both results.", {
        commands,
        subagents,
      }),
      reply("a1", t(5), "Starting two sub-agents, one for each count."),
    ],
    workers: [],
    approvals,
    settings: { approvals: "ask" },
    agents: { "agent-primes": "prime-counter", "agent-fib": "fibonacci-digits" },
    busy: true,
  });
}

const CONTENTS: Readonly<Record<string, string>> = {
  "outputs/report.md":
    "# π three ways\n\n| Steps | Monte Carlo | Leibniz | Nilakantha |\n| ---: | ---: | ---: | ---: |\n| 10 | 3.600000 | 3.041840 | 3.141406 |\n| 1,000 | 3.128000 | 3.140593 | 3.141593 |\n| 1,000,000 | 3.140592 | 3.141592 | 3.141593 |\n\nNilakantha converges fastest.\n",
  "outputs/estimates.json": '{\n  "monte_carlo": { "10": 3.6, "1000": 3.128, "1000000": 3.140592, "10000000": 3.1408824 }\n}\n',
  "outputs/primes.md": "# Mersenne primes\n\n- 2^89 − 1: prime (Lucas–Lehmer), listed on Wikipedia\n- 2^97 − 1: composite, not listed\n",
};
