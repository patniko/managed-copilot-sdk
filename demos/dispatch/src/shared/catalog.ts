// What the UI shows for each kind of sandbox, and the starter templates. Shared by the server and the web UI.
import type { BlueprintKind, Template } from "./types.js";

/** A blueprint's kind from its environment name (Dispatch's own are `dispatch-python`, `dispatch-node`, ...). */
export function blueprintKind(name: string): BlueprintKind {
  const lower = name.toLowerCase();
  if (/python|\bpy\b|-py$/.test(lower)) return "python";
  if (/node|javascript|\bjs\b|-js$/.test(lower)) return "node";
  if (/web|research|browse/.test(lower)) return "web";
  if (/writer|report|docs|write/.test(lower)) return "writer";
  return "other";
}

export const BLUEPRINT_LABELS: Readonly<Record<BlueprintKind, string>> = {
  python: "Python lab",
  node: "Node workshop",
  web: "Web research",
  writer: "Writer's desk",
  other: "Sandbox",
};

export const TEMPLATES: readonly Template[] = [
  {
    id: "estimate-pi",
    title: "Estimate π three ways",
    icon: "graph",
    description: "Three methods race to converge",
    prompt:
      "Estimate π three ways in parallel: a Monte Carlo simulation, the Leibniz series, and the Nilakantha series. Report each estimate and its error after 10, 1,000, and 1,000,000 steps, and say which converges fastest.",
    uses: [{ kind: "python", count: 3 }],
    minutes: 2,
    followUps: ["Run the Monte Carlo one again with 10 million samples.", "Chart the error of all three as the steps grow."],
  },
  {
    // Written for Mixed: math in the coordinator's own sandbox (no network), and a lookup that needs `dispatch-web`.
    id: "prime-check",
    title: "Prime check, with sources",
    icon: "verified",
    description: "Its own math, cited by a web worker",
    prompt:
      "Is 2^89 − 1 prime? And 2^97 − 1? Test both yourself with the Lucas–Lehmer test, in your own sandbox (Python's standard library is enough; it has no network). At the same time, have a web research worker check Wikipedia's Mersenne prime article for those exponents. Then say whether your results agree, with the link.",
    uses: [
      { kind: "python", count: 1 },
      { kind: "web", count: 1 },
    ],
    minutes: 2,
    followUps: ["Now test 2^107 − 1 and 2^127 − 1 too, and time each test.", "Ask the web worker when the most recent Mersenne prime was found, and by whom."],
    style: "mixed",
  },
  {
    id: "sorting-showdown",
    title: "Sorting showdown",
    icon: "versions",
    description: "Python vs. JavaScript, then a write-up",
    prompt:
      "Benchmark quicksort, merge sort, and the built-in sort in Python and in JavaScript on the same 100,000 random integers (generate the data once and use it in both). Then have a writer produce a one-page report with a results table.",
    uses: [
      { kind: "python", count: 1 },
      { kind: "node", count: 1 },
      { kind: "writer", count: 1 },
    ],
    minutes: 4,
    followUps: ["Add insertion sort to both benchmarks, on the first 10,000 numbers only.", "Which sort would you use in production, and why?"],
  },
  {
    id: "release-radar",
    title: "Release radar",
    icon: "broadcast",
    description: "What's new in Node.js and Python",
    prompt: "What's new in the latest releases of Node.js and Python? Research each from its official documentation in parallel, then summarize the highlights with links.",
    uses: [{ kind: "web", count: 2 }],
    minutes: 3,
    followUps: ["Which of those changes matter most for a team upgrading this quarter?", "Turn the summary into a short report with a comparison table."],
  },
  {
    id: "cli-build-review",
    title: "Build and review a CLI",
    icon: "terminal",
    description: "One worker builds it, another reviews",
    prompt:
      "Build a small Node.js command-line tool that converts CSV to JSON, with tests. Then have a second worker review a copy of it, and have the first worker fix whatever the review finds.",
    uses: [{ kind: "node", count: 2 }],
    minutes: 5,
    followUps: ["Add a --pretty flag and a test for it.", "Have the reviewer check the fix."],
  },
];
