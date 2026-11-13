import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../src/server/knowledge.js";
import { KnownIssues } from "../src/server/known-issues.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "help-desk-knowledge-"));
  dirs.push(dir);
  return dir;
};
const source = { customerId: "c01", customerName: "Maya Chen", sessionId: "hd-run-c01" };

describe("the team knowledge base", () => {
  it("keeps proposals and added facts across restarts, newest fact first, skipping a repeat", () => {
    const dir = tempDir();
    const knowledge = new KnowledgeBase(dir);
    expect(knowledge.prompt()).toContain("(empty so far)");
    const weather = knowledge.propose({ ...source, subject: "Weather holds", fact: "UPS weather holds clear within 48 hours." })!;
    const returns = knowledge.propose({ ...source, subject: "Returns", fact: "Return labels expire after 30 days." })!;
    expect(knowledge.propose({ ...source, subject: "weather  holds", fact: "UPS weather holds clear within 48 hours" })).toBeUndefined();
    const spam = knowledge.propose({ ...source, subject: "Liam", fact: "Liam likes tents." })!;
    expect(knowledge.prompt()).toContain("(empty so far)");

    const reopened = new KnowledgeBase(dir);
    expect(reopened.proposals().map((proposal) => proposal.subject)).toEqual(["Weather holds", "Returns", "Liam"]);
    expect(reopened.decide(weather.id, true)).toMatchObject({ subject: "Weather holds", source: { customerId: "c01", name: "Maya Chen", sessionId: "hd-run-c01" } });
    expect(reopened.decide(returns.id, true)).toMatchObject({ subject: "Returns" });
    expect(reopened.decide(spam.id, false)).toBeNull();
    expect(reopened.decide(spam.id, true)).toBeUndefined();
    expect(reopened.proposals()).toEqual([]);
    expect(reopened.list().map((entry) => entry.subject)).toEqual(["Returns", "Weather holds"]);
    expect(reopened.prompt()).toContain("Returns: Return labels expire after 30 days.");
    expect(reopened.prompt()).not.toContain("Liam");
    // Already known: not proposed again.
    expect(reopened.propose({ ...source, subject: "Returns", fact: "Return labels expire after 30 days." })).toBeUndefined();
    expect(reopened.remove(reopened.list()[1]!.id)).toBe(true);
    expect(reopened.remove("nope")).toBe(false);
    const file = JSON.parse(readFileSync(join(dir, "knowledge.json"), "utf8"));
    expect(file.entries).toHaveLength(1);
    expect(file.proposals).toEqual([]);
  });

  it("refuses to start from a damaged file instead of losing what it holds", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "knowledge.json"), "{not json");
    expect(() => new KnowledgeBase(dir)).toThrow(/isn't valid JSON/);
  });
});

describe("known issues", () => {
  it("are kept across restarts with their latest answer, and an answer a restart cut short says so", () => {
    const dir = tempDir();
    const issues = new KnownIssues(dir);
    expect(issues.prompt("customer")).toBe("");
    const proposal = new KnowledgeBase(dir).propose({ ...source, kind: "known-issue", subject: "Launch code rejected", fact: "Type TRAIL15 in capitals.", symptoms: "trail15 says Invalid code" })!;
    const issue = issues.record(proposal, "octocat");
    issues.answer(issue.id, {
      startedAt: "2026-11-12T17:40:00.000Z",
      startedBy: "octocat",
      tickets: [
        { sessionId: "hd-run-c05", customerId: "c05", name: "Aisha Khan", state: "replied", matched: true },
        { sessionId: "hd-run-c08", customerId: "c08", name: "Lucas Silva", state: "classifying" },
      ],
    });

    const reopened = new KnownIssues(dir);
    expect(reopened.list()).toEqual([expect.objectContaining({ title: "Launch code rejected", symptoms: "trail15 says Invalid code", update: "Type TRAIL15 in capitals.", recordedBy: "octocat" })]);
    const answer = reopened.list()[0]!.answer!;
    expect(answer.finishedAt).toEqual(expect.any(String));
    expect(answer.tickets.map((ticket) => ticket.state)).toEqual(["replied", "failed"]);
    expect(answer.tickets[1]!.message).toMatch(/restarted/);
    expect(reopened.prompt("customer")).toContain("- Launch code rejected (customers describe it as: trail15 says Invalid code): Type TRAIL15 in capitals.");
    expect(reopened.remove(issue.id)).toBe(true);
    expect(new KnownIssues(dir).list()).toEqual([]);
  });
});
