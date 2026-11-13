// Known issues: ongoing problems the whole desk knows about. A team member tells one ticket's agent about a problem in a
// team note; the agent proposes it with `report_known_issue` (it waits in the team knowledge panel like a proposed
// fact); a team member records it. From then on every session created or reopened is told it, and **Answer matching
// tickets** has the decision model pick the open tickets about it and sends each one's agent the update to reply with.
// Kept, with each issue's latest answer, in `<dataDir>/known-issues.json` when Help Desk has a data directory.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { KnownIssue, KnownIssueAnswer, MemoryProposal } from "../shared/types.js";
import type { QuestionSpecs } from "./triage-endpoint.js";

const FILE = "known-issues.json";
const MAX_ISSUES = 20;
/** What a restarted Help Desk says of a ticket it was still classifying or sending an update to. */
const INTERRUPTED = "Help Desk restarted before this finished. Answer matching tickets again.";

const clip = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const same = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const valid = (value: unknown): value is KnownIssue => {
  const issue = value as Partial<KnownIssue> | undefined;
  return typeof issue?.id === "string" && typeof issue.title === "string" && typeof issue.update === "string" && typeof issue.source?.sessionId === "string";
};

/** An answer that was running when Help Desk stopped: what didn't finish failed. */
function interrupted(answer: KnownIssueAnswer | undefined): KnownIssueAnswer | undefined {
  if (!answer || answer.finishedAt) return answer;
  const at = new Date().toISOString();
  return {
    ...answer,
    finishedAt: at,
    tickets: answer.tickets.map((ticket) => (ticket.state === "classifying" || ticket.state === "replying" ? { ...ticket, state: "failed", message: INTERRUPTED, at } : ticket)),
  };
}

function readFile(file: string): KnownIssue[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Couldn't read the known issues at ${file}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`The known issues at ${file} aren't valid JSON. Fix or delete the file.`);
  }
  const issues = (parsed as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) throw new Error(`The known issues at ${file} have no issues list. Fix or delete the file.`);
  return issues.filter(valid).map((issue) => {
    const answer = interrupted(issue.answer);
    const { answer: _stored, ...rest } = issue;
    return { ...rest, symptoms: typeof issue.symptoms === "string" ? issue.symptoms : issue.title, ...(answer ? { answer } : {}) };
  });
}

export class KnownIssues {
  readonly #file: string | undefined;
  #issues: KnownIssue[];

  /** Without `dataDir`, known issues last as long as the process. */
  constructor(dataDir?: string) {
    this.#file = dataDir ? join(dataDir, FILE) : undefined;
    this.#issues = this.#file ? readFile(this.#file) : [];
  }

  /** Newest first. */
  list(): readonly KnownIssue[] {
    return this.#issues;
  }

  get(id: string): KnownIssue | undefined {
    return this.#issues.find((issue) => issue.id === id);
  }

  /** A known issue with this title already, if any. */
  titled(title: string): KnownIssue | undefined {
    return this.#issues.find((issue) => same(issue.title) === same(title));
  }

  /** Records a known issue an agent proposed (`kind: "known-issue"`); one with the same title is replaced. */
  record(proposal: MemoryProposal, recordedBy: string, now = new Date()): KnownIssue {
    const issue: KnownIssue = {
      id: proposal.id || randomUUID(),
      title: clip(proposal.subject, 120),
      symptoms: clip(proposal.symptoms, 500) || clip(proposal.subject, 120),
      update: clip(proposal.fact, 500),
      source: proposal.source,
      recordedAt: now.toISOString(),
      recordedBy,
    };
    this.#save([issue, ...this.#issues.filter((existing) => same(existing.title) !== same(issue.title))].slice(0, MAX_ISSUES));
    return issue;
  }

  /** Sets an issue's latest answer. Returns false when the issue is gone (resolved meanwhile). */
  answer(id: string, answer: KnownIssueAnswer): boolean {
    if (!this.get(id)) return false;
    this.#save(this.#issues.map((issue) => (issue.id === id ? { ...issue, answer } : issue)));
    return true;
  }

  /** Resolves an issue: it's no longer told to new sessions. Returns whether there was such an issue. */
  remove(id: string): boolean {
    const rest = this.#issues.filter((issue) => issue.id !== id);
    if (rest.length === this.#issues.length) return false;
    this.#save(rest);
    return true;
  }

  #save(issues: KnownIssue[]): void {
    if (this.#file) {
      mkdirSync(join(this.#file, ".."), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ issues }, null, 2)}\n`);
      renameSync(temporary, this.#file);
    }
    this.#issues = issues;
  }

  /** The section of every session's instructions that carries the known issues; nothing while there are none. */
  prompt(person: "customer" | "player"): string {
    if (this.#issues.length === 0) return "";
    return [
      `Known issues: ongoing problems the support team is handling, each recorded by a team member. When the ${person}'s problem is one of them, tell them what it says, in your own words.`,
      ...this.#issues.map((issue) => `- ${issue.title} (customers describe it as: ${issue.symptoms}): ${issue.update}`),
    ].join("\n");
  }
}

/** The decision model's question for **Answer matching tickets**: is this ticket about the known issue? */
export function matchQuestions(issue: Pick<KnownIssue, "title" | "symptoms">): QuestionSpecs {
  return {
    matches: {
      instructions: `Is this outdoor gear shop customer's message about a known problem the support team is handling? The problem: ${issue.title}. Customers describe it like this: ${issue.symptoms}`,
      criteria: {
        true: `The customer ran into this problem: ${issue.symptoms}`,
        false: "The customer needs help with something else, even if they mention the same product, order, or page.",
      },
    },
  };
}

export const MATCH = z.object({ matches: z.boolean() });

/** What a matching ticket's agent is sent: the known issue, and to reply to the customer with its update. */
export function updateNote(issue: Pick<KnownIssue, "title" | "update">): string {
  return [
    `Known issue: ${issue.title}. This customer's ticket is about it.`,
    `Reply to the customer now, in your own words, with this update: ${issue.update}`,
    "Keep helping them with anything else they asked.",
  ].join("\n");
}
