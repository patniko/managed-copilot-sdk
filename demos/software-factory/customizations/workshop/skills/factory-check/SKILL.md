---
name: factory-check
description: Run the software factory's test harness, which tests the project and publishes work to outputs/ for the next station
---
# Factory check

The factory check is a deterministic harness that ships with this environment. It runs the project's tests with
Node's built-in test runner, writes a machine-readable test report, and publishes your work under `outputs/`, which
the platform turns into artifacts at the end of your turn. The next factory station only sees what the check
published, so always finish with a passing check.

## Run it

| Station | Command | Same as |
| --- | --- | --- |
| Builder | `npm run check` | `node /opt/managed-copilot/customizations/skills/factory-check/check.mjs` |
| Release | `npm run check:release` | `node /opt/managed-copilot/customizations/skills/factory-check/check.mjs --release` |

Run it from `/workspace`. It takes a few seconds, and it prints the spec reporter's output followed by a summary
line such as `FACTORY_TEST_SUMMARY {"total":9,"passed":9,"failed":0,"skipped":0,"durationMs":412}`.

## What it does

- Finds test files named `*.test.js`, `*.test.mjs`, or `*.spec.js` anywhere in the project except `node_modules`,
  `outputs`, and dot-folders. Name tests like `test/csv2json.test.js`.
- Runs them with `node --test`, five minutes at most.
- Writes `outputs/test-report.json` with every test's name, status, duration, and failure message.
- Builder: copies the files you added or changed to `outputs/files/` and lists them in `outputs/manifest.json`.
- Release: copies the whole project to `outputs/bundle/`, writes `outputs/project.patch`, and lists the bundle in
  `outputs/manifest.json`.

## Exit status

- `0`: tests ran and all passed.
- `1`: a test failed, a test file failed to load, or the run timed out. Read the failures, fix the code, run again.
- `2`: no test files were found. Add tests named `*.test.js`.

Do not edit files under `outputs/` by hand, except `outputs/NOTES.md` (builders, optional) and
`outputs/RELEASE.md` (release).
