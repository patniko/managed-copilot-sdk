import { CpuIcon, KebabHorizontalIcon, PlayIcon, TrashIcon, TriangleDownIcon, ZapIcon } from "@primer/octicons-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  CLASSIFICATION_METHODS,
  SIMULATION_SIZES,
  TICKET_CATEGORIES,
  TICKET_CATEGORY_INFO,
  type ClassificationMethod,
  type ClassificationRun,
  type ClassificationRuns,
  type CustomerCard,
  type PlayerTicket,
  type Ticket,
  type TicketCategory,
  type TicketTriage,
  type TriageInfo,
} from "../../shared/types.js";
import { chooseSize, classify, endSimulation, simulate, useStore } from "../lib/store.js";
import { useDismiss } from "../lib/useDismiss.js";
import { Issues } from "./Issues.js";
import { Knowledge } from "./Knowledge.js";
import { Stats } from "./Stats.js";
import { GhostTile, PlayerTile, Tile } from "./Tile.js";
import { ConfirmDialog } from "./ui/ConfirmDialog.js";
import { Spinner } from "./ui/Spinner.js";

/**
 * The operator's wall: live players of Downhill first, then every customer of the store, each with a private session
 * on the one shared runtime.
 */
export function Wall() {
  const phase = useStore((state) => state.phase);
  const loadError = useStore((state) => state.loadError);
  const customers = useStore((state) => state.customers);
  const tickets = useStore((state) => state.tickets);
  const players = useStore((state) => state.players);
  const run = useStore((state) => state.run);
  const size = useStore((state) => state.size);
  const classification = useStore((state) => state.classification);
  const classifications = useStore((state) => state.classifications);
  return (
    <main className="mx-auto w-full max-w-[1360px] px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">Contoso Outdoors support</h1>
          <p className="text-sm text-fg-muted">
            {players.length > 0
              ? "Each customer, and each player of Downhill who contacts support, gets a private agent session. All share one runtime."
              : "Each customer gets a private agent session. All share one runtime."}
          </p>
        </div>
        <Controls />
      </div>
      <PlatformNotice />
      <TriageNotice />
      {!run && classification ? <ClassificationSummary latest={classification} runs={classifications} /> : null}
      <div className="mt-4">
        <Stats />
      </div>
      <Issues />
      {phase === "error" ? (
        <div className="blankslate mt-4 rounded-md border border-line">
          <p className="blankslate-description">{loadError ?? "Couldn't load the help desk."}</p>
          <div className="blankslate-action">
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Try again
            </button>
          </div>
        </div>
      ) : run && Object.values(tickets).some((ticket) => ticket.triage) ? (
        <>
          <PlayerGroup players={players} />
          <TicketGroups customers={customers} tickets={tickets} />
        </>
      ) : !run && classification ? (
        <>
          <PlayerGroup players={players} />
          <ClassificationGroups customers={customers} classification={classification} />
        </>
      ) : (
        <section aria-label="Players and customers" className={GRID}>
          {phase === "loading"
            ? Array.from({ length: 10 }, (_, index) => <div key={index} className="SkeletonBox h-[112px]! rounded-md!" />)
            : [
                ...players.map((player) => <PlayerTile key={player.ticketId} ticket={player} />),
                ...customers.map((customer, index) => {
                  const ticket = tickets[customer.id];
                  return ticket ? <Tile key={customer.id} customer={customer} ticket={ticket} /> : <GhostTile key={customer.id} customer={customer} queued={!run && index < size} />;
                }),
              ]}
        </section>
      )}
      <Knowledge />
    </main>
  );
}

const GRID = "mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";

interface Entry {
  readonly customer: CustomerCard;
  readonly triage: TicketTriage | undefined;
  readonly tile: ReactNode;
}

/** Live players of Downhill, above the customers' groups: classification sorts the store's customers only. */
function PlayerGroup({ players }: { readonly players: readonly PlayerTicket[] }) {
  if (players.length === 0) return null;
  return (
    <section aria-label="Downhill players" className="mt-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        Downhill players
        <span className="Counter">{players.length}</span>
      </h2>
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {players.map((player) => (
          <PlayerTile key={player.ticketId} ticket={player} />
        ))}
      </div>
    </section>
  );
}

/** The simulation's tickets by their classification; the rest of the store's customers after. */
function TicketGroups({ customers, tickets }: { readonly customers: readonly CustomerCard[]; readonly tickets: Readonly<Record<string, Ticket>> }) {
  const entries: Entry[] = [];
  const rest: CustomerCard[] = [];
  for (const customer of customers) {
    const ticket = tickets[customer.id];
    if (ticket) entries.push({ customer, triage: ticket.triage, tile: <Tile key={customer.id} customer={customer} ticket={ticket} /> });
    else rest.push(customer);
  }
  return <Grouped entries={entries} rest={rest} />;
}

/** Classify's results: the customers' first messages by category, with no sessions behind them. */
function ClassificationGroups({ customers, classification }: { readonly customers: readonly CustomerCard[]; readonly classification: ClassificationRun }) {
  const entries: Entry[] = [];
  const rest: CustomerCard[] = [];
  for (const customer of customers) {
    const triage = classification.results[customer.id];
    if (triage) entries.push({ customer, triage, tile: <GhostTile key={customer.id} customer={customer} queued urgent={triage.state === "done" && triage.urgent} /> });
    else rest.push(customer);
  }
  return <Grouped entries={entries} rest={rest} />;
}

/** Customers by their classification, urgent ones first in each group; `rest` (not in this run) after. */
function Grouped({ entries, rest }: { readonly entries: readonly Entry[]; readonly rest: readonly CustomerCard[] }) {
  const groups = new Map<TicketCategory | "unclassified", Entry[]>();
  for (const entry of entries) {
    const key = entry.triage?.state === "done" ? entry.triage.category : "unclassified";
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const urgent = (entry: Entry) => (entry.triage?.state === "done" && entry.triage.urgent ? 0 : 1);
  const order = [...TICKET_CATEGORIES, "unclassified"] as const;
  return (
    <div aria-label="Customers by request">
      {order.map((key) => {
        const group = groups.get(key);
        if (!group) return null;
        const classifying = group.some((entry) => entry.triage?.state === "classifying");
        const label = key === "unclassified" ? (classifying ? "Classifying" : "Not classified") : TICKET_CATEGORY_INFO[key].label;
        return (
          <section key={key} aria-label={label} className="mt-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold" title={key === "unclassified" ? undefined : TICKET_CATEGORY_INFO[key].description}>
              {label}
              <span className="Counter">{group.length}</span>
              {key === "unclassified" && classifying ? <Spinner size={12} /> : null}
            </h2>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{[...group].sort((a, b) => urgent(a) - urgent(b)).map((entry) => entry.tile)}</div>
          </section>
        );
      })}
      {rest.length > 0 ? (
        <section aria-label="Other customers" className={GRID}>
          {rest.map((customer) => (
            <GhostTile key={customer.id} customer={customer} queued={false} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

const METHOD_LABELS: Readonly<Record<ClassificationMethod, string>> = { decision: "Decision model", llm: "LLM" };

/**
 * Each method's latest Classify, side by side: how far it got, how long it took, and what it cost. The point is how
 * much faster and cheaper the decision model is than an ordinary LLM at the same job.
 */
function ClassificationSummary({ latest, runs }: { readonly latest: ClassificationRun; readonly runs: ClassificationRuns }) {
  const shown = CLASSIFICATION_METHODS.flatMap((method) => (runs[method] ? [runs[method]] : []));
  return (
    <div className="mt-2 flex flex-col gap-1" role="status" aria-label="Classify results">
      {(shown.length > 0 ? shown : [latest]).map((run) => (
        <ClassificationLine key={run.method} run={run} latest={run.id === latest.id && run.method === latest.method} />
      ))}
    </div>
  );
}

function ClassificationLine({ run, latest }: { readonly run: ClassificationRun; readonly latest: boolean }) {
  const results = Object.values(run.results);
  const done = results.filter((result) => result.state === "done").length;
  const failed = results.filter((result) => result.state === "failed");
  const finished = run.elapsedMs !== undefined;
  const seconds = `${((run.elapsedMs ?? 0) / 1000).toFixed(1)}s`;
  const Icon = run.method === "decision" ? ZapIcon : CpuIcon;
  const usage = run.usage;
  const tokens = usage.inputTokens + usage.outputTokens;
  return (
    <p className={`flex items-center gap-1.5 text-sm ${latest ? "" : "text-fg-muted"}`}>
      {finished ? <Icon size={16} className={`shrink-0 ${run.method === "decision" ? "text-fg-attention" : "text-fg-muted"}`} /> : <Spinner size={14} />}
      <span className="shrink-0">
        <span className="font-semibold">{METHOD_LABELS[run.method]}</span>
        {run.model ? <code className="ml-1 text-xs">{run.model}</code> : null}
        {": "}
        {finished ? (
          <>
            <span className="font-semibold">
              {done} classified{failed.length > 0 ? `, ${failed.length} failed` : ""} in {seconds}
            </span>
            {usage.measured > 0 ? (
              <span className="text-fg-muted">
                {" "}
                · {tokens.toLocaleString("en-US")} tokens
                {usage.measured < done ? ` (usage of ${usage.measured})` : ""}
              </span>
            ) : null}
            {latest ? <span className="text-fg-muted"> · first messages only, no support sessions started</span> : null}
          </>
        ) : (
          <>
            classifying {run.size} customers' first messages… <span className="text-fg-muted">{done + failed.length} done</span>
          </>
        )}
      </span>
      {failed[0]?.state === "failed" ? <span className="min-w-0 truncate text-fg-danger" title={failed[0].message}>{failed[0].message}</span> : null}
    </p>
  );
}

/** How many customers, the primary action, and an overflow menu with ending the simulation. */
function Controls() {
  const size = useStore((state) => state.size);
  const run = useStore((state) => state.run);
  const working = useStore((state) => state.working);
  const connected = useStore((state) => state.platform?.state === "connected");
  const players = useStore((state) => state.players.length);
  const [confirm, setConfirm] = useState<"restart" | "end" | undefined>();
  const triage = useStore((state) => state.desk?.triage);
  const llmTriage = useStore((state) => state.desk?.llmTriage);
  const classifying = useStore((state) => Boolean(state.classification && state.classification.elapsedMs === undefined));
  const busy = working !== undefined || Boolean(run?.ending);
  const playersStay = players > 0 ? " Players' tickets stay." : "";
  return (
    <div className="flex items-center gap-2">
      <div className="SegmentedControl" role="group" aria-label="Customers to simulate">
        {SIMULATION_SIZES.map((option) => (
          <button key={option} type="button" className="SegmentedControl-item" aria-pressed={size === option} disabled={busy} onClick={() => chooseSize(option)}>
            {option}
          </button>
        ))}
      </div>
      <button type="button" className="btn btn-primary" disabled={!connected || busy} onClick={() => (run ? setConfirm("restart") : void simulate())}>
        {working === "simulate" || run?.ending ? <Spinner size={16} /> : <PlayIcon size={16} />}
        <span>
          <span className="max-sm:hidden">Simulate </span>
          {size} customers
        </span>
      </button>
      {(triage && triage.state !== "off") || (llmTriage && llmTriage.state !== "off") ? (
        <ClassifyMenu
          disabled={!connected || busy || classifying || Boolean(run)}
          working={working === "classify" || classifying}
          title={run ? "End the simulation first: Classify reads the customers' first messages without starting their sessions." : `Classify the first ${size} customers' messages, without starting their sessions.`}
          triage={triage}
          llmTriage={llmTriage}
        />
      ) : null}
      {run ? <Overflow disabled={busy} onEnd={() => setConfirm("end")} /> : null}
      {confirm === "restart" ? (
        <ConfirmDialog
          title={`Simulate ${size} new customers?`}
          confirm="Start over"
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => {
            setConfirm(undefined);
            void simulate();
          }}
        >
          The current {run?.size} conversations end, and their sessions are deleted.{playersStay}
        </ConfirmDialog>
      ) : null}
      {confirm === "end" ? (
        <ConfirmDialog
          title="End the simulation?"
          confirm="End simulation"
          danger
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => {
            setConfirm(undefined);
            void endSimulation();
          }}
        >
          Its {run?.size} sessions are deleted.{playersStay}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** Classify, as a menu: with the decision model, or with the ordinary LLM to compare. */
function ClassifyMenu(props: {
  readonly disabled: boolean;
  readonly working: boolean;
  readonly title: string;
  readonly triage: TriageInfo | undefined;
  readonly llmTriage: TriageInfo | undefined;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(container, open, close);
  const options: ReadonlyArray<{ readonly method: ClassificationMethod; readonly label: string; readonly info: TriageInfo | undefined; readonly Icon: typeof ZapIcon }> = [
    { method: "decision", label: "Use decision model", info: props.triage, Icon: ZapIcon },
    { method: "llm", label: "Use LLM", info: props.llmTriage, Icon: CpuIcon },
  ];
  return (
    <div ref={container} className="relative">
      <button type="button" className="btn" aria-haspopup="menu" aria-expanded={open} disabled={props.disabled} title={props.title} onClick={() => setOpen((value) => !value)}>
        {props.working ? <Spinner size={16} /> : <ZapIcon size={16} />}
        <span>Classify</span>
        <TriangleDownIcon size={16} />
      </button>
      {open ? (
        <div role="menu" className="Overlay absolute top-full right-0 z-40 mt-2 w-72 animate-scale-in">
          <ul className="ActionList">
            {options.map(({ method, label, info, Icon }) => {
              const usable = info !== undefined && (info.state === "ready" || info.state === "unavailable");
              const description =
                !info || info.state === "off"
                  ? "Not set up: Help Desk's README shows how to turn it on."
                  : info.state === "connecting"
                    ? "Connecting…"
                    : `${info.model ?? "Its model"} in ${info.environment ?? "its environment"}`;
              return (
                <li role="none" key={method}>
                  <button
                    type="button"
                    role="menuitem"
                    className="ActionList-item w-full"
                    disabled={!usable}
                    onClick={() => {
                      close();
                      void classify(method);
                    }}
                  >
                    <Icon size={16} />
                    <span className="ActionList-item-label flex flex-col items-start">
                      <span>{label}</span>
                      <span className="text-xs text-fg-muted">{description}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Overflow({ disabled, onEnd }: { readonly disabled: boolean; readonly onEnd: () => void }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(container, open, close);
  return (
    <div ref={container} className="relative">
      <button type="button" className="btn btn-icon" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((value) => !value)}>
        <KebabHorizontalIcon size={16} />
      </button>
      {open ? (
        <div role="menu" className="Overlay absolute top-full right-0 z-40 mt-2 w-56 animate-scale-in">
          <ul className="ActionList">
            <li role="none">
              <button
                type="button"
                role="menuitem"
                className="ActionList-item ActionList-item--danger w-full"
                onClick={() => {
                  close();
                  onEnd();
                }}
              >
                <TrashIcon size={16} />
                <span className="ActionList-item-label">End simulation</span>
              </button>
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Whether customers' messages are classified: set up (and by which model), not set up, or failing. */
function TriageNotice() {
  const triage = useStore((state) => state.desk?.triage);
  const llmTriage = useStore((state) => state.desk?.llmTriage);
  const connected = useStore((state) => state.platform?.state === "connected");
  if (!triage || !connected || triage.state === "connecting") return null;
  const compare = llmTriage?.state === "ready" ? llmTriage : undefined;
  if (triage.state === "unavailable") {
    return (
      <div className="flash flash-warn mt-4 text-sm" role="status">
        Tickets aren't being classified: {triage.message ?? "the triage environment isn't available."}
      </div>
    );
  }
  return (
    <p className="mt-2 text-sm text-fg-muted">
      {triage.state === "ready" ? (
        <>
          Each customer message is classified by <code>{triage.model}</code> in the <code>{triage.environment}</code> environment, then grouped below.
          {compare ? (
            <>
              {" "}
              To compare time and cost, Classify can use <code>{compare.model}</code> instead.
            </>
          ) : null}
        </>
      ) : compare ? (
        <>
          The decision model isn't set up, so tickets aren't grouped as they arrive. Classify can still use <code>{compare.model}</code>; Help Desk's README shows how to add the decision model.
        </>
      ) : (
        <>Ticket classification isn't set up, so tickets aren't grouped by request. Help Desk's README shows how to turn it on.</>
      )}
    </p>
  );
}

/** One line when Managed Copilot isn't connected. */
function PlatformNotice() {
  const platform = useStore((state) => state.platform);
  if (!platform || platform.state === "connected" || platform.state === "connecting") return null;
  return (
    <div className="flash flash-warn mt-4 text-sm" role="status">
      {platform.message ?? "Managed Copilot isn't available right now. Help Desk keeps trying."}
    </div>
  );
}
