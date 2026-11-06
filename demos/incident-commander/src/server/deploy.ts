// Where an approved fix goes. The bundled demo service has a simulated production (labeled "Demo" in the UI); your own
// services go to your deploy pipeline: a signed POST to INCIDENT_DEPLOY_URL (GitHub Actions, Argo, Jenkins, ...).
import { createHmac } from "node:crypto";
import type { DeployTarget } from "./config.js";

export interface DeployRequest {
  readonly incident: string;
  readonly service: string;
  /** What runs in production now. */
  readonly version?: string;
  readonly summary: string;
  readonly tests?: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  /** The tool call's idempotency key: the same deploy sent twice is one deploy. */
  readonly idempotencyKey: string;
}

export interface DeployOutcome {
  readonly ok: boolean;
  readonly target: "demo" | "webhook";
  readonly version?: string;
  readonly previousVersion?: string;
  readonly message: string;
}

export const DEPLOY_SIGNATURE_HEADER = "x-incident-commander-signature";

/** The next patch version: `1.4.2` → `1.4.3`. */
export function nextVersion(version: string | undefined): string | undefined {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : undefined;
}

/** The demo service's production: the release is recorded here, and its simulated monitoring sees the fix. */
export function deployDemo(request: DeployRequest): DeployOutcome {
  const version = nextVersion(request.version);
  return {
    ok: true,
    target: "demo",
    ...(version ? { version } : {}),
    ...(request.version ? { previousVersion: request.version } : {}),
    message: `Released ${request.service}${version ? ` v${version}` : ""} to the demo's production. Its 5xx rate is back to 0%.`,
  };
}

/** `t=<seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, the scheme Managed Copilot signs its own webhooks with. */
export function signature(secret: string, body: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.`).update(body).digest("hex")}`;
}

/** POSTs the approved release to your deploy pipeline and reports its answer. Never retried blindly: it may have deployed. */
export async function deployWebhook(target: DeployTarget, request: DeployRequest, fetchImpl: typeof fetch = fetch): Promise<DeployOutcome> {
  const version = nextVersion(request.version);
  const body = JSON.stringify({
    type: "incident.deploy_approved",
    incident: request.incident,
    service: request.service,
    ...(version ? { version } : {}),
    ...(request.version ? { previousVersion: request.version } : {}),
    summary: request.summary,
    ...(request.tests ? { tests: request.tests } : {}),
    ...(request.approvedBy ? { approvedBy: request.approvedBy } : {}),
    ...(request.approvedAt ? { approvedAt: request.approvedAt } : {}),
    files: request.files,
  });
  const base = { target: "webhook" as const, ...(request.version ? { previousVersion: request.version } : {}) };
  let response: Response;
  try {
    response = await fetchImpl(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": request.idempotencyKey,
        ...(target.secret ? { [DEPLOY_SIGNATURE_HEADER]: signature(target.secret, body) } : {}),
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { ...base, ok: false, message: `Couldn't reach your deploy pipeline: ${(error as Error).message}. It may not have deployed; check it before trying again.` };
  }
  const answer = (await response.json().catch(() => ({}))) as { version?: unknown; message?: unknown };
  const reported = typeof answer.version === "string" ? answer.version : version;
  const said = typeof answer.message === "string" ? ` ${answer.message.slice(0, 300)}` : "";
  if (!response.ok) return { ...base, ok: false, message: `Your deploy pipeline refused the release (HTTP ${response.status}).${said}` };
  return { ...base, ok: true, ...(reported ? { version: reported } : {}), message: `Your deploy pipeline accepted ${request.service}${reported ? ` v${reported}` : ""}.${said}` };
}
