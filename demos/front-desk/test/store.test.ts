import { describe, expect, it } from "vitest";
import { Store } from "../src/server/store.js";

const store = () => new Store(":memory:");

describe("store", () => {
  it("keeps each person's conversations to themselves", () => {
    const db = store();
    const alice = db.createEmailUser({ name: "Alice", email: "alice@example.com", passwordHash: "x" });
    const bob = db.createEmailUser({ name: "Bob", email: "bob@example.com", passwordHash: "x" });
    db.addConversation({ id: "c-alice", userId: alice.id, title: "Alice's", environment: "front-desk", route: "foundry" });

    expect(db.getConversation(alice.id, "c-alice")?.title).toBe("Alice's");
    expect(db.getConversation(bob.id, "c-alice")).toBeUndefined();
    expect(db.listConversations(bob.id)).toEqual([]);
    expect(db.touchConversation(bob.id, "c-alice", "Bob was here")).toBeUndefined();
    expect(db.deleteConversation(bob.id, "c-alice")).toBe(false);
    expect(db.getConversation(alice.id, "c-alice")?.title).toBe("Alice's");
  });

  it("keeps each person's memory to themselves", () => {
    const db = store();
    const alice = db.createEmailUser({ name: "Alice", email: "alice@example.com", passwordHash: "x" });
    const bob = db.createEmailUser({ name: "Bob", email: "bob@example.com", passwordHash: "x" });
    const memory = db.addMemory(alice.id, "Favorite color is teal", 10)!;

    expect(db.listMemories(bob.id)).toEqual([]);
    expect(db.deleteMemory(bob.id, memory.id)).toBe(false);
    expect(db.clearMemories(bob.id)).toBe(0);
    expect(db.listMemories(alice.id).map((item) => item.text)).toEqual(["Favorite color is teal"]);
  });
});
