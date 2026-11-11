// The support team's knowledge base: facts the agents proposed with the runtime's `store_memory` tool and a team member
// added. The stock SDK hands each memory to the session's `memory.storeMemory` callback, which keeps it here as a
// proposal; a team member adds it to the knowledge base or declines it later, outside the agent's turn. Every session
// created or resumed afterwards gets the knowledge base in its instructions, so later conversations start from what
// earlier ones learned. Kept, with the proposals, in `<dataDir>/knowledge.json` when Help Desk has a data directory.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeEntry, MemoryProposal } from "../shared/types.js";

/** What the knowledge base keeps of a memory an agent proposed. */
export interface NewKnowledge {
  readonly subject: string;
  readonly fact: string;
  readonly citations?: string;
  readonly reason?: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly sessionId: string;
}

const MAX_ENTRIES = 200;
const MAX_PROPOSALS = 100;
/** How many entries sessions are told about, newest first: enough to matter, short enough for a cheap model's prompt. */
const PROMPT_ENTRIES = 40;
const FILE = "knowledge.json";

const clip = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const same = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

interface Stored {
  readonly entries: KnowledgeEntry[];
  readonly proposals: MemoryProposal[];
}

const valid = <T extends { id?: unknown; subject?: unknown; fact?: unknown }>(value: unknown): value is T =>
  typeof (value as T)?.id === "string" && typeof (value as T)?.subject === "string" && typeof (value as T)?.fact === "string";

function readFile(file: string): Stored {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], proposals: [] };
    throw new Error(`Couldn't read the team knowledge base at ${file}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`The team knowledge base at ${file} isn't valid JSON. Fix or delete it.`);
  }
  const { entries, proposals } = (parsed ?? {}) as { entries?: unknown; proposals?: unknown };
  if (!Array.isArray(entries)) throw new Error(`The team knowledge base at ${file} has no entries list. Fix or delete it.`);
  return {
    entries: entries.filter((entry) => valid<KnowledgeEntry>(entry)),
    proposals: Array.isArray(proposals) ? proposals.filter((proposal) => valid<MemoryProposal>(proposal)) : [],
  };
}

export class KnowledgeBase {
  readonly #file: string | undefined;
  #entries: KnowledgeEntry[];
  #proposals: MemoryProposal[];

  /** Without `dataDir`, the knowledge base lasts as long as the process. */
  constructor(dataDir?: string) {
    this.#file = dataDir ? join(dataDir, FILE) : undefined;
    const stored = this.#file ? readFile(this.#file) : { entries: [], proposals: [] };
    this.#entries = stored.entries;
    this.#proposals = stored.proposals;
  }

  /** Newest first. */
  list(): readonly KnowledgeEntry[] {
    return this.#entries;
  }

  /** Facts waiting for a team member, oldest first. */
  proposals(): readonly MemoryProposal[] {
    return this.#proposals;
  }

  proposal(id: string): MemoryProposal | undefined {
    return this.#proposals.find((proposal) => proposal.id === id);
  }

  /**
   * Keeps a memory an agent proposed until a team member decides. Returns `undefined` when the knowledge base or a waiting
   * proposal says the same already.
   */
  propose(memory: NewKnowledge, now = new Date()): MemoryProposal | undefined {
    const subject = clip(memory.subject, 80);
    const fact = clip(memory.fact, 500);
    if (!subject || !fact) throw new Error("A memory needs a subject and a fact.");
    const known = [...this.#entries, ...this.#proposals].some((existing) => same(existing.subject) === same(subject) && same(existing.fact) === same(fact));
    if (known) return undefined;
    const citations = clip(memory.citations, 300);
    const reason = clip(memory.reason, 300);
    const proposal: MemoryProposal = {
      id: randomUUID(),
      subject,
      fact,
      ...(citations ? { citations } : {}),
      ...(reason ? { reason } : {}),
      source: { customerId: memory.customerId, name: memory.customerName, sessionId: memory.sessionId },
      at: now.toISOString(),
    };
    this.#save(this.#entries, [...this.#proposals, proposal].slice(-MAX_PROPOSALS));
    return proposal;
  }

  /**
   * A team member's decision on a proposal: added, it joins the knowledge base (an entry that says the same is
   * refreshed); declined, it's dropped. Returns the new entry, `null` when declined, or `undefined` for no such proposal.
   */
  decide(id: string, add: boolean, now = new Date()): KnowledgeEntry | null | undefined {
    const proposal = this.proposal(id);
    if (!proposal) return undefined;
    const proposals = this.#proposals.filter((candidate) => candidate.id !== id);
    if (!add) {
      this.#save(this.#entries, proposals);
      return null;
    }
    const entry: KnowledgeEntry = {
      id: proposal.id,
      subject: proposal.subject,
      fact: proposal.fact,
      ...(proposal.citations ? { citations: proposal.citations } : {}),
      ...(proposal.reason ? { reason: proposal.reason } : {}),
      source: proposal.source,
      at: now.toISOString(),
    };
    const rest = this.#entries.filter((existing) => !(same(existing.subject) === same(entry.subject) && same(existing.fact) === same(entry.fact)));
    this.#save([entry, ...rest].slice(0, MAX_ENTRIES), proposals);
    return entry;
  }

  /** Returns whether there was such an entry. */
  remove(id: string): boolean {
    const rest = this.#entries.filter((entry) => entry.id !== id);
    if (rest.length === this.#entries.length) return false;
    this.#save(rest, this.#proposals);
    return true;
  }

  #save(entries: KnowledgeEntry[], proposals: MemoryProposal[]): void {
    if (this.#file) {
      mkdirSync(join(this.#file, ".."), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ entries, proposals }, null, 2)}\n`);
      renameSync(temporary, this.#file);
    }
    this.#entries = entries;
    this.#proposals = proposals;
  }

  /** The section of every session's instructions that carries the team's knowledge. */
  prompt(): string {
    const entries = this.#entries.slice(0, PROMPT_ENTRIES);
    const lines = [
      "Team knowledge base: facts earlier conversations taught the support team, each approved by a team member. Use them when they apply.",
      ...(entries.length > 0 ? entries.map((entry) => `- ${entry.subject}: ${entry.fact}`) : ["- (empty so far)"]),
      "- The team learns from conversations. When the customer or your tools tell you something the knowledge base doesn't say yet that would help you answer other customers (how a product fits or works, a workaround for a problem with the website, how a store policy plays out), call store_memory once with a short, general fact that names the product, page, or policy it's about. Never put customer names, emails, order numbers, or amounts in it. A team member reviews it later, outside this conversation. Never mention it, the knowledge base, or store_memory to the customer: carry on helping them as if you hadn't called it.",
    ];
    return lines.join("\n");
  }
}
