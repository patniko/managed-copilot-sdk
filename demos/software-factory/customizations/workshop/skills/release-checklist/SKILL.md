---
name: release-checklist
description: The software factory's release checklist for integrating parallel tasks into one verified, documented deliverable
---
# Release checklist

1. **Inventory.** Read `.factory/release.json` and `.factory/REVIEWS.md`, then list the project files. Every task's
   owned files should be present.
2. **Conflicts.** If `.factory/conflicts/` exists, merge each task's version of the file into the project copy and
   keep both tasks' intent.
3. **Wiring.** Check that `package.json` `bin` entries point at existing files with a `#!/usr/bin/env node` shebang
   and that cross-task imports use the paths and exports the plan's interfaces promise. Fix mismatches minimally.
4. **Integration test.** Create `test/integration.test.js` that exercises the integration notes end to end through
   the public entry points, for example by running each command with `child_process.spawnSync(process.execPath, ...)`.
   Follow the `node-project` skill's portability rules: resolve files with `fileURLToPath`, never `URL.pathname`.
5. **README.md.** Cover: what the project does, requirements (Node.js 24), usage for every command with flags and an
   example, the library API if any, and how to run the tests (`npm test`).
6. **Verify.** Run `npm run check:release`. Fix failures and repeat until it passes. If a task's own tests fail
   after integration, fix the integration, not the test, unless the test contradicts the plan.
7. **Release notes.** Write `outputs/RELEASE.md`:

   ```markdown
   # <project> 0.1.0

   <one-paragraph summary of what was built>

   ## Highlights
   - <one bullet per command or feature>

   ## Verification
   - <N> tests passed (<task tests> task tests + <M> integration tests)

   ## Review
   - <one bullet per task: approved in round N, or sent back and what changed (from .factory/REVIEWS.md)>

   ## Notes
   - <integration fixes you made, accepted review findings, known limitations>
   ```

8. **Summary.** Reply with three or four sentences: what shipped, test totals, and anything a human should check.
