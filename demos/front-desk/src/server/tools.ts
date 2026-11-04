/**
 * The agent's memory tools: standard SDK `defineTool` declarations whose handlers run in this server. Each session gets
 * its own set, bound to the person it belongs to when it was created or resumed: the person comes from the server's
 * sign-in, never from the model's arguments, so no prompt can reach someone else's memory.
 */
import { defineTool, type Tool, type ToolResultObject, type ZodSchema } from "@github/copilot-sdk";
import { z } from "zod";
import { LIMITS } from "../shared/types.js";
import { log } from "./log.js";
import type { Store } from "./store.js";

export const MEMORY_TOOLS = ["remember", "recall", "forget"] as const;
export type MemoryTool = (typeof MEMORY_TOOLS)[number];
export const isMemoryTool = (name: string): name is MemoryTool => (MEMORY_TOOLS as readonly string[]).includes(name);

function failure(message: string): ToolResultObject {
  return { textResultForLlm: message, resultType: "failure", error: message };
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);

/** Memories that share a word with the query (all of them for an empty query), best matches first. */
export function searchMemories<T extends { text: string }>(memories: readonly T[], query: string | undefined, limit = 25): T[] {
  const wanted = words(query ?? "");
  if (wanted.length === 0) return memories.slice(-limit);
  return memories
    .map((memory) => {
      const have = new Set(words(memory.text));
      return { memory, score: wanted.filter((word) => have.has(word) || [...have].some((candidate) => candidate.startsWith(word))).length };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.memory);
}

export interface MemoryToolOptions {
  readonly store: Store;
  /** The person this session belongs to. */
  readonly userId: string;
  /** Called after the person's memory changed (to refresh their memory panel). */
  readonly onChange: () => void;
}

export function memoryTools({ store, userId, onChange }: MemoryToolOptions): Tool<any>[] {
  const define = <S extends z.ZodType>(name: MemoryTool, description: string, parameters: S, handler: (args: z.infer<S>) => unknown): Tool<any> =>
    defineTool<unknown>(name, {
      description,
      parameters: parameters as unknown as ZodSchema<unknown>,
      // Reading and writing the person's own notes needs no approval.
      skipPermission: true,
      handler: async (raw) => {
        const parsed = parameters.safeParse(raw ?? {});
        if (!parsed.success) return failure(`Invalid arguments for ${name}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
        try {
          return await handler(parsed.data);
        } catch (error) {
          log.error("A memory tool failed", { tool: name, error: (error as Error).message });
          return failure(`${name} didn't work. Tell the person and suggest trying again.`);
        }
      },
    });

  return [
    define(
      "remember",
      "Save one fact or preference the person wants you to remember in future conversations, in their own words, as a short sentence about them (\"Prefers metric units\"). Only for things they ask you to remember or clearly want kept.",
      z.object({ fact: z.string().trim().min(1).max(LIMITS.memory).describe("The fact, as a short sentence about the person") }),
      ({ fact }) => {
        const existing = store.listMemories(userId).find((memory) => memory.text.toLowerCase() === fact.toLowerCase());
        if (existing) return `Already remembered (id ${existing.id}).`;
        const saved = store.addMemory(userId, fact, LIMITS.memoriesPerPerson);
        if (!saved) return failure(`The person's memory is full (${LIMITS.memoriesPerPerson} items). Ask them to remove some in the Memory panel.`);
        onChange();
        return `Remembered (id ${saved.id}).`;
      },
    ),
    define(
      "recall",
      "Look up what you remember about the person you're talking to: facts and preferences they asked you to keep. Pass words to search for, or nothing to list everything. Only this person's memory is searched; you can't see anyone else's.",
      z.object({ query: z.string().trim().max(200).optional().describe("Words to look for; omit to list everything") }),
      ({ query }) => {
        const found = searchMemories(store.listMemories(userId), query);
        if (found.length === 0) return query ? `Nothing remembered about "${query}".` : "Nothing remembered yet.";
        return found.map((memory) => `- ${memory.text} (id ${memory.id}, saved ${memory.createdAt.slice(0, 10)})`).join("\n");
      },
    ),
    define(
      "forget",
      "Forget one remembered item by its id (from recall), when the person asks you to forget it or it's no longer true.",
      z.object({ id: z.string().trim().min(1).max(64).describe("The id recall showed") }),
      ({ id }) => {
        if (!store.deleteMemory(userId, id)) return failure(`There's no remembered item with id ${id}. Use recall to find it.`);
        onChange();
        return "Forgotten.";
      },
    ),
  ];
}
