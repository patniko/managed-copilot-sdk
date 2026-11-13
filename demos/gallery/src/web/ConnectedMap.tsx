import { useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { AppEntry } from "../shared/catalog.js";
import { CONNECTED_COLUMNS, FLOWS, type Flow, type Place } from "./model.js";
import { Tile } from "./PatternDiagram.js";
import { cx, Tooltip } from "./ui.js";

/** At this width and up the apps are a map with connectors; below it, a list in story order. Matches styles.css. */
const WIDE = "(min-width: 70rem)";
/** Space between the two connectors of a pair that run both ways. */
const LANE = 32;
/** How close a connector may come to a node's corner. */
const INSET = 20;

export type NodeLayout = "tall" | "wide";

/** A flow from this app, for the list's "sends" lines. */
export interface Send {
  readonly flow: Flow;
  readonly to: AppEntry;
}

interface Zone {
  readonly id: keyof typeof CONNECTED_COLUMNS;
  readonly title: string;
  readonly column: number;
}

const ZONES: readonly Zone[] = [
  { id: "storefront", title: "Storefront", column: 1 },
  { id: "responders", title: "Support and operations", column: 3 },
  { id: "engineering", title: "Engineering", column: 5 },
];

const LEGEND_TILES: readonly { readonly place: Place; readonly agent?: boolean; readonly title: string; readonly text: string }[] = [
  { place: "runtime", agent: true, title: "Shared runtime", text: "many sessions in one process" },
  { place: "sandbox", title: "Sandbox", text: "a session's own shell and files" },
  { place: "worker", agent: true, title: "Worker", text: "an agent in its own sandbox" },
  { place: "app", title: "Your app", text: "tools that run in the app" },
];

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", changed);
      return () => media.removeEventListener("change", changed);
    },
    () => window.matchMedia(query).matches,
  );
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
  readonly cx: number;
  readonly cy: number;
}

interface Edge {
  readonly flow: Flow;
  readonly d: string;
  readonly label: { readonly x: number; readonly y: number };
}

interface Drop {
  readonly id: string;
  readonly d: string;
  readonly label: { readonly x: number; readonly y: number };
}

interface Geometry {
  readonly width: number;
  readonly height: number;
  readonly edges: readonly Edge[];
  readonly drops: readonly Drop[];
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * One connector between two nodes in neighboring columns: straight across at the shorter node's middle, or with one
 * bend halfway when the nodes don't overlap there. A pair running both ways splits into two lanes.
 */
function route(flow: Flow, from: Box, to: Box, paired: boolean): Edge {
  const [left, right] = from.left < to.left ? [from, to] : [to, from];
  let y = (left.height <= right.height ? left : right).cy;
  if (paired) y += flow.back ? LANE / 2 : -LANE / 2;
  const leftY = clamp(y, left.top + INSET, left.bottom - INSET);
  const rightY = clamp(y, right.top + INSET, right.bottom - INSET);
  const middle = (left.right + right.left) / 2;
  const points: [number, number][] = Math.abs(leftY - rightY) < 1 ? [[left.right, leftY], [right.left, leftY]] : [[left.right, leftY], [middle, leftY], [middle, rightY], [right.left, rightY]];
  if (from !== left) points.reverse();
  const d = points.map(([x, py], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${py.toFixed(1)}`).join(" ");
  // The label sits on the horizontal run nearest the source.
  const [x1, y1] = points[0]!;
  const [x2] = points[1]!;
  return { flow, d, label: { x: (x1 + x2) / 2, y: y1 } };
}

/**
 * Contoso Outdoors' connected apps as a map: three zones left to right (the storefront, the apps whose agents respond,
 * and the factory that builds the fix), connectors labeled with what each sends, and the platform their agents run on.
 * Below {@link WIDE} it's the same nodes as a list, each saying what it sends where.
 */
export function ConnectedMap({ apps, renderNode }: { readonly apps: readonly AppEntry[]; readonly renderNode: (app: AppEntry, layout: NodeLayout, sends: readonly Send[]) => ReactNode }) {
  const wide = useMedia(WIDE);
  const container = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const zones = useRef(new Map<string, HTMLElement>());
  const platform = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<Geometry>();
  const [focus, setFocus] = useState<string>();

  const placed = new Set<string>(Object.values(CONNECTED_COLUMNS).flat());
  const column = (id: Zone["id"]): readonly AppEntry[] => [
    ...CONNECTED_COLUMNS[id].flatMap((appId) => apps.filter((app) => app.id === appId)),
    ...(id === "responders" ? apps.filter((app) => !placed.has(app.id)) : []),
  ];
  const columns = { storefront: column("storefront"), responders: column("responders"), engineering: column("engineering") };
  const rows = Math.max(1, columns.responders.length);
  const present = new Set(apps.map((app) => app.id));
  const flows = FLOWS.filter((flow) => present.has(flow.from) && present.has(flow.to));
  const byId = new Map(apps.map((app) => [app.id, app]));
  const appKey = apps.map((app) => app.id).join(",");

  useLayoutEffect(() => {
    const root = container.current;
    if (!wide || !root) {
      setGeometry(undefined);
      return;
    }
    const measure = (): void => {
      const base = root.getBoundingClientRect();
      const box = (element: HTMLElement): Box => {
        const r = element.getBoundingClientRect();
        const left = r.left - base.left;
        const top = r.top - base.top;
        return { left, right: left + r.width, top, bottom: top + r.height, height: r.height, cx: left + r.width / 2, cy: top + r.height / 2 };
      };
      const edges = flows.flatMap((flow) => {
        const from = nodes.current.get(flow.from);
        const to = nodes.current.get(flow.to);
        if (!from || !to) return [];
        const paired = flows.some((other) => other.from === flow.to && other.to === flow.from);
        return [route(flow, box(from), box(to), paired)];
      });
      const strip = platform.current ? box(platform.current) : undefined;
      const drops = strip
        ? (["responders", "engineering"] as const).flatMap((id) => {
            const zone = zones.current.get(id);
            if (!zone) return [];
            const z = box(zone);
            return [{ id, d: `M${z.cx.toFixed(1)} ${z.bottom.toFixed(1)} L${z.cx.toFixed(1)} ${strip.top.toFixed(1)}`, label: { x: z.cx, y: (z.bottom + strip.top) / 2 } }];
          })
        : [];
      setGeometry({ width: base.width, height: base.height, edges, drops });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const element of nodes.current.values()) observer.observe(element);
    return () => observer.disconnect();
    // flows derive from appKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wide, appKey]);

  const sendsOf = (app: AppEntry): readonly Send[] => flows.filter((flow) => flow.from === app.id).map((flow) => ({ flow, to: byId.get(flow.to)! }));
  const touches = (flow: Flow): boolean => focus !== undefined && (flow.from === focus || flow.to === focus);

  const node = (app: AppEntry, layout: NodeLayout, style: CSSProperties) => (
    <div
      key={app.id}
      ref={(element) => {
        if (element) nodes.current.set(app.id, element);
        else nodes.current.delete(app.id);
      }}
      className={cx("flow-cell", `flow-cell-${layout}`, focus && focus !== app.id && !flows.some((flow) => touches(flow) && (flow.from === app.id || flow.to === app.id)) && "flow-dim")}
      style={style}
      onMouseEnter={() => setFocus(app.id)}
      onMouseLeave={() => setFocus(undefined)}
      onFocus={() => setFocus(app.id)}
      onBlur={() => setFocus(undefined)}
    >
      {renderNode(app, layout, sendsOf(app))}
    </div>
  );

  const tall: CSSProperties = { gridRow: `2 / span ${rows}` };
  return (
    <div ref={container} className="flow-map" style={{ "--flow-rows": rows } as CSSProperties}>
      {ZONES.map((zone) => (
        <div
          key={`${zone.id}-box`}
          ref={(element) => {
            if (element) zones.current.set(zone.id, element);
            else zones.current.delete(zone.id);
          }}
          className={cx("flow-zone", `flow-zone-${zone.id}`)}
          style={{ gridColumn: zone.column, gridRow: `1 / span ${rows + 1}` }}
          aria-hidden
        />
      ))}

      {ZONES.map((zone) => {
        const members = columns[zone.id];
        if (!members.length) return null;
        return [
          <h3 key={`${zone.id}-title`} className="flow-zone-title" style={{ gridColumn: zone.column, gridRow: 1 }}>
            <span className="flow-zone-name">{zone.title}</span>
          </h3>,
          ...members.map((app, index) => node(app, zone.id === "responders" ? "wide" : "tall", zone.id === "responders" ? { gridColumn: 3, gridRow: 2 + index } : { gridColumn: zone.column, ...tall })),
        ];
      })}

      <div className="flow-legend" style={{ gridColumn: 1, gridRow: rows + 3 }}>
        <span className="flow-legend-item">
          <svg width="28" height="8" aria-hidden>
            <line x1="0" y1="4" x2="28" y2="4" className="flow-legend-line" />
          </svg>
          Sends work
        </span>
        <span className="flow-legend-item">
          <svg width="28" height="8" aria-hidden>
            <line x1="0" y1="4" x2="28" y2="4" className="flow-legend-line flow-legend-back" />
          </svg>
          Deploys back
        </span>
        <span className="flow-legend-item">
          <svg width="28" height="8" aria-hidden>
            <line x1="0" y1="4" x2="28" y2="4" className="flow-legend-line flow-legend-session" />
          </svg>
          Runs its agents on
        </span>
      </div>

      <div ref={platform} className="flow-platform" style={{ gridRow: rows + 3 }}>
        <div className="flow-zone-title">
          <span className="flow-zone-name">Managed Copilot platform</span>
        </div>
        <ul className="flow-platform-tiles">
          {LEGEND_TILES.map((tile) => (
            <li key={tile.place} className="flow-platform-tile">
              <Tile place={tile.place} agent={tile.agent} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{tile.title}</span>
                <span className="block text-xs text-fg-muted">{tile.text}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      {geometry ? (
        <>
          <svg className="flow-wires" width={geometry.width} height={geometry.height} viewBox={`0 0 ${geometry.width} ${geometry.height}`} aria-hidden>
            <defs>
              <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" className="flow-arrowhead" />
              </marker>
              <marker id="flow-arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" className="flow-arrowhead flow-arrowhead-active" />
              </marker>
              <marker id="flow-arrow-session" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" className="flow-arrowhead flow-arrowhead-session" />
              </marker>
            </defs>
            {geometry.drops.map((drop) => (
              <path key={drop.id} d={drop.d} className="flow-wire flow-wire-session" markerEnd="url(#flow-arrow-session)" />
            ))}
            {geometry.edges.map((edge) => {
              const active = touches(edge.flow);
              return (
                <path
                  key={`${edge.flow.from}-${edge.flow.to}`}
                  d={edge.d}
                  className={cx("flow-wire", edge.flow.back && "flow-wire-back", active && "flow-wire-active", focus && !active && "flow-dim")}
                  markerEnd={active ? "url(#flow-arrow-active)" : "url(#flow-arrow)"}
                />
              );
            })}
          </svg>
          {geometry.drops.map((drop) => (
            <span key={drop.id} className="flow-label flow-label-session" style={{ left: drop.label.x, top: drop.label.y }} aria-hidden>
              sessions
            </span>
          ))}
          {geometry.edges.map((edge) => {
            const active = touches(edge.flow);
            return (
              <div
                key={`${edge.flow.from}-${edge.flow.to}-label`}
                className={cx("flow-label-anchor", focus && !active && "flow-dim")}
                style={{ left: edge.label.x, top: edge.label.y }}
              >
                <Tooltip content={edge.flow.detail}>
                  <span className={cx("flow-label", edge.flow.back && "flow-label-back", active && "flow-label-active")} tabIndex={0}>
                    {edge.flow.label}
                  </span>
                </Tooltip>
              </div>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
