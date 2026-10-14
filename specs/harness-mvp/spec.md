# Feature Specification: Autonomous Engineering Harness MVP

**Feature directory**: `specs/harness-mvp/`
**Target repository**: `project-run-engine` (baseline `v0.5.0`, SHA `c1e4054`)
**Status**: DRAFT for Gate A review. **Specification only. No implementation is authorized.**
**Created**: 2026-10-15
**Source plan**: "Autonomous Engineering Harness MVP, Specification Plan" (2026-10-14)
**Audit baseline**: H0 read-only audit (2026-10-15), summarised in `research.md` §A.

> Provisional names (`HarnessController`, `PhaseAuthorizationEnvelope`, …) are specification names, not final public API.
> Normative words: **MUST**, **MUST NOT**, **SHOULD**, **MAY** follow RFC 2119.

## 1. Summary

The Harness is an **opt-in policy and continuity layer** over the existing Coordinator, Decision Engine, host contract
(`nextProjectRunStep` / `submitProjectRunStep`), and checkpoint store. For an explicitly authorised phase it runs a
**sequential, one-task-at-a-time** cycle:

`select eligible task → dispatch implementation → run allowlisted validators (engine-executed) → separate-invocation review of an exact diff → evaluate findings → remediate (≤ 3 attempts) → accept task → persist → next task, or suspend`.

It does **not** add a second state machine, a second source of truth, or any provider dependency. Executions that do not
enable it keep today's semantics byte-for-byte.

## 2. Existing behaviour that this feature must not silently change (compatibility baseline)

Verified in H0 (code + simulation against `dist/`). These are **facts about v0.5.0**, recorded so the Harness is
explicitly *different*, never *accidentally* different.

| ID | Existing behaviour (v0.5.0) | Consequence for the Harness |
|---|---|---|
| E-1 | `MAX_REMEDIATION_ITERATIONS = 3`, but `INDEPENDENT_REVIEW → REMEDIATION` does not consume budget; the budget is checked only on `RE_REVIEW`/`CONVERGE → REMEDIATION`. A persistent blocking finding therefore yields **4 remediation dispatches** before human intervention. | The Harness defines **exactly 3** as its own policy (FR-041..). The engine default MUST NOT change. |
| E-2 | A human answer given to an *exhausted* gate re-grants remediation budget (`tests/human-answers-resume-stages.test.ts`). | Harness budget is never replenished by a human answer (FR-045). |
| E-3 | `IMPLEMENT` is one feature-wide stage (`speckit-implement` "processes all tasks"); the engine has no notion of task. | Task granularity is new Harness behaviour (FR-011..). |
| E-4 | Stop points exist only because an agent chooses to return `BLOCKED` with a finding. The engine merely maps `BLOCKED` → `HUMAN_INTERVENTION_REQUIRED`. | Harness stop points are enforced by the controller (FR-018). |
| E-5 | `AgentResult` is validated for shape/identity only; the engine cannot verify that work occurred (`ARCHITECTURE.md` §4.15). | Harness evidence is computed by the engine, not asserted by agents (FR-019, FR-024). |
| E-6 | `history`/`step_log` keep no payloads or evidence (only `evidence_count`). | Harness adds evidence references and an append-only event list (FR-051..). |
| E-7 | `package-boundary.test.ts` permits only `node:fs`/`node:path` in `src/`. Nothing in the core spawns a process or hashes. | Hashing needs `node:crypto` in the core and spawning needs `node:child_process` in an isolated module: an explicit, approved boundary amendment (D-11, OD-1). |
| E-8 | The engine overwrites the whole checkpoint on save; fields not carried on the in-memory context are dropped. Older engines drop `revision`/`history`. | New persisted fields must be carried explicitly; mixed-version use must be detected (FR-073, FR-075). |
| E-9 | The file store lock and CAS are single-machine only. | MVP stays single machine (NG-1). |

## 3. User Scenarios & Testing

Priorities: P1 = required for the vertical slice (Gate B); P2 = required for MVP completeness; P3 = hardening.

### User Story 1: Authorise a phase and run one task end to end (P1)

A project owner issues a phase-scoped authorisation listing the tasks the Harness may run and the operations it may
perform. The Harness selects the first eligible task, has it implemented, verifies it with allowlisted validators,
has it independently reviewed against the exact diff, and, only if everything holds, marks it accepted and persists that.

**Why P1**: this is the minimal cycle every other story builds on.
**Independent test**: fixture project with a 3-task graph and mock host; run to first `TASK_ACCEPTED`.

**Acceptance scenarios**
1. **Given** an active envelope listing T1, T2 and T2 depends on T1, **When** the controller is asked for the next step, **Then** it dispatches T1 only and records an eligibility decision stating why T2 is not eligible.
2. **Given** T1's implementation result plus passing validators plus a review `PASS` bound to the post-implementation snapshot, **When** the controller evaluates, **Then** T1 is `ACCEPTED` in a single CAS checkpoint that also records the evidence references.
3. **Given** a task not listed in the envelope, **When** it is the only unfinished task, **Then** nothing is dispatched and the response is a suspension naming `TASK_NOT_AUTHORIZED`.

### User Story 2: Stop on failed verification (P1)

**Acceptance scenarios**
1. **Given** a required validator exits non-zero, **When** evaluating, **Then** the task is not accepted, a synthetic `VALIDATOR` finding with the log reference is raised and remediation (budget permitting) is dispatched.
2. **Given** a required validator cannot run (timeout, spawn error, missing binary), **When** evaluating, **Then** the cycle suspends with `VALIDATOR_ERROR`; no *additional* remediation attempt is consumed by the suspension itself.
3. **Given** an agent claims all tests passed but supplies no validator result, **When** evaluating, **Then** the claim is ignored and validators are run by the engine.

### User Story 3: Independent review tied to the diff (P1)

**Acceptance scenarios**
1. **Given** a subject snapshot S, **When** review is requested, **Then** the `ReviewRequest` names S, the diff artifact digest, the acceptance criteria and the validator results, and contains no implementer verdict.
2. **Given** a review result echoing a different snapshot id, **When** submitted, **Then** it is rejected as `STALE_SNAPSHOT` and cannot satisfy acceptance.
3. **Given** a `PASS` that lacks per-criterion verdicts or per-file coverage, **When** submitted, **Then** it is rejected as `REVIEW_INCOMPLETE`.
4. **Given** a reviewer invocation identity equal to the implementer's, **When** submitted, **Then** it is rejected as `REVIEW_NOT_INDEPENDENT`.

### User Story 4: Bounded automatic remediation (P1)

**Acceptance scenarios**
1. **Given** a blocking finding, **When** the first remediation dispatch is durably recorded, **Then** attempt counter = 1 (not 0), and the counter is part of the same checkpoint as the pending action.
2. **Given** three unsuccessful attempts, **When** a fourth would be needed, **Then** no dispatch occurs, the execution suspends with `REMEDIATION_BUDGET_EXHAUSTED`, and a human answer alone does not allow a fourth.
3. **Given** a recorded `RemediationBudgetGrant`, **When** the controller resumes, **Then** it may dispatch up to the granted number of additional attempts, each still followed by validators and a new separate review.
4. **Given** a process restart or a different host between attempts 1 and 2, **Then** the counter is unchanged.

### User Story 5: Safe resumption and `/loop` continuity (P2)

**Acceptance scenarios**
1. **Given** a pending action exists, **When** `next-step` is called again (any host), **Then** the same `step_id` is returned and no new dispatch or count occurs.
2. **Given** a stop point or `HUMAN_INTERVENTION_REQUIRED`, **When** a loop iteration runs, **Then** it returns the suspension and does nothing else.
3. **Given** `CHECKPOINT_CONFLICT`, lock failure or write failure, **Then** the controller does not progress, does not count a dispatch, and reports a non-terminal failure code.

### User Story 6: Escalate with structured reasons (P2)

Critical findings, unauthorised operations, out-of-scope diffs, business ambiguity, recurrence without progress,
exhausted budget, stale pins and reconciliation conflicts each produce a typed `HarnessSuspension` the human can answer.

### User Story 7: Legacy and mixed-version safety (P2)

Existing checkpoints load unchanged; an execution is Harness-enabled only through an explicit, recorded adoption; an
older engine touching a Harness execution is detected and fails closed.

### User Story 8: Invalidation on upstream change (P3)

Changing a pinned artifact (policy, allowlist, task definition, referenced contract) invalidates the dependent
approvals instead of being silently accepted.

### Edge cases

- Working tree already dirty before the first task (as in the Feature 009 consumer): baseline snapshot absorbs pre-existing changes; only the delta is reviewed; unrelated drift during a cycle is surfaced, never ignored.
- Task diff touches a protected path (policy files, allowlist, checkpoints, `tasks.md` beyond the task's own checkbox) → `OUT_OF_SCOPE_CHANGE`, no remediation attempt consumed until a human decides.
- Diff changes between validation and acceptance (TOCTOU) → acceptance refused, results marked stale.
- `tasks.md` checkbox says done but the ledger has no acceptance (or the reverse) → `RECONCILIATION_REQUIRED`.
- Reviewer finds a blocking issue in code the task did not touch → recorded, flagged `preExisting: true` only by the reviewer with evidence; still blocking unless a human accepts it.
- A validator is satisfied by editing the validator's own configuration/tests → `sensitivePaths` rule forces explicit reviewer disposition (FR-031).
- Log output contains a secret → redaction / quarantine rules (FR-054..FR-056).
- Host reports success after the pending action was abandoned → `STALE_STEP`, result discarded.

## 4. Requirements

### 4.1 Authorisation (FR-001 … FR-010)

- **FR-001** The Harness MUST be opt-in per execution. An execution without a persisted Harness block MUST behave exactly as in v0.5.0.
- **FR-002** A `PhaseAuthorizationEnvelope` MUST be a versioned, immutable-once-issued record (fields in `contracts/authorization-envelope.md`). Any change MUST create a new envelope revision that `supersedes` the previous one.
- **FR-003** Envelopes MUST be created, amended, revoked only through **human-only operations** (D-22) that are not reachable through `submitProjectRunStep`. Each records `actor` (kind `HUMAN`, identifier asserted by the host), time and the envelope digest. The engine cannot authenticate the actor; this limitation MUST be stated in the contract and in status output.
- **FR-004** Every envelope MUST be a subset of a project `HarnessPolicy` (repository configuration, digest-pinned). An envelope MUST NOT widen the policy ceiling (permitted operations, validators, limits).
- **FR-005** Permitted operations MUST be an explicit closed enumeration; anything unlisted is denied. The following MUST be un-grantable in the MVP: destructive operations, data migrations, deployments, infrastructure changes, business decisions, scope expansion, policy/allowlist/envelope changes, `git push`/merge/PR/release/publish, network egress.
- **FR-006** The envelope MUST support `expiresAt`, status (`ACTIVE`, `SUSPENDED_STALE`, `EXPIRED`, `REVOKED`, `SUPERSEDED`, `COMPLETED`), and immediate revocation effective at the next controller boundary.
- **FR-007** Authorisation MUST be evaluated before **every** dispatch (implementation, remediation, review) and again before acceptance; failure returns a typed denial and dispatches nothing.
- **FR-008** The envelope MUST pin digests of: policy, validator allowlist, authorised task definitions, and listed contract/spec artifacts (see FR-061..064 for invalidation).
- **FR-009** Time limits MUST use measurable quantities (`timeout_ms` per dispatch and validator, maximum elapsed time per task). Token/cost limits MUST be declared **unsupported** unless a host reports them; the Harness MUST NOT fabricate cost figures.
- **FR-010** The effective envelope and policy revision MUST be queryable through status output.

### 4.2 Task graph and scheduling (FR-011 … FR-018)

- **FR-011** The Harness MUST parse the approved `tasks.md` into a `TaskGraph` using only **explicitly declared** structure: task id, checkbox state, `[P]`/`[US#]` markers, `DEPENDS ON T###[, T###]` clauses, and gate markers (`OWNER GATE`, stop-point notes). Textual order MUST NOT create dependencies. Unstated dependencies are not inferred (risk R-4).
- **FR-012** Graph validation MUST reject (all errors reported together): duplicate ids, unknown dependency ids, self-dependency, cycles, malformed ids, and a task whose file state contradicts the ledger (FR-017).
- **FR-013** A task's Harness state MUST be derived from ledger events (`NOT_STARTED`, `IN_CYCLE`, `ACCEPTED`, `SUSPENDED`, `EXCLUDED`); the checkbox is an input to reconciliation only.
- **FR-014** A task is **eligible** iff: it is in the envelope's `authorizedTaskIds`; every dependency is a *satisfied dependency* (FR-017); every gate on it has a matching recorded `GateDecision`; its definition digest matches the pin; no other task is `IN_CYCLE`; the envelope is `ACTIVE`. Selection among eligible tasks is deterministic (ascending numeric id). Every decision is persisted as a `TaskEligibilityDecision` with reasons.
- **FR-015** At most one task may be `IN_CYCLE`. The invariant MUST be enforced under the execution lock and re-checked at every boundary.
- **FR-016** The Harness MUST NOT edit `tasks.md`. The implementation agent MAY toggle only its own task's checkbox, and that change is part of the reviewed diff.
- **FR-017** A task is a **satisfied dependency** iff the ledger holds a `TASK_ACCEPTED` event for it whose pins are still valid, **or** a human `DependencyAttestation` (for work completed before Harness enablement) with identity, rationale and evidence reference. A checked box alone is never sufficient.
- **FR-018** Stop points (`after` task X, `before` task Y, `phase_end`, and any task carrying a gate marker) MUST be enforced by the controller: it suspends, and proceeds only after a recorded `GateDecision` bound to the task id and its definition digest.

### 4.3 Implementation dispatch (FR-019 … FR-023)

- **FR-019** The implementation dispatch MUST carry exactly one task, its acceptance criteria, relevant contract references, the allowed/protected path sets, and an envelope summary, through the existing dispatch contract with required skills resolved and validated as today.
- **FR-020** The agent MUST receive no authority to change policy, allowlist, envelope, checkpoints, ledger or other tasks; protected paths (FR-029) are enforced by diff inspection, not by instruction.
- **FR-021** The agent's structured result (summary, files changed, evidence refs) MUST be treated as a claim; the engine computes the real delta (FR-026) and any mismatch is a `RESULT_MISMATCH` finding.
- **FR-022** A task baseline snapshot MUST be recorded before the first dispatch of the task cycle and never moved during that cycle.
- **FR-023** Dispatch options MUST carry `timeout_ms` from the envelope.

### 4.4 Verification pipeline (FR-024 … FR-032)

- **FR-024** Validators MUST be executed by an **engine-controlled executor**, never by the agent or host on the engine's behalf. A `ValidatorResult` produced from an agent assertion is invalid by construction.
- **FR-025** Each `ValidatorDefinition` MUST have: stable id, structured `argv` (no shell), working directory relative to the workspace root, timeout, risk class, `required`, `appliesTo`, environment allowlist, output cap, and a definition digest. Agent text MUST NOT be interpolated into argv.
- **FR-026** Snapshots (FR-033..) and validator runs MUST be bound together: a result records the subject `snapshotId`, exit code, signal, timeout/cancellation flags, duration and log references.
- **FR-027** Outcomes are `PASSED`, `FAILED` (ran, non-zero/assertion failure → remediable), `ERROR` (could not run or timed out → suspend). A missing result for a required validator is `ERROR`.
- **FR-028** Any required validator not `PASSED` MUST block acceptance and review dispatch.
- **FR-029** The allowlist, policy, envelope, ledger, checkpoints and evidence store are **protected paths**; a diff touching them is `OUT_OF_SCOPE_CHANGE`.
- **FR-030** Validators MUST run with cwd confined to the workspace (resolved real path), a minimal environment, and no additional permission grants; network isolation is **not enforceable** by the MVP executor and MUST be reported as `network: "not-enforced"`.
- **FR-031** Changes to `sensitivePaths` (files that define validator behaviour: test configs, build scripts, `package.json` scripts, test files named by the policy) MUST force the reviewer to give an explicit `verifierTampering` disposition and MAY require a gate, per policy.
- **FR-032** Validators MUST be re-run for every new subject snapshot; results for an older snapshot MUST NOT satisfy a newer one.

### 4.5 Snapshot / diff identity (FR-033 … FR-036)

- **FR-033** A `SnapshotIdentity` MUST contain `baseCommit`, a sorted list of per-path entries (`path`, change kind, mode, content sha-256, or tombstone), and `snapshotId = sha256(canonical form)`. It MUST work on an uncommitted working tree.
- **FR-034** A task's reviewed diff is the delta `taskBaseline → subject`, materialised as a content-addressed artifact whose digest is part of the `ReviewRequest`.
- **FR-035** Acceptance MUST recompute the snapshot and require equality with the snapshot that was validated **and** reviewed.
- **FR-036** Snapshot computation MUST exclude Harness-owned paths and VCS-ignored paths, and MUST report (not hide) untracked files.

### 4.6 Independent review (FR-037 … FR-040)

- **FR-037** The review MUST be a separate invocation (new `step_id`, new `reviewInvocationId`) under its own contract `harness-review/v1`, receiving no implementer conversation, narrative or verdict.
- **FR-038** The `ReviewResult` MUST echo `snapshotId` and `diffDigest`, give a verdict for **every** acceptance criterion with evidence, list a disposition for **every** file in the delta, and carry reviewer identity and contract version. `PASS` is valid only with all of these and zero open blocking findings.
- **FR-039** Reviewer independence MUST be recorded as `isolationEvidence` (`DISTINCT_INVOCATION_ATTESTED` | `NONE`). The MVP guarantees a separate invocation/context/contract only; it MUST NOT claim process or model isolation.
- **FR-040** Findings MUST use the `HarnessFinding` shape (`contracts/review-contract.md`): id, severity, category, description, impact, recommendation, evidence refs, violated criterion/contract, blocking, snapshot reference, reviewer identity/version, fingerprint, source (`REVIEW` | `VALIDATOR` | `HARNESS`).

### 4.7 Remediation (FR-041 … FR-050) — owner Decision 1

- **FR-041** The Harness allows **exactly three** automatic remediation attempts per `(authorizationLineage, taskId)`. The envelope may lower but never raise this ceiling.
- **FR-042** An **attempt** is a remediation dispatch that was durably recorded (pending action + incremented counter in one CAS checkpoint) in response to a blocking finding. The first such dispatch is attempt 1.
- **FR-043** The counter is persisted in the checkpoint, survives resume, restart and host change, and never decrements.
- **FR-044** Counting rules for abnormal outcomes are fixed (`contracts/remediation-budget.md` §4): a durably recorded dispatch counts even if the host fails, times out, returns an invalid result, or is abandoned; a dispatch that never became durable (CAS/lock/write failure, authorisation denial, pre-dispatch rejection) does not count; re-presenting the same pending action never counts twice.
- **FR-045** A human answer (`humanAnswers`) MUST NOT reset, replenish or alter the counter. Only a recorded `RemediationBudgetGrant` may extend the limit, bounded to ≤ 3 per grant, linked to a specific suspension.
- **FR-046** After attempt 3 is unsuccessful the Harness MUST suspend with `REMEDIATION_BUDGET_EXHAUSTED`; it MUST NOT accept the task and MUST NOT dispatch a fourth attempt without a grant.
- **FR-047** After every attempt: all affected required validators re-run, then a **new separate review invocation** runs against the new subject snapshot.
- **FR-048** `CRITICAL` findings, unauthorised operations, business ambiguity and out-of-scope changes MUST suspend immediately and MUST NOT cause a new remediation dispatch (so they never consume an attempt of their own; attempts already counted stay counted).
- **FR-049** If the set of blocking finding fingerprints after attempt *n* is not a strict reduction of attempt *n−1*'s for two consecutive attempts, the policy `ESCALATE_ON_NO_PROGRESS` (default) suspends early with `NO_PROGRESS`.
- **FR-050** The Harness remediation policy MUST be selected by the Harness workflow preset only; the engine's `MAX_REMEDIATION_ITERATIONS` behaviour for non-Harness executions MUST remain bit-for-bit unchanged.

### 4.8 Evidence ledger and retention (FR-051 … FR-058)

- **FR-051** Historical events MUST be **append-only** in the checkpoint's Harness block; derived fields ("latest result") MAY be updated but MUST NOT remove prior events. The specification MUST NOT call this *immutable*: append-only is enforced by code and hash-chaining, not by storage.
- **FR-052** Events carry a sequence number and `prevHash`; the chain head (`seq`, `hash`) is stored with the counters so truncation or reordering is detectable.
- **FR-053** From the ledger one MUST be able to reconstruct: execution, phase, task, envelope and policy revision, step ids and attempts, snapshot ids, validators and logs, reviewer and findings, remediations, and the final advance/suspend decision.
- **FR-054** Heavy artifacts (diffs, logs) MUST be content-addressed files under `.project-run/evidence/<executionId>/…`; the checkpoint holds only `EvidenceReference` records (path, sha-256, bytes, media type, `redactionStatus`).
- **FR-055** Captured output MUST be size-capped (truncation recorded), passed through a redaction pass (policy patterns + values of environment variables named in the validator allowlist), and labelled `REDACTED`, `CLEAN_SCANNED`, or `QUARANTINED`. `QUARANTINED` output MUST NOT be sent to a reviewer or host; the cycle suspends with `EVIDENCE_QUARANTINED`.
- **FR-056** Redaction is best effort and MUST be documented as such; the executor MUST NOT pass secrets to validators unless the policy names the variable.
- **FR-057** Evidence is retained until a human removes it; the Harness never auto-deletes. A reference whose file is missing or whose digest mismatches is `EVIDENCE_MISSING` and cannot support acceptance.
- **FR-058** `.project-run/evidence/` MUST be reported by `doctor` when not VCS-ignored.
- **FR-059** Invalidation of a validator or review result MUST be recorded as a new `INVALIDATED` event naming the cause (new snapshot, pin mismatch, missing evidence); the original event stays.
- **FR-060** `status` MUST expose Harness state (enabled, envelope digest/status, cycle step, task states, budgets, chain head, last suspension, `diverged`) without writing.

### 4.9 Invalidation (FR-061 … FR-064)

- **FR-061** Before every dispatch and before acceptance the controller MUST recompute pinned digests; any mismatch sets the envelope `SUSPENDED_STALE` and returns `PIN_MISMATCH` with the changed artifact names.
- **FR-062** Policy, allowlist or permitted-operation change ⇒ the whole envelope is invalid; a new revision is required.
- **FR-063** A changed definition of a task that is not yet accepted ⇒ that task ineligible until the envelope is amended.
- **FR-064** A changed definition or contract of an **accepted** task ⇒ it stays `ACCEPTED` but flagged `UPSTREAM_CHANGED`; dependents are blocked until a human `UpstreamAcknowledgement` is recorded. Validation and review results are logically invalidated whenever the subject snapshot changes.

### 4.10 Controller, recovery and continuity (FR-065 … FR-072)

- **FR-065** Every controller call MUST begin by loading the persisted state and evaluating, in order: persistence health → lock → envelope validity → pending action → suspension → eligibility.
- **FR-066** If a pending action exists it MUST be resumed through the existing protocol (same `step_id`); an equivalent new action MUST NOT be created.
- **FR-067** Absence of a host response MUST NOT be treated as success. A pending action older than the envelope's `dispatchTtlMs` MUST cause a `DISPATCH_TIMEOUT` suspension; it MUST NOT be auto-closed or auto-retried.
- **FR-068** A result failing Harness-level validation is rejected without applying it; the pending action stays; after `maxSubmissionRejections` (default 2) the step is closed unsuccessful and the cycle suspends `RESULT_INVALID`.
- **FR-069** `CHECKPOINT_CONFLICT`, `EXECUTION_LOCKED`, `EXECUTION_LOCK_UNAVAILABLE`, `CHECKPOINT_WRITE_FAILED` MUST each prevent progression, return the existing non-terminal failure code, and leave counters untouched. The controller MUST NOT retry a conflicting call blindly.
- **FR-070** Recovery MUST be defined and tested for every boundary listed in `contracts/harness-controller.md` §5.
- **FR-071** `/loop` MAY request another iteration, but each iteration MUST re-enter the controller (FR-065). Correlation uses `(executionId, cycleId, step_id)`; the spec MUST NOT claim exactly-once external effects.
- **FR-072** The controller MUST honour `HUMAN_INTERVENTION_REQUIRED`, stop points and exhausted limits identically in push and pull modes.

### 4.11 Compatibility and evolution (FR-073 … FR-078)

- **FR-073** The checkpoint MUST gain only **optional** fields (`harness` block); `version` stays `1`; the Harness block carries its own `schema_version`.
- **FR-074** Legacy checkpoints MUST load, display status and resume with no write unless the user performs a mutating turn; no silent migration; absent fields are read as empty and never reconstructed.
- **FR-075** Adopting an existing execution MUST be an explicit human operation (`adoptExecution`) recording the revision at adoption; earlier history is not back-filled.
- **FR-076** A Harness-enabled execution MUST record `min_engine_version`; a tripwire manifest in the evidence directory detects a checkpoint rewritten by an engine that dropped the block (`HARNESS_STATE_DIVERGED`, fail closed).
- **FR-077** New contracts MUST stay internal (`src/harness/`, not re-exported from the package root) until Gate D; any subpath export is marked experimental and covered by `public-api-surface` tests.
- **FR-078** The decision engine, existing presets and existing public types MUST remain source- and behaviour-compatible; the Harness preset is a new, separate preset id.

### 4.12 Out of scope / Non-goals

- **NG-1** Parallelism, distributed coordination, cross-machine locks.
- **NG-2** Worktree/branch management; merge, push, PR, release, publish, deploy, migration.
- **NG-3** Dependence on a specific SDK, model, IDE or host.
- **NG-4** Bulk migration of checkpoints.
- **NG-5** Enabling the Harness on Feature 009 (see §7).
- **NG-6** Strong process/model isolation of the reviewer.
- **NG-7** Network sandboxing of validators.
- **NG-8** Authenticating human actors.

## 5. Key entities

`PhaseAuthorizationEnvelope`, `HarnessPolicy`, `TaskGraph`/`TaskNode`/`TaskEligibilityDecision`, `GateDecision`,
`DependencyAttestation`, `VerificationProfile`/`ValidatorDefinition`/`ValidatorResult`, `SnapshotIdentity`,
`ReviewRequest`/`ReviewResult`/`HarnessFinding`, `RemediationBudget`/`RemediationBudgetGrant`,
`EvidenceReference`/`HarnessEvent`, `HarnessDecision` (`CONTINUE | REMEDIATE | ADVANCE_TASK | SUSPEND | FAIL_CLOSED`),
`HarnessSuspension`. Fields and invariants: `data-model.md` and `contracts/`.

## 6. Success criteria (verifiable on the Gate B fixture)

- **SC-001** In the fixture, a complete positive cycle (implement → validators → review with finding → remediation → validators → review PASS → accepted) produces a ledger from which every item in FR-053 can be reconstructed by a test.
- **SC-002** 100 % of scenarios in `acceptance-scenarios.md` marked P1 pass; each negative scenario ends in `SUSPEND` or `FAIL_CLOSED`, never in acceptance.
- **SC-003** After exactly three failed attempts the fixture suspends; across restart, host change and a human answer the counter never changes (property test over resume points).
- **SC-004** For every crash point in `contracts/harness-controller.md` §5 a recovery test shows: no fabricated success, no double-count, no duplicate dispatch.
- **SC-005** The full existing suite (428 tests at baseline) passes unchanged, and a new regression test proves a non-Harness execution reaches identical checkpoints (byte-compared modulo timestamps/ids) before and after the change.
- **SC-006** No test, fixture or document in this feature touches Incito or Feature 009.
- **SC-007** Mutating any pinned artifact in the fixture prevents the next dispatch (`PIN_MISMATCH`) in 100 % of the enumerated cases.

## 7. Feature 009 exclusion (unresolved H0 findings, treated as risks)

Feature 009 (`incito`, execution `offboarding-001`) is **excluded** from any fixture, pilot or test until a separate
review and authorisation. Unresolved H0 findings: checkpoint `branch` (`fix/008-pr24-review-followups`) differs from the
repository branch (`feat/009-business-offboarding`); `.project-run/config.json` `feature_directory` still names
`specs/007-operator-foundations`; a second checkpoint is `FAILED`; `pending_action.request.context` is `{}`; the working
tree is dirty (including `tasks.md`), so the committed state of Feature 009's T035–T038 is unverified; its first unchecked task
(its T039) has not been revalidated. These are tracked as R-8 in `plan.md`.

## 8. Assumptions

- The pull API (`nextProjectRunStep`/`submitProjectRunStep`) remains the primary integration path; push mode is supported but secondary.
- The consumer provides `tasks.md` in Spec Kit task format and approves it before authorisation.
- The workspace is a git repository (the existing engine already requires this).
- A single machine and local filesystem.

## 9. Open decisions requiring owner input

See `plan.md` §8 (OD-1 … OD-5). None blocks Gate A review; OD-1 blocks Gate B.
