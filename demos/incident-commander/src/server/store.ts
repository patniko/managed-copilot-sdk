// Incident Commander's own records: one JSON file of incidents and the app's settings. Sessions, workers, and sandboxes
// live in the platform; this keeps what the app learned about each incident (notes, approvals, deploys, postmortems,
// Software Factory work orders) and survives restarts.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AlertInfo,
  ApprovalView,
  CoordinatorState,
  DeployView,
  FactoryWorkView,
  Findings,
  FixRoute,
  IncidentStatus,
  Milestones,
  PostmortemView,
  SandboxView,
  TimelineEntry,
  TimelineKind,
} from "../shared/types.js";
import type { DemoSeed } from "./demo.js";
import type { FixFile } from "./factory.js";
import { log } from "./log.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface StoredApproval extends Mutable<ApprovalView> {
  /** Exactly what the person reviewed, so exactly that ships. */
  snapshot: { readonly path: string; readonly content: string }[];
}

/** The incident's fix as a Software Factory work order, followed until Copilot learned how it ended. */
export interface StoredFactoryWork extends Mutable<Omit<FactoryWorkView, "files">> {
  /** The fix it released, with the files' contents (what apply_factory_fix copies). */
  files?: FixFile[];
}

export interface StoredIncident {
  readonly id: string;
  readonly number: number;
  title: string;
  alert: AlertInfo;
  status: IncidentStatus;
  /** Set for the bundled demo service: how its production logs are generated. */
  readonly demo?: DemoSeed;
  /** How the fix is made; incidents recorded before routes existed are `workers`. */
  readonly fixRoute?: FixRoute;
  /** The service's version when the incident opened. */
  serviceVersion?: string;
  sessionId?: string;
  /** The alert reached the coordinator. */
  prompted?: boolean;
  readonly createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  findings: Mutable<Findings> & { evidence: string[] };
  factory?: StoredFactoryWork;
  approval?: StoredApproval;
  deploy?: DeployView;
  postmortem?: PostmortemView;
  timeline: TimelineEntry[];
  milestones: Mutable<Milestones>;
  sandboxes: Mutable<SandboxView>[];
  coordinator: { state: CoordinatorState; lastMessage?: string };
  problem?: string;
}

/** The app's settings, chosen in its UI. */
export interface StoredSettings {
  /** Absent until someone chooses: Software Factory when it's connected, otherwise workers. */
  fixRoute?: FixRoute;
}

interface StoreFile {
  readonly version: 1;
  next: number;
  incidents: StoredIncident[];
  webhook: { lastAt?: string; seen: string[] };
  settings: StoredSettings;
}

const FILE = "incidents.json";
const FIRST_NUMBER = 1001;
const SEEN_KEPT = 500;
const TIMELINE_KEPT = 300;

let entries = 0;
export const entryId = (): string => `${Date.now().toString(36)}-${(entries++).toString(36)}`;

export class Store {
  readonly #path: string;
  #data: StoreFile;
  #timer: NodeJS.Timeout | undefined;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.#path = join(dataDir, FILE);
    this.#data = this.#load();
  }

  #load(): StoreFile {
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as Partial<StoreFile>;
      // Files from before settings existed have none: the defaults apply.
      if (parsed.version === 1 && Array.isArray(parsed.incidents)) return { ...(parsed as StoreFile), webhook: parsed.webhook ?? { seen: [] }, settings: parsed.settings ?? {} };
      log.warn("Ignoring an incidents file in an unknown format", { path: this.#path });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("Couldn't read the incidents file; starting empty", { error: (error as Error).message });
    }
    return { version: 1, next: FIRST_NUMBER, incidents: [], webhook: { seen: [] }, settings: {} };
  }

  get settings(): Readonly<StoredSettings> {
    return this.#data.settings;
  }

  /** Changes the app's settings (and saves). */
  setSettings(change: Partial<StoredSettings>): void {
    this.#data.settings = { ...this.#data.settings, ...change };
    this.#save();
  }

  /** Newest first. */
  list(): readonly StoredIncident[] {
    return this.#data.incidents;
  }

  get(id: string): StoredIncident | undefined {
    return this.#data.incidents.find((incident) => incident.id === id);
  }

  bySession(sessionId: string): StoredIncident | undefined {
    return this.#data.incidents.find((incident) => incident.sessionId === sessionId);
  }

  /** The open incident a re-sent alert belongs to. */
  openByFingerprint(fingerprint: string): StoredIncident | undefined {
    return this.#data.incidents.find((incident) => incident.status !== "resolved" && incident.alert.fingerprint === fingerprint);
  }

  create(alert: AlertInfo, demo?: DemoSeed, serviceVersion?: string, fixRoute: FixRoute = "workers"): StoredIncident {
    const now = new Date().toISOString();
    const number = this.#data.next++;
    const incident: StoredIncident = {
      id: `INC-${number}`,
      number,
      title: alert.summary,
      alert,
      status: "investigating",
      ...(demo ? { demo } : {}),
      fixRoute,
      ...(serviceVersion ? { serviceVersion } : {}),
      createdAt: now,
      updatedAt: now,
      findings: { evidence: [] },
      timeline: [],
      milestones: {},
      sandboxes: [],
      coordinator: { state: "starting" },
    };
    this.#data.incidents.unshift(incident);
    this.#save();
    return incident;
  }

  /** Changes an incident and saves it. Returns undefined when it no longer exists. */
  update(id: string, change: (incident: StoredIncident) => void): StoredIncident | undefined {
    const incident = this.get(id);
    if (!incident) return undefined;
    change(incident);
    incident.updatedAt = new Date().toISOString();
    if (incident.timeline.length > TIMELINE_KEPT) incident.timeline.splice(0, incident.timeline.length - TIMELINE_KEPT);
    this.#save();
    return incident;
  }

  /** Adds a timeline entry (and saves). */
  note(id: string, kind: TimelineKind, text: string, detail?: string, at = new Date().toISOString()): void {
    this.update(id, (incident) => {
      incident.timeline.push({ id: entryId(), at, kind, text, ...(detail ? { detail } : {}) });
      incident.timeline.sort((a, b) => a.at.localeCompare(b.at));
    });
  }

  remove(id: string): void {
    this.#data.incidents = this.#data.incidents.filter((incident) => incident.id !== id);
    this.#save();
  }

  /** Whether a webhook delivery was already handled (deliveries are at least once). */
  seenWebhook(eventId: string): boolean {
    return this.#data.webhook.seen.includes(eventId);
  }

  recordWebhook(eventId: string): void {
    const webhook = this.#data.webhook;
    if (!webhook.seen.includes(eventId)) webhook.seen.push(eventId);
    if (webhook.seen.length > SEEN_KEPT) webhook.seen.splice(0, webhook.seen.length - SEEN_KEPT);
    webhook.lastAt = new Date().toISOString();
    this.#save();
  }

  get lastWebhookAt(): string | undefined {
    return this.#data.webhook.lastAt;
  }

  #save(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, 100);
    this.#timer.unref?.();
  }

  /** Writes now (atomically: a crash never leaves half a file). */
  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const temporary = `${this.#path}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(this.#data, null, 1));
      renameSync(temporary, this.#path);
    } catch (error) {
      log.error("Couldn't save incidents", { error: (error as Error).message });
    }
  }
}
