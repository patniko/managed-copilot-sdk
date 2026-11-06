import { ContainerIcon, CopilotIcon, CpuIcon, PlugIcon, type Icon } from "@primer/octicons-react";
import { Fragment } from "react";
import type { Pattern } from "../shared/catalog.js";
import { SHAPES, type Place } from "./model.js";
import { cx, Tooltip } from "./ui.js";

const PLACE: Readonly<Record<Place, { readonly icon: Icon; readonly tone: string }>> = {
  runtime: { icon: CpuIcon, tone: "tile-runtime" },
  sandbox: { icon: ContainerIcon, tone: "tile-sandbox" },
  worker: { icon: ContainerIcon, tone: "tile-sandbox" },
  app: { icon: PlugIcon, tone: "tile-app" },
};

/** One place: an icon tile. `agent` marks where an agent's model loop runs (the brain, or a worker). */
function Tile({ place, agent, later }: { readonly place: Place; readonly agent?: boolean; readonly later?: boolean }) {
  const { icon: Glyph, tone } = PLACE[place];
  return (
    <span className={cx("tile", tone, later && "tile-later")}>
      <Glyph size={16} />
      {agent ? (
        <span className="tile-agent">
          <CopilotIcon size={10} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * Where a pattern's brain (its model loop) runs and where its hands (the tools that act) run, as two groups of tiles:
 * the shared runtime, a sandbox, your app, or worker sandboxes with an agent in each.
 */
export function PatternDiagram({ pattern }: { readonly pattern: Pattern }) {
  const shape = SHAPES[pattern.id];
  if (!shape) {
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-fg-muted">Brain</dt>
        <dd>{pattern.brain}</dd>
        <dt className="text-fg-muted">Hands</dt>
        <dd>{pattern.hands}</dd>
      </dl>
    );
  }
  return (
    <Tooltip
      block
      content={
        <span className="block text-left">
          <strong>Brain:</strong> {pattern.brain}.<br />
          <strong>Hands:</strong> {pattern.hands}.
        </span>
      }
    >
      <div className={cx("diagram", shape.together && "diagram-together")} role="img" aria-label={`Brain: ${pattern.brain}. Hands: ${pattern.hands}.`} tabIndex={0}>
        <span className="diagram-label diagram-brain-label" aria-hidden>
          Brain
        </span>
        <span className="diagram-label diagram-hands-label" aria-hidden>
          Hands
        </span>
        <span className="diagram-group diagram-brain" aria-hidden>
          {shape.brain.map((place, index) => (
            <Fragment key={index}>
              {index > 0 ? <span className="diagram-move" /> : null}
              <Tile place={place} agent later={index > 0} />
            </Fragment>
          ))}
        </span>
        <span className="diagram-link" aria-hidden />
        <span className="diagram-group diagram-hands" aria-hidden>
          {shape.hands.map((hand, index) => (
            <Tile key={index} place={hand.place} agent={hand.place === "worker"} later={hand.later} />
          ))}
        </span>
        <span className="diagram-caption diagram-brain-caption" aria-hidden>
          {shape.brainCaption}
        </span>
        <span className="diagram-caption diagram-hands-caption" aria-hidden>
          {shape.handsCaption}
        </span>
      </div>
    </Tooltip>
  );
}
