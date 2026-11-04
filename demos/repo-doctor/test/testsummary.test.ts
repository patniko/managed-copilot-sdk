import { describe, expect, it } from "vitest";
import { parseTestOutput, stripAnsi } from "../src/server/testsummary.js";
import { FAILING_OUTPUT } from "./fakes.js";

describe("parseTestOutput", () => {
  it("reads node --test's spec reporter, once per failing test", () => {
    const output = `${FAILING_OUTPUT}\n✖ failing tests:\n\ntest at test/next-version.test.js:9:1\n✖ a feature bumps the minor version (1.2ms)\n  AssertionError [ERR_ASSERTION]\n`;
    expect(parseTestOutput(output)).toEqual({ total: 6, passed: 4, failed: 2, skipped: 0, failures: ["a feature bumps the minor version", "the biggest change wins"] });
  });

  it("reads node --test's TAP reporter", () => {
    const output = ["TAP version 13", "ok 1 - adds", "not ok 2 - subtracts", "  ---", "  ...", "1..2", "# tests 2", "# suites 0", "# pass 1", "# fail 1", "# cancelled 0", "# skipped 0", "# todo 0"].join("\n");
    expect(parseTestOutput(output)).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0, failures: ["subtracts"] });
  });

  it("reads Jest", () => {
    const output = ["FAIL src/cart.test.js", "  ● cart › applies the discount before tax", "", "Test Suites: 1 failed, 1 total", "Tests:       1 failed, 1 skipped, 5 passed, 7 total", "Time:        1.2 s"].join("\n");
    expect(parseTestOutput(output)).toEqual({ total: 7, passed: 5, failed: 1, skipped: 1, failures: ["cart › applies the discount before tax"] });
  });

  it("reads Vitest, with color codes", () => {
    const output = ["\x1b[31m × \x1b[39mtest/math.test.ts > rounds half up 3ms", "", " Test Files  1 failed (1)", "      Tests  \x1b[31m1 failed\x1b[39m | 3 passed (4)"].join("\n");
    expect(parseTestOutput(output)).toMatchObject({ total: 4, passed: 3, failed: 1, failures: ["test/math.test.ts > rounds half up"] });
  });

  it("reads pytest", () => {
    const output = ["FAILED tests/test_money.py::test_rounding - AssertionError: assert 1.0 == 1.01", "ERROR tests/test_io.py::test_load", "===== 1 failed, 5 passed, 1 skipped, 1 error in 0.42s ====="].join("\n");
    expect(parseTestOutput(output)).toEqual({ total: 8, passed: 5, failed: 2, skipped: 1, failures: ["tests/test_money.py::test_rounding", "tests/test_io.py::test_load"] });
  });

  it("reads unittest", () => {
    const failing = ["FAIL: test_round (tests.test_money.MoneyTest.test_round)", "----------------------------------------------------------------------", "Ran 4 tests in 0.002s", "", "FAILED (failures=1, skipped=1)"].join("\n");
    expect(parseTestOutput(failing)).toEqual({ total: 4, passed: 2, failed: 1, skipped: 1, failures: ["test_round (tests.test_money.MoneyTest.test_round)"] });
    expect(parseTestOutput("Ran 3 tests in 0.001s\n\nOK\n")).toEqual({ total: 3, passed: 3, failed: 0, skipped: 0, failures: [] });
  });

  it("reads Mocha", () => {
    const output = ["  3 passing (12ms)", "  1 failing", "", "  1) parser", "       handles tabs:", "     AssertionError"].join("\n");
    expect(parseTestOutput(output)).toEqual({ total: 4, passed: 3, failed: 1, skipped: 0, failures: ["parser"] });
  });

  it("reads Cargo across test binaries, and Go", () => {
    const cargo = ["test parse::tabs ... FAILED", "test result: FAILED. 4 passed; 1 failed; 0 ignored; 0 measured", "test result: ok. 2 passed; 0 failed; 1 ignored; 0 measured"].join("\n");
    expect(parseTestOutput(cargo)).toEqual({ total: 8, passed: 6, failed: 1, skipped: 1, failures: ["parse::tabs"] });
    const go = ["=== RUN   TestAdd", "--- PASS: TestAdd (0.00s)", "=== RUN   TestRound", "--- FAIL: TestRound (0.00s)", "FAIL", "FAIL\texample.com/money\t0.002s"].join("\n");
    expect(parseTestOutput(go)).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0, failures: ["TestRound"] });
  });

  it("leaves counts it can't read undefined", () => {
    expect(parseTestOutput("make: *** [test] Error 2")).toEqual({ failures: [] });
  });

  it("strips terminal colors", () => {
    expect(stripAnsi("\x1b[32mok\x1b[0m \x1b]8;;https://x\x07link\x1b]8;;\x07")).toBe("ok link");
  });
});
