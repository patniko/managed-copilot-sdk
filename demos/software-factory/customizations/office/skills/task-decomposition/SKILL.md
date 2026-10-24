---
name: task-decomposition
description: How to split a software factory work order into independent tasks that parallel builders implement in separate sandboxes
---
# Task decomposition

Each task goes to one builder agent working alone in a fresh sandbox for a few minutes. Builders run in parallel and
never see each other's work until the release stage. A good plan lets every builder finish and test its task
without waiting for anyone.

## Rules

- **1 to 4 tasks**; 2 or 3 is typical. One task per builder-sized piece of work (about 50-300 lines plus tests).
- **Prefer vertical slices** (a whole feature with its own tests) over horizontal layers (parser, then CLI).
  Two independent command-line tools are two tasks; a library and the CLI that wraps it are usually one task.
- **Disjoint files.** Every task lists the files it owns in `files`, including its tests. No two tasks own the same
  file. The factory generates `package.json` from your plan, so never assign it to a task. Put command-line entry
  points in `bin` (command name → `bin/<name>.js`) and assign each bin file to the task that implements it.
- **`dependsOn` sparingly.** A task that needs another task's module at build time lists it in `dependsOn` and
  starts only after that dependency is built and reviewed. Avoid chains: they serialize the factory. Prefer giving
  each slice its own small helpers over sharing a module.
- **Precise interfaces.** In `interface`, write exactly what other tasks or the release stage rely on: exported
  functions with signatures, CLI usage with flags, output formats, and exit codes.
- **Testable acceptance criteria.** 3 to 6 concrete statements per task that a builder can turn into `node:test`
  cases, for example: "`csv2json --pretty` prints 2-space indented JSON".
- **Integration notes.** In `integration`, tell the release agent what to verify end to end (for example a round
  trip through two tools) and what the README must cover.

## Conventions builders follow

- Node.js 24, ES modules (`"type": "module"`), plain JavaScript with JSDoc where helpful.
- Zero runtime dependencies unless the work order requires one.
- Sources in `src/`, executables in `bin/` with a `#!/usr/bin/env node` shebang, tests in `test/<name>.test.js`
  using `node:test` and `node:assert/strict`.
- Command-line tools read from a file path argument or stdin, write results to stdout, and write a one-line error
  to stderr with exit status 1 on bad input.

## Example

For "a CSV to JSON converter and a JSON to CSV converter":

```json
{
  "summary": "Two independent command-line tools, each with its own parser or serializer and tests.",
  "projectName": "csvjson",
  "packageDescription": "Convert between CSV and JSON from the command line",
  "bin": { "csv2json": "bin/csv2json.js", "json2csv": "bin/json2csv.js" },
  "tasks": [
    {
      "id": "csv2json",
      "title": "CSV to JSON command",
      "description": "RFC 4180 CSV parser with type inference and the csv2json CLI.",
      "files": ["src/csv-parse.js", "bin/csv2json.js", "test/csv2json.test.js"],
      "interface": "export function parseCsv(text, { delimiter = \",\" } = {}): string[][]\nCLI: csv2json [file] [--pretty] [--delimiter <char>] [--no-infer]",
      "acceptance": [
        "Quoted fields may contain the delimiter, doubled quotes, and newlines",
        "Numbers and true/false are inferred unless --no-infer is passed; empty fields become null",
        "--pretty prints 2-space indented JSON",
        "A missing file exits with status 1 and a one-line error on stderr"
      ],
      "dependsOn": []
    }
  ],
  "integration": "Verify a round trip: json2csv output parsed by csv2json reproduces the original objects. README: install, usage for both commands, examples."
}
```
