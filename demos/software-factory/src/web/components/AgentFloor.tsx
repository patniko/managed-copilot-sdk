import { CopilotIcon, LinkIcon } from "@primer/octicons-react";
import type { Station, WorkOrder } from "../../shared/types.js";
import { taskRows, taskTitle } from "../lib/stations.js";
import { StationCard } from "./StationCard.js";

/** The agent-led floor: workers appear in their plan lanes as the coordinator creates their sandboxes. */
export function AgentFloor({ workOrder, selectedId, onSelect }: {
  readonly workOrder: WorkOrder;
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
}) {
  const plan = workOrder.stations.find((station) => station.kind === "plan");
  const coordinator = workOrder.stations.find((station) => station.kind === "coordinate");
  const release = workOrder.stations.find((station) => station.kind === "release");
  const rows = taskRows(workOrder);
  const card = (station: Station, heading?: string) => (
    <StationCard station={station} selected={selectedId === station.id} onSelect={() => onSelect(station.id)} heading={heading} compact />
  );
  return (
    <section aria-label="Agent-led factory floor" className="Box @container min-w-0 overflow-auto bg-dot-grid p-4 xl:h-full xl:min-h-0">
      <div className="grid items-stretch gap-3 @xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {plan ? card(plan) : null}
        {coordinator ? card(coordinator) : null}
      </div>
      {rows.length ? (
        <div className="mt-4 grid gap-3 @2xl:grid-cols-2">
          {rows.map((row) => (
            <section key={row.id} aria-label={row.title} className="min-w-0 rounded-md border border-dashed border-line p-2.5">
              <h3 className="mb-2 font-semibold">{row.title}</h3>
              {row.dependsOn.length ? (
                <p className="mb-2 flex items-center gap-1 text-xs text-fg-muted"><LinkIcon size={12} /> After {row.dependsOn.map((id) => taskTitle(workOrder, id)).join(", ")}</p>
              ) : null}
              <div className="grid items-start gap-2 @sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
                {row.build ? card(row.build, row.build.round ? `Build · round ${row.build.round}` : "Build") : null}
                {row.review ? card(row.review, row.review.round ? `Review · round ${row.review.round}` : "Review") : null}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="mt-4 rounded-md border border-dashed border-line bg-canvas p-6 text-center">
          <CopilotIcon size={24} className="text-fg-done" />
          <p className="mt-2 font-semibold">The plan comes first</p>
          <p className="mt-1 text-xs text-fg-muted">Once the factory accepts it, the coordinator decides which builder sandboxes to create.</p>
        </div>
      )}
      {release ? (
        <div className="mt-4">
          {card(release)}
          {!release.sessionId ? (
            <p className="mt-2 px-1 text-xs text-fg-muted">The coordinator creates the release sandbox only after every task passes checks and review, then copies the builders&apos; outputs into it.</p>
          ) : null}
        </div>
      ) : null}
      <button type="button" className="mt-4 text-xs text-fg-accent hover:underline" onClick={() => onSelect("intake")}>Read the original work order</button>
    </section>
  );
}
