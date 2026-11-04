// The values a correct answer contains, computed here so every lane is judged by the same, independent result.
import { createHash } from "node:crypto";
import type { Check, Expectation, Job } from "../shared/jobs.js";
import type { Verdict } from "../shared/types.js";

const cache = new Map<string, string>();

export function expectedValue(expect: Expectation): string {
  const key = JSON.stringify(expect);
  let value = cache.get(key);
  if (value === undefined) {
    value = compute(expect);
    cache.set(key, value);
  }
  return value;
}

/** Computes every job's expected values once, so judging a lane never waits on them. */
export function warmExpectations(jobs: readonly Job[]): void {
  for (const job of jobs) for (const check of job.checks) expectedValue(check.expect);
}

function compute(expect: Expectation): string {
  switch (expect.kind) {
    case "value":
      return expect.value;
    case "sha256":
      return createHash("sha256").update(expect.text, "utf8").digest("hex");
    case "primes-below":
      return String(countPrimesBelow(expect.n));
    case "collatz-longer-than":
      return String(collatzLongerThan(expect.below, expect.steps));
    case "digit-sum-of-power":
      return String(digitSum(BigInt(expect.base) ** BigInt(expect.exponent)));
  }
}

export function countPrimesBelow(n: number): number {
  const composite = new Uint8Array(Math.max(n, 0));
  let count = 0;
  for (let i = 2; i < n; i++) {
    if (composite[i]) continue;
    count++;
    for (let j = i * i; j < n; j += i) composite[j] = 1;
  }
  return count;
}

/** How many starting numbers below `below` take more than `steps` applications of the Collatz rule to reach 1. */
export function collatzLongerThan(below: number, steps: number): number {
  const known = new Uint16Array(Math.max(below, 2));
  let count = 0;
  for (let start = 2; start < below; start++) {
    let value = start;
    let taken = 0;
    while (value >= start) {
      value = value % 2 === 0 ? value / 2 : 3 * value + 1;
      taken++;
    }
    known[start] = taken + known[value]!;
    if (known[start]! > steps) count++;
  }
  return count;
}

export function digitSum(value: bigint): number {
  let sum = 0;
  for (const digit of value.toString()) sum += digit.charCodeAt(0) - 48;
  return sum;
}

/** Joins digit groups (5,000,000, 5 000 000, 5_000_000) so numbers compare as plain digits. */
function normalize(answer: string): string {
  return answer.toLowerCase().replace(/(\d)[,_'\u00a0\u2009\u202f ](?=\d{3}(?!\d))/g, "$1");
}

function contains(text: string, value: string): boolean {
  if (/^\d+$/.test(value)) return new RegExp(`(?<!\\d)${value}(?!\\d)`).test(text);
  return text.includes(value.toLowerCase());
}

/** Which of a job's expected values an answer contains, and what that makes it. */
export function judge(answer: string | undefined, checks: readonly Check[]): { readonly verdict: Verdict; readonly checks: readonly boolean[] } {
  if (!answer?.trim()) return { verdict: "failed", checks: checks.map(() => false) };
  const text = normalize(answer);
  const results = checks.map((check) => contains(text, expectedValue(check.expect)));
  const found = results.filter(Boolean).length;
  return { verdict: found === checks.length ? "correct" : found > 0 ? "partial" : "missed", checks: results };
}
