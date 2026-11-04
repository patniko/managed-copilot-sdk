/**
 * The web UI's state module, run in Node with a stand-in browser: what one person's requests can leave behind for the
 * next person who signs in on the same browser, and how sent messages settle.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

interface Store {
  loadMe(): Promise<void>;
  signOut(): Promise<void>;
  signIn(request: { email: string; password: string }): Promise<void>;
  startConversation(prompt: string): Promise<boolean>;
  openConversation(id: string): Promise<void>;
  getState(): {
    readonly me: { readonly user: { readonly name: string } | null } | undefined;
    readonly conversations: readonly { readonly id: string }[];
    readonly views: Readonly<Record<string, unknown>>;
    readonly outgoing: Readonly<Record<string, readonly { readonly text: string; readonly messageId?: string }[]>>;
  };
}

const user = (id: string, name: string) => ({ id, kind: "email", name, email: `${id}@example.com`, billing: { route: "foundry", label: "Front Desk's Azure AI Foundry", detail: "" } });
const options = { github: false, localGitHub: false, email: true, inviteRequired: false, appUsers: { available: true } };
const summary = (id: string) => ({ id, title: "Hello", createdAt: "2026-11-04T07:00:00.000Z", updatedAt: "2026-11-04T07:00:00.000Z", route: "foundry", busy: true });

/** Answers each API call from `routes` ("METHOD /path"); a route may return a promise to answer later. */
const routes = new Map<string, (body: unknown) => unknown>();

class FakeEventSource {
  static readonly CLOSED = 2;
  static current: FakeEventSource | undefined;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly #listeners = new Map<string, ((event: { data: string }) => void)[]>();
  constructor() {
    FakeEventSource.current = this;
  }
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  emit(event: { readonly type: string }): void {
    for (const listener of this.#listeners.get(event.type) ?? []) listener({ data: JSON.stringify(event) });
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

let store: Store;

beforeAll(async () => {
  const location = { pathname: "/", search: "" };
  const go = (_state: unknown, _title: string, href: string) => {
    location.pathname = href;
  };
  vi.stubGlobal("window", { location, history: { pushState: go, replaceState: go }, addEventListener: () => undefined });
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", async (path: string, init: { method?: string; body?: string } = {}) => {
    const route = routes.get(`${init.method ?? "GET"} ${path}`);
    if (!route) return new Response(JSON.stringify({ error: { code: "not_found", message: "No such route." } }), { status: 404 });
    const payload = await route(init.body ? JSON.parse(init.body) : undefined);
    return payload === undefined ? new Response(null, { status: 204 }) : new Response(JSON.stringify(payload), { status: 200 });
  });
  // A variable path keeps the server's TypeScript project (no DOM types) from checking the browser module.
  const path = "../src/web/lib/store.js";
  store = (await import(/* @vite-ignore */ path)) as Store;
});

describe("the web UI's state", () => {
  it("drops a reply to a request made for someone who has since signed out", async () => {
    routes.set("GET /api/me", () => ({ user: user("alice", "Alice"), options }));
    routes.set("GET /api/conversations", () => []);
    await store.loadMe();
    expect(store.getState().me?.user?.name).toBe("Alice");

    let answer!: (value: unknown) => void;
    routes.set("POST /api/conversations", () => new Promise((resolve) => (answer = resolve)));
    const started = store.startConversation("Alice's private question");
    routes.set("POST /api/auth/signout", () => undefined);
    await store.signOut();
    routes.set("POST /api/auth/signin", () => ({ user: user("bob", "Bob") }));
    await store.signIn({ email: "bob@example.com", password: "correct horse battery" });
    expect(store.getState().me?.user?.name).toBe("Bob");

    // Alice's request answers only now, while Bob is signed in: none of it may reach Bob's view.
    answer({ conversation: summary("c-alice"), messageId: "m-alice" });
    expect(await started).toBe(false);
    const state = store.getState();
    expect(state.conversations.map((item) => item.id)).not.toContain("c-alice");
    expect(state.views["c-alice"]).toBeUndefined();
    expect(JSON.stringify(state.outgoing)).not.toContain("Alice's private question");
  });

  it("settles a sent message whose event arrived before the reply that created its conversation", async () => {
    routes.set("GET /api/me", () => ({ user: user("carol", "Carol"), options }));
    routes.set("GET /api/conversations", () => []);
    await store.loadMe();
    let answer!: (value: unknown) => void;
    routes.set("POST /api/conversations", () => new Promise((resolve) => (answer = resolve)));
    const started = store.startConversation("Hello there");
    // The live event for the message comes first, before Front Desk's reply says which conversation it's in.
    FakeEventSource.current!.emit({ type: "item", conversationId: "c-carol", item: { kind: "user", id: "m-carol", text: "Hello there", at: "2026-11-04T07:00:00.000Z" } } as never);
    answer({ conversation: summary("c-carol"), messageId: "m-carol" });
    expect(await started).toBe(true);
    routes.set("GET /api/conversations/c-carol", () => ({ ...summary("c-carol"), busy: false, items: [{ kind: "user", id: "m-carol", text: "Hello there", at: "2026-11-04T07:00:00.000Z" }] }));
    await store.openConversation("c-carol");
    expect(store.getState().outgoing["c-carol"] ?? []).toEqual([]);
  });

  it("forgets everything of the last person once the server says nobody is signed in here", async () => {
    routes.set("GET /api/me", () => ({ user: user("dana", "Dana"), options }));
    routes.set("GET /api/conversations", () => [summary("c-dana")]);
    routes.set("GET /api/conversations/c-dana", () => ({ ...summary("c-dana"), busy: false, items: [{ kind: "user", id: "m-dana", text: "Dana's private note", at: "2026-11-04T07:00:00.000Z" }] }));
    await store.loadMe();
    await store.openConversation("c-dana");
    expect(store.getState().views["c-dana"]).toBeDefined();

    // Dana signed out in another tab: this tab's next check of who is signed in says nobody.
    routes.set("GET /api/me", () => ({ user: null, options }));
    await store.loadMe();
    const state = store.getState();
    expect(state.me?.user).toBeNull();
    expect(state.conversations).toEqual([]);
    expect(state.views).toEqual({});
    expect(JSON.stringify(state)).not.toContain("Dana's private note");
  });

  it("keeps what the same person has in flight when it checks again who is signed in", async () => {
    routes.set("GET /api/me", () => ({ user: user("erin", "Erin"), options }));
    routes.set("GET /api/conversations", () => []);
    await store.loadMe();
    let answer!: (value: unknown) => void;
    routes.set("POST /api/conversations", () => new Promise((resolve) => (answer = resolve)));
    const started = store.startConversation("Plan my week");
    // The live-events stream reconnects and checks again: still Erin.
    await store.loadMe();
    answer({ conversation: summary("c-erin"), messageId: "m-erin" });
    expect(await started).toBe(true);
    expect(store.getState().outgoing["new"] ?? []).toEqual([]);
  });
});
