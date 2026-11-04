// The operator module's view of the other modules. Each module redacts its own data in these methods; the operator
// module authorizes callers, composes the views, audits actions, and serves the console. Every port is optional:
// a gateway without a module simply shows less.
import type { ActionState, ArtifactInfo, EgressStatus, NetworkPolicy, SandboxState, ScheduleRun } from "@managed-copilot/protocol";
import type { ActionOperatorRecord } from "../durable/actions/store.js";
import type { WebhookDeliveryInfo } from "../durable/contract.js";
import type { ScheduleOperatorRecord } from "../durable/schedules/service.js";
import type { BlockedEvent } from "../network/policy.js";
import type { PromotionOperation } from "../promotion/contract.js";
import type { SandboxOperatorRecord } from "../sandbox/service.js";

export interface SandboxesOperatorPort {
  readonly available?: boolean;
  probe?(): Promise<boolean>;
  operatorStatus?(): Promise<{
    provider: string;
    available: boolean;
    checkedAt?: string;
    lastError?: string;
    defaultIdleSeconds: number;
    facts: readonly { label: string; value: string; mono?: boolean }[];
    counts: Partial<Record<SandboxState, number>>;
  }>;
  operatorSandboxes?(query?: { readonly state?: SandboxState; readonly ownerId?: number; readonly sessionId?: string; readonly limit?: number }): SandboxOperatorRecord[];
  operatorStop?(sessionId: string, reason: string): Promise<{ readonly sandboxId: string; readonly stopped: boolean }>;
}

export interface ArtifactsOperatorPort {
  list?(sessionId: string, options?: { readonly versions?: "latest" | "all" }): ArtifactInfo[];
}

export interface PolicyOperatorPort {
  session?(sessionId: string): { readonly policy: NetworkPolicy; readonly vaults?: readonly string[]; readonly promotedTo?: string } | undefined;
  blocked?(sessionId: string, limit?: number): readonly BlockedEvent[];
  operatorEgress?(): EgressStatus;
  operatorBlocks?(limit?: number): readonly BlockedEvent[];
}

export interface ActionsOperatorPort {
  operatorActions?(query?: { readonly state?: string; readonly sessionId?: string; readonly incarnation?: string; readonly limit?: number }): ActionOperatorRecord[];
  operatorActionCounts?(): Partial<Record<ActionState, number>>;
}

export type WebhookOperatorDelivery = WebhookDeliveryInfo & { readonly ownerId?: number; readonly environment?: string; readonly updatedAt: string };

export interface WebhooksOperatorPort {
  operatorSubscriptions?(): { name: string; url: string; environments: readonly string[]; events: readonly string[]; signed: boolean }[];
  operatorDeliveries?(query?: { readonly state?: WebhookDeliveryInfo["state"]; readonly limit?: number; readonly sessionId?: string }): WebhookOperatorDelivery[];
  operatorCounts?(): Partial<Record<WebhookDeliveryInfo["state"], number>>;
  operatorStatus?(): { running: boolean; subscriptions: number; counts: Partial<Record<WebhookDeliveryInfo["state"], number>> };
  retry?(deliveryId: string): WebhookDeliveryInfo;
}

export interface SchedulesOperatorPort {
  operatorSchedules?(query?: { readonly ownerId?: number; readonly state?: "active" | "paused"; readonly targetSessionId?: string }): ScheduleOperatorRecord[];
  operatorRuns?(scheduleId: string): { readonly schedule: ScheduleOperatorRecord; readonly runs: ScheduleRun[] };
  operatorPause?(scheduleId: string, operator: string, reason?: string): ScheduleOperatorRecord;
  operatorResume?(scheduleId: string): ScheduleOperatorRecord;
  schedulerStatus?(): { running: boolean; tickIntervalMs: number; lastTickAt?: string; lastTickError?: string; nextDueAt?: string; queuedRuns: number; activeRuns: number };
}

export interface CredentialsOperatorPort {
  operatorStatuses?(): { accountId: number; login: string; state: "active" | "revoked" | "invalid"; createdAt: string; lastVerifiedAt?: string; reason?: string }[];
}

export interface PromotionOperatorPort {
  latest?(sessionId: string): PromotionOperation | undefined;
}

/** The ports above, read structurally from `app.services`. */
export interface OperatorPorts {
  readonly sandboxes?: SandboxesOperatorPort;
  readonly artifacts?: ArtifactsOperatorPort;
  readonly policy?: PolicyOperatorPort;
  readonly actions?: ActionsOperatorPort;
  readonly webhooks?: WebhooksOperatorPort;
  readonly schedules?: SchedulesOperatorPort;
  readonly credentials?: CredentialsOperatorPort;
  readonly promotion?: PromotionOperatorPort;
}

export function operatorPorts(services: object): OperatorPorts {
  const read = <T>(key: string) => (services as Record<string, unknown>)[key] as T | undefined;
  return {
    ...(read<SandboxesOperatorPort>("sandboxes") ? { sandboxes: read<SandboxesOperatorPort>("sandboxes")! } : {}),
    ...(read<ArtifactsOperatorPort>("artifacts") ? { artifacts: read<ArtifactsOperatorPort>("artifacts")! } : {}),
    ...(read<PolicyOperatorPort>("policy") ? { policy: read<PolicyOperatorPort>("policy")! } : {}),
    ...(read<ActionsOperatorPort>("actions") ? { actions: read<ActionsOperatorPort>("actions")! } : {}),
    ...(read<WebhooksOperatorPort>("webhooks") ? { webhooks: read<WebhooksOperatorPort>("webhooks")! } : {}),
    ...(read<SchedulesOperatorPort>("schedules") ? { schedules: read<SchedulesOperatorPort>("schedules")! } : {}),
    ...(read<CredentialsOperatorPort>("credentials") ? { credentials: read<CredentialsOperatorPort>("credentials")! } : {}),
    ...(read<PromotionOperatorPort>("promotion") ? { promotion: read<PromotionOperatorPort>("promotion")! } : {}),
  };
}
