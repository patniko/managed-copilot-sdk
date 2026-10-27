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
    id: "sorting-showdown",
    title: "Sorting showdown",
    icon: "versions",
    description: "Benchmark sorts in Python and JavaScript on identical data, then write it up.",
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
    description: "What's new in the latest Node.js and Python releases, from their official sources.",
    prompt: "What's new in the latest releases of Node.js and Python? Research each from its official documentation in parallel, then summarize the highlights with links.",
    uses: [{ kind: "web", count: 2 }],
    minutes: 3,
    followUps: ["Which of those changes matter most for a team upgrading this quarter?", "Turn the summary into a short report with a comparison table."],
  },
  {
    id: "estimate-pi",
    title: "Estimate π three ways",
    icon: "graph",
    description: "Monte Carlo, Leibniz, and Nilakantha in parallel; compare how fast they converge.",
    prompt:
      "Estimate π three ways in parallel, each in its own sandbox: a Monte Carlo simulation, the Leibniz series, and the Nilakantha series. Report each estimate and its error after 10, 1,000, and 1,000,000 steps, and say which converges fastest.",
    uses: [{ kind: "python", count: 3 }],
    minutes: 2,
    followUps: ["Run the Monte Carlo one again with 10 million samples.", "Chart the error of all three as the steps grow."],
  },
  {
    id: "cli-build-review",
    title: "Build and review a CLI",
    icon: "terminal",
    description: "One worker builds a tested Node CLI; another reviews a copy, and the first fixes what it finds.",
    prompt:
      "Build a small Node.js command-line tool that converts CSV to JSON, with tests. Then have a second worker review a copy of it, and have the first worker fix whatever the review finds.",
    uses: [{ kind: "node", count: 2 }],
    minutes: 5,
    followUps: ["Add a --pretty flag and a test for it.", "Have the reviewer check the fix."],
  },
];
