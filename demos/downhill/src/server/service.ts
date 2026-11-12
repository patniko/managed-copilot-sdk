// Contract B: downhill-shop as Incident Commander sees it. The storefront code exactly as checkout runs it now (the
// originals with the latest deploy's files over them), the shop's log for the last two hours, and its deploy history.
import { BANNER_RELEASE, LAUNCH_OFFER } from "../shared/catalog.js";
import { SERVICE_NAME } from "./deploys.js";
import { eventLogLine, logLine, type Ledger } from "./ledger.js";
import type { DeployRecord, Storefront } from "./storefront.js";
import { MINUTE } from "./timeline.js";

export interface ServiceFile {
  readonly path: string;
  readonly content: string;
}

export interface IncidentService {
  readonly name: string;
  readonly version: string;
  readonly files: readonly ServiceFile[];
}

const LOG_WINDOW = 2 * 60 * MINUTE;
const FIRST = ["package.json", "README.md", "src/promotions.js", "src/cart.js", "src/order-status.js"];

function order(paths: readonly string[]): string[] {
  const rank = (path: string) => (FIRST.includes(path) ? FIRST.indexOf(path) : path.startsWith("src/") ? FIRST.length : path.startsWith("test/") ? FIRST.length + 1 : FIRST.length + 2);
  return [...paths].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const day = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

/** `logs/shop.log`: the last two hours of checkouts, releases, and deploys, newest last. */
export function shopLog(ledger: Ledger, storefront: Storefront, gameVersion: string, now: number): string {
  const from = now - LOG_WINDOW;
  const { launchAt, bannerAt } = ledger.timeline;
  const lines: { at: number; text: string }[] = ledger.events(from, now).map((event) => ({ at: event.at, text: eventLogLine(event) }));
  const marker = (at: number, fields: Record<string, string | undefined>) => {
    if (at >= from && at <= now) lines.push({ at, text: logLine(at, "info", fields) });
  };
  marker(launchAt, { event: "release", service: SERVICE_NAME, version: gameVersion, storefront: storefront.originalVersion(), msg: `Downhill ${gameVersion} launched: the Downhill Shop opens, with checkout on storefront v${storefront.originalVersion()}` });
  marker(bannerAt, { event: "release", service: SERVICE_NAME, version: BANNER_RELEASE.version, msg: BANNER_RELEASE.summary });
  for (const deploy of storefront.deploys()) {
    marker(Date.parse(deploy.deployedAt), { event: "deploy", service: SERVICE_NAME, storefront: deploy.version, incident: deploy.incident, approved_by: deploy.approvedBy, msg: deploy.summary });
  }
  // Releases sort before the checkouts of the same second.
  lines.sort((a, b) => a.at - b.at);
  return lines.length ? `${lines.map((line) => line.text).join("\n")}\n` : "";
}

function deployRow(deploy: DeployRecord): string {
  const by = deploy.approvedBy ? ` (approved by ${deploy.approvedBy})` : "";
  return `| ${day(Date.parse(deploy.deployedAt))} | storefront v${deploy.version} | ${deploy.incident}: ${deploy.summary.replace(/\|/g, "\\|").replace(/\n+/g, " ")}${by} |`;
}

/** `deploys/HISTORY.md`: launch, the banner release, then every deploy, oldest first. */
export function deployHistory(ledger: Ledger, storefront: Storefront, gameVersion: string): string {
  const { launchAt, bannerAt } = ledger.timeline;
  const original = storefront.originalVersion();
  return [
    `# Deploys: ${SERVICE_NAME} (production)`,
    "",
    "| When (UTC) | Release | Change |",
    "| --- | --- | --- |",
    `| ${day(launchAt)} | Downhill ${gameVersion}, storefront v${original} | Launch: the Downhill Shop opens; checkout runs Contoso Outdoors' storefront v${original} |`,
    `| ${day(bannerAt)} | Downhill shop ${BANNER_RELEASE.version} | ${BANNER_RELEASE.summary} |`,
    ...storefront.deploys().map(deployRow),
    "",
    `What shop ${BANNER_RELEASE.version} changed: the shop shows the banner "${LAUNCH_OFFER.text}". Its Apply code button puts the banner's code, exactly as the banner shows it (\`${LAUNCH_OFFER.code}\`), in the Promo code field and applies it with the storefront's \`applyPromoCode\`. The storefront code didn't change.`,
    "",
  ].join("\n");
}

/** The service Incident Commander investigates and fixes. */
export function incidentService(ledger: Ledger, storefront: Storefront, gameVersion: string, now: number): IncidentService {
  const { version } = storefront.current();
  const code = storefront.files(version);
  return {
    name: SERVICE_NAME,
    version,
    files: [
      ...order([...code.keys()]).map((path) => ({ path, content: code.get(path)! })),
      { path: "logs/shop.log", content: shopLog(ledger, storefront, gameVersion, now) },
      { path: "deploys/HISTORY.md", content: deployHistory(ledger, storefront, gameVersion) },
    ],
  };
}
