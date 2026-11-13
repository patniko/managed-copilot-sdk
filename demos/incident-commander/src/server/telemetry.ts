// OpenTelemetry logs in. Services send OTLP/HTTP log exports, JSON-encoded, to `/api/otlp/v1/logs` with the alert
// secret, the same way any OpenTelemetry SDK or Collector exports to a backend. Incident Commander keeps the most recent
// records in memory and streams new ones to every open browser, so people watch a service's real logs arrive while its
// incidents open and resolve. Records are what services say: shown as text, never acted on.
import type { ServerEvent, TelemetryRecord, TelemetrySeverity } from "../shared/types.js";
import { serviceOf } from "./alerts.js";
import { AppError } from "./errors.js";
import type { EventHub } from "./hub.js";
import { log, redact, SECRET_KEYS } from "./log.js";

/** Where services send OTLP/HTTP logs, under the app's address (`<endpoint>/v1/logs`, the OTLP convention). */
export const OTLP_LOGS_PATH = "/api/otlp/v1/logs";
/** A request's body, bytes (after decompression). */
export const MAX_OTLP_BYTES = 4 * 1024 * 1024;
/** Records kept for browsers that open later. */
export const KEEP_RECORDS = 1_000;
/** Records a browser gets when it connects. */
const SNAPSHOT_RECORDS = 300;
const MAX_RECORDS_PER_EXPORT = 5_000;
const MAX_BODY = 2_000;
const MAX_ATTRIBUTES = 40;
const MAX_VALUE = 500;

/** The OTLP/HTTP answer: `ExportLogsServiceResponse`. */
export interface OtlpLogsResponse {
  readonly partialSuccess: { readonly rejectedLogRecords?: number; readonly errorMessage?: string };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function clip(text: string, max: number): string {
  // Control characters out, except newlines and tabs: a body can be a stack trace.
  const cleaned = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** An OTLP `AnyValue` as text: strings as they are, everything else as compact JSON. */
export function anyValueText(value: unknown, depth = 0): string {
  if (!isObject(value)) return "";
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.boolValue === "boolean") return String(value.boolValue);
  if (typeof value.intValue === "string" || typeof value.intValue === "number") return String(value.intValue);
  if (typeof value.doubleValue === "number" || typeof value.doubleValue === "string") return String(value.doubleValue);
  if (typeof value.bytesValue === "string") return value.bytesValue;
  if (depth >= 4) return "…";
  if (isObject(value.arrayValue)) return `[${list(value.arrayValue.values).map((item) => anyValueText(item, depth + 1)).join(", ")}]`;
  if (isObject(value.kvlistValue)) {
    const pairs = list(value.kvlistValue.values).filter(isObject).map((pair) => `${String(pair.key)}: ${anyValueText(pair.value, depth + 1)}`);
    return `{${pairs.join(", ")}}`;
  }
  return "";
}

/** `KeyValue[]` as a record of text, secret-named keys masked and token-shaped values redacted. */
function attributesOf(value: unknown): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const pair of list(value).filter(isObject)) {
    if (Object.keys(attributes).length >= MAX_ATTRIBUTES) break;
    if (typeof pair.key !== "string" || !pair.key) continue;
    const key = clip(pair.key, 100);
    attributes[key] = SECRET_KEYS.test(key) ? "***" : clip(redact(anyValueText(pair.value)), MAX_VALUE);
  }
  return attributes;
}

/** A `fixed64` nanosecond time (a decimal string, or a number) in ms, or undefined for none, zero, or garbage. */
function nanosToMs(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value / 1e6 : undefined;
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) return undefined;
  const ms = Number(BigInt(value) / 1_000_000n);
  return ms > 0 ? ms : undefined;
}

/** OpenTelemetry's severity number ranges (1-4 TRACE … 21-24 FATAL), or its text when there's no number. */
export function severityOf(number: unknown, text: unknown): TelemetrySeverity {
  if (typeof number === "number" && number >= 1 && number <= 24) {
    return (["trace", "debug", "info", "warn", "error", "fatal"] as const)[Math.floor((number - 1) / 4)]!;
  }
  const word = typeof text === "string" ? text.trim().toLowerCase() : "";
  if (word.startsWith("fatal") || word.startsWith("crit") || word.startsWith("emerg")) return "fatal";
  if (word.startsWith("err")) return "error";
  if (word.startsWith("warn")) return "warn";
  if (word.startsWith("debug")) return "debug";
  if (word.startsWith("trace")) return "trace";
  return "info";
}

const HEX_ID = /^[0-9a-f]{32}$/i;

/**
 * The records in an OTLP/HTTP JSON `ExportLogsServiceRequest`, without ids, oldest first as sent. Records past the
 * per-export cap are counted as rejected. Throws `invalid_request` for anything that isn't one.
 */
export function parseOtlpLogs(body: unknown, now = Date.now()): { records: Omit<TelemetryRecord, "id">[]; rejected: number } {
  if (!isObject(body) || !Array.isArray(body.resourceLogs)) {
    throw new AppError("invalid_request", "That isn't an OTLP logs export: send { resourceLogs: [...] }, as an OpenTelemetry log exporter does.");
  }
  const records: Omit<TelemetryRecord, "id">[] = [];
  let rejected = 0;
  for (const resourceLogs of body.resourceLogs.filter(isObject)) {
    const resource = attributesOf(isObject(resourceLogs.resource) ? resourceLogs.resource.attributes : undefined);
    const service = serviceOf({}, resource["service.name"] ?? "unknown_service");
    for (const scopeLogs of list(resourceLogs.scopeLogs).filter(isObject)) {
      for (const logRecord of list(scopeLogs.logRecords).filter(isObject)) {
        if (records.length >= MAX_RECORDS_PER_EXPORT) {
          rejected++;
          continue;
        }
        const attributes = attributesOf(logRecord.attributes);
        // The event name is the record's own field; older SDKs put it in an `event.name` attribute instead.
        const named = typeof logRecord.eventName === "string" && logRecord.eventName ? clip(logRecord.eventName, 100) : undefined;
        const event = named ?? attributes["event.name"];
        if (!named) delete attributes["event.name"];
        const at = nanosToMs(logRecord.timeUnixNano) ?? nanosToMs(logRecord.observedTimeUnixNano) ?? now;
        const traceId = typeof logRecord.traceId === "string" && HEX_ID.test(logRecord.traceId) && !/^0+$/.test(logRecord.traceId) ? logRecord.traceId.toLowerCase() : undefined;
        records.push({
          at: new Date(at).toISOString(),
          service,
          severity: severityOf(logRecord.severityNumber, logRecord.severityText),
          ...(event ? { event } : {}),
          body: clip(redact(anyValueText(logRecord.body)), MAX_BODY),
          attributes,
          ...(traceId ? { traceId } : {}),
        });
      }
    }
  }
  return { records, rejected };
}

/** The recent records, and the stream of new ones to every open browser. */
export class TelemetryFeed {
  readonly #hub: EventHub;
  readonly #keep: number;
  #records: TelemetryRecord[] = [];
  #sequence = 0;
  readonly #services = new Set<string>();

  constructor(hub: EventHub, keep = KEEP_RECORDS) {
    this.#hub = hub;
    this.#keep = keep;
  }

  /** Takes an OTLP/HTTP JSON logs export; answers as OTLP does, counting the records it didn't take. */
  ingest(body: unknown): OtlpLogsResponse {
    const { records, rejected } = parseOtlpLogs(body);
    const added = records.map((record) => ({ id: `t${++this.#sequence}`, ...record }));
    for (const record of added) {
      if (this.#services.has(record.service)) continue;
      this.#services.add(record.service);
      log.info("Receiving OpenTelemetry logs", { service: record.service });
    }
    if (added.length) {
      this.#records.push(...added);
      if (this.#records.length > this.#keep) this.#records.splice(0, this.#records.length - this.#keep);
      this.#hub.publish({ type: "telemetry", records: added.slice(-SNAPSHOT_RECORDS) });
    }
    return { partialSuccess: rejected ? { rejectedLogRecords: rejected, errorMessage: `Send at most ${MAX_RECORDS_PER_EXPORT} log records per export.` } : {} };
  }

  /** The recent records, oldest first; only one service's with `service`. */
  recent(service?: string, limit = this.#keep): TelemetryRecord[] {
    const records = service ? this.#records.filter((record) => record.service === service) : this.#records;
    return records.slice(-limit);
  }

  /** What a browser gets when it connects: the recent records, replacing whatever it had. */
  snapshot(): ServerEvent {
    return { type: "telemetry", records: this.recent(undefined, SNAPSHOT_RECORDS), reset: true };
  }
}
