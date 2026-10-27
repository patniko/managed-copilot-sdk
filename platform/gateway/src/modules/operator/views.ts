// Composes the operator API's answers from every module's operator views: health and attention items, the overview,
// infrastructure, and a session's detail across modules. Accounts are attached here (modules keep owner IDs).
import {
  ManagedCopilotError,
  sandboxedType,
  type AccountInfo,
  type ActionState,
  type AttentionItem,
  type ComponentHealth,
  type EgressStatus,
  type OperatorAccount,
  type OperatorAction,
  type OperatorConnections,
  type OperatorEgressBlock,
  type OperatorInfrastructure,
  type OperatorOverview,
  type OperatorPromotion,
  type OperatorSandbox,
  type OperatorSchedule,
  type OperatorScheduleRuns,
  type OperatorSessionDetail,
  type OperatorWebhookDeliveryState,
  type OperatorWebhooks,
  type SandboxBackendStatus,
  type SandboxState,
  type SchedulerStatus,
  type SharedRuntimeStatus,
  type TrafficCounter,
  type TrafficSeries,
  type WebhookWorkerStatus,
} from "@managed-copilot/protocol";
import type { GatewayApp } from "../../app.js";
import { redactPath, redactText } from "../../redaction.js";
import type { CoreOperator } from "../core/operator.js";
import type { ScheduleOperatorRecord } from "../durable/schedules/service.js";
import type { OperatorAccess } from "./access.js";
import { operatorPorts, type OperatorPorts } from "./contract.js";

const TRAFFIC_COUNTERS: readonly TrafficCounter[] = [
  "http.requests",
  "http.errors",
  "rpc.requests",
  "rpc.notifications",
  "connections.opened",
  "sessions.created",
  "events.published",
  "inference.requests",
];
const OPEN_ACTION_STATES: readonly ActionState[] = ["pending", "claimed", "executing", "needs_reconciliation"];
/** Event-loop delay (p99, ms) above which the gateway reports itself degraded. */
const SLOW_EVENT_LOOP_MS = 250;
const LARGE_WAL_BYTES = 512 * 1024 * 1024;

const plural = (count: number, noun: string, nouns = `${noun}s`) => `${count} ${count === 1 ? noun : nouns}`;

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

export class OperatorViews {
  readonly #app: GatewayApp;
  readonly #access: OperatorAccess;

  constructor(options: { readonly app: GatewayApp; readonly access: OperatorAccess }) {
    this.#app = options.app;
    this.#access = options.access;
  }

  get #core(): CoreOperator {
    return this.#app.service("coreOperator");
  }

  get #ports(): OperatorPorts {
    return operatorPorts(this.#app.services);
  }

  /** What the declared environments need: the shared runtime, and sandboxes (with egress). */
  get #needs(): { shared: boolean; sandboxes: boolean } {
    const deployment = this.#app.config.deployment;
    const types = [...Object.values(deployment.environments).map((environment) => environment.type), ...(deployment.inline?.types ?? [])];
    return { shared: types.some((type) => type !== "isolated"), sandboxes: types.some((type) => sandboxedType(type)) };
  }

  // --- Infrastructure and health --------------------------------------------------------------------------------

  async infrastructure(): Promise<OperatorInfrastructure> {
    const core = this.#core;
    const ports = this.#ports;
    const sandboxes: SandboxBackendStatus = (await ports.sandboxes?.operatorStatus?.()) ?? { available: false, facts: [], counts: {} };
    const egress = ports.policy?.operatorEgress?.();
    const scheduler = ports.schedules?.schedulerStatus?.();
    const webhooks = ports.webhooks?.operatorStatus?.();
    const runtime = core.runtime();
    const storage = core.storage();
    const gateway = {
      ...core.gateway(),
      operators: { githubUsers: this.#access.rules.githubUsers, githubOrgs: this.#access.rules.githubOrgs, localDefault: this.#access.localDefault },
    };
    const health = this.#health({ gateway, runtime, sandboxes, egress, scheduler, webhooks, storage });
    return {
      gateway,
      runtime,
      sandboxes,
      ...(egress ? { egress } : {}),
      ...(scheduler ? { scheduler } : {}),
      ...(webhooks ? { webhooks } : {}),
      storage,
      health,
      generatedAt: new Date().toISOString(),
    };
  }

  #health(input: {
    gateway: OperatorInfrastructure["gateway"];
    runtime: SharedRuntimeStatus;
    sandboxes: SandboxBackendStatus;
    egress: EgressStatus | undefined;
    scheduler: SchedulerStatus | undefined;
    webhooks: WebhookWorkerStatus | undefined;
    storage: OperatorInfrastructure["storage"];
  }): ComponentHealth[] {
    const needs = this.#needs;
    const { gateway, runtime, sandboxes, egress, scheduler, webhooks, storage } = input;
    const health: ComponentHealth[] = [];

    const slow = gateway.eventLoopDelayMs.p99 > SLOW_EVENT_LOOP_MS;
    health.push({
      id: "gateway",
      name: "Gateway",
      status: slow ? "degraded" : "healthy",
      summary: `v${gateway.version} · ${gateway.mode} · up ${duration(gateway.uptimeSeconds)}`,
      ...(slow ? { detail: `The event loop is slow (p99 ${gateway.eventLoopDelayMs.p99} ms): the gateway is overloaded or something blocks it.` } : {}),
      since: gateway.startedAt,
    });

    const runtimeName = "Shared runtime";
    switch (runtime.state) {
      case "running":
        health.push({ id: "runtime", name: runtimeName, status: "healthy", summary: `Running · runtime ${runtime.version ?? "?"} · ${plural(runtime.sessions, "session")} open`, ...(runtime.connectedAt ? { since: runtime.connectedAt } : {}) });
        break;
      case "starting":
        health.push({ id: "runtime", name: runtimeName, status: "degraded", summary: "Starting" });
        break;
      case "restarting":
        health.push({ id: "runtime", name: runtimeName, status: "degraded", summary: `Restarting (${plural(runtime.restarts, "restart")} so far)`, ...(runtime.lastError ? { detail: `Last error: ${runtime.lastError}` } : {}) });
        break;
      case "disabled":
        health.push({
          id: "runtime",
          name: runtimeName,
          status: needs.shared ? "unavailable" : "disabled",
          summary: "Off (MANAGED_COPILOT_SHARED_RUNTIME=0)",
          ...(needs.shared ? { detail: "Shared and promotable environments are declared, but their sessions cannot run without the shared runtime." } : {}),
        });
        break;
      default:
        health.push({
          id: "runtime",
          name: runtimeName,
          status: needs.shared ? "unavailable" : "disabled",
          summary: runtime.state === "failed" ? "Failed to start" : "Stopped",
          detail: `${runtime.lastError ? `${runtime.lastError}. ` : ""}Shared sessions fail with capability_unavailable until it runs.`,
        });
    }

    const sandboxName = "Sandbox backend";
    if (!sandboxes.provider) health.push({ id: "sandboxes", name: sandboxName, status: "disabled", summary: "No sandbox module" });
    else if (!needs.sandboxes) health.push({ id: "sandboxes", name: sandboxName, status: "disabled", summary: `${sandboxes.provider} · no isolated or promotable environments` });
    else if (sandboxes.available) {
      health.push({
        id: "sandboxes",
        name: sandboxName,
        status: "healthy",
        summary: `${sandboxes.provider} · ${plural(sandboxes.counts.running ?? 0, "sandbox", "sandboxes")} running · ${sandboxes.counts.stopped ?? 0} stopped`,
        ...(sandboxes.checkedAt ? { since: sandboxes.checkedAt } : {}),
      });
    } else {
      health.push({
        id: "sandboxes",
        name: sandboxName,
        status: "unavailable",
        summary: `${sandboxes.provider} · not reachable`,
        detail: `${sandboxes.lastError ?? "The backend has not answered its readiness check yet."} Isolated sessions fail until it answers; /v1/info leaves out isolated meanwhile.`,
      });
    }

    const egressName = "Egress proxy";
    if (!egress) health.push({ id: "egress", name: egressName, status: "disabled", summary: "No network module" });
    else if (!needs.sandboxes) health.push({ id: "egress", name: egressName, status: "disabled", summary: `Mode ${egress.mode} · no sandboxes declared` });
    else if (egress.mode === "off") {
      health.push({ id: "egress", name: egressName, status: "disabled", summary: "Off (MANAGED_COPILOT_EGRESS=off)", detail: "Sandboxes that need network access or vault credentials fail with capability_unavailable." });
    } else if (egress.connected) {
      health.push({
        id: "egress",
        name: egressName,
        status: "healthy",
        summary: `Connected · ${egress.version ? `v${egress.version} · ` : ""}${plural(egress.registrations, "sandbox", "sandboxes")} registered${egress.blockedLastDay > 0 ? ` · ${egress.blockedLastDay} blocked today` : ""}`,
        ...(egress.since ? { since: egress.since } : {}),
      });
    } else if (egress.mode === "external") {
      health.push({ id: "egress", name: egressName, status: "unavailable", summary: "Not connected", detail: "The operator-run egress proxy has not connected. Check that it runs and shares MANAGED_COPILOT_EGRESS_KEY with the gateway." });
    } else if (egress.mode === "docker") {
      health.push({ id: "egress", name: egressName, status: "degraded", summary: "Starting", detail: "The gateway starts the egress container at startup; it has not connected yet." });
    } else {
      health.push({ id: "egress", name: egressName, status: "unknown", summary: "Starts with the first sandbox that needs it" });
    }

    const schedulerName = "Scheduler";
    if (!scheduler) health.push({ id: "scheduler", name: schedulerName, status: "disabled", summary: "No durable module" });
    else if (!scheduler.running) health.push({ id: "scheduler", name: schedulerName, status: "unavailable", summary: "Stopped", detail: "Scheduled runs do not start while the scheduler is stopped." });
    else {
      health.push({
        id: "scheduler",
        name: schedulerName,
        status: scheduler.lastTickError ? "degraded" : "healthy",
        summary: `${plural(scheduler.activeRuns, "run")} running · ${scheduler.queuedRuns} queued`,
        ...(scheduler.lastTickError ? { detail: `The last scheduler pass failed: ${scheduler.lastTickError}` } : {}),
        ...(scheduler.lastTickAt ? { since: scheduler.lastTickAt } : {}),
      });
    }

    const webhookName = "Webhooks";
    const unsigned = (this.#ports.webhooks?.operatorSubscriptions?.() ?? []).filter((subscription) => !subscription.signed);
    if (!webhooks) health.push({ id: "webhooks", name: webhookName, status: "disabled", summary: "No durable module" });
    else if (webhooks.subscriptions === 0) health.push({ id: "webhooks", name: webhookName, status: "disabled", summary: "No webhook subscriptions" });
    else if (!webhooks.running) health.push({ id: "webhooks", name: webhookName, status: "unavailable", summary: "Delivery stopped" });
    else {
      const failed = webhooks.counts.failed ?? 0;
      const problems = [
        ...(unsigned.length > 0 ? [`${unsigned.map((subscription) => subscription.name).join(", ")} ${unsigned.length === 1 ? "has" : "have"} no signing secret, so ${unsigned.length === 1 ? "its" : "their"} deliveries fail.`] : []),
        ...(failed > 0 ? [`${plural(failed, "delivery", "deliveries")} failed after every retry.`] : []),
      ];
      health.push({
        id: "webhooks",
        name: webhookName,
        status: problems.length > 0 ? "degraded" : "healthy",
        summary: `${plural(webhooks.subscriptions, "subscription")} · ${(webhooks.counts.pending ?? 0) + (webhooks.counts.delivering ?? 0)} pending · ${failed} failed`,
        ...(problems.length > 0 ? { detail: problems.join(" ") } : {}),
      });
    }

    const largeWal = storage.walBytes > LARGE_WAL_BYTES;
    health.push({
      id: "storage",
      name: "Ledger storage",
      status: largeWal ? "degraded" : "healthy",
      summary: `Ledger ${bytes(storage.databaseBytes)} · WAL ${bytes(storage.walBytes)}`,
      ...(largeWal ? { detail: "The SQLite write-ahead log is large; check free space in the data directory." } : {}),
    });
    return health;
  }

  async overview(): Promise<OperatorOverview> {
    const core = this.#core;
    const ports = this.#ports;
    const infrastructure = await this.infrastructure();
    const info = core.info();
    const counts = core.sessionCounts();
    const connections = core.connections();
    const actionCounts = ports.actions?.operatorActionCounts?.() ?? {};
    const deliveryCounts = ports.webhooks?.operatorCounts?.() ?? {};
    const schedules = ports.schedules?.operatorSchedules?.() ?? [];
    const accounts = core.accounts();
    const snapshot = this.#app.metrics.snapshot();
    const traffic: Partial<Record<TrafficCounter, TrafficSeries>> = {};
    for (const name of TRAFFIC_COUNTERS) traffic[name] = snapshot[name] ?? { total: 0, perMinute: new Array<number>(60).fill(0) };
    return {
      deployment: {
        name: info.name,
        version: info.version,
        mode: info.mode,
        publicUrl: this.#app.config.publicUrl,
        startedAt: this.#app.startedAt.toISOString(),
        capabilities: info.capabilities,
        sdk: info.sdk,
      },
      health: infrastructure.health,
      counts: {
        sessions: { total: counts.total, live: counts.live, byState: counts.byState, byPlacement: counts.byPlacement, byEnvironment: counts.byEnvironment },
        connections: { sdk: connections.filter((connection) => connection.kind === "sdk").length, cli: connections.filter((connection) => connection.kind === "cli").length },
        sandboxes: { total: Object.entries(infrastructure.sandboxes.counts).reduce((sum, [state, count]) => (state === "deleted" ? sum : sum + (count ?? 0)), 0), byState: infrastructure.sandboxes.counts },
        schedules: { active: schedules.filter((schedule) => schedule.state === "active").length, paused: schedules.filter((schedule) => schedule.state === "paused").length },
        actions: { open: OPEN_ACTION_STATES.reduce((sum, state) => sum + (actionCounts[state] ?? 0), 0), needsReconciliation: actionCounts.needs_reconciliation ?? 0 },
        webhooks: { pending: (deliveryCounts.pending ?? 0) + (deliveryCounts.delivering ?? 0), failed: deliveryCounts.failed ?? 0 },
        accounts: accounts.length,
      },
      traffic,
      attention: this.#attention(infrastructure, { counts, actionCounts, deliveryCounts, schedules }),
      generatedAt: new Date().toISOString(),
    };
  }

  #attention(
    infrastructure: OperatorInfrastructure,
    input: { counts: ReturnType<CoreOperator["sessionCounts"]>; actionCounts: Partial<Record<ActionState, number>>; deliveryCounts: Partial<Record<OperatorWebhookDeliveryState, number>>; schedules: readonly ScheduleOperatorRecord[] },
  ): AttentionItem[] {
    const items: AttentionItem[] = [];
    for (const component of infrastructure.health) {
      if (component.id === "webhooks") continue;
      if (component.status === "unavailable") items.push({ id: `health:${component.id}`, severity: "error", title: `${component.name} is unavailable`, ...(component.detail ? { detail: component.detail } : {}), target: { view: "infrastructure" } });
      else if (component.status === "degraded") items.push({ id: `health:${component.id}`, severity: "warning", title: `${component.name} is degraded`, ...(component.detail ? { detail: component.detail } : {}), target: { view: "infrastructure" } });
    }
    for (const environment of this.#core.environments().environments) {
      if (environment.customizations?.problem) {
        items.push({ id: `environment:${environment.name}`, severity: "error", title: `Environment ${environment.name} cannot start sessions`, detail: environment.customizations.problem, target: { view: "environments", id: environment.name } });
      }
    }
    const reconcile = input.actionCounts.needs_reconciliation ?? 0;
    if (reconcile > 0) {
      items.push({
        id: "actions:needs_reconciliation",
        severity: "warning",
        title: `${plural(reconcile, "action")} ${reconcile === 1 ? "needs" : "need"} reconciliation`,
        detail: "A tool call's outcome is unknown after a crash or an expired lease. Its responder must check the downstream effect with the action's idempotency key, then claim it with reconcile.",
        target: { view: "actions" },
      });
    }
    const unsigned = (this.#ports.webhooks?.operatorSubscriptions?.() ?? []).filter((subscription) => !subscription.signed);
    for (const subscription of unsigned) {
      items.push({ id: `webhook:${subscription.name}:unsigned`, severity: "error", title: `Webhook ${subscription.name} has no signing secret`, detail: "Its deliveries fail until the AppHost secret reaches the gateway.", target: { view: "webhooks" } });
    }
    const failedDeliveries = input.deliveryCounts.failed ?? 0;
    if (failedDeliveries > 0) {
      items.push({ id: "webhooks:failed", severity: "warning", title: `${plural(failedDeliveries, "webhook delivery", "webhook deliveries")} failed`, detail: "They failed after every retry. Retry them from the Webhooks view once the receiver works again.", target: { view: "webhooks" } });
    }
    const failedSandboxes = infrastructure.sandboxes.counts.failed ?? 0;
    if (failedSandboxes > 0) items.push({ id: "sandboxes:failed", severity: "warning", title: `${plural(failedSandboxes, "sandbox", "sandboxes")} failed`, target: { view: "sandboxes" } });
    const failedSessions = input.counts.byState["failed"] ?? 0;
    if (failedSessions > 0) items.push({ id: "sessions:failed", severity: "info", title: `${plural(failedSessions, "session")} failed`, target: { view: "sessions" } });
    for (const schedule of input.schedules) {
      if (schedule.state === "paused" && schedule.pausedReason) {
        items.push({ id: `schedule:${schedule.id}:paused`, severity: "warning", title: `Schedule ${schedule.name} (@${schedule.ownerLogin}) is paused`, detail: schedule.pausedReason.replace(/^Paused: /, ""), target: { view: "schedules" } });
      } else if (schedule.state === "active" && schedule.lastRun && (schedule.lastRun.status === "failed" || schedule.lastRun.status === "needs_reconciliation")) {
        items.push({
          id: `schedule:${schedule.id}:last-run`,
          severity: "warning",
          title: `Schedule ${schedule.name}'s last run ${schedule.lastRun.status === "failed" ? "failed" : "needs reconciliation"}`,
          ...(schedule.lastRun.reason ? { detail: redactText(schedule.lastRun.reason) } : {}),
          target: { view: "schedules" },
          ...(schedule.lastRun.completedAt ? { at: schedule.lastRun.completedAt } : {}),
        });
      }
    }
    for (const credential of this.#ports.credentials?.operatorStatuses?.() ?? []) {
      if (credential.state === "invalid") {
        items.push({ id: `credential:${credential.accountId}`, severity: "warning", title: `@${credential.login}'s background sign-in no longer works`, ...(credential.reason ? { detail: credential.reason } : {}), target: { view: "accounts" } });
      }
    }
    if (infrastructure.gateway.mode === "azure" && infrastructure.gateway.access.open) {
      items.push({ id: "access:open", severity: "warning", title: "Any GitHub account can use this deployment", detail: "Name who may use it with access in addManagedCopilot, or Parameters:<name>-github-users.", target: { view: "infrastructure" } });
    }
    if (this.#access.localDefault) {
      items.push({
        id: "operators:local",
        severity: "info",
        title: "Every account that can use this local gateway is an operator",
        detail: "No operators are named, which is fine on your machine. Name them (operators in addManagedCopilot) before you deploy: a deployed console stays off until you do.",
        target: { view: "infrastructure" },
      });
    }
    const order = { error: 0, warning: 1, info: 2 } as const;
    return items.sort((a, b) => order[a.severity] - order[b.severity]);
  }

  // --- Sessions, connections, sandboxes ------------------------------------------------------------------------

  session(sessionId: string): OperatorSessionDetail {
    const core = this.#core;
    const ports = this.#ports;
    const detail = core.session(sessionId);
    if (!detail) throw new ManagedCopilotError("not_found", `Session ${sessionId} was not found`, { sessionId });
    const account = core.accountDirectory();
    const binding = ports.policy?.session?.(sessionId);
    const blocks = ports.policy?.blocked?.(sessionId, 25) ?? [];
    const sandbox = ports.sandboxes?.operatorSandboxes?.({ sessionId, limit: 1 })[0];
    const actions = ports.actions?.operatorActions?.({ sessionId, incarnation: detail.incarnation, state: "all", limit: 100 }) ?? [];
    const promotion = ports.promotion?.latest?.(sessionId);
    const artifacts = ports.artifacts?.list?.(sessionId, { versions: "latest" });
    const schedules = ports.schedules?.operatorSchedules?.({ targetSessionId: sessionId }) ?? [];
    return {
      ...detail,
      ...(binding
        ? {
            network: {
              policy: binding.policy,
              vaults: binding.vaults ?? [],
              ...(binding.promotedTo ? { promotedTo: binding.promotedTo } : {}),
              recentBlocks: blocks.map((block): OperatorEgressBlock => ({
                id: block.id,
                sessionId: block.sessionId ?? sessionId,
                ...(block.sandboxId ? { sandboxId: block.sandboxId } : {}),
                at: block.at,
                reason: block.reason,
                ...(block.host ? { host: block.host } : {}),
                ...(block.port ? { port: block.port } : {}),
                ...(block.method ? { method: block.method } : {}),
                ...(block.path ? { path: redactPath(block.path) } : {}),
                message: redactText(block.message),
              })),
            },
          }
        : {}),
      ...(sandbox ? { sandbox: withOwner(sandbox, account) } : {}),
      actions: actions.map((action) => withOwner(action, account)),
      ...(promotion
        ? {
            promotion: {
              id: promotion.id,
              state: promotion.state,
              trigger: promotion.trigger,
              target: promotion.target,
              fromGeneration: promotion.fromGeneration,
              ...(promotion.toGeneration !== undefined ? { toGeneration: promotion.toGeneration } : {}),
              ...(promotion.sandboxId ? { sandboxId: promotion.sandboxId } : {}),
              ...(promotion.errorCode ? { errorCode: promotion.errorCode } : {}),
              ...(promotion.error ? { error: redactText(promotion.error) } : {}),
              createdAt: promotion.createdAt,
              updatedAt: promotion.updatedAt,
              ...(promotion.committedAt ? { committedAt: promotion.committedAt } : {}),
            } satisfies OperatorPromotion,
          }
        : {}),
      ...(artifacts
        ? {
            artifacts: {
              count: artifacts.length,
              bytes: artifacts.reduce((sum, artifact) => sum + artifact.size, 0),
              latest: artifacts.slice(0, 25).map((artifact) => ({ path: artifact.path, version: artifact.version, size: artifact.size, state: artifact.state, ...(artifact.publishedAt ? { publishedAt: artifact.publishedAt } : {}) })),
            },
          }
        : {}),
      schedules: schedules.map((schedule) => ({ id: schedule.id, name: schedule.name, state: schedule.state })),
    };
  }

  connections(): OperatorConnections {
    return { connections: this.#core.connections(), upstreams: this.#core.upstreams(), generatedAt: new Date().toISOString() };
  }

  sandboxes(query: { readonly state?: SandboxState; readonly limit?: number }): OperatorSandbox[] {
    const account = this.#core.accountDirectory();
    return (this.#ports.sandboxes?.operatorSandboxes?.(query) ?? []).map((sandbox) => withOwner(sandbox, account));
  }

  // --- Durable work ---------------------------------------------------------------------------------------------

  schedules(): OperatorSchedule[] {
    const account = this.#core.accountDirectory();
    return (this.#ports.schedules?.operatorSchedules?.() ?? []).map((schedule) => scheduleView(schedule, account));
  }

  scheduleRuns(scheduleId: string): OperatorScheduleRuns {
    const port = this.#ports.schedules?.operatorRuns;
    if (!port) throw new ManagedCopilotError("capability_unavailable", "Schedules are not available on this gateway");
    const { schedule, runs } = port.call(this.#ports.schedules, scheduleId);
    return { schedule: scheduleView(schedule, this.#core.accountDirectory()), runs };
  }

  webhooks(query: { readonly state?: OperatorWebhookDeliveryState; readonly limit?: number }): OperatorWebhooks {
    const port = this.#ports.webhooks;
    const account = this.#core.accountDirectory();
    return {
      subscriptions: port?.operatorSubscriptions?.() ?? [],
      deliveries: (port?.operatorDeliveries?.(query) ?? []).map(({ ownerId, ...delivery }) => ({ ...delivery, ...(ownerId !== undefined ? { owner: account(ownerId) } : {}) })),
      counts: port?.operatorCounts?.() ?? {},
    };
  }

  actions(query: { readonly state?: string; readonly sessionId?: string; readonly limit?: number }): OperatorAction[] {
    const account = this.#core.accountDirectory();
    return (this.#ports.actions?.operatorActions?.(query) ?? []).map((action) => withOwner(action, account));
  }

  accounts(): OperatorAccount[] {
    const credentials = new Map((this.#ports.credentials?.operatorStatuses?.() ?? []).map((credential) => [credential.accountId, credential]));
    const schedules = this.#ports.schedules?.operatorSchedules?.() ?? [];
    const named = new Set(this.#access.rules.githubUsers.map((user) => user.toLowerCase()));
    return this.#core.accounts().map((entry) => {
      const credential = credentials.get(entry.account.id);
      const own = schedules.filter((schedule) => schedule.ownerId === entry.account.id);
      return {
        account: entry.account,
        lastSeenAt: entry.lastSeenAt,
        sessions: { total: entry.sessions, live: entry.live },
        connections: entry.connections,
        schedules: { active: own.filter((schedule) => schedule.state === "active").length, paused: own.filter((schedule) => schedule.state === "paused").length },
        background: credential
          ? { state: credential.state, createdAt: credential.createdAt, ...(credential.lastVerifiedAt ? { lastVerifiedAt: credential.lastVerifiedAt } : {}), ...(credential.reason ? { reason: credential.reason } : {}) }
          : { state: "none" },
        operator: this.#access.localDefault || named.has(entry.account.login.toLowerCase()),
      };
    });
  }
}

function withOwner<T extends { readonly ownerId: number }>(record: T, account: (id: number) => AccountInfo): Omit<T, "ownerId"> & { owner: AccountInfo } {
  const { ownerId, ...rest } = record;
  return { ...rest, owner: account(ownerId) };
}

function scheduleView(schedule: ScheduleOperatorRecord, account: (id: number) => AccountInfo): OperatorSchedule {
  const { ownerId, ownerLogin, ...rest } = schedule;
  const known = account(ownerId);
  return { ...rest, owner: known.login === String(ownerId) ? { id: ownerId, login: ownerLogin } : known };
}
