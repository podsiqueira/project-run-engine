# Tasks: Autonomous Engineering Harness MVP

**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/*`, `acceptance-scenarios.md`
**Status**: DRAFT for Gate A. **NOT AUTHORISED FOR EXECUTION.** Every task below is blocked until the owner grants
Gate B in writing; no box in this file may be ticked by an agent during Phase 2 (specification).
**Format**: `- [ ] T### [P?] [Story?] Description (files) (FR-…, AS-…)`. Dependencies are explicit (`DEPENDS ON …`); order is not a dependency. `[P]` is informational (the Harness itself is sequential; these tasks are for human/agent planning only).
**Story labels**: US1 authorise & run, US2 verify, US3 review, US4 remediate, US5 resume/loop, US6 escalate, US7 compat, US8 invalidation.

## Phase 0 — Specification deliverables (H0–H7) · status: produced, awaiting Gate A

- [x] H0 Baseline and contract audit — done and approved (read-only; see `research.md` §A)
- [ ] H1 Envelope & stop-point contract — drafted: `contracts/authorization-envelope.md` (awaits Gate A)
- [ ] H2 Task graph & scheduler contract — drafted: `contracts/task-graph.md` (awaits Gate A)
- [ ] H3 Verification & allowlist contract — drafted: `contracts/verification-pipeline.md` (awaits Gate A)
- [ ] H4 Reviewer & findings contract — drafted: `contracts/review-contract.md` (awaits Gate A)
- [ ] H5 Remediation & budget contract — drafted: `contracts/remediation-budget.md` (awaits Gate A)
- [ ] H6 Ledger & checkpoint evolution — drafted: `contracts/evidence-ledger.md`, `data-model.md` (awaits Gate A)
- [ ] H7 Controller & recovery — drafted: `contracts/harness-controller.md` (awaits Gate A)

> H1–H7 stay unticked: ticking them *is* the Gate A approval, which belongs to the owner.

## Phase 1 — Pre-requisites (Gate B decisions)

- [ ] T001 Owner decision OD-1: approve the package-boundary amendment (`node:crypto` in core; `node:child_process` only in `src/harness/node/`) · OWNER GATE (FR-024, D-11)
- [ ] T002 Owner decisions OD-2..OD-5 recorded in `plan.md` §8 · OWNER GATE
- [ ] T003 DEPENDS ON T001: amend `tests/package-boundary.test.ts` to the enumerated allowlist and make it fail on any other import (FR-024)

## Phase 2 — Foundations (shared, blocking)

- [ ] T004 DEPENDS ON T003: `src/harness/` skeleton, internal barrel, **not** exported from `src/index.ts`; extend `tests/public-api-surface.test.ts` and consumer-type fixtures to prove no change (FR-077, FR-078, AS-49)
- [ ] T005 DEPENDS ON T004: canonical JSON + sha-256 + hash-chain utilities (`ledger.ts`) with property tests (FR-052, AS-46)
- [ ] T006 DEPENDS ON T004: `EvidenceStore` content-addressed write-once store, size cap, redaction/quarantine, digest verification (`evidence-store.ts`) (FR-054, FR-055, FR-056, FR-057, AS-17, AS-47, AS-63, AS-64)
- [ ] T007 DEPENDS ON T005: `HarnessEvent` schema (payload-free) and `reconstructTask` reader (FR-051, FR-053, FR-059, AS-50, AS-62)

## Phase 3 — US1/US6/US8: Authorisation, graph, eligibility

- [ ] T008 DEPENDS ON T005: `HarnessPolicy` loader/validator and digest (`policy.ts`) (FR-004, FR-005, FR-025, AS-03)
- [ ] T009 DEPENDS ON T007, T008: envelope types, human-only `issueEnvelope`/`amendEnvelope`/`revokeEnvelope` with all rejection cases (`envelope.ts`) (FR-002, FR-003, FR-006, FR-008, FR-009, FR-041, AS-03, AS-05, AS-06, AS-57, AS-58, AS-59)
- [ ] T010 DEPENDS ON T009: pre-dispatch authorisation check and typed denials (FR-007, AS-02, AS-05)
- [ ] T011 DEPENDS ON T009: pin recomputation and invalidation matrix (`SUSPENDED_STALE`, `ENVELOPE_TAMPERED`, `UPSTREAM_CHANGED`) (FR-061, FR-062, FR-063, FR-064, AS-20, AS-51, AS-52)
- [ ] T012 DEPENDS ON T005: `TaskGraph` parser + `GraphParseReport` + validation (`task-graph.ts`) (FR-011, FR-012, AS-08, AS-09)
- [ ] T013 DEPENDS ON T010, T012: eligibility, deterministic selection, sequential invariant, gate handling (FR-013, FR-014, FR-015, FR-018, AS-01, AS-11, AS-12, AS-13)
- [ ] T014 DEPENDS ON T013: completion criterion, `DependencyAttestation`, reconciliation, no-edit guarantee for `tasks.md` (FR-016, FR-017, AS-10)
- [ ] T015 DEPENDS ON T013: phase-end handling and `HarnessSuspension` catalogue (FR-018, FR-063, AS-02)

## Phase 4 — US2/US3: Snapshot, verification, review

- [ ] T016 DEPENDS ON T006: `SnapshotProvider` port + canonical snapshot/diff types (`snapshot.ts`) (FR-033, FR-034, FR-036)
- [ ] T017 DEPENDS ON T016, T003: Node `SnapshotProvider` using structured git argv (`node/snapshot-provider.ts`), real-git temp-repo tests incl. dirty baseline, untracked, rename, symlink/opaque (FR-022, FR-033, FR-035, AS-18, AS-61)
- [ ] T018 DEPENDS ON T006, T008: `ValidatorExecutor` port, result/outcome model and gate semantics (`validators.ts`) (FR-024, FR-025, FR-026, FR-027, FR-028, FR-032, AS-14)
- [ ] T019 DEPENDS ON T018, T003: Node executor (no shell, cwd confinement, env allowlist, timeout + process-group kill, output cap) with real-process tests (`node/validator-executor.ts`) (FR-030, AS-14, AS-15, AS-16, AS-17)
- [ ] T020 DEPENDS ON T016, T011: diff inspection against `allowedPaths`/`protectedPaths`/`sensitivePaths`; `RESULT_MISMATCH` (FR-020, FR-021, FR-029, FR-031, AS-04, AS-19)
- [ ] T021 DEPENDS ON T013, T020: task-scoped implementation/remediation dispatch builder: exactly one task, its acceptance criteria, contract refs, allowed/protected paths, envelope summary, `timeout_ms` from the envelope, required skills resolved as today (`dispatch.ts`) (FR-019, FR-020, FR-023, AS-60)
- [ ] T022 DEPENDS ON T006, T016: `HarnessFinding`, severity normalisation, fingerprints, `NO_PROGRESS` detector (`review.ts`) (FR-040, FR-049, AS-25, AS-34)
- [ ] T023 DEPENDS ON T022, T018: `ReviewRequest` builder (no implementer narrative) and `ReviewResult` validator with all rejection reasons (FR-037, FR-038, FR-039, AS-21, AS-22, AS-23, AS-24)
- [ ] T024 DEPENDS ON T023: pure findings-evaluation function → `HarnessDecision` incl. CRITICAL/BLOCKED handling and human `FindingDisposition` limits (FR-048, AS-26)

## Phase 5 — US4: Remediation budget

- [ ] T025 DEPENDS ON T007, T009: `RemediationBudget`, attempts, write-ahead counting, grant operation, counting table (`remediation.ts`) (FR-041, FR-042, FR-043, FR-044, FR-045, FR-046, AS-27, AS-28, AS-30, AS-31, AS-32, AS-33)
- [ ] T026 DEPENDS ON T025, T023: post-attempt chain (validators → new review) wiring (FR-047, AS-31)

## Phase 6 — US5/US7: Persistence, preset, controller

- [ ] T027 DEPENDS ON T007: optional `harness` field on `PersistedExecutionState`, carry-forward on `CoordinatorExecutionContext`, MANIFEST tripwire, `HARNESS_SCHEMA_UNSUPPORTED` (`src/project/state-store.ts`, `src/decision/types.ts`, coordinator checkpoint path) (FR-073, FR-076, AS-45, AS-48)
- [ ] T028 DEPENDS ON T027: golden v0.4.0/v0.5.0 checkpoint fixtures; read paths write nothing; `adoptExecution` (FR-001, FR-074, FR-075, AS-36, AS-44, AS-56)
- [ ] T029 DEPENDS ON T027: `spec-kit-harness-v1` preset with the four additive edges; regression that the default preset/matrix is byte-identical and that non-Harness runs still do 4 remediation dispatches (FR-050, FR-078, AS-35)
- [ ] T030 DEPENDS ON T013, T015, T021, T024, T025, T027, T029: `HarnessController` evaluation order and step machine (`controller.ts`) (FR-065, FR-066, FR-067, FR-068, FR-071, FR-072, AS-38, AS-40, AS-41, AS-43, AS-66, AS-67)
- [ ] T031 DEPENDS ON T030: human-only operations: `resumeSuspension`, `recordGateDecision`, `attestDependency`, `acknowledgeUpstreamChange`, `abandonPendingAction`, `extendPendingAction` with idempotency and wrong-suspension refusal (FR-003, FR-017, FR-018, FR-064, FR-067, AS-68)
- [ ] T032 DEPENDS ON T030: delegation from `nextProjectRunStep`/`submitProjectRunStep` when a Harness block exists; fault mapping for CAS/lock/write failures (FR-001, FR-066, FR-069, AS-39, AS-56)
- [ ] T033 DEPENDS ON T030: `status` projection and CLI exposure; `doctor` evidence-dir check (FR-010, FR-058, FR-060, AS-07, AS-65)

## Phase 7 — Gate B vertical-slice fixture and recovery proof (H8)

- [ ] T034 DEPENDS ON T032: isolated fixture (temp git repo, 3-task graph, mock host, policy with real allowlisted validators) — **no reference to Incito/Feature 009** (SC-006, AS-55)
- [ ] T035 DEPENDS ON T034: positive and negative end-to-end cycles (AS-53, AS-54, SC-001, SC-003)
- [ ] T036 DEPENDS ON T034: recovery suite R1–R18 incl. SIGKILL and multi-process (FR-070, AS-37, SC-004)
- [ ] T037 DEPENDS ON T034: counter property test over every resume point and host change (FR-043, AS-29, SC-003)
- [ ] T038 DEPENDS ON T034: push/pull equivalence and `/loop` simulation (AS-41, AS-42)
- [ ] T039 DEPENDS ON T034: ledger reconstruction, chain tamper, divergence, evidence-missing suites (AS-46, AS-47, AS-48, AS-50)
- [ ] T040 DEPENDS ON T035, T036, T037, T038, T039: full existing suite + typecheck + build green; baseline byte-regression for non-Harness executions (SC-005)
- [ ] T041 DEPENDS ON T040: `docs/` (incl. `state-machine.md`, `transition-contract.md` for the preset edges) and `ARCHITECTURE.md` section for the Harness; `CONSUMER-GUIDE.md` operator guide; update `docs/backlog.md` E-1/E-2 notes · STOP: Gate B review (owner)

## Phase 8 — Gate C: host and continuity (H9) — not started

- [ ] T042 DEPENDS ON T041 AND owner authorisation: host-adapter validation with a real host, no permission bypass, no unauthorised global change (FR-072)
- [ ] T043 DEPENDS ON T042: `/loop` continuity test against the real host (FR-071)

## Phase 9 — Gate D: consumer pilot preparation (H10) — not started

- [ ] T044 DEPENDS ON T043 AND explicit owner authorisation: pilot plan and stop procedure. **Feature 009 is excluded until a separate review of its H0 findings (R-8) and a separate authorisation.**

## Coverage statement

Every FR in `spec.md` maps to ≥ 1 task above and ≥ 1 scenario in `acceptance-scenarios.md`; the mechanical check is in `analysis.md`.
