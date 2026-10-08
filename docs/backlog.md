# Backlog: Future Host Integrations & Hardening

This tracks work deliberately **not** implemented yet, to keep `project-run-engine`'s
core provider-neutral and avoid speculative scope creep. See `ARCHITECTURE.md` §4.13
for how these fit the overall architecture, and `docs/phase-reports.md` for phase
history. None of these are scheduled; they are recorded so the engine's
provider-neutral boundary stays a deliberate choice, not an accidental gap.

**Host split**: *current* — Claude Code (live-validated in Phase 4) and Antigravity
(supported target; not yet live-validated). *Backlog* — Cursor, Codex, MCP.

**Sequencing decision (after `0.3.0`)**: the persistence work (checkpoint write failures, the revisioned
store contract — `ARCHITECTURE.md` §4.17) changes what a host can rely on and must handle
(`failureCode`: `CHECKPOINT_WRITE_FAILED`, `CHECKPOINT_CONFLICT`). The four integrations below are
therefore **deferred until that release (`0.4.0`) is out**, so no host integration is built on, or hides,
a persistence limitation. They stay thin: a skill/adapter or transport over
`nextProjectRunStep`/`submitProjectRunStep`, with no provider SDK in the core, no provider branch in
the Coordinator, no second persistence mechanism and no workflow logic of their own. None is started.

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

## Execution persistence under concurrent submission — ADDRESSED in Phase 5 (cross-machine / optimistic concurrency still DEFERRED)

**Original observation (kept for history)**: `FileExecutionStateStore` persisted with plain
file read/modify/write — no locking, no atomic replace, no optimistic-concurrency check.
Two near-simultaneous `submitProjectRunStep()` calls for the same pending action could
both pass validation (`STALE_STEP` etc.) before either wrote, and simultaneous writes from
independent hosts could race. It was deferred because only one host at a time had been
validated.

**Phase 5 outcome** (`ARCHITECTURE.md` §4.17; `tests/phase5-locking.test.ts`):
- Checkpoint writes are atomic (temp file + fsync + rename). Reproduced beforehand: a reader
  racing a writer in another process got "Unexpected end of JSON input" from `load()`.
- A per-execution advisory lock (`FileExecutionStateStore.withLock` / `withExecutionLock`)
  now serialises every mutating turn — `submitProjectRunStep`, mutating
  `nextProjectRunStep`, `resume`, and `start`/`executeProjectRun` with an id. Reads stay
  unlocked. Dead holders are reclaimed by pid probe; contention surfaces as a non-terminal
  `EXECUTION_LOCKED` failure, and an unusable runs directory as a non-terminal
  `EXECUTION_LOCK_UNAVAILABLE` (the engine fails closed rather than run unlocked). Verified
  with real OS processes, including SIGKILL.
- Duplicate-submission idempotency is preserved and is now race-proof.

**Post-`0.3.0` follow-up (unreleased; next release `0.4.0`)** — see `ARCHITECTURE.md` §4.17.1–§4.17.4:
- *Optimistic concurrency* — **contract and file-store implementation delivered**: revisioned
  checkpoints, `save(state, { expectedRevision })` compare-and-swap, `CHECKPOINT_CONFLICT`, an
  exact CAS in the file store independent of the lock, and a host API that accepts any
  `ExecutionStateStore`. A database-backed store itself is **not** built (no concrete backend or
  requirement); the contract and the contract tests are what it would implement.
- *Lock heartbeat* — **evaluated, deferred**: the engine cannot falsely reclaim a live holder's lock, so
  there is no failure for a heartbeat to fix; revisit only on a measured false reclamation or a store
  that needs time-based leases (§4.17.3).
- *Event-stream / payload history* — **evaluated, deferred**: a full lifecycle checkpoint is 8–10 KB with
  compact `history`; no requirement for payload history, replay or an external sink (§4.17.4).

**Still deferred (not decided, not scheduled)**:
- *Cross-machine / network-filesystem coordination.* The file store is scoped to one machine and a
  local filesystem and is **not distributed-safe**. A distributed deployment needs a store whose
  conditional write is atomic across machines (the revision contract above); the engine cannot
  provide that with `node:fs`/`node:path`.
- *A concrete database-backed store.*
- *Mixed-engine-version use of one execution* (older engines don't lock the same way, don't keep
  `revision`, and drop `history`) is unsupported.

## Checkpoint save failures are swallowed — RESOLVED (unreleased; next release `0.4.0`)

`Coordinator.checkpoint()` used to catch and ignore every `stateStore.save()` error (pre-existing,
present since the Coordinator's first checkpointing commit; documented in `0.3.0`). A later write
failure could therefore leave the durable checkpoint at the previous step while the call returned
the next action or a push-mode result, and a later submission failed `STALE_STEP`.

**Resolved**: a checkpoint the engine needs but cannot write is now a `CheckpointWriteError`
(`CHECKPOINT_WRITE_FAILED`), reported by every pull/host/push entry point as a non-terminal failure
with an explicit `failureCode`, describing the last durable checkpoint, never marking the
execution `FAILED`, and recoverable through `next-step` / `resume`. Proven by failing each single save
of full pull and push lifecycles (`tests/checkpoint-save-failures.test.ts`). Contract, recovery and
the one remaining best-effort write (the advisory terminal `FAILED` marker): `ARCHITECTURE.md`
§4.17.1. Found along the way and fixed: an `IN_PROGRESS` checkpoint at `READY_FOR_PR` (crash or failed
`COMPLETED` write) was rejected as completed and could never finish.

## Observations (not engine contract; no action scheduled)

- `created_at` in a checkpoint is rewritten on every save (it equals `updated_at`), so it is not the
  creation time. Nothing in the engine reads it; fixing it means preserving it across saves. Found
  during the post-`0.3.0` persistence review.
- The `README.md` persisted-state field list described names that never matched the code
  (`schema_version`, `current_state`, `timestamps`); corrected to the real fields with the
  revision work. The code was right; the documentation was wrong.
- A TypeScript subclass of `FileExecutionStateStore` that overrides `save()` with a `Promise<void>`
  return type no longer type-checks (the base now returns `{ revision }`); implementing
  `ExecutionStateStore` yourself is unaffected.

## Phase 5

Complete and released as `0.3.0`: persistence hardening (decision `history`, atomic
checkpoints, per-execution advisory lock). See `docs/phase-reports.md` for the baseline,
evidence, and the release impact (a minor bump, `0.3.0`).
Host integrations (Antigravity, Cursor, Codex, MCP) are **not** part of Phase 5; they remain
the backlog items above.
