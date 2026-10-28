import { ArrowSwitchIcon, TerminalIcon, WorkflowIcon, type Icon } from "@primer/octicons-react";
import type { ApprovalMode, ExecutionStyle } from "../../shared/types.js";

export interface StyleMeta {
  /** The switch's label. */
  readonly label: string;
  /** A few words, for badges. */
  readonly short: string;
  readonly icon: Icon;
  /** What happens to a message, in one sentence. */
  readonly summary: string;
  /** The approval setting's two choices, for this style. */
  readonly approvals: Readonly<Record<ApprovalMode, { readonly label: string; readonly title: string; readonly state: string }>>;
}

export const STYLE_ORDER: readonly ExecutionStyle[] = ["delegate", "direct", "mixed"];

export const STYLE_META: Readonly<Record<ExecutionStyle, StyleMeta>> = {
  delegate: {
    label: "Delegate to workers",
    short: "Delegates",
    icon: WorkflowIcon,
    summary: "The coordinator creates worker agents, each in its own sandbox, and sends them the work.",
    approvals: {
      ask: { label: "Ask before new sandboxes", title: "The agent asks you before each new sandbox", state: "New sandboxes ask you first" },
      auto: { label: "Create freely", title: "The agent creates sandboxes as it decides", state: "New sandboxes start without asking" },
    },
  },
  direct: {
    label: "Work directly",
    short: "Works directly",
    icon: TerminalIcon,
    summary: "The coordinator and its sub-agents run commands and edit files themselves, in one sandbox with no agent in it.",
    approvals: {
      ask: { label: "Ask before commands", title: "The agent asks you before each command and file change", state: "Commands ask you first" },
      auto: { label: "Run freely", title: "The agent runs commands and changes files as it decides", state: "Commands run without asking" },
    },
  },
  mixed: {
    label: "Mixed",
    short: "Mixed",
    icon: ArrowSwitchIcon,
    summary: "The coordinator works in its own sandbox, and creates workers for parts that need another environment or should run on their own.",
    approvals: {
      ask: { label: "Ask first", title: "The agent asks you before each command, file change, and new sandbox", state: "Commands and new sandboxes ask you first" },
      auto: { label: "Go ahead freely", title: "The agent runs commands and creates sandboxes as it decides", state: "Commands and new sandboxes go ahead without asking" },
    },
  },
};
