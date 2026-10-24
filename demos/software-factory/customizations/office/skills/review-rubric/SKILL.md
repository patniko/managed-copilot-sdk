---
name: review-rubric
description: The software factory's code review rubric for deciding between approve and request_changes
---
# Review rubric

Your review decides whether a task goes to release or back to its builder. Sending work back costs a full build
round, so request changes only when it matters.

## Request changes (`request_changes`) only for

- **blocker**: wrong behavior for an acceptance criterion or the documented interface, a crash on valid input, a
  failing test, or a missing required feature.
- **major**: an acceptance criterion with no test, an unhandled documented error case (wrong exit status or a stack
  trace instead of a one-line error), or code that only passes because the test is wrong.

## Approve (`approve`) when

- Every acceptance criterion is implemented and tested, and the test report shows no failures.
- Remaining issues are **minor**: naming, style, small duplication, extra comments, or optional improvements.
  Report them as minor findings; they do not block approval.

## Findings

- At most 6 findings, most severe first.
- Each finding names the file and, when possible, the line, says what is wrong, and says what to change. Write
  findings so the builder can act on them without asking questions.
- Do not request rewrites, new features beyond the task, new dependencies, or stylistic changes.

## Later rounds

When you review a resubmission, check whether each earlier finding was fixed. Do not introduce new minor
complaints. Approve once blockers and majors are resolved.
