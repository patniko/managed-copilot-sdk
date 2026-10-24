---
name: node-project
description: Software factory conventions for Node.js 24 libraries and command-line tools, and how to test them with node:test
---
# Node.js project conventions

## Layout

- ES modules (`"type": "module"` is already in `package.json`), plain JavaScript, Node.js 24 built-ins only.
- Library code in `src/`, executables in `bin/`, tests in `test/<name>.test.js`.
- Each executable starts with `#!/usr/bin/env node` and keeps its logic in an exported function so tests can call
  it directly as well as through a child process.

## Command-line tools

- Parse arguments with `parseArgs` from `node:util` (`allowPositionals: true`, `strict: true`). Unknown flags are
  errors.
- Read the input from the file path argument when given, otherwise from stdin:

  ```js
  import { readFile } from "node:fs/promises";

  async function readInput(path) {
    if (path) return readFile(path, "utf8");
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    return text;
  }
  ```

- Write results to stdout. On bad input or a missing file, write one line such as
  `csv2json: cannot read missing.csv` to stderr and exit with status 1. Never print a stack trace for user errors.
- Guard the entry point so importing the module in tests does not run the CLI:

  ```js
  import { pathToFileURL } from "node:url";
  if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
  ```

## Tests

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/csv2json.js", import.meta.url));

test("prints pretty JSON", () => {
  const run = spawnSync(process.execPath, [bin, "--pretty"], { input: "a,b\n1,x\n", encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [{ a: 1, b: "x" }]);
});
```

- Cover every acceptance criterion with at least one test, plus the error cases (missing file, malformed input).
- Use `fs.mkdtempSync(path.join(os.tmpdir(), "case-"))` for temporary files and clean them up.
- Keep tests deterministic and fast: no network, no sleeps.

## Portability

The sandbox is Linux, but customers run the release on Windows and macOS too:

- Turn module URLs into paths with `fileURLToPath(new URL(..., import.meta.url))`. Never use `URL.pathname`, which
  becomes `/C:/...` on Windows.
- Build paths with `path.join`, run child processes with `process.execPath` (never a shebang or shell), and don't
  rely on shell utilities, `/dev/null`, or `/tmp`.
- Compare text after normalizing line endings when output could contain `\r\n`.
