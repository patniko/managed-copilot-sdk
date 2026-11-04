import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { collatzLongerThan, countPrimesBelow, digitSum, expectedValue, judge } from "../src/server/checks.js";
import { JOBS, jobById } from "../src/shared/jobs.js";

describe("expected values", () => {
  it("counts primes", () => {
    expect([2, 3, 10, 100, 1_000_000].map(countPrimesBelow)).toEqual([0, 1, 4, 25, 78_498]);
  });

  it("counts Collatz starts that take more than a number of steps, like a brute force does", () => {
    const steps = (start: number) => {
      let value = start;
      let taken = 0;
      while (value !== 1) {
        value = value % 2 === 0 ? value / 2 : 3 * value + 1;
        taken++;
      }
      return taken;
    };
    let brute = 0;
    for (let start = 1; start < 5_000; start++) if (steps(start) > 80) brute++;
    expect(collatzLongerThan(5_000, 80)).toBe(brute);
  });

  it("sums digits of big numbers", () => {
    expect(digitSum(2n ** 15n)).toBe(26);
    expect(digitSum(2n ** 1_000n)).toBe(1_366);
  });

  it("computes every job's values", () => {
    expect(JOBS.find((job) => job.id === "split")!.checks.map((check) => expectedValue(check.expect))).toEqual(["315948", "5617", "11629"]);
    expect(expectedValue({ kind: "sha256", text: "abc" })).toBe(createHash("sha256").update("abc").digest("hex"));
    expect(expectedValue({ kind: "value", value: "925" })).toBe("925");
  });
});

describe("judging an answer", () => {
  const split = jobById("split").checks;

  it("finds numbers written with digit group separators", () => {
    expect(judge("1. 315,948 primes\n2. 5 617 starts\n3. 11_629", split)).toEqual({ verdict: "correct", checks: [true, true, true] });
  });

  it("finds a number only as a whole number", () => {
    expect(judge("1. 3159480\n2. 5617\n3. 111629", split)).toEqual({ verdict: "partial", checks: [false, true, false] });
  });

  it("calls an answer with none of the values missed, and no answer failed", () => {
    expect(judge("I can't run Python here.", split).verdict).toBe("missed");
    expect(judge("  ", split)).toEqual({ verdict: "failed", checks: [false, false, false] });
    expect(judge(undefined, split).verdict).toBe("failed");
  });

  it("matches a digest in any case, and a total with cents", () => {
    const hash = expectedValue({ kind: "sha256", text: "Managed Copilot pattern race" });
    expect(judge(`\`${hash.toUpperCase()}\``, jobById("code").checks).verdict).toBe("correct");
    expect(judge(hash.slice(0, -1), jobById("code").checks).verdict).toBe("missed");
    expect(judge("The order total is $925.00.", jobById("answer").checks).verdict).toBe("correct");
    expect(judge("The order total is $1,925.", jobById("answer").checks).verdict).toBe("missed");
  });
});
