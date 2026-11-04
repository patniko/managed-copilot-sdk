import assert from "node:assert/strict";
import { test } from "node:test";
import { bump, nextVersion, releaseType } from "../src/next-version.js";

test("a fix bumps the patch version", () => {
  assert.equal(nextVersion("1.4.2", ["fix: handle an empty changelog"]), "1.4.3");
});

test("a feature bumps the minor version", () => {
  assert.equal(nextVersion("1.4.2", ["feat: add --dry-run"]), "1.5.0");
});

test("a breaking change bumps the major version", () => {
  assert.equal(nextVersion("1.4.2", ["feat!: drop Node 18"]), "2.0.0");
  assert.equal(nextVersion("1.4.2", ["refactor: new config file\n\nBREAKING CHANGE: .bumpkitrc moved"]), "2.0.0");
});

test("docs, chores, and tests don't release", () => {
  assert.equal(nextVersion("1.4.2", ["docs: fix a typo", "chore: update dependencies", "test: cover scopes"]), "1.4.2");
});

test("the biggest change wins", () => {
  assert.equal(nextVersion("1.4.2", ["fix: trim whitespace", "feat(cli): add --json", "docs: usage"]), "1.5.0");
});

test("scopes don't change the release", () => {
  assert.equal(releaseType("fix(parser): accept tabs"), "patch");
  assert.equal(releaseType("perf(core): cache parsed versions"), "patch");
});

test("bump resets the smaller parts", () => {
  assert.equal(bump("1.4.2", "patch"), "1.4.3");
  assert.equal(bump("1.4.2", "minor"), "1.5.0");
  assert.equal(bump("1.4.2", "major"), "2.0.0");
  assert.throws(() => bump("v1", "patch"), TypeError);
});
