import { ArrowSwitchIcon, TerminalIcon, WorkflowIcon, type Icon } from "@primer/octicons-react";
import type { ApprovalMode, ExecutionStyle } from "../../shared/types.js";

export interface StyleMeta {
  /** The switch's label. */
  readonly label: string;
  /** A few words, for badges. */
  readonly short: string;
  readonly icon: Icon;
  /** The caption beside the style's diagram: eight words or fewer. */
  readonly caption: string;
  /** What each approval setting means in this style (the toggle's tooltip). */
  readonly approvals: Readonly<Record<ApprovalMode, string>>;
}

export const STYLE_ORDER: readonly ExecutionStyle[] = ["delegate", "direct", "mixed"];

/** The approval toggle's labels: the same two for every style; the tooltip says what they cover. */
export const APPROVAL_LABELS: Readonly<Record<ApprovalMode, string>> = { ask: "Ask first", auto: "Run freely" };

export const STYLE_META: Readonly<Record<ExecutionStyle, StyleMeta>> = {
  delegate: {
    label: "Delegate to workers",
    short: "Delegates",
    icon: WorkflowIcon,
    caption: "Each part gets its own worker and sandbox",
    approvals: {
      ask: "Asks before each new sandbox. Work sent to sandboxes it has never asks.",
      auto: "Creates sandboxes without asking.",
    },
  },
  direct: {
    label: "Work directly",
    short: "Works directly",
    icon: TerminalIcon,
    caption: "It and its sub-agents work in one sandbox",
    approvals: {
      ask: "Asks before each command and file change. Reading never asks.",
      auto: "Runs commands and changes files without asking.",
    },
  },
  mixed: {
    label: "Mixed",
    short: "Mixed",
    icon: ArrowSwitchIcon,
    caption: "Its own sandbox, plus workers when it helps",
    approvals: {
      ask: "Asks before each command, file change, and new sandbox.",
      auto: "Runs commands and creates sandboxes without asking.",
    },
  },
};
