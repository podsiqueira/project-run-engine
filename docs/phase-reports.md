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
| Phase 5 | **NOT STARTED — READY TO PLAN** (see [Phase 5](#phase-5-not-started)) |

Current release: `@incito-labs/project-run-engine@0.1.1` (`package.json`; published to
npm, `latest` dist-tag).

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
- **Status**: COMPLETE. Known limitation carried forward: `status().history` is always
  empty (`ARCHITECTURE.md` §4.4, `docs/backlog.md`).

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

## Phase 5: NOT STARTED

Phase 5 has not begun; no Phase 5 code or integration exists in this repository.

**What Phase 5 means**: live-validating the next host(s) against the unchanged
provider-neutral pull contract — Antigravity first — and deciding whether any deferred
item below has become a real requirement. It is a planning-ready scope, not a commitment
to a specific integration order; Cursor, Codex, and MCP remain backlog.

**Entry criteria, as of `0.1.1`**

| Criterion | State |
|---|---|
| Phase 4 complete | Yes (above) |
| Phase 4 Closure complete | Yes (above) |
| npm `0.1.1` published and verified | Yes — `latest` dist-tag is `0.1.1` |
| Runtime-default behavior covered by tests | Yes — `tests/runtime-default-resolution.test.ts` |
| Claude Code pull-mode validated | Yes — `ARCHITECTURE.md` §4.12 |
| Provider neutrality intact | Yes — `tests/package-boundary.test.ts`; no provider SDK or `claude -p` in `src/` |
| Remaining deferred work documented | Yes — `docs/backlog.md` |

**Result: Phase 4 Closure COMPLETE · Phase 5 NOT STARTED · Phase 5 READY TO PLAN.**
