# Tasks: Autonomous Engineering Harness MVP

**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/*`, `acceptance-scenarios.md`
**Status**: Gate A approved (specification concluded). **Gate B AUTHORISED 2026-10-15 for the isolated vertical slice only (Phases 1–7, H8); Gates C and D remain BLOCKED.** Revision 3 is published at `2576046`; revision 4 (this file) is an uncommitted working-tree edit. **OD-14, OD-15 and OD-16 were approved 2026-10-15 as specification decisions** (OD-15's numeric limits are provisional initial specification limits); that is not an implementation authorisation. **OD-17 and OD-18 were approved 2026-10-15 as specification decisions** (OD-18 applied to the mandatory protected set).
Gate B in writing (granted 2026-10-15, scope above); no box may be ticked until the work it describes has actually been done and verified.
**Format**: `- [ ] T### [P?] [Story?] Description (files) (FR-…, AS-…)`. Dependencies are explicit (`DEPENDS ON …`); order is not a dependency. `[P]` is informational (the Harness itself is sequential; these tasks are for human/agent planning only).
**Story labels**: US1 authorise & run, US2 verify, US3 review, US4 remediate, US5 resume/loop, US6 escalate, US7 compat, US8 invalidation.

## Phase 0 — Specification deliverables (H0–H7) · status: CONCLUDED (Gate A approved)

- [x] H0 Baseline and contract audit — done and approved (read-only; see `research.md` §A)
- [x] H1 Envelope & stop-point contract — specified: `contracts/authorization-envelope.md` (Gate A approved 2026-10-15, revision 2)
- [x] H2 Task graph & scheduler contract — specified: `contracts/task-graph.md` (Gate A approved 2026-10-15, revision 2)
- [x] H3 Verification & allowlist contract — specified: `contracts/verification-pipeline.md` (Gate A approved 2026-10-15, revision 2)
- [x] H4 Reviewer & findings contract — specified: `contracts/review-contract.md` (Gate A approved 2026-10-15, revision 2)
- [x] H5 Remediation & budget contract — specified: `contracts/remediation-budget.md` (Gate A approved 2026-10-15, revision 2)
- [x] H6 Ledger & checkpoint evolution — specified: `contracts/evidence-ledger.md`, `data-model.md` (Gate A approved 2026-10-15, revision 2)
- [x] H7 Controller & recovery — specified: `contracts/harness-controller.md` (Gate A approved 2026-10-15, revision 2)

> H1–H7 ticked on the owner's explicit approval of the specification phase (2026-10-15). Approval was given on the basis of the revision-2 report; the owner had not yet read the revision-2 files directly. **Gate B was authorised 2026-10-15** after the pre-Gate-B technical review (T049) was closed (`t049-technical-review.md` §13), with OD-10…OD-13 reconfirmed; the authorisation covers the isolated vertical slice only and does not authorise a push, PR, release or publication.

## Phase 1 — Pre-requisites (Gate B decisions)

- [x] T001 Owner decision OD-1: approve the package-boundary amendment (`node:crypto` in core; `node:child_process` only in `src/harness/node/`) · OWNER GATE (FR-024, D-11) — **DECIDED: OD-1 approved 2026-10-15**
- [x] T002 Owner decisions OD-2..OD-5 recorded in `plan.md` §8 · OWNER GATE — **DECIDED: OD-2…OD-5 approved 2026-10-15 (OD-5 resolved in revision 2)**
- [ ] T003 DEPENDS ON T001, T049 (closed), Gate B authorisation (**granted 2026-10-15**, isolated vertical slice only): amend `tests/package-boundary.test.ts` to the enumerated allowlist and make it fail on any other import (FR-024)

- [x] T045 OWNER GATE: OD-8 confirm path-matching dialect, POSIX-only scope and `CLEAN_REQUIRED` default baseline; OD-6, OD-7, OD-9 recorded (FR-082, FR-091, FR-093, FR-094, FR-095) — **DECIDED: OD-8, OD-6, OD-7, OD-9 approved 2026-10-15**
- [x] T049 OWNER GATE, read-only: pre-Gate-B technical review. Re-verify against the code `coordinator.ts`, `host-dispatch-adapter.ts`, `bootstrap.ts`, `doctor.ts`, the engine `resume` reconstruction (`suspended_from`) and the human-answer revalidation (commit `cdd4d41`); confirm the projection table, the carry-forward of the `harness` block and the delegation points (analysis X7, R-13, R-14). Report findings; no code changes. **Required before any Gate B request (satisfied by the closure below).** **CLOSED 2026-10-15 by owner decision** (decision and justification: `t049-technical-review.md` §13; evidence: §3, §10–§12). The review is a **sample, not a census**: partial reading of tests and documentation, three in-memory probes, and no real execution of the file store or of real hosts; risks R-26…R-31 and all unimplemented scenarios stay pending. Closing T049 does **not** start T003 and does **not** authorise Gate B.**

## Phase 2 — Foundations (shared, blocking)

- [ ] T004 DEPENDS ON T003: `src/harness/` skeleton, internal barrel, **not** exported from `src/index.ts`; extend `tests/public-api-surface.test.ts` and consumer-type fixtures to prove no change (FR-077, FR-078, FR-095, SC-011, AS-49)
- [ ] T005 DEPENDS ON T004: canonical JSON + sha-256 + hash-chain utilities (`ledger.ts`) with property tests (FR-052, AS-46)
- [ ] T006 DEPENDS ON T004: `EvidenceStore` content-addressed write-once store, size cap, redaction/quarantine, digest verification (`evidence-store.ts`) (FR-054, FR-055, FR-056, FR-057, AS-17, AS-47, AS-63, AS-64)
- [ ] T007 DEPENDS ON T005: `HarnessEvent` schema (payload-free) and `reconstructTask` reader (FR-051, FR-053, FR-059, AS-50, AS-62)
- [ ] T046 DEPENDS ON T004, T045: `path-matching.ts` pure matcher, pattern validator, candidate validator, scope decision, symlink/`lstat` step, collision detection; all 32 normative vectors as table tests plus an adversarial-input timing test (FR-093, FR-094, AS-94, AS-95, AS-96, AS-114, SC-009)
- [ ] T047 DEPENDS ON T004: enforcement-class table (E1/E2/E3) in policy types, `status` text, doc-lint test that forbids "prevented/blocked" for E2/E3 rules, and the platform guard (`HARNESS_PLATFORM_UNSUPPORTED`) (FR-079, FR-080, FR-094, AS-69, AS-70, AS-72)

## Phase 3 — US1/US6/US8: Authorisation, graph, eligibility

- [ ] T008 DEPENDS ON T005, T046: `HarnessPolicy` loader/validator and digest (`policy.ts`) (FR-004, FR-005, FR-025, AS-03, FR-090, FR-092, AS-90, AS-93)
- [ ] T009 DEPENDS ON T007, T008, T046: envelope types, human-only `issueEnvelope`/`amendEnvelope`/`revokeEnvelope` with all rejection cases (`envelope.ts`) (FR-002, FR-003, FR-006, FR-008, FR-009, FR-041, AS-03, AS-05, AS-06, AS-57, AS-58, AS-59, FR-091, FR-092, AS-91, AS-93)
- [ ] T010 DEPENDS ON T009: pre-dispatch authorisation check and typed denials (FR-007, AS-02, AS-05)
- [ ] T011 DEPENDS ON T009: pin recomputation and invalidation matrix (`SUSPENDED_STALE`, `ENVELOPE_TAMPERED`, `UPSTREAM_CHANGED`) (FR-061, FR-062, FR-063, FR-064, AS-20, AS-51, AS-52, FR-085, FR-086, FR-089, AS-80, AS-83, AS-84, AS-87)
- [ ] T012 DEPENDS ON T005: `TaskGraph` parser + `GraphParseReport` + validation (`task-graph.ts`) (FR-011, FR-012, AS-08, AS-09, FR-085, AS-81, AS-83)
- [ ] T013 DEPENDS ON T010, T012: eligibility, deterministic selection, sequential invariant, gate handling (FR-013, FR-014, FR-015, FR-018, AS-01, AS-11, AS-12, AS-13)
- [ ] T014 DEPENDS ON T013: completion criterion, `DependencyAttestation`, reconciliation, no-edit guarantee for `tasks.md` (FR-016, FR-017, AS-10)
- [ ] T015 DEPENDS ON T013: phase-end handling and `HarnessSuspension` catalogue (FR-018, FR-063, AS-02)

## Phase 4 — US2/US3: Snapshot, verification, review

- [ ] T016 DEPENDS ON T006: `SnapshotProvider` port + canonical snapshot/diff types (`snapshot.ts`) (FR-033, FR-034, FR-036)
- [ ] T017 DEPENDS ON T016, T003, T046: Node `SnapshotProvider` using structured git argv (`node/snapshot-provider.ts`), real-git temp-repo tests incl. dirty baseline, untracked, rename, symlink/opaque (FR-022, FR-033, FR-035, AS-18, AS-61, FR-082, FR-083, FR-084, AS-73, AS-74, AS-75, AS-76, AS-77, AS-78)
- [ ] T018 DEPENDS ON T006, T008: `ValidatorExecutor` port, result/outcome model and gate semantics (`validators.ts`) (FR-024, FR-025, FR-026, FR-027, FR-028, FR-032, AS-14)
- [ ] T019 DEPENDS ON T018, T003: Node executor (no shell, cwd confinement, env allowlist, timeout + process-group kill, output cap) with real-process tests (`node/validator-executor.ts`) (FR-030, AS-14, AS-15, AS-16, AS-17)
- [ ] T020 DEPENDS ON T016, T011, T046: diff inspection against `allowedPaths`/`protectedPaths`/`sensitivePaths`; `RESULT_MISMATCH` (FR-020, FR-021, FR-029, FR-031, AS-04, AS-19, FR-086, AS-82)
- [ ] T021 DEPENDS ON T013, T020: task-scoped implementation/remediation dispatch builder: exactly one task, its acceptance criteria, contract refs, allowed/protected paths, envelope summary, `timeout_ms` from the envelope, required skills resolved as today (`dispatch.ts`) (FR-019, FR-020, FR-023, AS-60)
- [ ] T022 DEPENDS ON T006, T016: `HarnessFinding`, severity normalisation, fingerprints, `NO_PROGRESS` detector (`review.ts`) (FR-040, FR-049, AS-25, AS-34, FR-092, AS-92)
- [ ] T023 DEPENDS ON T022, T018: `ReviewRequest` builder (no implementer narrative) and `ReviewResult` validator with all rejection reasons (FR-037, FR-038, FR-039, AS-21, AS-22, AS-23, AS-24)
- [ ] T024 DEPENDS ON T023: pure findings-evaluation function → `HarnessDecision` incl. CRITICAL/BLOCKED handling and human `FindingDisposition` limits (FR-048, AS-26)

## Phase 5 — US4: Remediation budget

- [ ] T025 DEPENDS ON T007, T009: `RemediationBudget`, attempts, write-ahead counting, grant operation, counting table (`remediation.ts`) (FR-041, FR-042, FR-043, FR-044, FR-045, FR-046, AS-27, AS-28, AS-30, AS-31, AS-32, AS-33, FR-049, AS-92)
- [ ] T026 DEPENDS ON T025, T023: post-attempt chain (validators → new review) wiring (FR-047, AS-31)

## Phase 6 — US5/US7: Persistence, preset, controller

- [ ] T027 DEPENDS ON T007: optional `PersistedExecutionState.harness?: unknown` (the only exported-type change besides `Coordinator.commit`, FR-105), block validation (`schema_version`, chain, MANIFEST tripwire), `HARNESS_SCHEMA_UNSUPPORTED`; **no** field on `CoordinatorExecutionContext`/`CoordinatorOptions` (`src/project/state-store.ts`) (FR-073, FR-076, FR-105, AS-45, AS-48, AS-112)
- [ ] T028 DEPENDS ON T027: golden v0.4.0/v0.5.0 checkpoint fixtures; read paths write nothing; `adoptExecution` (three quiescent source tuples, W0) (FR-001, FR-074, FR-075, AS-118, AS-36, AS-44, AS-56)
- [ ] T029 DEPENDS ON T027: `spec-kit-harness-v1` preset used only to validate/label the Harness' own writes (`validStates`, `allowedTransitions`, `stateToRole`) with the four additive edges and no edge to `CONVERGE` (OD-14 approved); regression that the default preset/matrix is byte-identical and that non-Harness runs still do 4 remediation dispatches (FR-050, FR-078, AS-117, AS-35, FR-087, FR-088, FR-089, AS-85, AS-86, AS-88, AS-89)
- [ ] T030 DEPENDS ON T013, T015, T021, T024, T025, T027, T029, T050, T053, T056: `HarnessController` evaluation order and step machine (`controller.ts`) (FR-065, FR-066, FR-067, FR-068, FR-071, FR-072, AS-38, AS-40, AS-41, AS-43, AS-66, AS-67)
- [ ] T031 DEPENDS ON T030: human-only operations (internal functions, logically separated, unauthenticated): `reconcileCycle`, `approveDirtyBaseline`, `resumeSuspension`, `recordGateDecision`, `attestDependency`, `acknowledgeUpstreamChange`, `abandonPendingAction`, `extendPendingAction` with idempotency and wrong-suspension refusal (FR-003, FR-017, FR-018, FR-064, FR-067, FR-083, FR-088, AS-68, AS-72, AS-75, AS-86)
- [ ] T032 DEPENDS ON T030, T051, T052, T059, T062: delegation from `nextProjectRunStep`/`submitProjectRunStep` when a Harness block exists (behaviour change for Harness executions only; no signature, type or export change); fault mapping for CAS/lock/write failures (FR-001, FR-066, FR-069, AS-39, AS-56)
- [ ] T033 DEPENDS ON T030: `harnessStatus` as an **internal function** (no CLI, host or package exposure at Gate B, FR-095) incl. the enforcement table and limitation text; internal `harnessDoctor` evidence-dir check via `git check-ignore` on the `SnapshotProvider` port (public doctor unchanged) (FR-010, FR-058, FR-060, AS-07, AS-65)

## Phase 6a — Revision 3 tasks (from T049; authorised under Gate B, isolated slice; none implemented yet)

- [ ] T050 DEPENDS ON T027: `Coordinator.commit` (`@internal`, additive): builds the record from the persisted record, validates transitions with the Harness preset, appends `step_log`/`history`/`human_answers`, `questions` override, literal pending action, one CAS save; regression that non-Harness behaviour is byte-identical (FR-097, FR-099, AS-45, AS-97, AS-98, AS-100, AS-101, AS-108)
- [ ] T051 DEPENDS ON T050: entry guards (`HARNESS_REQUIRES_PULL_API`, no write) in `executeProjectRun` (**load the record under the existing lock before its first, unconditional checkpoint**; non-Harness same-id overwrite preserved, E-19), `executeProjectResume`, `ProjectRunHost.start/resume`, `reconstructResumeContext` (FR-097, AS-42, AS-102, AS-133)
- [ ] T052 DEPENDS ON T050: audit-only human-answer path and `HARNESS_SUSPENSION:` suspension surface (AS-134) for Harness executions (`validateHumanAnswers`, `ANSWER_RECORDED`, same suspension returned, no dispatch/counter/`last_result`/`remediation_iteration` change) and `resumeSuspension` restoring the pre-suspension row (FR-098, SC-012, AS-103, AS-106, AS-134)
- [ ] T053 DEPENDS ON T050: `recovery.ts`: projection rows T0–T9, write sequences W1–W13, per-row recovery actions, completeness enumeration and crash-injection harness (FR-087, FR-101, SC-013, AS-85, AS-99, AS-115)
- [ ] T054 DEPENDS ON T006, T023: request/reference discipline: references-and-digests-only builders with size limits (8 KiB / 4 KiB), `AgentResult.metadata.harness` transport and validation, evidence reading by hosts from files (FR-102, FR-103, SC-014, AS-107, AS-108, AS-113)
- [ ] T055 DEPENDS ON T019: validator run records, `STALE_VALIDATOR_PROCESS`, lock-wait behaviour tests (FR-106, FR-107, AS-110, AS-111)
- [ ] T056 DEPENDS ON T050: identification by validated `harness` block (never `preset`), Harness preset wiring for validation, `buildStepCoordinator` untouched for non-Harness (FR-096, AS-104)
- [ ] T057 DEPENDS ON T050: exported type-surface test limited to the FR-105 delta, built on the existing mechanisms (`tests/public-api-surface.test.ts` and the `tests/fixtures/consumer-types/*` compile fixtures); consumer-type fixtures unchanged (FR-105, FR-077, FR-108, SC-011, AS-112, AS-116)
- [ ] T058 DEPENDS ON T030: dispatch sets `request.options.timeout_ms` from the envelope; documented host-enforced (FR-023, AS-109)
- [ ] T059 DEPENDS ON T050: delegation ordering in `nextProjectRunStep`/`submitProjectRunStep`: read-only pass returns "needs lock" when a write is required; Harness validation before any `commit`; held-action move and restore (FR-100, FR-089, FR-104, AS-105, AS-106)

## Phase 6b — Revision 4 tasks (host-supplied result validation, OD-15/OD-16 approved as specification decisions; phase boundary OD-14; **authorised under Gate B, isolated slice; none implemented yet**)

- [ ] T060 DEPENDS ON T006, T054: `result-validation.ts`: closed schema `harness-result/v1`, `ResultLimits` in `HarnessPolicy` (defaults and hard ceilings, envelope may only lower), error codes and bounded diagnostics (FR-109, FR-110, AS-119, AS-120, AS-121, AS-124)
- [ ] T061 DEPENDS ON T006, T060: counting serializer that aborts at `limit + 1`, iterative traversal, prototype-pollution and non-JSON rejection, secret-pattern scan; read-only evidence-reference verification at submission (FR-109, FR-114, AS-122, AS-128, AS-135)
- [ ] T062 DEPENDS ON T050, T059, T060, T061: integration in the submission pipeline **before any `commit`** (class A zero-write; class B per FR-068; OD-16 Option A), recovery paths (resubmit, TTL, abandon/extend), counter unchanged (FR-112, FR-104, FR-068, AS-123, AS-125, AS-129)
- [ ] T063 DEPENDS ON T050, T060: compact `step_log` findings for Harness executions; full text only in `last_result` and evidence (FR-111, AS-127)
- [ ] T064 DEPENDS ON T062: Harness-only isolation and non-Harness regression for the same inputs (FR-113, SC-016, AS-126)
- [ ] T065 DEPENDS ON T062, T063: boundary and negative suite, zero-write proof harness (byte/revision/directory comparison, `commit`/`applyExternalResult` spies), and a report of **observed maxima on the Gate B fixture** next to the configured **provisional initial limits** (confirming or amending them is a separate explicit specification change) (FR-110, SC-015, AS-119, AS-120, AS-121, AS-122, AS-123)

- [ ] T066 DEPENDS ON T030, T031: `PHASE_END` as a mandatory stop point (cannot be removed), suspension without dispatch, `GateDecision{PHASE_END, CLOSE_PHASE|CONTINUE}` (human-only), `CLOSE_PHASE` ⇒ envelope `COMPLETED`, `CONTINUE` only with a new/amended ACTIVE envelope + `resumeSuspension`; no per-task approval introduced; no edge to `CONVERGE` (FR-115, FR-018, NG-11, AS-117, AS-130, AS-131)
- [ ] T067 DEPENDS ON T060, T008: `ResultLimits` as policy fields with hard ceilings, loader rejection above ceiling, envelope may only lower, labelled "provisional initial specification limits" in `harnessStatus` (FR-110, AS-132)

## Phase 7 — Gate B vertical-slice fixture and recovery proof (H8)

- [ ] T034 DEPENDS ON T032: isolated fixture (temp git repo, 3-task graph, mock host, policy with real allowlisted validators, **sanitised environment, redirected `HOME`, canary secrets planted in the runner and asserted absent from agent-mock/validator environments and evidence, no credential files**) — **no reference to Incito/Feature 009** (SC-006, SC-008, FR-081, AS-55, AS-71, AS-79)
- [ ] T035 DEPENDS ON T034: positive and negative end-to-end cycles (AS-53, AS-54, SC-001, SC-003)
- [ ] T036 DEPENDS ON T034: recovery suite R1–R19 incl. SIGKILL and multi-process (FR-070, AS-37, SC-004)
- [ ] T037 DEPENDS ON T034: counter property test over every resume point and host change (FR-043, AS-29, SC-003)
- [ ] T038 DEPENDS ON T034: `/loop` simulation and refusal of Harness executions by every push/legacy entry point (AS-41, AS-42, AS-102)
- [ ] T039 DEPENDS ON T034: ledger reconstruction, chain tamper, divergence, evidence-missing suites (AS-46, AS-47, AS-48, AS-50)
- [ ] T040 DEPENDS ON T035, T036, T037, T038, T039, T054, T055, T057, T058, T064, T065, T066, T067: full existing suite + typecheck + build green; baseline byte-regression for non-Harness executions (SC-005)
- [ ] T041 DEPENDS ON T040: `docs/` (incl. `state-machine.md`, `transition-contract.md` for the preset edges, and the `ARCHITECTURE.md` §4.17 dispatch↔step pairing sentence, FR-108) and `ARCHITECTURE.md` section for the Harness; `CONSUMER-GUIDE.md` operator guide; update `docs/backlog.md` E-1/E-2 notes · STOP: Gate B review (owner)

## Phase 8 — Gate C: host and continuity (H9) — not started

- [ ] T042 DEPENDS ON T041 AND owner authorisation: host-adapter validation with a real host, no permission bypass, no unauthorised global change (FR-072)
- [ ] T043 DEPENDS ON T042: `/loop` continuity test against the real host (FR-071)
- [ ] T048 DEPENDS ON T041 AND separate owner approval: expose human-only operations (including `resumeSuspension`) and `harnessStatus` to hosts/CLI, and update the host skill text (`SKILL.md` steps 4–5) that resumes by `humanAnswers`, so that a host recognises `HARNESS_SUSPENSION:` suspensions instead of re-asking (R-31) (new subcommands, host skill text); public-API impact review (`public-api-surface`, consumer type fixtures) (FR-095, D-15)

## Phase 9 — Gate D: consumer pilot preparation (H10) — not started

- [ ] T044 DEPENDS ON T043 AND explicit owner authorisation: pilot plan and stop procedure. **Feature 009 is excluded until a separate review of its H0 findings (R-8) and a separate authorisation.**

## Coverage statement

Every FR in `spec.md` maps to ≥ 1 task above and ≥ 1 scenario in `acceptance-scenarios.md`; the mechanical check is in `analysis.md`.
