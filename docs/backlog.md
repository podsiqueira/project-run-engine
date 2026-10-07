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

## Trust boundary — result truthfulness

The engine validates the *shape and status* of a submitted `AgentResult` (`stepId`,
`execution_id`, no pending/terminal misuse; transitions derive only from
`status`/`findings`) but does **not** independently verify that the host/agent actually
performed the work it reports. Truthful execution reporting is the host's
responsibility. See `ARCHITECTURE.md` §4.15. No independent verifier is planned or
implied.

## Phase 5

Not started. See `docs/phase-reports.md` for the phase history, entry criteria, and
current state.
