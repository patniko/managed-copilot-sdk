// Attached clients: SDK hooks, handler registrations, and the session's persisted callback inventory.
import { ManagedCopilotError, type Placement } from "@managed-copilot/protocol";
import type { AttachedResponder } from "../../durable/contract.js";
import type { AdmittedSession } from "../admission.js";
import type { AdmittedConfig, CallbackInventory } from "../ledger.js";
import type { IncomingRequestContext } from "../rpc.js";
import type { ClientPeer, Attachment, WireSettings, InventoryChange, LiveSession } from "./types.js";
import { WIRE_FLAGS, FAIL_CLOSED_HOOKS, hooksUnavailable, inventoryOf, applyInventory, trueFlags } from "./support.js";
import { SessionInferenceRouting } from "./inference.js";

export abstract class SessionAttachments extends SessionInferenceRouting {
  // Implemented by later layers of SessionManager.
  protected abstract platformToolDeclarations(live: LiveSession, placement?: Placement): Record<string, unknown>[];
  protected abstract persist(sessionId: string, update: (stored: AdmittedConfig) => AdmittedConfig): void;
  protected abstract incarnationOf(sessionId: string): { readonly incarnation?: string };
  protected abstract historyPlacement(live: LiveSession): Placement;

  // ------------------------------------------------------------------------------------------------------------
  // SDK hooks: one connected client answers them; without it they fail closed

  /** The one attached, connected client that registered the session's hooks. */
  #hooksProvider(live: LiveSession): Attachment | undefined {
    const providers = [...live.attachments.values()].filter((attachment) => attachment.hooks && !attachment.peer.closed);
    return providers.length === 1 ? providers[0] : undefined;
  }

  /** Whether the session has hooks registered (by a connected client, or by one that is away). */
  #hooksRequired(live: LiveSession): boolean {
    return this.#inventory(live).flags["hooks"] === true || [...live.attachments.values()].some((attachment) => attachment.hooks && !attachment.peer.closed);
  }

  /** Refuses work that would run without the session's required hooks, rather than skipping them. */
  protected assertHooks(live: LiveSession): void {
    if (this.#hooksRequired(live) && !this.#hooksProvider(live)) throw new ManagedCopilotError("background_callback_unsupported", hooksUnavailable(live.id));
  }

  /**
   * A session has one hooks handler: another connected client cannot register hooks too (its answers would compete),
   * and a client that resumes without hooks needs the handler connected, unless it is the handler withdrawing them.
   */
  protected checkHooksRegistration(live: LiveSession, peer: ClientPeer, params: Record<string, unknown>): void {
    const provider = this.#hooksProvider(live);
    if (params["hooks"] === true) {
      if (provider && provider.peer.id !== peer.id) {
        throw new ManagedCopilotError("conflict", `Session ${live.id} already has SDK hooks from another connected client, and a session has one hooks handler. Resume without hooks, or close the other client first.`);
      }
      return;
    }
    if (provider?.peer.id === peer.id) return;
    if (!provider && this.#hooksRequired(live)) throw new ManagedCopilotError("background_callback_unsupported", `${hooksUnavailable(live.id)} A client that resumes with hooks takes them over, and can withdraw them by resuming again without.`);
  }

  /** `hooks.invoke` goes to the session's hooks handler only; without one (or without an answer) it fails closed. */
  protected async invokeHook(live: LiveSession, params: Record<string, unknown>, context: IncomingRequestContext): Promise<unknown> {
    const provider = this.#hooksProvider(live);
    if (provider) {
      try {
        return await provider.peer.request("hooks.invoke", this.scrub(live, params), context.signal);
      } catch (error) {
        this.log.warn("The session's hooks handler did not answer; the hook fails closed", { sessionId: live.id, hookType: params["hookType"], error: (error as Error).message });
      }
    } else {
      this.log.warn("No connected client answers the session's hooks; the hook fails closed", { sessionId: live.id, hookType: params["hookType"] });
    }
    return this.hookClosed(live.id, params, hooksUnavailable(live.id));
  }

  /**
   * The runtime treats an error from `hooks.invoke` as "no output" and carries on (verified on 1.0.103), so a gating
   * hook fails closed with an explicit answer: a denied tool call, a blocked prompt, a withheld tool result. Other
   * hooks have no closing answer; turns that would need them are refused before they start (`#assertHooks`).
   */
  protected hookClosed(sessionId: string, params: Record<string, unknown>, reason: string): unknown {
    const hookType = String(params["hookType"] ?? "");
    const closed = FAIL_CLOSED_HOOKS[hookType];
    if (closed) return { output: closed(reason) };
    throw new ManagedCopilotError("background_callback_unsupported", `No connected client answers the ${hookType || "requested"} hook for session ${sessionId}.`);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Attachments

  protected attach(live: LiveSession, peer: ClientPeer, admitted: AdmittedSession, forwarded: Record<string, unknown>): void {
    const flag = (key: string) => forwarded[key] === true;
    const sections = (forwarded["systemMessage"] as { sections?: Record<string, { action?: unknown }> } | undefined)?.sections ?? {};
    const before = live.attachments.get(peer.id);
    live.attachments.delete(peer.id);
    live.attachments.set(peer.id, {
      peer,
      attachedAt: Date.now(),
      tools: new Set(admitted.client.tools),
      requestPermission: admitted.client.requestPermission,
      requestUserInput: admitted.client.requestUserInput,
      requestElicitation: admitted.client.requestElicitation,
      requestExitPlanMode: flag("requestExitPlanMode"),
      requestAutoModeSwitch: flag("requestAutoModeSwitch"),
      hooks: flag("hooks"),
      skillProvider: flag("hasSkillProvider"),
      memoryStore: flag("hasMemoryStore"),
      transforms: Object.values(sections).some((section) => section?.action === "transform"),
      canvases: (Array.isArray(forwarded["canvases"]) && forwarded["canvases"].length > 0) || forwarded["requestCanvasRenderer"] !== undefined || forwarded["canvasProvider"] !== undefined,
      declarations: ((forwarded["tools"] as Record<string, unknown>[] | undefined) ?? []).filter((tool) => !this.options.platformTools.has(String(tool["name"]), live.environment.name)),
      flags: Object.fromEntries([...WIRE_FLAGS, "streaming"].filter((key) => forwarded[key] !== undefined).map((key) => [key, forwarded[key]])),
      registered: { tools: { ...before?.registered.tools }, flags: { ...before?.registered.flags } },
    });
    live.creator ??= peer.id;
  }

  /**
   * The runtime scopes tool and handler registrations to the calling connection, and every attached client shares
   * the gateway's one upstream connection. Upstream registrations are therefore the union of the session's callback
   * inventory (what clients registered, kept while they are away), stored server-side declarations, and attached
   * clients, so one client's resume or disconnect never removes another's tools or handlers. `pending` is a
   * registration being made now (applied before it is stored). `committed` leaves attached clients out: every
   * registration that committed is in the inventory, so restores and placement changes register exactly that.
   */
  protected registrations(live: LiveSession, pending?: InventoryChange, committed = false): WireSettings {
    const stored = this.ledger.admitted(live.id);
    const inventory = this.#inventory(live, pending);
    const byName = new Map<string, Record<string, unknown>>();
    for (const tool of stored?.tools ?? []) byName.set(String(tool["name"]), tool);
    for (const tool of inventory.tools) byName.set(String(tool["name"]), tool);
    const ordered = committed ? [] : [...live.attachments.values()].filter((attachment) => !attachment.peer.closed).sort((a, b) => a.attachedAt - b.attachedAt);
    for (const attachment of ordered) for (const tool of attachment.declarations) byName.set(String(tool["name"]), tool);
    // Every handler flag, set or not: one nobody registers any more is turned off on the runtime, not left as it was.
    const flags: Record<string, unknown> = {};
    for (const key of WIRE_FLAGS) flags[key] = inventory.flags[key] === true || ordered.some((attachment) => attachment.flags[key] === true);
    const streaming = ordered.at(-1)?.flags["streaming"];
    if (streaming !== undefined) flags["streaming"] = streaming;
    return { tools: [...byName.values()], flags };
  }

  /** The session's callback inventory: stored, plus `pending` (a registration being made now). */
  #inventory(live: LiveSession, pending?: InventoryChange): CallbackInventory {
    const stored = this.ledger.admitted(live.id);
    return applyInventory(stored ? inventoryOf(stored) : undefined, pending);
  }

  /** Upstream create/resume/tools params: the aggregate registrations plus the environment's platform tools. */
  protected withRegistrations(live: LiveSession, params: Record<string, unknown>, pending?: InventoryChange): Record<string, unknown> {
    const registrations = this.registrations(live, pending);
    return { ...params, ...registrations.flags, tools: [...registrations.tools, ...this.platformToolDeclarations(live)] };
  }

  /**
   * What a client's registration changes in the inventory: it adds what the client registers, and withdraws only what
   * this connection itself had registered before and no other attached client registers. What others still register
   * is handed over to them once the change is stored (registration changes of a session run one at a time).
   */
  protected inventoryChange(live: LiveSession, peerId: string, previous: Attachment | undefined, next: { readonly tools: readonly Record<string, unknown>[]; readonly flags: Readonly<Record<string, unknown>> }, scope: "all" | "tools" = "all"): InventoryChange {
    const others = [...live.attachments.values()].filter((attachment) => attachment.peer.id !== peerId && !attachment.peer.closed);
    const named = new Set(next.tools.map((tool) => String(tool["name"])));
    const withdrawnTools = (previous?.declarations ?? []).map((tool) => String(tool["name"])).filter((name) => !named.has(name));
    const otherTool = (name: string) => others.some((attachment) => attachment.declarations.some((tool) => tool["name"] === name));
    const toolRevisions = (names: readonly string[]) =>
      names.flatMap((name) => {
        const revision = previous?.registered.tools[name];
        return revision === undefined ? [] : [{ name, revision }];
      });
    const withdrawnFlags = scope === "all" && previous ? WIRE_FLAGS.filter((key) => previous.flags[key] === true && next.flags[key] !== true) : [];
    const otherFlag = (key: string) => others.some((attachment) => attachment.flags[key] === true);
    const flagRevisions = (keys: readonly string[]) =>
      keys.flatMap((key) => {
        const revision = previous?.registered.flags[key];
        return revision === undefined ? [] : [{ key, revision }];
      });
    const handover = { tools: toolRevisions(withdrawnTools.filter(otherTool)), flags: flagRevisions(withdrawnFlags.filter(otherFlag)) };
    return {
      tools: next.tools,
      flags: scope === "all" ? next.flags : {},
      removeTools: toolRevisions(withdrawnTools.filter((name) => !otherTool(name))),
      removeFlags: flagRevisions(withdrawnFlags.filter((key) => !otherFlag(key))),
      ...(handover.tools.length > 0 || handover.flags.length > 0 ? { handover } : {}),
    };
  }

  /**
   * Stores a registration that succeeded. Withdrawals apply only to the registrations they saw (a newer registration of
   * the same tool or flag by another client stays), and the registering attachment learns its revisions. A withdrawn
   * registration other attached clients still make passes to them when it is the stored one.
   */
  protected persistInventory(live: LiveSession, peerId: string | undefined, change: InventoryChange): void {
    let applied: CallbackInventory | undefined;
    this.persist(live.id, (stored) => {
      applied = applyInventory(inventoryOf(stored), change);
      return { ...stored, callbacks: applied };
    });
    if (!applied) return;
    const revisions = applied.revisions;
    for (const { name, revision } of change.handover?.tools ?? []) {
      if (revisions?.tools[name] !== revision) continue;
      for (const other of live.attachments.values()) {
        if (other.peer.id !== peerId && other.declarations.some((tool) => tool["name"] === name)) other.registered.tools[name] = revision;
      }
    }
    for (const { key, revision } of change.handover?.flags ?? []) {
      if (revisions?.flags[key] !== revision) continue;
      for (const other of live.attachments.values()) {
        if (other.peer.id !== peerId && other.flags[key] === true) other.registered.flags[key] = revision;
      }
    }
    const attachment = peerId === undefined ? undefined : live.attachments.get(peerId);
    if (!attachment) return;
    for (const { name } of [...change.removeTools, ...(change.handover?.tools ?? [])]) delete attachment.registered.tools[name];
    for (const { key } of [...change.removeFlags, ...(change.handover?.flags ?? [])]) delete attachment.registered.flags[key];
    for (const tool of change.tools) {
      const revision = revisions?.tools[String(tool["name"])];
      if (revision !== undefined) attachment.registered.tools[String(tool["name"])] = revision;
    }
    for (const key of Object.keys(trueFlags(change.flags))) {
      const revision = revisions?.flags[key];
      if (revision !== undefined) attachment.registered.flags[key] = revision;
    }
  }

  /** Detaches one connection from one session; durable releases only that session's live claims of the connection. */
  protected detachAttachment(live: LiveSession, peerId: string, notifyActions = true): void {
    live.attachments.delete(peerId);
    // The creating connection's preference passes to an SDK client before an attached CLI.
    if (live.creator === peerId) {
      const remaining = [...live.attachments.values()];
      live.creator = (remaining.find((attachment) => attachment.peer.kind === "sdk") ?? remaining[0])?.peer.id;
    }
    if (notifyActions) this.actions?.onDetached(peerId, live.id);
  }

  /** Undoes an attach whose resume did not complete: the client keeps the attachment it had before, while connected. */
  protected unattach(live: LiveSession, peerId: string, previous: Attachment | undefined): void {
    if (previous && !previous.peer.closed) live.attachments.set(peerId, previous);
    else if (live.attachments.has(peerId)) this.detachAttachment(live, peerId);
  }

  protected async afterAttach(peer: ClientPeer, sessionId: string): Promise<void> {
    const actions = this.actions;
    const live = this.live.get(sessionId);
    if (!actions || !live || peer.closed) return;
    const record = this.get(sessionId);
    if (!record) return;
    const responder = this.responders(live).find((candidate) => candidate.connectionId === peer.id);
    if (!responder) return;
    try {
      const replay = await actions.onAttached({ sessionId, ...this.incarnationOf(sessionId), ownerId: record.ownerId, environment: record.environment, generation: record.generation, responder });
      // Pending actions can predate a placement change, like history.
      const origin = this.historyPlacement(live);
      for (const event of replay) peer.notify("session.event", { sessionId, event: this.scrub(live, this.sanitizeEvent(live, event, origin), origin) });
    } catch (error) {
      this.log.warn("Action replay after attach failed", { sessionId, error: (error as Error).message });
    }
  }

  /** Responder preference among connected attachments: the creating connection first, then the others by attach time. */
  protected preferred(live: LiveSession): Attachment[] {
    return [...live.attachments.values()]
      .filter((attachment) => !attachment.peer.closed)
      .sort((a, b) => (a.peer.id === live.creator ? -1 : b.peer.id === live.creator ? 1 : a.attachedAt - b.attachedAt));
  }

  protected responders(live: LiveSession): AttachedResponder[] {
    return this.preferred(live).map((attachment) => ({
      connectionId: attachment.peer.id,
      kind: attachment.peer.kind,
      tools: [...attachment.tools],
      requestPermission: attachment.requestPermission,
      requestElicitation: attachment.requestElicitation,
    }));
  }
}
