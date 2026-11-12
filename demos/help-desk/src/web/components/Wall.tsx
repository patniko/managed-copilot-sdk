import { KebabHorizontalIcon, PlayIcon, TrashIcon, ZapIcon } from "@primer/octicons-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { SIMULATION_SIZES, TICKET_CATEGORIES, TICKET_CATEGORY_INFO, type ClassificationRun, type CustomerCard, type Ticket, type TicketCategory, type TicketTriage } from "../../shared/types.js";
import { chooseSize, classify, endSimulation, simulate, useStore } from "../lib/store.js";
import { useDismiss } from "../lib/useDismiss.js";
import { Issues } from "./Issues.js";
import { Knowledge } from "./Knowledge.js";
import { Stats } from "./Stats.js";
import { GhostTile, Tile } from "./Tile.js";
import { ConfirmDialog } from "./ui/ConfirmDialog.js";
import { Spinner } from "./ui/Spinner.js";

/** The operator's wall: every customer of the store, each with a private session on the one shared runtime. */
export function Wall() {
  const phase = useStore((state) => state.phase);
  const loadError = useStore((state) => state.loadError);
  const customers = useStore((state) => state.customers);
  const tickets = useStore((state) => state.tickets);
  const run = useStore((state) => state.run);
  const size = useStore((state) => state.size);
  const classification = useStore((state) => state.classification);
  return (
    <main className="mx-auto w-full max-w-[1360px] px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">Contoso Outdoors support</h1>
          <p className="text-sm text-fg-muted">Each customer gets a private agent session. All share one runtime.</p>
        </div>
        <Controls />
      </div>
      <PlatformNotice />
      <TriageNotice />
      {!run && classification ? <ClassificationSummary classification={classification} /> : null}
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
        <TicketGroups customers={customers} tickets={tickets} />
      ) : !run && classification ? (
        <ClassificationGroups customers={customers} classification={classification} />
      ) : (
        <section aria-label="Customers" className={GRID}>
          {phase === "loading"
            ? Array.from({ length: 10 }, (_, index) => <div key={index} className="SkeletonBox h-[112px]! rounded-md!" />)
            : customers.map((customer, index) => {
                const ticket = tickets[customer.id];
                return ticket ? <Tile key={customer.id} customer={customer} ticket={ticket} /> : <GhostTile key={customer.id} customer={customer} queued={!run && index < size} />;
              })}
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

/** How far Classify got, and how long it took: the point is how fast the decision model is. */
function ClassificationSummary({ classification }: { readonly classification: ClassificationRun }) {
  const results = Object.values(classification.results);
  const done = results.filter((result) => result.state === "done").length;
  const failed = results.filter((result) => result.state === "failed");
  const finished = classification.elapsedMs !== undefined;
  const seconds = `${((classification.elapsedMs ?? 0) / 1000).toFixed(1)}s`;
  return (
    <p className="mt-2 flex items-center gap-1.5 text-sm" role="status">
      {finished ? <ZapIcon size={16} className="shrink-0 text-fg-attention" /> : <Spinner size={14} />}
      <span>
        {finished ? (
          <>
            <span className="font-semibold">
              {done} classified{failed.length > 0 ? `, ${failed.length} failed` : ""} in {seconds}
            </span>
            <span className="text-fg-muted"> · first messages only, no support sessions started</span>
          </>
        ) : (
          <>
            Classifying {classification.size} customers' first messages… <span className="text-fg-muted">{done + failed.length} done</span>
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
  const [confirm, setConfirm] = useState<"restart" | "end" | undefined>();
  const triage = useStore((state) => state.desk?.triage);
  const classifying = useStore((state) => Boolean(state.classification && state.classification.elapsedMs === undefined));
  const busy = working !== undefined || Boolean(run?.ending);
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
      {triage && triage.state !== "off" ? (
        <button
          type="button"
          className="btn"
          disabled={!connected || busy || classifying || Boolean(run) || triage.state === "connecting"}
          title={run ? "End the simulation first: Classify reads the customers' first messages without starting their sessions." : `Classify the first ${size} customers' messages with ${triage.model ?? "the decision model"}, without starting their sessions.`}
          onClick={() => void classify()}
        >
          {working === "classify" || classifying ? <Spinner size={16} /> : <ZapIcon size={16} />}
          <span>Classify</span>
        </button>
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
          The current {run?.size} conversations end, and their sessions are deleted.
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
          Its {run?.size} sessions are deleted.
        </ConfirmDialog>
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
  const connected = useStore((state) => state.platform?.state === "connected");
  if (!triage || !connected || triage.state === "connecting") return null;
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
