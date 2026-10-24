/**
 * The gateway's internal API for the egress proxy (`EGRESS_ROUTES` in the protocol): the proxy announces itself and
 * its CA certificate, follows a server-sent stream of sandbox registrations, authorizes vault uses, and reports
 * blocked attempts. Authenticated with an egress-scoped key (never the platform key, never given to workloads).
 */
import { timingSafeEqual, X509Certificate } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  EGRESS_KEY_HEADER,
  EGRESS_ROUTES,
  ManagedCopilotError,
  type EgressHello,
  type EgressHelloResponse,
  type EgressRegistration,
  type EgressReport,
  type EgressSecretRequest,
} from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import type { Database } from "../../db.js";
import type { RequestContext } from "../../http.js";
import type { Logger } from "../../log.js";
import type { EgressChannel } from "./policy.js";
import { getState, setState } from "./store.js";

const HEARTBEAT_SECONDS = 15;
const CA_STATE_KEY = "egress_ca_certificate";

export interface EgressHubOptions {
  readonly db: Database;
  readonly key: string;
  readonly deployment: string;
  readonly log: Logger;
  /** Lazily bound to the policy service (it needs the hub first). */
  readonly snapshot: () => readonly EgressRegistration[];
  readonly resolveSecret: (request: EgressSecretRequest) => string;
  readonly record: (reports: readonly EgressReport[]) => void;
}

function keyMatches(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== "string" || !header || !expected) return false;
  const left = Buffer.from(header);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class EgressHub implements EgressChannel {
  readonly #options: EgressHubOptions;
  readonly #streams = new Set<ServerResponse>();
  readonly #waiters = new Set<() => void>();
  #hello: (EgressHello & { at: string }) | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #starter: (() => void) | undefined;

  constructor(options: EgressHubOptions) {
    this.#options = options;
  }

  /** Called when a sandbox needs egress before the proxy is connected (the supervisor starts the container). */
  setStarter(starter: () => void): void {
    this.#starter = starter;
  }

  ensureStarted(): void {
    this.#starter?.();
  }

  get ready(): boolean {
    return this.#hello !== undefined && this.#streams.size > 0;
  }

  get status(): { readonly connected: boolean; readonly instanceId?: string; readonly version?: string; readonly since?: string; readonly streams: number } {
    return {
      connected: this.ready,
      ...(this.#hello ? { instanceId: this.#hello.instanceId, version: this.#hello.version, since: this.#hello.at } : {}),
      streams: this.#streams.size,
    };
  }

  caCertificate(): string | undefined {
    return this.#hello?.caCertificate ?? getState(this.#options.db, CA_STATE_KEY);
  }

  waitReady(timeoutMs: number): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(done);
        reject(new ManagedCopilotError("timeout", "The egress proxy did not connect in time"));
      }, timeoutMs);
      this.#waiters.add(done);
    });
  }

  #notifyReady(): void {
    if (!this.ready) return;
    for (const waiter of [...this.#waiters]) waiter();
  }

  #send(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of this.#streams) stream.write(frame);
  }

  upsert(registration: EgressRegistration): void {
    this.#send("upsert", registration);
  }

  remove(sandboxId: string): void {
    this.#send("remove", { sandboxId });
  }

  #authorize(req: IncomingMessage): void {
    if (!keyMatches(req.headers[EGRESS_KEY_HEADER], this.#options.key)) throw new ManagedCopilotError("forbidden", "Egress credential required");
  }

  register(app: GatewayApp): void {
    app.routes.post(
      EGRESS_ROUTES.hello,
      async (ctx: RequestContext) => {
        this.#authorize(ctx.req);
        const body = await ctx.json<Partial<EgressHello>>();
        if (typeof body.instanceId !== "string" || typeof body.version !== "string" || typeof body.caCertificate !== "string") {
          throw new ManagedCopilotError("invalid_request", "hello needs instanceId, version, and caCertificate");
        }
        let certificate: X509Certificate;
        try {
          certificate = new X509Certificate(body.caCertificate);
        } catch {
          throw new ManagedCopilotError("invalid_request", "caCertificate is not a PEM certificate");
        }
        if (!certificate.ca) throw new ManagedCopilotError("invalid_request", "caCertificate is not a CA certificate");
        const previous = getState(this.#options.db, CA_STATE_KEY);
        if (previous && previous !== certificate.toString()) {
          this.#options.log.warn("The egress proxy presented a new CA certificate; running sandboxes keep trusting the old one until they restart", { fingerprint: certificate.fingerprint256 });
        }
        setState(this.#options.db, CA_STATE_KEY, certificate.toString());
        this.#hello = { instanceId: body.instanceId.slice(0, 100), version: body.version.slice(0, 40), caCertificate: certificate.toString(), at: new Date().toISOString() };
        this.#options.log.info("Egress proxy connected", { instanceId: this.#hello.instanceId, version: this.#hello.version, caFingerprint: certificate.fingerprint256 });
        const response: EgressHelloResponse = { deployment: this.#options.deployment, heartbeatSeconds: HEARTBEAT_SECONDS };
        return response;
      },
      { auth: "none" },
    );

    app.routes.get(
      EGRESS_ROUTES.stream,
      (ctx: RequestContext) => {
        this.#authorize(ctx.req);
        const res = ctx.res;
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
        res.write(`event: snapshot\ndata: ${JSON.stringify({ registrations: this.#options.snapshot(), issuedAt: new Date().toISOString() })}\n\n`);
        this.#streams.add(res);
        this.#heartbeat ??= setInterval(() => this.#send("ping", { at: new Date().toISOString() }), HEARTBEAT_SECONDS * 1000);
        this.#heartbeat.unref();
        const cleanup = () => {
          this.#streams.delete(res);
          if (this.#streams.size === 0 && this.#heartbeat) {
            clearInterval(this.#heartbeat);
            this.#heartbeat = undefined;
            this.#options.log.warn("Egress proxy stream disconnected");
          }
        };
        res.once("close", cleanup);
        this.#notifyReady();
        return undefined;
      },
      { auth: "none" },
    );

    app.routes.post(
      EGRESS_ROUTES.secret,
      async (ctx: RequestContext) => {
        this.#authorize(ctx.req);
        const body = await ctx.json<Partial<EgressSecretRequest>>();
        for (const field of ["sandboxId", "credentialId", "placeholder", "host", "header"] as const) {
          if (typeof body[field] !== "string" || !body[field]) throw new ManagedCopilotError("invalid_request", `${field} is required`);
        }
        if (typeof body.port !== "number") throw new ManagedCopilotError("invalid_request", "port is required");
        return { value: this.#options.resolveSecret(body as EgressSecretRequest) };
      },
      { auth: "none" },
    );

    app.routes.post(
      EGRESS_ROUTES.reports,
      async (ctx: RequestContext) => {
        this.#authorize(ctx.req);
        const body = await ctx.json<{ reports?: unknown }>();
        if (!Array.isArray(body.reports) || body.reports.length > 200) throw new ManagedCopilotError("invalid_request", "reports must be a list of at most 200 entries");
        this.#options.record(body.reports.filter((report): report is EgressReport => !!report && typeof report === "object" && typeof (report as EgressReport).reason === "string"));
        return undefined;
      },
      { auth: "none" },
    );
  }

  close(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    for (const stream of this.#streams) stream.end();
    this.#streams.clear();
  }
}
