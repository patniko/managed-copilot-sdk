/** The six lanes: the same job in each pattern's environment. Shared by the server and the page. */

export type LaneId = "shared" | "isolated" | "promotable" | "direct" | "delegate" | "mixed";

/** Where an agent's brain (its model loop) runs. */
export type BrainPlace = "runtime" | "sandbox";

export interface Lane {
  readonly id: LaneId;
  /** The pattern's name, as docs/concepts/patterns.md uses it. */
  readonly pattern: string;
  /** The root AppHost's environment for this pattern: the only thing that differs between lanes. */
  readonly environment: string;
  /** How the root AppHost must declare that environment for the lane to race. */
  readonly type: "shared" | "isolated" | "promotable" | "orchestrator";
  readonly execution?: "delegate" | "direct" | "mixed";
  /** Where its brain runs when it starts. */
  readonly brain: BrainPlace;
  /** Where its brain runs and its hands act, in one line. */
  readonly summary: string;
}

export const LANES: readonly Lane[] = [
  { id: "shared", pattern: "Shared", environment: "chat", type: "shared", brain: "runtime", summary: "Brain on the shared runtime, no shell or files" },
  { id: "isolated", pattern: "Isolated", environment: "coder", type: "isolated", brain: "sandbox", summary: "Brain and hands in its own sandbox" },
  {
    id: "promotable",
    pattern: "Promotable",
    environment: "helper",
    type: "promotable",
    brain: "runtime",
    summary: "Starts on the shared runtime, moves into a sandbox when it needs one",
  },
  {
    id: "direct",
    pattern: "Direct",
    environment: "operator",
    type: "orchestrator",
    execution: "direct",
    brain: "runtime",
    summary: "Brain on the shared runtime; it and its sub-agents act in a sandbox",
  },
  {
    id: "delegate",
    pattern: "Delegate",
    environment: "team",
    type: "orchestrator",
    execution: "delegate",
    brain: "runtime",
    summary: "A coordinator that starts worker agents, each in its own sandbox",
  },
  {
    id: "mixed",
    pattern: "Mixed",
    environment: "lead",
    type: "orchestrator",
    execution: "mixed",
    brain: "runtime",
    summary: "A coordinator with its own sandbox that can also start workers",
  },
];

export function laneById(id: LaneId): Lane {
  const lane = LANES.find((candidate) => candidate.id === id);
  if (!lane) throw new Error(`Unknown lane "${id}"`);
  return lane;
}
