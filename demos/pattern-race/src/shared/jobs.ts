/** The jobs a race can run: one prompt, sent unchanged to every lane. Shared by the server and the page. */

export type JobId = "answer" | "code" | "split";

/** A value a correct answer contains. The server computes it; the page shows only the label. */
export type Expectation =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "sha256"; readonly text: string }
  | { readonly kind: "primes-below"; readonly n: number }
  | { readonly kind: "digit-sum-of-power"; readonly base: number; readonly exponent: number }
  | { readonly kind: "collatz-longer-than"; readonly below: number; readonly steps: number };

export interface Check {
  readonly label: string;
  readonly expect: Expectation;
}

export interface Job {
  readonly id: JobId;
  readonly title: string;
  /** One short line for the picker. */
  readonly summary: string;
  readonly prompt: string;
  /** Whether the job needs a shell: a lane without one can't do it. */
  readonly needsShell: boolean;
  readonly checks: readonly Check[];
}

export const SHA_TEXT = "Managed Copilot pattern race";

export const JOBS: readonly Job[] = [
  {
    id: "answer",
    title: "Quick answer",
    summary: "No code needed",
    prompt: "A customer ordered 3 tents at $249 each and 2 sleeping bags at $89 each. What is the order total? Reply in one sentence.",
    needsShell: false,
    checks: [{ label: "Order total", expect: { kind: "value", value: "925" } }],
  },
  {
    id: "code",
    title: "Run code",
    summary: "Needs a shell",
    prompt: `Use Python to compute the SHA-256 hash of the text "${SHA_TEXT}" (UTF-8, no newline). Reply with the hex digest.`,
    needsShell: true,
    checks: [{ label: "SHA-256", expect: { kind: "sha256", text: SHA_TEXT } }],
  },
  {
    id: "split",
    title: "Split the work",
    summary: "Three parallel parts",
    prompt: [
      "Three independent jobs. Do each one with Python, in parallel if you can:",
      "1. Count the prime numbers below 4,500,000.",
      "2. Count the starting numbers below 1,000,000 whose Collatz sequence takes more than 300 steps to reach 1.",
      "3. Sum the digits of 7 to the power 3,000.",
      "Reply with the three answers as a numbered list.",
    ].join("\n"),
    needsShell: true,
    checks: [
      { label: "Primes below 4,500,000", expect: { kind: "primes-below", n: 4_500_000 } },
      { label: "Collatz starts over 300 steps", expect: { kind: "collatz-longer-than", below: 1_000_000, steps: 300 } },
      { label: "Digit sum of 7^3000", expect: { kind: "digit-sum-of-power", base: 7, exponent: 3_000 } },
    ],
  },
];

export const DEFAULT_JOB: JobId = "code";

export function isJobId(value: unknown): value is JobId {
  return typeof value === "string" && JOBS.some((job) => job.id === value);
}

export function jobById(id: JobId): Job {
  const job = JOBS.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`Unknown job "${id}"`);
  return job;
}
