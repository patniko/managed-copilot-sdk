/**
 * Incremental parser for `text/event-stream` (the WHATWG server-sent events format).
 *
 * The console cannot use `EventSource` (it cannot send the console request header), so it reads the stream with
 * `fetch` and feeds decoded text chunks here. Chunks may split lines, CRLF pairs, or multi-byte characters anywhere;
 * decode with `TextDecoder(..., { stream: true })` before pushing.
 */
export interface SseMessage {
  /** The `event:` field, or `message` when the block had none. */
  readonly event: string;
  /** `data:` lines joined with `\n`. */
  readonly data: string;
  /** The last `id:` seen on the stream (it persists across messages, as in `EventSource`). */
  readonly id: string | undefined;
}

export class SseParser {
  #buffer = "";
  #pendingCarriageReturn = false;
  #started = false;
  #event = "";
  #data: string[] = [];
  #lastEventId: string | undefined;
  #comments = 0;
  #retryMs: number | undefined;

  /** Comment lines (`: ping` heartbeats) seen so far. */
  get comments(): number {
    return this.#comments;
  }

  /** The last valid `retry:` value, in milliseconds. */
  get retryMs(): number | undefined {
    return this.#retryMs;
  }

  get lastEventId(): string | undefined {
    return this.#lastEventId;
  }

  /** Feeds decoded text; returns the messages completed by it, in order. */
  push(chunk: string): SseMessage[] {
    const messages: SseMessage[] = [];
    let text = chunk;
    if (!this.#started) {
      if (text.length === 0) return messages;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      this.#started = true;
    }
    if (this.#pendingCarriageReturn) {
      this.#pendingCarriageReturn = false;
      if (text.startsWith("\n")) text = text.slice(1);
    }
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code !== 10 && code !== 13) continue;
      const line = this.#buffer + text.slice(start, index);
      this.#buffer = "";
      this.#line(line, messages);
      if (code === 13) {
        if (index + 1 < text.length) {
          if (text.charCodeAt(index + 1) === 10) index += 1;
        } else {
          this.#pendingCarriageReturn = true;
        }
      }
      start = index + 1;
    }
    this.#buffer += text.slice(start);
    return messages;
  }

  /** Forgets a partial block, e.g. before reusing the parser for a new connection (the last event ID is kept). */
  reset(): void {
    this.#buffer = "";
    this.#pendingCarriageReturn = false;
    this.#started = false;
    this.#event = "";
    this.#data = [];
  }

  #line(line: string, messages: SseMessage[]): void {
    if (line === "") {
      this.#dispatch(messages);
      return;
    }
    if (line.startsWith(":")) {
      this.#comments += 1;
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.#event = value;
        break;
      case "data":
        this.#data.push(value);
        break;
      case "id":
        if (!value.includes("\u0000")) this.#lastEventId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.#retryMs = Number(value);
        break;
      default:
        break;
    }
  }

  #dispatch(messages: SseMessage[]): void {
    if (this.#data.length === 0) {
      this.#event = "";
      return;
    }
    messages.push({ event: this.#event || "message", data: this.#data.join("\n"), id: this.#lastEventId });
    this.#event = "";
    this.#data = [];
  }
}

/** Parses a whole SSE text at once (tests and fixtures). */
export function parseSse(text: string): SseMessage[] {
  return new SseParser().push(text);
}
