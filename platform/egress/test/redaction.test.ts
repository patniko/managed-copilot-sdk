import { describe, expect, it } from "vitest";
import { redactingStream } from "../src/proxy.js";

const SECRET = "sk_test_51abcdef";

/** Writes `chunks` and returns, after each write, everything emitted so far, plus the final output after end. */
async function run(secrets: readonly string[], chunks: readonly string[]): Promise<{ readonly afterEach: string[]; readonly final: string }> {
  const stream = redactingStream(secrets);
  let out = "";
  stream.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  const afterEach: string[] = [];
  for (const chunk of chunks) {
    stream.write(Buffer.from(chunk, "utf8"));
    await new Promise((resolve) => setImmediate(resolve));
    afterEach.push(out);
  }
  stream.end();
  await new Promise((resolve) => stream.on("end", resolve));
  return { afterEach, final: out };
}

describe("response redaction", () => {
  it("redacts a secret split at any chunk boundary", async () => {
    const body = `{"echo":"Bearer ${SECRET}","again":"${SECRET}"}`;
    for (let split = 1; split < body.length; split++) {
      const { final } = await run([SECRET], [body.slice(0, split), body.slice(split)]);
      expect(final, `split at ${split}`).toBe('{"echo":"Bearer [redacted]","again":"[redacted]"}');
    }
  });

  it("redacts a secret that arrives one byte at a time", async () => {
    const body = `data: ${SECRET}\n\n`;
    const { afterEach, final } = await run([SECRET], [...body]);
    expect(final).toBe("data: [redacted]\n\n");
    for (const partial of afterEach) expect(partial).not.toMatch(/sk_/);
  });

  it("passes events through at once, holding back only what could still become a secret", async () => {
    const event = 'event: message\ndata: {"jsonrpc":"2.0","method":"ping"}\n\n';
    expect((await run([SECRET], [event])).afterEach).toEqual([event]);
    const { afterEach, final } = await run([SECRET], ["data: sk_te", "xt\n\n"]);
    expect(afterEach).toEqual(["data: ", "data: sk_text\n\n"]);
    expect(final).toBe("data: sk_text\n\n");
  });

  it("releases a held tail when the body ends", async () => {
    expect((await run([SECRET, "another-secret"], ["trailing sk_test"])).final).toBe("trailing sk_test");
  });
});
