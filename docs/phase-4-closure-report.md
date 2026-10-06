# Phase 4 Closure Report

This records what the Phase 4 Closure task actually did, verified directly against this
repository's state at the time — not reconstructed from memory. See `ARCHITECTURE.md`
§4.12–§4.14 for the architectural documentation this work produced; this file is the
narrower implementation record.

## What was fixed

A prior architecture review reproduced a real defect: a project configuring
`.project-run/config.json`'s `runtime.default_runtime` (e.g. `"CLAUDE_CODE"`) still saw
dispatch fail against the hardcoded literal `"ANTIGRAVITY"` whenever a call omitted
`runtime` explicitly — exactly the usage pattern the reference Claude Code skill and
`CONSUMER-GUIDE.md` document. Root cause: `context.runtime` was read in several places
but never back-filled with the config-resolved value before the Coordinator's decision
loop ran.

**Fix**: `resolveRuntime()` (`src/project/project-run.ts`) resolves the runtime once,
honoring `explicit argument ?? context/persisted runtime ?? config.runtime.default_runtime
?? "ANTIGRAVITY"`, called at every fresh-start/resume entry point
(`executeProjectRun`, `nextProjectRunStep`'s fresh-start path, `reconstructResumeContext`)
and written onto `context.runtime` before any decision is made.

## Verification performed

- `tests/runtime-default-resolution.test.ts` (5 new tests) added, covering: config
  default honored (push), explicit override still wins (push), config default honored
  (pull), legacy explicit-runtime behavior unchanged, and restart/recovery continuing
  to use the already-resolved runtime.
- Confirmed each new test that should fail pre-fix actually does: temporarily reverted
  the two changed source files (`git stash`) and re-ran the suite — 3 of 5 tests failed
  with the exact originally-reported symptom (`FAILED` / wrong runtime), 2 passed
  unchanged (the explicit-runtime and legacy-path tests, which test pre-existing
  correct behavior). Restored the fix and re-ran — all 5 pass.
- Manually reproduced the original live failure against the same disposable fixture
  repository the architecture review used, before the fix (confirmed the exact
  "`Agent SPECIFICATION does not support runtime ANTIGRAVITY`" error) and after
  (confirmed a clean `AGENT_ACTION_REQUIRED` response with `runtime` omitted).
- Full suite: see the final report's Validation table for the exact test count.

## What was not changed

- No architectural redesign. `Coordinator`, `CoordinatorDecisionEngine`, and
  `AgentDispatcher` are unchanged in structure; only `resolveRuntime()` is new, and it
  is called from existing entry points, not a new orchestration path.
- The concurrent-submission race identified in the same review (`FileExecutionStateStore`
  has no locking/optimistic-concurrency check) was deliberately left unaddressed and is
  recorded in `docs/backlog.md` — it is a separate, lower-priority concern this phase
  was explicitly scoped not to solve.
- No new host integration (Cursor, Codex, MCP) was implemented. These remain backlog
  items (`docs/backlog.md`), per this phase's explicit scope limits.
- Git history for Phases 1/2 (which share a single commit) was not rewritten. This
  remains a recorded historical/process observation only.
