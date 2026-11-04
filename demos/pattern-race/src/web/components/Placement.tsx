import { ContainerIcon, CopilotIcon, CpuIcon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import type { Lane } from "../../shared/lanes.js";
import type { LaneRun, SandboxKind, SandboxState, SandboxToken } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { Spinner } from "./ui/Spinner.js";
import { Tooltip } from "./ui/Tooltip.js";

/** At rest, each lane shows its pattern's shape: where its brain runs, and the sandboxes it would use. */
const SHAPES: Readonly<Record<Lane["id"], readonly SandboxKind[]>> = {
  shared: [],
  isolated: ["own"],
  promotable: ["own"],
  direct: ["hands"],
  delegate: ["worker", "worker"],
  mixed: ["hands", "worker"],
};

const MAX_TOKENS = 4;

const KIND_LABEL: Readonly<Record<SandboxKind, string>> = {
  own: "Its own sandbox, its brain inside",
  hands: "Its hands: commands run here, no agent inside",
  worker: "A worker agent in its own sandbox",
};

const STATE_LABEL: Readonly<Record<SandboxState, string>> = {
  starting: "starting",
  working: "working",
  idle: "idle",
  failed: "failed",
  stopped: "deleted",
};

/** Where the lane's brains run (the shared runtime, or sandboxes) and the sandboxes its hands act in. */
export function Placement({ lane, run }: { readonly lane: Lane; readonly run: LaneRun | undefined }) {
  const live = run && run.status !== "ready" && run.status !== "skipped";
  const brain = run?.brain ?? lane.brain;
  const thinking = run?.status === "thinking" || run?.status === "working" || run?.status === "starting";
  const subagents = run?.subagents ?? 0;
  const tokens: readonly (SandboxToken | GhostToken)[] = live ? run.sandboxes : SHAPES[lane.id].map((kind, index) => ({ ghost: true, kind, key: `${kind}-${index}` }));
  const shown = tokens.slice(0, MAX_TOKENS);
  return (
    <div className="flex flex-col gap-1.5" aria-label={`${lane.pattern}: brain on ${brain === "runtime" ? "the shared runtime" : "a sandbox"}, ${live ? run.sandboxes.length : 0} sandboxes`}>
      <Zone icon={<CpuIcon size={16} />} label="Shared runtime" empty={brain !== "runtime"}>
        {brain === "runtime" ? <Brain size="lg" active={thinking} /> : null}
        {brain === "runtime" ? Array.from({ length: Math.min(subagents, MAX_TOKENS) }, (_, index) => <Brain key={index} size="sm" active={thinking} />) : null}
        {brain === "runtime" && subagents > MAX_TOKENS ? <More count={subagents - MAX_TOKENS} label="more sub-agents" /> : null}
      </Zone>
      <Zone icon={<ContainerIcon size={16} />} label="Sandboxes" empty={shown.length === 0}>
        {shown.map((token) =>
          "ghost" in token ? <Ghost key={token.key} kind={token.kind} /> : <Sandbox key={token.id} token={token} brainInside={token.kind === "own" && brain === "sandbox"} subagents={token.kind === "own" ? subagents : 0} />,
        )}
        {tokens.length > MAX_TOKENS ? <More count={tokens.length - MAX_TOKENS} label="more sandboxes" /> : null}
      </Zone>
    </div>
  );
}

function More({ count, label }: { readonly count: number; readonly label: string }) {
  return (
    <span className="shrink-0 text-xs font-semibold text-fg-muted" aria-label={`${count} ${label}`}>
      +{count}
    </span>
  );
}

interface GhostToken {
  readonly ghost: true;
  readonly kind: SandboxKind;
  readonly key: string;
}

function Zone({ icon, label, empty, children }: { readonly icon: ReactNode; readonly label: string; readonly empty: boolean; readonly children: ReactNode }) {
  return (
    <div className={cx("flex h-12 items-center gap-1.5 rounded-md border px-2", empty ? "border-dashed border-line-muted" : "border-line-muted bg-canvas-inset")}>
      <Tooltip content={label} className="shrink-0 race:hidden">
        <span className="inline-flex text-fg-muted" aria-label={label} role="img">
          {icon}
        </span>
      </Tooltip>
      <span className="mx-0.5 h-6 w-px shrink-0 bg-[var(--borderColor-muted)] race:hidden" aria-hidden />
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

/** An agent's brain: its model loop. */
function Brain({ size, active }: { readonly size: "lg" | "sm"; readonly active: boolean }) {
  const large = size === "lg";
  return (
    <Tooltip content={large ? "Its brain: the agent's model loop" : "A sub-agent it started"}>
      <span
        className={cx(
          "inline-grid shrink-0 place-items-center rounded-full",
          large ? "size-8 bg-accent-emphasis text-fg-on-emphasis" : "size-6 bg-accent-muted text-fg-accent",
          active && "brain-live",
        )}
      >
        <CopilotIcon size={large ? 16 : 12} />
      </span>
    </Tooltip>
  );
}

function Sandbox({ token, brainInside, subagents }: { readonly token: SandboxToken; readonly brainInside: boolean; readonly subagents: number }) {
  const agent = token.kind === "worker" || brainInside;
  const tone =
    token.state === "failed"
      ? "border-line-danger text-fg-danger"
      : token.state === "stopped"
        ? "border-dashed border-line text-fg-muted"
        : token.state === "starting"
          ? "border-line-attention text-fg-attention"
          : token.state === "working"
            ? "border-line-accent text-fg-accent"
            : "border-line text-fg-muted";
  const label = `${token.kind === "own" ? KIND_LABEL.own : token.name} · ${token.kind === "own" ? token.environment : KIND_LABEL[token.kind]} · ${STATE_LABEL[token.state]}`;
  return (
    <Tooltip content={label}>
      <span className={cx("relative inline-grid size-9 shrink-0 animate-scale-in place-items-center rounded-md border-2 bg-canvas", tone, token.state === "working" && "sandbox-live")}>
        {token.state === "starting" ? <Spinner size={16} /> : <ContainerIcon size={16} />}
        {agent ? (
          <span className={cx("absolute -top-1.5 -right-1.5 inline-grid size-4 place-items-center rounded-full text-fg-on-emphasis ring-2 ring-[var(--bgColor-default)]", token.state === "stopped" ? "bg-neutral-emphasis" : "bg-accent-emphasis")}>
            <CopilotIcon size={10} />
          </span>
        ) : null}
        {subagents > 0 ? <span className="absolute -right-1.5 -bottom-1.5 rounded-full bg-accent-muted px-1 text-[10px] leading-4 font-semibold text-fg-accent">+{subagents}</span> : null}
      </span>
    </Tooltip>
  );
}

/** A sandbox the pattern would use, before the race. */
function Ghost({ kind }: { readonly kind: SandboxKind }) {
  return (
    <Tooltip content={KIND_LABEL[kind]}>
      <span className="relative inline-grid size-9 shrink-0 place-items-center rounded-md border-2 border-dashed border-line text-fg-muted opacity-70">
        <ContainerIcon size={16} />
        {kind !== "hands" ? (
          <span className="absolute -top-1.5 -right-1.5 inline-grid size-4 place-items-center rounded-full bg-neutral-emphasis text-fg-on-emphasis ring-2 ring-[var(--bgColor-default)]">
            <CopilotIcon size={10} />
          </span>
        ) : null}
      </span>
    </Tooltip>
  );
}
