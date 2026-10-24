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

  it("never exposes the rest of a secret that begins with another secret", async () => {
    const short = "tok_12345";
    const long = "tok_12345_extended";
    const body = `x ${long} y ${short} z ${long}`;
    for (const secrets of [
      [short, long],
      [long, short],
    ]) {
      for (let split = 1; split < body.length; split++) {
        const { afterEach, final } = await run(secrets, [body.slice(0, split), body.slice(split)]);
        expect(final, `split at ${split}`).toBe("x [redacted] y [redacted] z [redacted]");
        expect(afterEach[0], `split at ${split}`).not.toMatch(/_ext|_12345/);
      }
    }
  });

  it("redacts overlapping and self-similar secrets whole, and never rescans its own marker", async () => {
    const cases: Array<readonly [readonly string[], string, string]> = [
      [["aaaa_secret", "secret_bbbb"], "<aaaa_secret_bbbb>", "<[redacted]>"],
      [["aba_aba"], "<aba_aba_aba>", "<[redacted]>"],
      [["ted]1234"], "ted]12341234", "[redacted]1234"],
      [["secret_one", "ted]_two"], "secret_one_two", "[redacted]_two"],
    ];
    for (const [secrets, body, expected] of cases) {
      for (let split = 0; split <= body.length; split++) {
        expect((await run(secrets, [body.slice(0, split), body.slice(split)])).final, `${body} split at ${split}`).toBe(expected);
      }
    }
  });

  it("handles endless overlapping secrets in bounded time and memory, sending the marker at once", async () => {
    const stream = redactingStream(["aba_aba"]);
    let out = "";
    stream.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    const chunk = Buffer.from("aba_".repeat(1024));
    const started = performance.now();
    for (let i = 0; i < 1024; i++) {
      stream.write(chunk);
      if (i === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        expect(out).toBe("[redacted]");
      }
    }
    // 4 MiB of one continuous overlapping secret: linear work (the reviewed version took seconds for 512 KiB).
    expect(performance.now() - started).toBeLessThan(3_000);
    stream.write(Buffer.from("|tail"));
    await new Promise((resolve) => setImmediate(resolve));
    // The final "_" of "…aba_aba_" belongs to no occurrence of the secret.
    expect(out).toBe("[redacted]_|tail");
    stream.end();
    await new Promise((resolve) => stream.on("end", resolve));
    expect(out).toBe("[redacted]_|tail");
  });

  it("grows a span over alternating overlapping secrets in linear time within one chunk", async () => {
    const started = performance.now();
    const { final } = await run(["init_aaaa", "aaaa_bbbb", "bbbb_aaaa"], [`init_${"aaaa_bbbb_".repeat(50_000)}`]);
    // The reviewed version spent seconds on this 500 KB chunk; the final "_" belongs to no occurrence.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(final).toBe("[redacted]_");
  });

  it("gives the same result however a body is chunked, and never lets a secret through", async () => {
    let seed = 20261024;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pick = () => "ab_"[random(3)]!;
    for (let round = 0; round < 400; round++) {
      const secrets = Array.from({ length: 1 + random(3) }, () => Array.from({ length: 4 + random(5) }, pick).join(""));
      const body = Array.from({ length: 10 + random(30) }, () => (random(3) === 0 ? secrets[random(secrets.length)]! : pick())).join("");
      const chunks: string[] = [];
      for (let start = 0; start < body.length; ) {
        const size = 1 + random(6);
        chunks.push(body.slice(start, start + size));
        start += size;
      }
      const whole = (await run(secrets, [body])).final;
      const { afterEach, final } = await run(secrets, chunks);
      expect(final, JSON.stringify({ secrets, chunks })).toBe(whole);
      for (const secret of secrets) for (const seen of [...afterEach, final]) expect(seen.includes(secret), JSON.stringify({ secrets, chunks })).toBe(false);
    }
  });
});
