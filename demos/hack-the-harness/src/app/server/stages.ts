// The agent deployment architectures the demo steps through, in talk order. Each is its own platform environment
// (declared in apphost.mts), so every stage runs side by side and a chat's stage is the environment it was created in.
// Plain data: the server and the UI both import it.

export type StageId = "shared" | "isolated" | "promotable" | "direct" | "workers" | "mixed";

export interface Stage {
  readonly id: StageId;
  readonly title: string;
  /** One line for the stage picker. */
  readonly summary: string;
  /** The platform environment its chats are created in. */
  readonly environment: string;
  /**
   * Where the agent's own shell and file commands run, for moving files in and out: `session` (its own session),
   * `hands` (a workspace-only sandbox the platform starts at its first command), or undefined when it has none.
   */
  readonly workspace?: "session" | "hands";
  /** The agent can start worker agents, each in its own sandbox. */
  readonly workers: boolean;
}

export const STAGES: readonly Stage[] = [
  {
    id: "shared",
    title: "Shared",
    summary: "Every chat on one shared runtime, no sandboxes and no shell.",
    environment: "hack-the-harness",
    workspace: "session",
    workers: false,
  },
  {
    id: "isolated",
    title: "Isolated",
    summary: "Every chat in its own sandbox, with its runtime, history, and files.",
    environment: "hack-the-harness-isolated",
    workspace: "session",
    workers: false,
  },
  {
    id: "promotable",
    title: "Promotable",
    summary: "Chats start shared and move into a sandbox when they need to run code.",
    environment: "hack-the-harness-promotable",
    workspace: "session",
    workers: false,
  },
  {
    id: "direct",
    title: "Direct",
    summary: "The agent stays shared; only its shell and file commands run in a sandbox.",
    environment: "hack-the-harness-direct",
    workspace: "hands",
    workers: false,
  },
  {
    id: "workers",
    title: "Workers",
    summary: "The agent stays shared and hands each job to a worker in its own sandbox.",
    environment: "hack-the-harness-workers",
    workers: true,
  },
  {
    id: "mixed",
    title: "Mixed",
    summary: "The agent works directly in its own sandbox, and hands bigger jobs to workers.",
    environment: "hack-the-harness-mixed",
    workspace: "hands",
    workers: true,
  },
];

export const DEFAULT_STAGE: StageId = "shared";

export function findStage(id: unknown): Stage | undefined {
  return STAGES.find(stage => stage.id === id);
}
