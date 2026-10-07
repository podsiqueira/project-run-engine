# Backlog: Future Host Integrations & Hardening

This tracks work deliberately **not** implemented yet, to keep `project-run-engine`'s
core provider-neutral and avoid speculative scope creep. See `ARCHITECTURE.md` §4.13
for how these fit the overall architecture, and `docs/phase-reports.md` for phase
history. None of these are scheduled; they are recorded so the engine's
provider-neutral boundary stays a deliberate choice, not an accidental gap.

**Host split**: *current* — Claude Code (live-validated in Phase 4) and Antigravity
(supported target; not yet live-validated). *Backlog* — Cursor, Codex, MCP.

## Host Integration — Antigravity

**Purpose**: Validate that the same provider-neutral pull contract
(`nextProjectRunStep`/`submitProjectRunStep`, or the push-based `ProjectRunHost`) can be
driven by an Antigravity host without changing any engine internals — the same proof
Phase 4 performed for Claude Code, but for the other long-standing supported runtime
identifier (`AgentRuntime` already includes `"ANTIGRAVITY"`).

**Not done**: No Antigravity-specific code, skill, or adapter exists in this repository.

## Host Integration — Cursor

**Purpose**: Validate the provider-neutral pull contract with Cursor, when Cursor is
available for testing. Conceptual integration notes already exist (`ARCHITECTURE.md`
§4.7–§4.8); no implementation.

## Host Integration — Codex

**Purpose**: Validate the provider-neutral pull contract with Codex, when Codex is
available for testing. Conceptual integration notes already exist (`ARCHITECTURE.md`
§4.7–§4.8); no implementation.

## MCP Transport

**Purpose**: Evaluate MCP as an optional transport/integration mechanism for hosts that
benefit from it (Cursor and Codex both commonly support it per `ARCHITECTURE.md` §4.7).
MCP must remain an **integration/transport concern** carrying the existing
`PROJECT_ENGINE_RUN_TOOL_SCHEMA`, never an engine architectural dependency — the engine
itself must never import an MCP SDK.

## Execution persistence under concurrent submission — DEFERRED

**Current behavior**: `FileExecutionStateStore` persists with plain file
read/modify/write (`src/project/state-store.ts`) — no locking, no atomic replace, no
optimistic-concurrency check. Two near-simultaneous `submitProjectRunStep()` calls for
the same pending action can both pass validation (`STALE_STEP` etc.) before either
writes, and simultaneous writes from independent hosts could race.

**Why deferred**: not a blocker for the supported model — one host / one session
driving an execution at a time, which is what Phases 3–4 validated. There is no current
multi-host simultaneous-write requirement.

**Revisit when**: real multi-host concurrent execution (more than one host submitting
against the same `executionId` at the same time) becomes a supported requirement. Not
before.

**Open directions** (none selected, none decided): stronger persistence semantics,
optimistic concurrency, locking, or a database-backed store.

## Known limitation — `status().history` is always empty

The persisted checkpoint does not retain a step-by-step event stream; only a live
`Coordinator.run()` result carries `history`. `statusProjectRun()` therefore returns
`history: []` and a `stepsCount` approximated from the persisted `iteration` counter
(`src/host/status.ts`; `ARCHITECTURE.md` §4.4). **Impact**: a host that needs the exact
step sequence must observe it live via `onEvent` during the call that produced it; a
restarted host can recover state, pending action, and findings, but not past steps.
Still true as of `0.1.1`. Status persistence is intentionally not redesigned here.
The broader audit-record consequence observed in a real run is tracked as **ENG-002**
below.

## Trust boundary — result truthfulness

The engine validates the *shape and status* of a submitted `AgentResult` (`stepId`,
`execution_id`, no pending/terminal misuse; transitions derive only from
`status`/`findings`) but does **not** independently verify that the host/agent actually
performed the work it reports. Truthful execution reporting is the host's
responsibility. See `ARCHITECTURE.md` §4.15. No independent verifier is planned or
implied.

## Follow-ups from the Claude cloud lifecycle smoke test

Source: a full pull-mode run (`@incito-labs/project-run-engine` 0.1.1, consumed by the
Incito repo, Claude Code cloud session; feature `007-lifecycle-smoke-test`, execution
`exec-1791412982780-58use`) that reached `COMPLETED` / `READY_FOR_PR` through a real
human-intervention gate. The run's temporary branch, feature files and checkpoint were
deleted afterward, so this section is the retained evidence. All three items are
**OPEN**; none is designed or implemented. Severities are provisional — this
repository has no formal severity taxonomy.

### ENG-001 — Feature-directory bootstrap (MEDIUM, OPEN)

`discoverFeature()` (`src/project/context-discovery.ts`) requires an explicit feature to
already exist as a directory (`<root>/<feature>` or `<root>/specs/<feature>`), otherwise
returns `FEATURE_NOT_DISCOVERED`. For a brand-new feature the `speckit-specify` skill is
what normally creates that directory, but the engine refuses to start — and so never
dispatches `SPECIFY` — until it exists. In the smoke test the host seeded the directory
by hand and retried with an explicit `feature`. Branch matching only recognizes a
folder named after the branch (after stripping `feat/`, `fix/`, … prefixes), so a branch
like `tmp/...` does not auto-discover.

**Open question**: should the engine create the feature workspace, or is the
host/skill intentionally responsible for seeding it? Either way the bootstrap contract
is currently undocumented. **Not decided.**

### ENG-002 — Final execution state loses findings and history (HIGH, OPEN)

A nine-step run with four findings, a human-intervention gate, three human answers,
remediation and an `ANALYZE` re-run returned a final `COMPLETED` response with
`findings: []`, `history: []`, `stepsCount: 1`. Only `human_answers` survived in the
checkpoint. Verified causes in the current code (observations, not a design):

- `history` is not persisted (see the `status().history` limitation above).
- `Coordinator.applyExternalResult()` *replaces* `context.findings` with each submitted
  result's findings rather than accumulating, so the persisted findings describe only
  the latest result — a clean final result yields `[]`.
- `stepsCount` is taken from the persisted workflow `iteration` counter
  (`src/host/status.ts`), not a count of dispatched steps.

**Desired outcome**: the final record lets a reader reconstruct which roles ran, which
findings were raised and remediated, what required human intervention and what the
human decided, which steps were re-run, and the evidence behind the final state. How is
**not decided**; this also bears on the "no event-sourcing" scope limit of earlier
phases.

### ENG-003 — Feature vs. execution vs. branch identity in prerequisite tooling (LOW–MEDIUM, OPEN)

Spec-Kit prerequisite scripts (`.specify/scripts/bash/check-prerequisites.sh`,
`setup-plan.sh`, in the consuming repo — not shipped by this package) printed
`BRANCH: 007-lifecycle-smoke-test`, sourced from `.specify/feature.json`, while the
actual Git branch was `tmp/project-run-lifecycle-smoke`. Three identities are being
conflated in reporting: the feature (`007-lifecycle-smoke-test`), the execution
(`exec-…`), and the Git branch. The engine itself keeps them separate (`execution_id`,
`feature`, `branch` are distinct context fields). **To do**: clarify terminology and the
source of truth for each; do not force feature and branch names to match without an
explicit architectural reason. Likely resolved in the consumer/Spec-Kit tooling rather
than engine source.

## Phase 5

Not started. See `docs/phase-reports.md` for the phase history, entry criteria, and
current state.
