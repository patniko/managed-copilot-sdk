// Alerts from monitoring tools: Prometheus Alertmanager and Grafana webhooks (the same JSON shape), or a small generic
// JSON object for anything else. Every alert must carry the shared secret (INCIDENT_ALERT_SECRET).
import { createHash, timingSafeEqual } from "node:crypto";
import type { AlertInfo, AlertLink, AlertSource, Severity } from "../shared/types.js";
import { AppError } from "./errors.js";

export interface IncomingAlert {
  readonly status: "firing" | "resolved";
  readonly alert: AlertInfo;
}

const MAX_ALERTS = 20;
const MAX_TEXT = 2_000;
const MAX_LABELS = 40;
/** How the generic shape says an alert stopped firing. */
const RESOLVED = /^(resolved|ok|recovered|closed)$/i;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Plain text: control characters removed, whitespace collapsed, length bounded. */
function text(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const cleaned = String(value)
    .replace(/\p{Cc}/gu, (char) => (char === "\n" ? "\n" : ""))
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  const record: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value).slice(0, MAX_LABELS)) {
    const name = text(key, 100);
    const entry = text(raw, 500);
    if (name && entry) record[name] = entry;
  }
  return record;
}

function link(title: string, value: unknown): AlertLink[] {
  const url = text(value, 1_000);
  if (!url) return [];
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? [{ title, url: parsed.toString() }] : [];
  } catch {
    return [];
  }
}

function timestamp(value: unknown, fallback: Date): string {
  const raw = text(value, 100);
  const ms = raw ? Date.parse(raw) : NaN;
  // Alertmanager sends the zero time for alerts that haven't ended.
  return Number.isFinite(ms) && ms > Date.UTC(2000, 0, 1) ? new Date(ms).toISOString() : fallback.toISOString();
}

/** Maps the many ways tools name severity onto SEV1 (worst) to SEV4. Unknown or missing is SEV3. */
export function severityOf(value: string | undefined): Severity {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (/^(sev|p)?1$|^(critical|crit|page|emergency|fatal|disaster)$/.test(normalized)) return "SEV1";
  if (/^(sev|p)?2$|^(high|major|error|err|severe)$/.test(normalized)) return "SEV2";
  if (/^(sev|p)?4$|^(info|informational|low|none|ok)$/.test(normalized)) return "SEV4";
  return "SEV3";
}

/** The service an alert is about, from the labels tools commonly use for it. */
export function serviceOf(labels: Readonly<Record<string, string>>, fallback?: string): string {
  const name = labels.service ?? labels.app ?? labels.application ?? labels.component ?? labels.job ?? fallback;
  const normalized = name
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 60);
  return normalized || "unknown";
}

function fingerprintOf(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

function labelFingerprint(name: string, labels: Readonly<Record<string, string>>): string {
  return fingerprintOf([name, ...Object.keys(labels).sort().map((key) => `${key}=${labels[key]}`)]);
}

/** One alert of an Alertmanager or Grafana notification. */
function fromAlertmanager(item: Json, body: Json, source: AlertSource, now: Date): IncomingAlert {
  const labels = { ...stringRecord(body.commonLabels), ...stringRecord(item.labels) };
  const annotations = { ...stringRecord(body.commonAnnotations), ...stringRecord(item.annotations) };
  const name = labels.alertname ?? text(body.title, 200) ?? "Alert";
  const summary = annotations.summary ?? annotations.message ?? annotations.description ?? text(body.title) ?? name;
  const description = annotations.description && annotations.description !== summary ? annotations.description : undefined;
  const resolved = (text(item.status, 20) ?? text(body.status, 20)) === "resolved";
  return {
    status: resolved ? "resolved" : "firing",
    alert: {
      source,
      name,
      summary,
      ...(description ? { description } : {}),
      service: serviceOf(labels),
      severity: severityOf(labels.severity ?? labels.priority),
      labels,
      startsAt: timestamp(item.startsAt, now),
      fingerprint: text(item.fingerprint, 100) ?? labelFingerprint(name, labels),
      links: [
        ...link("Runbook", annotations.runbook_url ?? annotations.runbook),
        ...link("Dashboard", item.dashboardURL),
        ...link("Panel", item.panelURL),
        ...link("Source", item.generatorURL),
      ],
      ...(resolved ? { resolvedAt: timestamp(item.endsAt, now) } : {}),
    },
  };
}

/** `{ title, summary, service, severity, status, id, labels, url }`: the shape for tools without a built-in format. */
function fromGeneric(item: Json, now: Date): IncomingAlert {
  const labels = stringRecord(item.labels);
  const name = text(item.title, 200) ?? text(item.name, 200) ?? text(item.alert, 200) ?? labels.alertname ?? "Alert";
  const summary = text(item.summary) ?? text(item.message) ?? text(item.description) ?? name;
  const description = text(item.description);
  const service = serviceOf(labels, text(item.service, 100));
  const resolved = RESOLVED.test(text(item.status, 20) ?? "");
  return {
    status: resolved ? "resolved" : "firing",
    alert: {
      source: "generic",
      name,
      summary,
      ...(description && description !== summary ? { description } : {}),
      service,
      severity: severityOf(text(item.severity, 40) ?? labels.severity),
      labels: { ...labels, ...(labels.service ? {} : { service }) },
      startsAt: timestamp(item.startsAt ?? item.timestamp, now),
      fingerprint: text(item.id, 100) ?? text(item.fingerprint, 100) ?? text(item.key, 100) ?? fingerprintOf([name, service]),
      links: [...link("Runbook", item.runbook ?? item.runbook_url), ...link("Source", item.url ?? item.link)],
      ...(resolved ? { resolvedAt: timestamp(item.endsAt ?? item.resolvedAt, now) } : {}),
    },
  };
}

/** The alerts in a notification. Throws `invalid_request` for anything that isn't an alert. */
export function parseAlertPayload(body: unknown, now = new Date()): IncomingAlert[] {
  if (!isObject(body)) throw new AppError("invalid_request", "Send the alert as a JSON object.");
  if (Array.isArray(body.alerts)) {
    const items = body.alerts.filter(isObject);
    if (items.length === 0) throw new AppError("invalid_request", "The notification has no alerts.");
    if (items.length > MAX_ALERTS) throw new AppError("invalid_request", `Send at most ${MAX_ALERTS} alerts at a time.`);
    const grafana = body.orgId !== undefined || items.some((item) => item.dashboardURL !== undefined || item.panelURL !== undefined);
    return items.map((item) => (isObject(item.labels) || isObject(item.annotations) ? fromAlertmanager(item, body, grafana ? "grafana" : "alertmanager", now) : fromGeneric(item, now)));
  }
  const named = text(body.title) ?? text(body.name) ?? text(body.alert) ?? text(body.summary);
  // A resolved notification needs no title: its ID names the alert it resolves.
  const resolvesById = RESOLVED.test(text(body.status, 20) ?? "") && (text(body.id, 100) ?? text(body.fingerprint, 100) ?? text(body.key, 100)) !== undefined;
  if (named || resolvesById) return [fromGeneric(body, now)];
  throw new AppError("invalid_request", "That isn't an alert: send an Alertmanager or Grafana notification, or { title, service, severity, summary }.");
}

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** Whether an `Authorization` header carries the secret: `Bearer <secret>`, or Basic auth with it as the password. */
export function authorized(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const [scheme, value = ""] = header.trim().split(/\s+/, 2);
  let presented: string | undefined;
  if (/^bearer$/i.test(scheme ?? "")) presented = value;
  else if (/^basic$/i.test(scheme ?? "")) {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    presented = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded;
  }
  return presented !== undefined && presented.length > 0 && timingSafeEqual(digest(presented), digest(secret));
}
