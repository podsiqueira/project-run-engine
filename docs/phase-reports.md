# Phase Reports

A concise, repository-native history of the phases that took `project-run-engine` from
its initial orchestration core to the published `0.1.1` release. Everything here is
traceable to a commit, a test file, or an authoritative document in this repository;
where the repository does not record a detail, this file says so rather than
reconstructing it.

For the architecture itself see `ARCHITECTURE.md`; for work deliberately **not** done,
known limitations, and trust boundaries see `docs/backlog.md`.

## Current status

| Phase | Status |
|---|---|
| Phase 0 — Coordinator safety gates | COMPLETE |
| Phase 1 — Host / HITL orchestration | COMPLETE |
| Phase 2 — Host / Skill contract | COMPLETE |
| Phase 3 — Pull-based execution model | COMPLETE |
| Phase 4 — Real Claude Code host integration | COMPLETE |
| Phase 4 Closure — runtime-default hardening, docs, release | COMPLETE |
| Phase 5 — Persistence hardening | **IMPLEMENTED in source — unreleased** (see [Phase 5](#phase-5--persistence-hardening)) |

Current release: `@incito-labs/project-run-engine@0.2.0` (`package.json`; published to npm,
`latest` dist-tag, verified from a fresh registry install). The Phase 5 work below is
unreleased; because it changes the typed `history` contract it must ship as `0.3.0`, not a
patch.

## Phase 0 — Coordinator safety gates

- **Objective**: make the Coordinator's blocking gates actually reachable from agent
  output.
- **Outcome**: the `CLARIFY` gate previously consulted only `context.blockingAmbiguity`,
  which nothing derived from an `AgentResult`, so a blocking finding from the
  Specification agent was silently discarded. `CLARIFY` now uses the same
  `hasBlockingFindings(context)` mechanism as every other gate (`ANALYZE`,
  `INDEPENDENT_REVIEW`, `RE_REVIEW`, `CONVERGE`); `blockingAmbiguity` remains an explicit
  host override. Resume re-verification was extended to `CLARIFY`.
- **Evidence**: commit `377d347`; `tests/clarify-blocking-safety-gate.test.ts`.
- **Status**: COMPLETE. Two follow-ups from this phase (`BLOCKED`/`FAIL` semantics,
  `ANALYZE` resume staleness) were closed in the Phase 1/2 commit.

## Phase 1 — Host / HITL orchestration

- **Objective**: a defined Human-in-the-Loop round trip and consistent blocking
  semantics.
- **Outcome**: engine-owned HITL contract (`HumanQuestion`, `deriveHumanQuestions`,
  `HumanInterventionRequired`); durable, timestamped persistence of human answers
  (`human_intervention` / `human_answers`) that never mutate a finding directly — the
  responsible agent is always re-dispatched to re-verify; `AgentResult.status ===
  "BLOCKED"` always routes to human intervention; a flat `FAIL` blocks the
  previously-unconditional transitions; `ANALYZE` resume re-verification via a shared
  `shouldReverifyOnResume()` helper.
- **Evidence**: commit `e7df567`; `tests/human-intervention-contract.test.ts`,
  `tests/blocked-status-semantics.test.ts`, `tests/analyze-resume-safety-gate.test.ts`.
- **Status**: COMPLETE. (Phases 1 and 2 share one commit; history was not rewritten.)

## Phase 2 — Host / Skill contract

- **Objective**: a provider-neutral, machine-readable front door for any AI coding-agent
  host.
- **Outcome**: `src/host/` — `ProjectRunHost` (`start`/`resume`/`status`), typed progress
  events, and a provider-neutral skill/tool schema. It wraps the existing
  `executeProjectRun`/`executeProjectResume` unchanged, adds no runtime dependencies,
  and makes the CLI one consumer of the host layer. All changes additive.
- **Evidence**: commit `e7df567`; `tests/host-api.test.ts`,
  `tests/host-status-and-restart.test.ts`, `tests/cli-host-compatibility.test.ts`,
  `tests/host-isolation.test.ts`; `ARCHITECTURE.md` §4.1–§4.10.
- **Status**: COMPLETE. Known limitation carried forward: `status().history` was always
  empty — resolved later, in Phase 5 (`ARCHITECTURE.md` §4.17).

## Phase 3 — Pull-based execution model

- **Gap found**: `start()`/`resume()` are push-based — they run the Coordinator loop to
  completion and invoke an `AgentRuntimeAdapter` per dispatch. A live interactive host
  cannot supply that from one tool call without spawning a nested agent process per
  dispatch.
- **Correction**: `nextProjectRunStep()` returns one `AgentDispatchRequest` at a time;
  the host does the work in its own session and reports the result through
  `submitProjectRunStep()`. Not a second orchestrator: `Coordinator.prepareNextAction()`
  / `applyExternalResult()` and `AgentDispatcher.prepareRequest()` reuse the existing
  decision, checkpoint, and skill-validation paths.
- **Persistence and recovery**: the pending action is persisted literally
  (`PersistedExecutionState.pending_action`, lifecycle status `AWAITING_AGENT_ACTION`),
  so a restarted process recovers the exact `stepId`/`request` from disk. Stale,
  duplicate, forged, and post-terminal submissions return structured `FAILED`
  responses (`STALE_STEP`, `NO_PENDING_ACTION`, `INVALID_RESULT`,
  `EXECUTION_NOT_RESUMABLE`).
- **Also**: `project-run engine next-step|submit-step` CLI transport; reference Claude
  Code skill rewritten to drive the workflow in-session; fixed `required_skills[].
  required: false` being ignored during dispatch.
- **Evidence**: commit `3f47f70` (160 tests at that commit);
  `tests/project-run-step-api.test.ts`, `tests/cli-engine-step-transport.test.ts`,
  `tests/config-skill-requirement-precedence.test.ts`; `ARCHITECTURE.md` §4.11.
- **Status**: COMPLETE.

## Phase 4 — Real Claude Code host integration

- **Objective**: prove the §4.11 design with a real Claude Code session, real tool
  calls, and a real human — not synthetic harnesses.
- **Validated** (against a disposable fixture repository): the full
  `SPECIFY → … → CONVERGE → COMPLETED` lifecycle via `next-step`/`submit-step`
  subprocess calls; a real `HUMAN_INTERVENTION_REQUIRED` round trip with the answer
  persisted and the role re-dispatched; a genuine non-blocking `FINDINGS` result;
  restart/recovery by a second, independent, context-free process (not two terminal
  sessions). No SDK import, `claude -p`, or nested agent process.
- **Independent review**: an architecture review of Phases 0–4 followed; it judged the
  architecture sound and surfaced the follow-ups handled in Phase 4 Closure and in
  `docs/backlog.md`. The review's own report is not stored in this repository.
- **Evidence**: `ARCHITECTURE.md` §4.12–§4.13; `tests/package-boundary.test.ts`; live
  validation described in the `3f47f70` commit message. There is no dedicated Phase 4
  code commit — the work validated the Phase 3 implementation.
- **Status**: COMPLETE.

## Phase 4 Closure — hardening, documentation, release

- **Runtime-default resolution**: the review reproduced a defect where a configured
  `runtime.default_runtime` was ignored and dispatch fell back to the literal
  `"ANTIGRAVITY"`. `resolveRuntime()` now resolves it once at every entry point
  (explicit → context/persisted → config default → legacy fallback). Commit `2afd4a6`;
  `tests/runtime-default-resolution.test.ts` (5 tests); `ARCHITECTURE.md` §4.14;
  details in `docs/phase-4-closure-report.md`.
- **Documentation closure**: `ARCHITECTURE.md` §4.12–§4.14, `CONSUMER-GUIDE.md` §9.2,
  the `SKILL.md` truthfulness section, `docs/backlog.md`, and
  `docs/phase-4-closure-report.md`. Commit `6c349a8`.
- **Package/release cleanup**: `package-lock.json` added (`c9efa29`, dev dependencies
  only; `dependencies` remains `{}`).
- **Release**: `0.1.1` (`867b3cd`), published to npm and verified as the `latest`
  dist-tag.
- **Status**: COMPLETE. 165 tests pass; typecheck and build clean.

## Post-closure follow-ups (ENG-001 / ENG-002 / ENG-003)

Three items registered after a real pull-mode lifecycle run against `0.1.1` were
triaged and dispositioned without starting Phase 5 or any new host integration. Full
detail, ownership, and tests are in `docs/backlog.md`:

- **ENG-001** (feature bootstrap): CLOSED — host/consumer owns creating a new feature's
  workspace; the engine's contract is documented (`ARCHITECTURE.md` §4.16).
- **ENG-002** (lost findings/history): CLOSED — durable `step_log`/`stepLog` added and
  `stepsCount` redefined as agent steps; decision-level `history` remains deferred.
  This is a response-contract change; it shipped as `0.2.0`.
- **ENG-003** (feature vs. branch identity): OPEN, consumer-owned; no engine action.

## Phase 5 — Persistence hardening

- **Objective**: make `Coordinator.checkpoint()` populate recoverable decision `history`,
  and make `FileExecutionStateStore` safe now that independent host turns (separate
  processes/sessions) can touch the same `execution_id`.
- **Correction to earlier text**: this file previously described Phase 5 as "live-validating
  the next host(s), Antigravity first". That was wrong; Phase 5 is persistence hardening.
  Host integrations are backlog (`docs/backlog.md`), not Phase 5.
- **Baseline**: `main` at `c867518`, package `0.2.0` published; `PersistedExecutionState.history`
  existed in the type but was never written; saves were plain truncating `writeFileSync`
  calls; no locking.
- **Where the historical plan was adjusted**: `stepLog` (ENG-002) already provides the
  execution-level record, so `history` was defined as the *decision* record (including pure
  transitions) rather than a second copy of it, and stored compactly instead of persisting
  full `StepRecord`s (≈20× checkpoint growth, measured).
- **Delivered** (`ARCHITECTURE.md` §4.17): durable compact `history` across resume/restart
  (pull and push); atomic checkpoint writes; per-execution advisory lock over every mutating
  turn with dead-holder reclamation and non-terminal `EXECUTION_LOCKED` failures;
  duplicate-submit/answer idempotency preserved under real contention.
- **Evidence**: `tests/phase5-history.test.ts` and `tests/phase5-locking.test.ts`. The
  implementation commit added **27** tests (history 7, locking 20); the review remediation
  below added **19** more (history +2, locking +17), so Phase 5 now has **46** (history 9,
  locking 37). The full suite is 230 tests in 28 files. They include genuine child-process
  races, a SIGKILLed lock holder, and a SIGKILLed host recovered by a second host.
  Mutation-checked: disabling the lock, atomic writes or recording makes the relevant tests
  fail, and so does removing the lock from any single entry point.
- **Compatibility**: schema `version` stays `1`; `history` is optional (legacy checkpoints
  load with `[]`, nothing back-filled). `stepLog`/`stepsCount` unchanged. **Typed contract
  change**: `ProjectRunHostResponse.history` is `DecisionRecord[]` (was `StepRecord[]`) and
  is populated everywhere — a minor-version bump (`0.3.0`) pre-1.0.
- **Not done / deferred**: cross-machine locking, optimistic concurrency or a database
  store, lock heartbeats, payload-level or event-stream history, and any host integration.
- **Review remediation** (findings F1–F8 of the Phase 5 review; no change to the contract
  above): lock-acquisition failures now return a structured, non-terminal
  `EXECUTION_LOCK_UNAVAILABLE` (fail-closed) instead of a raw exception that left the CLI
  with no JSON (F1, required); the acquire loop is bounded by its deadline on every path
  (F2); the `EXECUTION_LOCKED` message names the lock file and the manual recovery (F3);
  each mutating entry point and the reap re-verification now have their own tests, plus a
  push/pull decision-sequence parity test (F4); test counts corrected (F5); the consumer
  guide gained an "Upgrading from 0.2.x" section and lock/recovery guidance (F6); the stale
  `PACKAGING.md` publishing note was replaced with the actual release facts (F7); the README
  export map and consumer guide document the new public API (F8). While verifying exports,
  the README's `/decision` subpath row was found to describe a subpath that has never been
  published, and was corrected.
- **Review remediation 2** (findings N1–N5 of the independent release review; no change to
  the contract above): `nextProjectRunStep` could classify a call as read-only from one
  read and then mutate on a second, unlocked read (N3, high) — reproduced deterministically
  and as spurious `STALE_STEP`s under two-process polling/submission. It now runs a
  structurally read-only pass and, only if that finds it must mutate, takes the lock and
  re-decides from a fresh read taken under it. A read that throws can no longer fall
  through to an unlocked mutation (N4). Lock failures are told apart from operation errors
  structurally rather than by message prefix (N2, `lockFailure` + `runLockedTurn`). A first
  `next-step` without an id confirms the first checkpoint was written before issuing an
  action (N1). `PACKAGING.md` commands corrected for the standalone repository (N5).
  This added 17 locking tests (N3/N4 7, N2 6, N1 4), so Phase 5 now has **63** tests
  (history 9, locking 54) and the full suite is **247** tests in 28 files. Mutation-checked:
  removing the lock re-entry, letting the read pass mutate, letting a failed read fall
  through to the locked path, restoring prefix classification, and dropping the
  first-checkpoint check each make a test fail.
- **Status**: IMPLEMENTED in source, validated, review remediation applied; **unreleased**
  (release is a separate step: the next version must be `0.3.0`).
