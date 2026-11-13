// OpenTelemetry for Downhill's server. Its own log lines, the shop's checkouts, and what players do in the game become
// OpenTelemetry log records (the stock logs SDK), serialized as OTLP JSON by OpenTelemetry's own serializer and sent over
// OTLP/HTTP to Incident Commander's `/api/otlp/v1/logs`, with its alert secret as a bearer token. Incident Commander
// streams them live, next to the incidents they cause. Without INCIDENT_URL and INCIDENT_ALERT_SECRET, nothing is sent.
import { SeverityNumber, type AttributeValue } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { JsonLogsSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider, type LogRecordExporter, type ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { SERVICE_NAME } from "./deploys.js";
import { log, setLogSink, type Level } from "./log.js";

export const TELEMETRY_OFF = "Telemetry is off: set INCIDENT_URL and INCIDENT_ALERT_SECRET to stream Downhill's logs to Incident Commander over OpenTelemetry.";

/** Where Incident Commander takes OTLP/HTTP logs, under its address. */
export const OTLP_LOGS_PATH = "/api/otlp/v1/logs";

export type TelemetryAttributes = Readonly<Record<string, string | number | boolean | undefined>>;

/** One thing that happened, as a log record. */
export interface TelemetryRecord {
  /** The event's name, such as `shop.promo_rejected` or `ride.trick`. Plain log lines have none. */
  readonly name?: string;
  readonly level: Level;
  /** What happened, in a sentence. */
  readonly message: string;
  readonly attributes?: TelemetryAttributes;
  /** When it happened, ms since the epoch (defaults to now). */
  readonly at?: number;
}

export interface TelemetryStatus {
  readonly configured: boolean;
  /** Where records go (Incident Commander's OTLP logs endpoint), or why they don't. */
  readonly endpoint?: string;
  readonly message?: string;
}

export interface Telemetry {
  readonly configured: boolean;
  status(): TelemetryStatus;
  emit(record: TelemetryRecord): void;
  /** Sends what's buffered now. */
  flush(): Promise<void>;
  /** Sends what's buffered and stops; the log sink is removed. */
  shutdown(): Promise<void>;
}

export interface TelemetryOptions {
  /** Incident Commander's address (`INCIDENT_URL`). */
  readonly incidentUrl?: string;
  /** Its alert secret (`INCIDENT_ALERT_SECRET`), sent as the bearer token. */
  readonly secret?: string;
  /** The game's version, for the resource. */
  readonly version: string;
  /** Replaces the OTLP exporter (tests). */
  readonly exporter?: LogRecordExporter;
  /** How long records wait to be batched, ms. */
  readonly delayMs?: number;
  /** Also export this server's own log lines (default true). */
  readonly bridgeLog?: boolean;
}

const SEVERITY: Readonly<Record<Level, SeverityNumber>> = { debug: SeverityNumber.DEBUG, info: SeverityNumber.INFO, warn: SeverityNumber.WARN, error: SeverityNumber.ERROR };
const EXPORT_TIMEOUT_MS = 10_000;

const failed = (message: string): ExportResult => ({ code: ExportResultCode.FAILED, error: new Error(message) });

/**
 * OTLP/HTTP with JSON, to one URL with exactly the headers given. OpenTelemetry's OTLP/HTTP exporter would add
 * OTEL_EXPORTER_OTLP_HEADERS from the environment to every request, and Aspire puts its dashboard's API key there: a
 * key that isn't Incident Commander's to see. The body is OpenTelemetry's own JSON serialization, as that exporter's.
 */
export class OtlpJsonLogExporter implements LogRecordExporter {
  readonly #pending = new Set<Promise<void>>();
  #stopped = false;

  constructor(
    private readonly url: string,
    private readonly headers: Readonly<Record<string, string>>,
  ) {}

  export(records: ReadableLogRecord[], done: (result: ExportResult) => void): void {
    if (this.#stopped) return done(failed("the exporter is shut down"));
    const body = JsonLogsSerializer.serializeRequest(records);
    if (!body) return done(failed("the records couldn't be serialized"));
    const sent = fetch(this.url, { method: "POST", headers: { ...this.headers, "content-type": "application/json" }, body, signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS) })
      .then(
        async (response): Promise<ExportResult> => {
          if (response.ok) {
            await response.body?.cancel();
            return { code: ExportResultCode.SUCCESS };
          }
          const said = await response
            .json()
            .then((answer) => {
              const message = (answer as { error?: { message?: unknown } } | null)?.error?.message;
              return typeof message === "string" ? message : undefined;
            })
            .catch(() => undefined);
          return failed(`it answered HTTP ${response.status}${said ? ` (${said})` : ""}`);
        },
        (error: Error & { cause?: { code?: string } }) =>
          failed(error.name === "TimeoutError" ? "it didn't answer within 10 seconds" : `it isn't reachable (${error.cause?.code ?? error.message})`),
      )
      .then(done);
    this.#pending.add(sent);
    void sent.finally(() => this.#pending.delete(sent));
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.#pending);
  }

  async shutdown(): Promise<void> {
    this.#stopped = true;
    await this.forceFlush();
  }
}

/** Says once, in plain words, when records stop reaching Incident Commander, and once when they reach it again. */
class ReportingExporter implements LogRecordExporter {
  #failing = false;

  constructor(
    private readonly inner: LogRecordExporter,
    private readonly endpoint: string,
  ) {}

  export(records: ReadableLogRecord[], done: (result: ExportResult) => void): void {
    this.inner.export(records, (result) => {
      if (result.code === ExportResultCode.SUCCESS) {
        if (this.#failing) log.local.info("Telemetry reaches Incident Commander again", { endpoint: this.endpoint });
        this.#failing = false;
      } else if (!this.#failing) {
        this.#failing = true;
        log.local.warn(
          `Couldn't send telemetry to Incident Commander: ${result.error?.message ?? "it didn't answer"}. The game keeps working; the next records try again.`,
          { endpoint: this.endpoint },
        );
      }
      done(result);
    });
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/** Sends nothing: telemetry isn't configured (and the default for tests). */
export const NO_TELEMETRY: Telemetry = {
  configured: false,
  status: () => ({ configured: false, message: TELEMETRY_OFF }),
  emit: () => undefined,
  flush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

function attributesOf(attributes: TelemetryAttributes | undefined): Record<string, AttributeValue> {
  const result: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) if (value !== undefined) result[key] = value;
  return result;
}

/** The OpenTelemetry pipeline to Incident Commander, or one that sends nothing when it isn't configured. */
export function createTelemetry(options: TelemetryOptions): Telemetry {
  const base = options.incidentUrl?.replace(/\/+$/, "");
  if (!options.exporter && (!base || !options.secret)) return NO_TELEMETRY;
  const endpoint = base ? `${base}${OTLP_LOGS_PATH}` : "(test exporter)";
  const exporter = options.exporter ?? new OtlpJsonLogExporter(endpoint, { authorization: `Bearer ${options.secret}` });
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ "service.name": SERVICE_NAME, "service.namespace": "contoso-outdoors", "service.version": options.version }),
    processors: [new BatchLogRecordProcessor({ exporter: new ReportingExporter(exporter, endpoint), scheduledDelayMillis: options.delayMs ?? 500 })],
  });
  const logger = provider.getLogger("downhill", options.version);
  const emit = (record: TelemetryRecord): void => {
    logger.emit({
      ...(record.name ? { eventName: record.name } : {}),
      timestamp: record.at ?? Date.now(),
      severityNumber: SEVERITY[record.level],
      severityText: record.level.toUpperCase(),
      body: record.message,
      attributes: attributesOf(record.attributes),
    });
  };
  if (options.bridgeLog !== false) {
    // A log line's `event` field names it (`alert.fired`, `deploy.completed`); the rest are its attributes.
    setLogSink((level, message, { event, ...fields }) => emit({ ...(event ? { name: event } : {}), level, message, attributes: fields }));
  }
  let stopped = false;
  return {
    configured: true,
    status: () => ({ configured: true, endpoint }),
    emit: (record) => {
      if (!stopped) emit(record);
    },
    flush: () => provider.forceFlush(),
    shutdown: async () => {
      if (stopped) return;
      stopped = true;
      if (options.bridgeLog !== false) setLogSink(undefined);
      await provider.shutdown();
    },
  };
}
