import {
  BellFillIcon,
  BellIcon,
  CheckCircleFillIcon,
  ContainerIcon,
  CopilotIcon,
  CpuIcon,
  DotFillIcon,
  ShieldIcon,
  StopIcon,
  TerminalIcon,
  XCircleFillIcon,
  type Icon,
} from "@primer/octicons-react";
import type { ReactNode } from "react";
import type { CoordinatorState, IncidentView, SandboxView } from "../../shared/types.js";
import { between, clock, cx, duration } from "../lib/format.js";
import { useNow } from "../lib/hooks.js";
import { CopyButton, Popover, Spinner } from "./ui.js";

/** Activities that run in Copilot's own sandbox. */
const HANDS_ACTIVITY = /^(\$ |Reading |Searching |Listing |Writing |Editing |Watching )/;

function Column({ caption, icon: Glyph, children }: { readonly caption: string; readonly icon: Icon; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="mb-2 flex h-6 items-center gap-1.5 text-xs font-semibold text-fg-muted">
        <Glyph size={14} />
        {caption}
      </div>
      <div className="flex flex-1 flex-col justify-center">{children}</div>
    </div>
  );
}

/** An arrow between columns: across on wide screens, down when the map stacks. */
function Connector({ active = false, plain = false }: { readonly active?: boolean; readonly plain?: boolean }) {
  return (
    <div className="flex flex-col" aria-hidden>
      <div className="hidden h-8 md:block" />
      <div className="hidden flex-1 items-center md:flex">
        <div className={cx("link w-full", plain && "after:hidden")} {...(active ? { "data-active": "" } : {})} />
      </div>
      <div className="link-down md:hidden" {...(active ? { "data-active": "" } : {})} />
    </div>
  );
}

function Detail({ rows }: { readonly rows: readonly (readonly [string, ReactNode] | false | undefined)[] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
      {rows.filter((row): row is readonly [string, ReactNode] => Boolean(row)).map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-fg-muted">{term}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function IdRow({ id }: { readonly id: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <span className="truncate font-mono">{id}</span>
      <CopyButton text={id} label="Copy the ID" />
    </span>
  );
}

const CARD = "Box w-full p-3 text-left transition-colors hover:bg-canvas-muted focus-visible:outline-2";

function AlertCard({ incident }: { readonly incident: IncidentView }) {
  const { alert } = incident;
  const firing = !alert.resolvedAt;
  return (
    <Popover
      label="Alert"
      width="w-80"
      align="left"
      trigger={(open, toggle) => (
        <button type="button" className={CARD} aria-expanded={open} onClick={toggle}>
          <div className="flex items-center gap-2">
            {firing ? <BellFillIcon size={16} className="text-fg-danger" /> : <CheckCircleFillIcon size={16} className="text-fg-success" />}
            <span className="text-sm font-semibold">{firing ? "Firing" : "Resolved"}</span>
            <span className="ml-auto font-mono text-xs text-fg-muted">{clock(alert.startsAt).slice(0, 5)}</span>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-fg-muted" title={alert.name}>
            {alert.name}
          </div>
        </button>
      )}
    >
      <div className="flex flex-col gap-3 p-4 text-sm">
        <div className="font-semibold">{alert.summary}</div>
        {alert.description ? <p className="text-fg-muted">{alert.description}</p> : null}
        <Detail
          rows={[
            ["Source", alert.source === "simulated" ? "Simulated (demo)" : alert.source === "generic" ? "Webhook" : alert.source === "grafana" ? "Grafana" : "Alertmanager"],
            ["Started", clock(alert.startsAt)],
            alert.resolvedAt ? ["Resolved", clock(alert.resolvedAt)] : false,
            Object.keys(alert.labels).length ? ["Labels", <span className="font-mono">{Object.entries(alert.labels).map(([key, value]) => `${key}=${value}`).join(" ")}</span>] : false,
            ...alert.links.map((link): readonly [string, ReactNode] => [link.title, <a href={link.url} target="_blank" rel="noreferrer" className="break-all">{link.url}</a>]),
          ]}
        />
      </div>
    </Popover>
  );
}

const COORDINATOR_WORDS: Record<CoordinatorState, string> = {
  starting: "Starting",
  working: "Working",
  waiting: "Waiting for you",
  idle: "Stopped",
  done: "Done",
  failed: "Failed",
};

function StateWord({ state }: { readonly state: CoordinatorState }) {
  const icon =
    state === "starting" ? (
      <Spinner size={12} className="text-fg-muted" />
    ) : state === "working" ? (
      <DotFillIcon size={16} className="animate-pulse text-fg-accent" />
    ) : state === "waiting" ? (
      <ShieldIcon size={12} className="text-fg-attention" />
    ) : state === "done" ? (
      <CheckCircleFillIcon size={12} className="text-fg-success" />
    ) : state === "failed" ? (
      <XCircleFillIcon size={12} className="text-fg-danger" />
    ) : (
      <DotFillIcon size={16} className="text-fg-muted" />
    );
  return (
    <span className={cx("inline-flex items-center gap-1 text-xs", state === "waiting" ? "font-semibold text-fg-attention" : "text-fg-muted")}>
      {icon}
      {COORDINATOR_WORDS[state]}
    </span>
  );
}

function CopilotCard({ incident }: { readonly incident: IncidentView }) {
  const { coordinator } = incident;
  const line =
    coordinator.state === "working"
      ? (coordinator.activity ?? "Thinking")
      : coordinator.state === "waiting"
        ? "Released · its request waits on the platform"
        : coordinator.state === "starting"
          ? "Taking the incident…"
          : coordinator.state === "done"
            ? "Incident resolved"
            : (coordinator.lastMessage ?? "Its turn ended");
  return (
    <Popover
      label="Copilot"
      width="w-80"
      align="left"
      trigger={(open, toggle) => (
        <button type="button" className={cx(CARD, coordinator.state === "waiting" && "needs-you")} aria-expanded={open} onClick={toggle}>
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-done-muted text-fg-done">
              <CopilotIcon size={20} />
            </span>
            <div className="min-w-0">
              <div className="font-semibold">Copilot</div>
              <StateWord state={coordinator.state} />
            </div>
          </div>
          <div className={cx("mt-2 truncate text-xs text-fg-muted", coordinator.state === "working" && coordinator.activity?.startsWith("$") && "font-mono")} title={line}>
            {line}
          </div>
        </button>
      )}
    >
      <div className="flex flex-col gap-3 p-4 text-sm">
        <div>
          <div className="font-semibold">Copilot, the incident's coordinator</div>
          <div className="text-xs text-fg-muted">Its brain runs on the shared runtime: no sandbox of its own for thinking.</div>
        </div>
        <Detail
          rows={[
            ["Environment", <span className="font-mono">{coordinator.environment}</span>],
            ["Model", coordinator.model],
            ["Connection", coordinator.attached ? "Live in this app" : "Released: requests wait on the platform"],
            coordinator.sessionId ? ["Session", <IdRow id={coordinator.sessionId} />] : false,
            coordinator.lastMessage ? ["Last said", <span className="line-clamp-4">{coordinator.lastMessage}</span>] : false,
          ]}
        />
      </div>
    </Popover>
  );
}

function SandboxStatus({ sandbox, busy }: { readonly sandbox: SandboxView; readonly busy: boolean }) {
  if (sandbox.role === "worker" && sandbox.done) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-success">
        <CheckCircleFillIcon size={12} /> Done
      </span>
    );
  }
  if (sandbox.state === "failed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-danger">
        <XCircleFillIcon size={12} /> Failed
      </span>
    );
  }
  if (sandbox.state === "starting") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-muted">
        <Spinner size={12} /> Starting
      </span>
    );
  }
  if (sandbox.state === "stopped") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-muted">
        <StopIcon size={12} /> Stopped
      </span>
    );
  }
  const working = sandbox.role === "worker" ? sandbox.state === "working" : busy;
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-0.5 text-xs", working ? "text-fg-accent" : "text-fg-muted")}>
      <DotFillIcon size={16} className={working ? "animate-pulse" : undefined} />
      {working ? "Working" : "Idle"}
    </span>
  );
}

function SandboxCard({ sandbox, busy, now }: { readonly sandbox: SandboxView; readonly busy: boolean; readonly now: number }) {
  const own = sandbox.role === "own";
  const subline = own
    ? `Copilot's own · ${sandbox.commands ?? 0} ${sandbox.commands === 1 ? "command" : "commands"}`
    : sandbox.done
      ? "Worker · reported back"
      : sandbox.state === "working"
        ? `Worker · ${duration(between(sandbox.startedAt, now))}`
        : "Worker";
  return (
    <Popover
      label={own ? "Copilot's own sandbox" : `Worker ${sandbox.name}`}
      width="w-96"
      align="left"
      trigger={(open, toggle) => (
        <button type="button" className={cx(CARD, "flex items-center gap-3 p-2.5", sandbox.state === "stopped" && "opacity-75")} aria-expanded={open} onClick={toggle}>
          <span className="relative grid size-9 shrink-0 place-items-center rounded-md bg-accent-muted text-fg-accent">
            <ContainerIcon size={18} />
            <span className="absolute -right-1.5 -bottom-1.5 grid size-5 place-items-center rounded-full bg-canvas text-fg-muted ring-1 ring-line">
              {own ? <TerminalIcon size={12} /> : <CopilotIcon size={12} className="text-fg-done" />}
            </span>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{sandbox.name}</span>
            <span className="block truncate text-xs text-fg-muted">{subline}</span>
          </span>
          <SandboxStatus sandbox={sandbox} busy={busy} />
        </button>
      )}
    >
      <div className="flex flex-col gap-3 p-4 text-sm">
        <div>
          <div className="font-semibold">{own ? "Copilot's own sandbox" : `${sandbox.name}: a worker`}</div>
          <div className="text-xs text-fg-muted">{own ? "No agent inside: Copilot runs commands here itself, from the shared runtime." : "Its own agent, in its own sandbox, with the task Copilot gave it."}</div>
        </div>
        <Detail
          rows={[
            ["Environment", <span className="font-mono">{sandbox.environment}</span>],
            own ? ["Commands", String(sandbox.commands ?? 0)] : false,
            own && sandbox.lastCommand ? ["Latest", <span className="font-mono">$ {sandbox.lastCommand}</span>] : false,
            sandbox.error ? ["Error", <span className="text-fg-danger">{sandbox.error}</span>] : false,
            ["Sandbox", <IdRow id={sandbox.id} />],
          ]}
        />
        {sandbox.task ? (
          <details>
            <summary className="text-xs font-semibold text-fg-muted">Task</summary>
            <p className="mt-1 max-h-40 overflow-y-auto text-xs whitespace-pre-wrap">{sandbox.task}</p>
          </details>
        ) : null}
        {sandbox.report ? (
          <details open>
            <summary className="text-xs font-semibold text-fg-muted">Report</summary>
            <p className="mt-1 max-h-56 overflow-y-auto text-xs whitespace-pre-wrap">{sandbox.report}</p>
          </details>
        ) : null}
      </div>
    </Popover>
  );
}

function GhostSlot({ label, own }: { readonly label: string; readonly own: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed border-line p-2.5 text-fg-muted">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-canvas-muted">
        {own ? <TerminalIcon size={16} /> : <ContainerIcon size={16} />}
      </span>
      <span className="text-sm">{label}</span>
    </div>
  );
}

function ProductionCard({ incident }: { readonly incident: IncidentView }) {
  const { approval, deploy } = incident;
  const state = approval?.state;
  const chip =
    state === "waiting" ? (
      <span className="Label Label--attention">Needs you</span>
    ) : state === "approved" ? (
      <span className="inline-flex items-center gap-1 text-xs text-fg-accent">
        <Spinner size={12} /> Deploying
      </span>
    ) : state === "deployed" ? (
      <span className="Label Label--success">Deployed</span>
    ) : state === "declined" || state === "failed" ? (
      <span className="Label Label--danger">{state === "declined" ? "Declined" : "Failed"}</span>
    ) : state === "expired" ? (
      <span className="Label">Expired</span>
    ) : (
      <span className="text-xs text-fg-muted">Not yet</span>
    );
  const before = deploy?.previousVersion ?? incident.serviceVersion;
  const version = deploy?.ok && deploy.version ? (before ? `v${before} → v${deploy.version}` : `v${deploy.version}`) : before ? `v${before}` : undefined;
  return (
    <Popover
      label="Production"
      width="w-80"
      trigger={(open, toggle) => (
        <button type="button" className={cx(CARD, state === "waiting" && "needs-you")} aria-expanded={open} onClick={toggle}>
          <div className="flex items-center gap-2">
            <ShieldIcon size={16} className={state === "waiting" ? "text-fg-attention" : state === "deployed" ? "text-fg-success" : "text-fg-muted"} />
            <span className="font-semibold">Deploy</span>
            <span className="ml-auto">{chip}</span>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-fg-muted">
            {incident.service}
            {version ? ` ${version}` : ""}
          </div>
        </button>
      )}
    >
      <div className="flex flex-col gap-3 p-4 text-sm">
        <div>
          <div className="font-semibold">Production asks a person first</div>
          <div className="text-xs text-fg-muted">Sandboxes are isolated, so Copilot works freely there. A deploy waits for your approval.</div>
        </div>
        <Detail
          rows={[
            ["Service", incident.demo ? `${incident.service} (demo service)` : incident.service],
            ["Target", incident.demo ? "The demo's simulated production" : "Your deploy pipeline"],
            deploy ? ["Result", deploy.message] : false,
          ]}
        />
      </div>
    </Popover>
  );
}

/** Where the incident's work runs: the alert, Copilot's brain, its hands, and the production gate. */
export function ResponseMap({ incident }: { readonly incident: IncidentView }) {
  const now = useNow();
  const { coordinator, approval } = incident;
  const working = coordinator.state === "working";
  const own = incident.sandboxes.find((sandbox) => sandbox.role === "own");
  const workers = incident.sandboxes.filter((sandbox) => sandbox.role === "worker");
  const handsBusy = working && HANDS_ACTIVITY.test(coordinator.activity ?? "");
  // Placeholders for what the runbook brings, so cards don't jump in as sandboxes start.
  const expecting = incident.status !== "resolved" && (coordinator.state === "starting" || coordinator.state === "working");
  const ghosts = expecting ? Math.max(0, 2 - workers.length) : 0;
  const items: ReactNode[] = [];
  if (own) {
    items.push(
      <li key={own.id} {...(handsBusy ? { "data-active": "" } : {})}>
        <SandboxCard sandbox={own} busy={handsBusy} now={now} />
      </li>,
    );
  } else if (expecting) {
    items.push(
      <li key="own">
        <GhostSlot label="Copilot's own sandbox" own />
      </li>,
    );
  }
  for (const worker of workers) {
    items.push(
      <li key={worker.id} {...(worker.state === "working" || worker.state === "starting" ? { "data-active": "" } : {})}>
        <SandboxCard sandbox={worker} busy={false} now={now} />
      </li>,
    );
  }
  for (let index = 0; index < ghosts; index++) {
    items.push(
      <li key={`ghost-${index}`}>
        <GhostSlot label="A worker" own={false} />
      </li>,
    );
  }

  return (
    <section aria-label="Where it's running" className="Box p-4 sm:p-5">
      <div className="grid grid-cols-1 gap-y-1 md:grid-cols-[minmax(0,0.85fr)_32px_minmax(0,1fr)_32px_minmax(0,1.25fr)_32px_minmax(0,0.95fr)] md:gap-y-0">
        <Column caption="Alert" icon={BellIcon}>
          <AlertCard incident={incident} />
        </Column>
        <Connector />
        <Column caption="Brain · shared runtime" icon={CpuIcon}>
          <CopilotCard incident={incident} />
        </Column>
        <Connector active={working} plain />
        <Column caption="Hands · sandboxes" icon={ContainerIcon}>
          {items.length ? <ul className="fan max-md:pl-0 max-md:[&>li]:before:hidden max-md:[&>li]:after:hidden">{items}</ul> : <div className="text-sm text-fg-muted">No sandboxes</div>}
        </Column>
        <Connector active={approval?.state === "approved"} />
        <Column caption="Production" icon={ShieldIcon}>
          <ProductionCard incident={incident} />
        </Column>
      </div>
    </section>
  );
}
