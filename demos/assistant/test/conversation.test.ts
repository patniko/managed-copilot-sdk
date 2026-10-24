import type { PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";
import type { AssistantConfig } from "../src/server/config.js";
import { Conversation } from "../src/server/conversation.js";
import { createLogger } from "../src/server/log.js";
import type { Platform } from "../src/server/platform.js";
import { Store } from "../src/server/store.js";
import type { TimelineChange } from "../src/server/timeline.js";

let seq = 0;
function event(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): SessionEvent {
  seq++;
  return { id: `evt-${seq}`, parentId: null, timestamp: new Date(Date.UTC(2026, 9, 23, 17, 0, seq)).toISOString(), type, data, ...extra } as unknown as SessionEvent;
}

interface SessionConfigLike {
  onEvent?: (event: SessionEvent) => void;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionRequestResult>;
}

/** A conversation over fake SDK objects; `history` runs while the session loads its events. */
function setup(options: { history?: (emit: (event: SessionEvent) => void) => SessionEvent[]; storedSessionId?: string | null; listSessions?: () => Promise<unknown[]> } = {}) {
  const store = new Store(":memory:");
  store.upsertUser({ id: 1, login: "octo" });
  const stored = options.storedSessionId === undefined ? "s1" : options.storedSessionId;
  if (stored) store.setSessionId(1, stored);
  let config: SessionConfigLike = {};
  let created = 0;
  const session = {
    sessionId: "s1",
    getEvents: async () => (options.history ?? (() => []))((e) => config.onEvent?.(e)),
    disconnect: async () => undefined,
  };
  const client = {
    resumeSession: async (_id: string, sessionConfig: SessionConfigLike) => {
      config = sessionConfig;
      return session;
    },
    createSession: async (sessionConfig: SessionConfigLike) => {
      created++;
      config = sessionConfig;
      return session;
    },
    stop: async () => [],
    forceStop: async () => undefined,
    ping: async () => ({}),
  };
  const managed = { client: async () => client, sessions: { list: options.listSessions ?? (async () => []) } };
  const changes: TimelineChange[] = [];
  const conversation = new Conversation({
    config: { environment: "assistant", model: "test-model" } as AssistantConfig,
    log: createLogger("test"),
    store,
    platform: { managed, reconnect: async () => undefined } as unknown as Platform,
    accountId: () => 1,
    tools: () => [],
    systemMessage: async () => "You are a test assistant.",
    currentEvent: async () => undefined,
    timeline: { timeZone: () => "UTC", scheduleNameFor: () => undefined, isOffline: () => false },
    onChanges: (batch) => changes.push(...batch),
    onReset: () => undefined,
    onStatus: () => undefined,
    onSessionChanged: () => undefined,
  });
  return { conversation, changes, store, config: () => config, created: () => created };
}

describe("Conversation", () => {
  it("keeps text streamed while history loaded, never rolling the snapshot back", async () => {
    const { conversation, changes } = setup({
      history: (emit) => {
        emit(event("assistant.message_delta", { messageId: "a1", deltaContent: "The first " }, { ephemeral: true }));
        emit(event("assistant.message_delta", { messageId: "a1", deltaContent: "and second chunk" }, { ephemeral: true }));
        return [event("user.message", { content: "Hi", messageId: "m1" }), event("assistant.turn_start", { turnId: "t1" })];
      },
    });
    await conversation.attach();
    expect(conversation.timeline.get("a1")).toMatchObject({ text: "The first and second chunk", streaming: true });
    const resent = changes.filter((change) => change.type === "item");
    expect(resent).toEqual([{ type: "item", item: expect.objectContaining({ id: "a1", text: "The first and second chunk" }) }]);
    expect(conversation.status).toMatchObject({ attach: "live", busy: true });
    await conversation.detach("test");
  });

  it("lets go of a waiting approval on detach so the platform delivers it again later", async () => {
    const { conversation, config } = setup();
    await conversation.attach();
    const decision = config().onPermissionRequest!({
      kind: "custom-tool",
      toolName: "send_email",
      toolCallId: "c1",
      toolDescription: "",
      args: { to: ["sam@contoso.example"], subject: "Hi", body: "Hello" },
    } as PermissionRequest);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(conversation.timeline.get("approval:c1")).toMatchObject({ status: "pending", actionable: true });
    await conversation.detach("test");
    expect(await decision).toEqual({ kind: "no-result" });
    expect(conversation.timeline.get("approval:c1")).toMatchObject({ status: "pending", actionable: false });
  });

  it("doesn't start a new conversation when it can't look up the existing one", async () => {
    const { conversation, created } = setup({
      storedSessionId: null,
      listSessions: async () => {
        throw new Error("fetch failed");
      },
    });
    await expect(conversation.attach()).rejects.toMatchObject({ code: "discovery_failed" });
    expect(created()).toBe(0);
    expect(conversation.state).toBe("error");
  });
});
