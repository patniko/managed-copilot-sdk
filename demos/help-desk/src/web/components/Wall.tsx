import { KebabHorizontalIcon, PlayIcon, TrashIcon } from "@primer/octicons-react";
import { useCallback, useRef, useState } from "react";
import { SIMULATION_SIZES } from "../../shared/types.js";
import { chooseSize, endSimulation, simulate, useStore } from "../lib/store.js";
import { useDismiss } from "../lib/useDismiss.js";
import { Issues } from "./Issues.js";
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
      ) : (
        <section aria-label="Customers" className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {phase === "loading"
            ? Array.from({ length: 10 }, (_, index) => <div key={index} className="SkeletonBox h-[112px]! rounded-md!" />)
            : customers.map((customer, index) => {
                const ticket = tickets[customer.id];
                return ticket ? <Tile key={customer.id} customer={customer} ticket={ticket} /> : <GhostTile key={customer.id} customer={customer} queued={!run && index < size} />;
              })}
        </section>
      )}
    </main>
  );
}

/** How many customers, the primary action, and an overflow menu with ending the simulation. */
function Controls() {
  const size = useStore((state) => state.size);
  const run = useStore((state) => state.run);
  const working = useStore((state) => state.working);
  const connected = useStore((state) => state.platform?.state === "connected");
  const [confirm, setConfirm] = useState<"restart" | "end" | undefined>();
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
