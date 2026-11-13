// Gates: steps after a routed work order's release that wait for a person in the factory while the routing app does the
// work. A `deploy` gate is declared with the work order, opened by the routing app with its deploy request, decided by a
// person on the floor, and closed by the routing app's report of how the deploy went. The factory never deploys: the
// routing app keeps its credentials and polls the work order for the decision.
import type {
  GateDeclaration,
  GateDecisionRequest,
  GateOutcomeRequest,
  GateRequest,
  WorkOrderGate,
} from "../../shared/types.js";
import { StationError } from "./errors.js";

const invalid = (message: string): StationError => new StationError("invalid_request", message);
const conflict = (message: string): StationError => new StationError("conflict", message);

const KINDS = new Set(["deploy"]);
const VERSION = /^v?\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]{1,40})?$/;

function text(value: unknown, field: string, max: number, required: true): string;
function text(value: unknown, field: string, max: number, required?: false): string | undefined;
function text(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw invalid(`${field} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw invalid(`${field} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid(`${field} can be at most ${max} characters.`);
  if (!trimmed && required) throw invalid(`${field} is required.`);
  return trimmed || undefined;
}

function version(value: unknown, field: string): string | undefined {
  const raw = text(value, field, 60);
  if (raw === undefined) return undefined;
  if (!VERSION.test(raw)) throw invalid(`${field} must be a version such as 2.3.1.`);
  return raw.replace(/^v/, "");
}

function link(value: unknown, field: string): string | undefined {
  const raw = text(value, field, 2000);
  if (raw === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalid(`${field} must be an http or https URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw invalid(`${field} must be an http or https URL.`);
  return parsed.href;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(message);
  return value as Record<string, unknown>;
}

/** `<version>` as people read it: `v2.3.1`. */
export const shownVersion = (value: string | undefined): string => (value ? ` v${value}` : "");

/** Validates a work order's declared gates: one per kind, and only for work orders another app routed here. */
export function parseGateDeclarations(value: unknown, routed: boolean, at: string): WorkOrderGate[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid('gates must be a list like [{ "kind": "deploy", "target": "downhill-shop" }].');
  if (value.length === 0) return [];
  if (!routed) throw invalid("Gates need an origin: the app that opens them with its request and does the work once a person decides.");
  const gates: WorkOrderGate[] = [];
  for (const [index, item] of value.entries()) {
    const input = object(item, `gates[${index}] must be an object like { "kind": "deploy", "target": "downhill-shop" }.`);
    if (!KINDS.has(input.kind as string)) throw invalid(`gates[${index}].kind must be "deploy".`);
    const kind = input.kind as GateDeclaration["kind"];
    if (gates.some((gate) => gate.kind === kind)) throw invalid(`A work order takes one ${kind} gate.`);
    const target = text(input.target, `gates[${index}].target`, 100, true);
    const label = text(input.label, `gates[${index}].label`, 80) ?? `Deploy ${target}`;
    gates.push({ id: kind, kind, target, label, state: "pending", updatedAt: at });
  }
  return gates;
}

/** `POST …/gates/:gateId/request`, validated. */
export function parseOpenGate(value: unknown, gate: WorkOrderGate, at: string): GateRequest {
  const input = object(value, "Send the deploy request as a JSON object with requestId, title, and summary.");
  const files = input.files;
  if (files !== undefined && files !== null && (!Array.isArray(files) || files.length > 100 || files.some((file) => typeof file !== "string" || file.length > 300))) {
    throw invalid("files must be a list of at most 100 paths.");
  }
  const requestVersion = version(input.version, "version");
  const previousVersion = version(input.previousVersion, "previousVersion");
  const tests = text(input.tests, "tests", 300);
  const url = link(input.url, "url");
  return {
    requestId: text(input.requestId, "requestId", 200, true),
    title: text(input.title, "title", 120, true),
    summary: text(input.summary, "summary", 2000, true),
    target: text(input.target, "target", 100) ?? gate.target,
    ...(requestVersion ? { version: requestVersion } : {}),
    ...(previousVersion ? { previousVersion } : {}),
    ...(tests ? { tests } : {}),
    ...(Array.isArray(files) && files.length ? { files: files as string[] } : {}),
    ...(url ? { url } : {}),
    requestedAt: at,
  };
}

/**
 * The gate with the routing app's request: it waits for a person. The same request again changes nothing (the routing
 * app retries after a restart); a new one replaces an earlier request that was declined, closed, or ran its course.
 */
export function openGate(gate: WorkOrderGate, request: GateRequest, at: string): WorkOrderGate {
  if (gate.request?.requestId === request.requestId) return gate;
  if (gate.state === "approved") throw conflict(`${gate.label} was approved and is deploying: report how it went before asking again.`);
  return { id: gate.id, kind: gate.kind, target: gate.target, label: gate.label, state: "open", request, updatedAt: at };
}

/** `POST …/gates/:gateId/decision`, validated. */
export function parseDecision(value: unknown): GateDecisionRequest {
  const input = object(value, "Send the decision as a JSON object: { approve: true } or { approve: false, reason }.");
  if (typeof input.approve !== "boolean") throw invalid("Pass approve: true or false.");
  const reason = text(input.reason, "reason", 500);
  const requestId = text(input.requestId, "requestId", 200);
  return { approve: input.approve, ...(reason ? { reason } : {}), ...(requestId ? { requestId } : {}) };
}

/** A person's decision on an open gate. */
export function decideGate(gate: WorkOrderGate, decision: GateDecisionRequest, by: string | undefined, at: string): WorkOrderGate {
  const request = gate.request;
  if (gate.state !== "open" || !request) {
    throw conflict(gate.state === "pending" ? `${gate.label} has no request to decide yet.` : `This deploy request was already answered (${gate.state}).`);
  }
  if (decision.requestId && decision.requestId !== request.requestId) throw conflict("This deploy request was replaced by a newer one. Reload to see it.");
  return {
    ...gate,
    state: decision.approve ? "approved" : "declined",
    decision: {
      requestId: request.requestId,
      approve: decision.approve,
      ...(!decision.approve && decision.reason ? { reason: decision.reason } : {}),
      ...(by ? { by } : {}),
      at,
    },
    updatedAt: at,
  };
}

const OUTCOMES = new Set(["deployed", "failed", "closed"]);

/** `POST …/gates/:gateId/outcome`, validated. */
export function parseOutcome(value: unknown): GateOutcomeRequest {
  const input = object(value, 'Send the outcome as a JSON object: { requestId, outcome: "deployed" | "failed" | "closed", message }.');
  if (!OUTCOMES.has(input.outcome as string)) throw invalid('Pass outcome: "deployed", "failed", or "closed".');
  const message = text(input.message, "message", 1000);
  const deployed = version(input.version, "version");
  return {
    requestId: text(input.requestId, "requestId", 200, true),
    outcome: input.outcome as GateOutcomeRequest["outcome"],
    ...(message ? { message } : {}),
    ...(deployed ? { version: deployed } : {}),
  };
}

/**
 * What the routing app reports: how an approved deploy went, or that the request was answered elsewhere or ended. The
 * routing app's word is final: a gate decided here can still be closed when the routing app answered first (a person
 * there, at the same time) or its request ended, so the gate never claims a deploy that isn't coming. Reporting the
 * same outcome again changes nothing.
 */
export function reportGate(gate: WorkOrderGate, report: GateOutcomeRequest, at: string): WorkOrderGate {
  if (!gate.request || gate.request.requestId !== report.requestId) throw conflict("That isn't the deploy request this gate shows.");
  if (gate.state === report.outcome) return gate;
  if (report.outcome === "closed") {
    if (gate.state !== "open" && gate.state !== "approved" && gate.state !== "declined") throw conflict(`This deploy request already ran its course here (${gate.state}).`);
  } else if (gate.state !== "approved") {
    throw conflict(gate.state === "open" ? "Nobody approved this deploy request yet." : `This deploy request is ${gate.state}; only an approved deploy has an outcome.`);
  }
  return {
    ...gate,
    state: report.outcome,
    outcome: { outcome: report.outcome, ...(report.message ? { message: report.message } : {}), ...(report.version ? { version: report.version } : {}), at },
    updatedAt: at,
  };
}

/** One line for the activity stream about what just happened to a gate. */
export function gateActivity(gate: WorkOrderGate, originName: string): { readonly text: string; readonly level: "info" | "success" | "warning" | "error" } {
  const request = gate.request;
  const what = `${request?.target ?? gate.target}${shownVersion(request?.version)}`;
  switch (gate.state) {
    case "open":
      return { text: `${originName} asks to deploy ${what}: ${request?.title ?? gate.label}`, level: "warning" };
    case "approved":
      return { text: `${gate.decision?.by ? `@${gate.decision.by}` : "Someone"} approved deploying ${what}; ${originName} deploys it`, level: "success" };
    case "declined":
      return { text: `${gate.decision?.by ? `@${gate.decision.by}` : "Someone"} declined deploying ${what}${gate.decision?.reason ? `: ${gate.decision.reason}` : ""}`, level: "warning" };
    case "deployed":
      return { text: `${originName} deployed ${request?.target ?? gate.target}${shownVersion(gate.outcome?.version ?? request?.version)}`, level: "success" };
    case "failed":
      return { text: `${originName}'s deploy of ${what} failed${gate.outcome?.message ? `: ${gate.outcome.message}` : ""}`, level: "error" };
    case "closed":
      return { text: `${originName} closed the deploy request${gate.outcome?.message ? `: ${gate.outcome.message}` : ""}`, level: "info" };
    default:
      return { text: `${gate.label} waits for ${originName}'s deploy request`, level: "info" };
  }
}
