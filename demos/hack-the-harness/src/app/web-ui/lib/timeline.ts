import type { SessionEvent } from "@github/copilot-sdk";

export type TimelineItem =
  | { kind: "user" | "assistant" | "error"; id: string; content: string; attachments?: string[] }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; output?: { content: string }; success?: boolean; error?: string };

// Combines persisted history with live events, without duplicates.
export function mergeEvents(history: SessionEvent[], live: SessionEvent[]): SessionEvent[] {
  const events = new Map<string, SessionEvent>();

  for (const event of [...history, ...live]) {
    events.set(event.id, event);
  }

  return [...events.values()];
}

// Turns SDK session events into the messages and tool calls shown in the chat.
// The server puts a <file path="..." /> element before the prompt for each attached file.
export const fileElements = /^(<file path="[^"]*" \/>\n)*/;

export function timeline(events: SessionEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const messages = new Map<string, { content: string }>();
  const tools = new Map<string, Extract<TimelineItem, { kind: "tool" }>>();

  // Once a message is complete, ignore its streamed deltas.
  const completed = new Set(events.flatMap(event =>
    event.type === "assistant.message" && event.data.content ? [event.data.messageId] : []));

  for (const event of events) {
    switch (event.type) {
      case "user.message": {
        const files = event.data.content.match(fileElements)![0];
        const attachments = [...files.matchAll(/path="(?:[^"]*\/)?([^"]*)"/g)].map(match => match[1]!);

        items.push({
          kind: "user",
          id: event.id,
          content: event.data.content.slice(files.length),
          ...(attachments?.length ? { attachments } : {}),
        });
        break;
      }

      case "assistant.message_delta": {
        if (completed.has(event.data.messageId)) {
          break;
        }

        const message = messages.get(event.data.messageId);

        if (message) {
          message.content += event.data.deltaContent;
        } else {
          const item = { kind: "assistant" as const, id: event.data.messageId, content: event.data.deltaContent };
          messages.set(item.id, item);
          items.push(item);
        }
        break;
      }

      case "assistant.message":
        if (event.data.content) {
          items.push({ kind: "assistant", id: event.data.messageId, content: event.data.content });
        }
        break;

      case "tool.execution_start": {
        const item = {
          kind: "tool" as const,
          id: event.data.toolCallId,
          name: event.data.toolName,
          input: (event.data.arguments ?? {}) as Record<string, unknown>,
        };
        tools.set(item.id, item);
        items.push(item);
        break;
      }

      case "tool.execution_complete": {
        const tool = tools.get(event.data.toolCallId);

        if (tool) {
          tool.success = event.data.success;
          tool.output = event.data.result;
          tool.error = event.data.error?.message;
        }
        break;
      }

      case "session.error":
        items.push({ kind: "error", id: event.id, content: event.data.message });
        break;

      case "abort":
        items.push({ kind: "assistant", id: event.id, content: "Response stopped." });
        break;
    }
  }

  return items;
}
