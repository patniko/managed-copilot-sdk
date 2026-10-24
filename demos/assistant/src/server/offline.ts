/**
 * Work that continues without a live client (spec section 12). When no browser tab is open the conversation is
 * detached, so a scheduled run's Gmail/Calendar tool calls become durable actions on the platform. This server answers
 * them two ways with the same tool handlers:
 *
 * 1. **Webhook (primary):** the platform POSTs `session.action_required` to `/api/copilot-events`; we verify the
 *    signature with `verifyWebhook` and claim/answer the listed actions with `event.handleActions({ tools })`.
 * 2. **Polling (safety net):** on startup, after reconnecting, and periodically while detached we read
 *    `managed.sessions.get(id).pendingActions` and call `managed.sessions.handleActions(id, { tools })`.
 *
 * Neither path passes `onPermissionRequest`, so approvals (send mail, change events) stay pending for the person.
 */
import type { Tool } from "@github/copilot-sdk";
import { isManagedCopilotError, verifyWebhook, type VerifiedWebhookEvent } from "@managed-copilot/sdk";
import type { OfflineView } from "../shared/protocol.js";
import type { AssistantConfig } from "./config.js";
import { HttpError, type RequestContext } from "./http.js";
import { errorMessage, type Logger } from "./log.js";
import type { Platform } from "./platform.js";
import type { Store } from "./store.js";

const MAX_WEBHOOK_BYTES = 1024 * 1024;

export interface OfflineDeps {
  readonly config: AssistantConfig;
  readonly log: Logger;
  readonly store: Store;
  readonly platform: Platform;
  /** The conversation session this server answers for; actions for any other session are refused. */
  sessionId(): string | undefined;
  live(): boolean;
  /** The assistant's tools, labeling each call as answered offline. */
  tools(via: "webhook" | "poll"): Tool<any>[];
  onChange(view: OfflineView): void;
  /** A platform event about the conversation arrived (run started/completed, idle, failed). */
  onEvent(event: VerifiedWebhookEvent): void;
}

export class OfflineWorker {
  readonly #deps: OfflineDeps;
  #offlineIds: Set<string>;
  #waitingApprovals = 0;
  #reconciling: Promise<void> | undefined;

  constructor(deps: OfflineDeps) {
    this.#deps = deps;
    this.#offlineIds = deps.store.offlineCallIds();
  }

  view(): OfflineView {
    return {
      webhookConfigured: this.#deps.config.webhookSecret !== undefined,
      lastWebhookAt: this.#deps.store.lastWebhookAt(),
      handledOffline: this.#offlineIds.size,
      // While a tab is open, waiting approvals are cards in the chat instead.
      waitingApprovals: this.#deps.live() ? 0 : this.#waitingApprovals,
    };
  }

  /** Forgets offline activity for a conversation that was replaced by a new one. */
  reset(): void {
    this.#deps.store.clearOfflineCalls();
    this.#offlineIds = new Set();
    this.#waitingApprovals = 0;
    this.#deps.onChange(this.view());
  }

  isOffline(toolCallId: string): boolean {
    return this.#offlineIds.has(toolCallId);
  }

  /** Records a tool call answered by the webhook or poller (shown as a badge in the chat). */
  recordCall(toolCallId: string, tool: string, via: "webhook" | "poll"): void {
    this.#deps.store.recordOfflineCall(toolCallId, tool, via);
    this.#offlineIds.add(toolCallId);
  }

  async handleWebhook(ctx: RequestContext): Promise<unknown> {
    const secret = this.#deps.config.webhookSecret;
    if (!secret) throw new HttpError(503, "webhook_not_configured", "Set ASSISTANT_WEBHOOK_SECRET to receive platform webhooks.");
    const rawBody = await ctx.raw(MAX_WEBHOOK_BYTES);
    let event: VerifiedWebhookEvent;
    try {
      // The action capability must be for the deployment this server is connected to.
      event = await verifyWebhook({ headers: ctx.req.headers, rawBody }, secret, { deploymentUrl: this.#deps.platform.managed?.url });
    } catch (error) {
      if (isManagedCopilotError(error, "capability_unavailable")) throw new HttpError(501, "capability_unavailable", errorMessage(error));
      this.#deps.log.warn("Rejected a webhook delivery", { error: errorMessage(error) });
      throw new HttpError(401, "invalid_signature", "Webhook verification failed.");
    }
    const firstDelivery = !this.#deps.store.hasWebhookEvent(event.id);
    const ours = event.sessionId !== undefined && event.sessionId === this.#deps.sessionId();
    if (event.type === "session.action_required") {
      if (!ours) {
        // A webhook is scoped to an environment, which other people's sessions share; never run tools for them.
        this.#deps.log.warn("Ignoring actions for a session this assistant doesn't own", { sessionId: event.sessionId });
      } else {
        const before = this.#offlineIds.size;
        try {
          // Claims are atomic, so a redelivery or a racing live client cannot run the same call twice.
          await event.handleActions({ tools: this.#deps.tools("webhook") });
          const answered = this.#offlineIds.size - before;
          if (answered > 0) this.#deps.log.info("Answered tool calls through the webhook", { sessionId: event.sessionId, answered });
        } catch (error) {
          // For example an expired or mismatched capability. Retrying the delivery won't help; polling with this
          // server's own credentials answers the actions instead.
          this.#deps.log.warn("Couldn't answer actions through the webhook; polling instead", { error: errorMessage(error) });
          void this.reconcile("webhook could not answer");
        }
        await this.#refreshWaiting();
      }
    }
    this.#deps.store.recordWebhookEvent(event.id, event.type);
    if (ours && firstDelivery) this.#deps.onEvent(event);
    this.#deps.onChange(this.view());
    return { ok: true };
  }

  async #refreshWaiting(): Promise<void> {
    const managed = this.#deps.platform.managed;
    const sessionId = this.#deps.sessionId();
    if (!managed || !sessionId) return;
    try {
      const info = await managed.sessions.get(sessionId);
      this.#waitingApprovals = info.pendingActions.filter((action) => action.kind === "permission" && action.state === "pending").length;
    } catch {
      // Informational only.
    }
  }

  /** Polls for pending tool calls while no live client is attached. */
  reconcile(reason: string): Promise<void> {
    this.#reconciling ??= this.#reconcile(reason).finally(() => (this.#reconciling = undefined));
    return this.#reconciling;
  }

  async #reconcile(reason: string): Promise<void> {
    const managed = this.#deps.platform.managed;
    const sessionId = this.#deps.sessionId();
    if (!managed || !sessionId || this.#deps.live()) return;
    try {
      const info = await managed.sessions.get(sessionId);
      const pending = info.pendingActions.filter((action) => action.state === "pending");
      this.#waitingApprovals = pending.filter((action) => action.kind === "permission").length;
      if (pending.some((action) => action.kind === "tool")) {
        const results = await managed.sessions.handleActions(sessionId, { tools: this.#deps.tools("poll") });
        if (results.length) this.#deps.log.info("Answered pending tool calls by polling", { sessionId, reason, answered: results.length });
      }
      this.#deps.onChange(this.view());
    } catch (error) {
      if (isManagedCopilotError(error, "capability_unavailable")) return;
      this.#deps.log.debug("Polling for pending actions failed", { reason, error: errorMessage(error) });
    }
  }
}
