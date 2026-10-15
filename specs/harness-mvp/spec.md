# Feature Specification: Autonomous Engineering Harness MVP

**Feature directory**: `specs/harness-mvp/`
**Target repository**: `project-run-engine` (baseline `v0.5.0`, SHA `c1e4054`)
**Status**: **Gate A approved 2026-10-15 (revision 2); specification phase H0–H7 concluded. Revision 3 (2026-10-15) incorporates the T049 technical review into the specification only.** **Specification only. No implementation is authorized; Gate B is blocked** pending the owner's review of the T049 report and a new explicit authorisation. T049 is **not** closed by this revision.
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
| E-8 | The engine overwrites the whole checkpoint on save; fields not built by the Coordinator are dropped (confirmed by T049 probe 1, E-11). Older engines also drop `revision`/`history`. | Harness executions are written only by `Coordinator.commit`, which preserves every field of the persisted record (FR-099); mixed-version use is detected (FR-076). |
| E-9 | The file store lock and CAS are single-machine only. | MVP stays single machine (NG-1). |
| E-10 | `.project-run/config.json` is tracked configuration; `.project-run/runs/` is mutable state that consumers are told to VCS-ignore (`CONSUMER-GUIDE.md`). | Policy goes under a new tracked `.project-run/harness/`; evidence under an ignored `.project-run/evidence/` (FR-090). |
| E-11 | `Coordinator.checkpoint()` builds the record field by field; contexts are rebuilt field by field on submit and resume; an injected unknown field did not survive one submit (T049 probe 1). | Harness executions are written only by one additive `Coordinator.commit` that starts from the persisted record (FR-099). |
| E-12 | One `submitProjectRunStep` writes **three** checkpoints (`(IMPLEMENT, IN_PROGRESS, result)` → `(INDEPENDENT_REVIEW, IN_PROGRESS, none)` → `(INDEPENDENT_REVIEW, AWAITING, pending)`); transitions are checkpointed `IN_PROGRESS` with no pending action. | Every at-rest tuple of the Harness' own write sequences is a defined row with a recovery action (FR-101). |
| E-13 | `reconstructResumeContext` sets `state = suspended_from`, clears the saved result and resets `remediation_iteration` for most stages, so a human answer **re-dispatches** the agent with a new `step_id` (T049 probe 2; `cdd4d41`). | Harness executions never use it; human answers are audit-only (FR-097, FR-098). |
| E-14 | Push mode (`Coordinator.step/run`, `executeProjectRun/Resume`, `ProjectRunHost`) has no durable pending action while an agent runs. | Harness executions are pull-only (FR-097). |
| E-15 | The pull API always builds `new CoordinatorDecisionEngine()`; the persisted `preset` is a free label (`"v1"` in a consumer). | Identification is by the validated `harness` block only (FR-096). |
| E-16 | `pending_action.request` (including `context`) is persisted unscrubbed; `scrubSecrets` covers only `state.context`. `NextProjectRunStepRequest.executionOptions` is declared but never forwarded in pull mode. | Requests carry references and digests only (FR-102); `timeout_ms` is host-enforced (FR-023). |
| E-17 | Checkpoint `created_at` is rewritten on every save; `tests/phase5-history.test.ts:124` asserts one applied step per dispatch. | Harness audit time comes from events; the pairing exception for abandoned/timed-out actions is documented (FR-105, FR-108). |

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
4. **Given** a Harness execution is suspended, **When** `humanAnswers` are supplied, **Then** they are validated and recorded, the same suspension is returned, and **no agent is dispatched** and no counter, `remediation_iteration` or `last_result` changes; only a typed human operation or `resumeSuspension` leaves the suspension, and the next dispatch (if any) goes through authorisation, pins, baseline and budget.
5. **Given** a crash between any two commits, **When** the controller is called again, **Then** it finds a documented table row and completes the cycle without a duplicate dispatch or a double count.
6. **Given** a Harness execution is passed to a push entry point or to `reconstructResumeContext`, **Then** it is refused with no write.

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

- Working tree already dirty at authorization: **refused by default** (`BASELINE_NOT_CLEAN`); a dirty baseline needs an evidence-backed `DirtyBaselineApproval` (FR-083). Drift between tasks, or any change not produced by an accepted task of this envelope, ⇒ `BASELINE_DRIFT` (FR-082). Feature 009's working tree is never used as a baseline or fixture.
- Task diff touches a protected path (policy files, allowlist, checkpoints, `tasks.md` beyond the task's own checkbox) → `OUT_OF_SCOPE_CHANGE`, no remediation attempt consumed until a human decides.
- Diff changes between validation and acceptance (TOCTOU) → acceptance refused, results marked stale.
- `tasks.md` checkbox says done but the ledger has no acceptance (or the reverse) → `RECONCILIATION_REQUIRED`.
- Reviewer finds a blocking issue in code the task did not touch → recorded, flagged `preExisting: true` only by the reviewer with evidence; still blocking unless a human accepts it.
- A validator is satisfied by editing the validator's own configuration/tests → `sensitivePaths` rule forces explicit reviewer disposition (FR-031).
- Log output contains a secret → redaction / quarantine rules (FR-054..FR-056).
- Host reports success after the pending action was abandoned → `STALE_STEP`, result discarded.
- Host crashes between the transition commit and the dispatch commit (`(REMEDIATION, IN_PROGRESS, none)`): the counter has **not** been incremented yet; recovery dispatches with counter+1 in one commit (row T7).
- A human answers a blocked remediation stage: the answer is recorded only; the existing engine behaviour (new `step_id`, `remediation_iteration` reset) does **not** apply to Harness executions (FR-098).
- `NextProjectRunStepRequest.executionOptions` is ignored by the existing pull API: the Harness sets `timeout_ms` itself (FR-023).
- A request or pending action would exceed 8 KiB or contain diff text: rejected at construction (FR-102).

## 4. Requirements

### 4.1 Authorisation (FR-001 … FR-010)

- **FR-001** The Harness MUST be opt-in per execution. An execution without a persisted Harness block MUST behave exactly as in v0.5.0.
- **FR-002** A `PhaseAuthorizationEnvelope` MUST be a versioned, immutable-once-issued record (fields in `contracts/authorization-envelope.md`). Any change MUST create a new envelope revision that `supersedes` the previous one.
- **FR-003** Envelopes MUST be created, amended, revoked only through **human-only operations** (D-22) that are not reachable through `submitProjectRunStep`. Each records `actor` (kind `HUMAN`, identifier asserted by the host), time and the envelope digest. This is **logical separation, not technical prevention**: the engine cannot authenticate the actor, and any local process with the same filesystem and shell access (including an agent) can call the same internal functions or edit files directly. The contract, status output and risk register MUST say so (FR-079).
- **FR-004** Every envelope MUST be a subset of a project `HarnessPolicy` (repository configuration, digest-pinned). An envelope MUST NOT widen the policy ceiling (permitted operations, validators, limits).
- **FR-005** Permitted operations MUST be an explicit closed enumeration; anything unlisted is **denied by policy**. The following MUST NOT be authorisable in the MVP: destructive operations, data migrations, deployments, infrastructure changes, business decisions, scope expansion, policy/allowlist/envelope changes, `git commit`/`push`/merge/PR/release/publish, network egress. "Denied by policy" means the Harness will not dispatch, accept or run them itself and will suspend when it **sees** one; it does **not** mean they are technically prevented (FR-079, FR-080).
- **FR-006** The envelope MUST support `expiresAt`, status (`ACTIVE`, `SUSPENDED_STALE`, `EXPIRED`, `REVOKED`, `SUPERSEDED`, `COMPLETED`), and immediate revocation effective at the next controller boundary.
- **FR-007** Authorisation MUST be evaluated before **every** dispatch (implementation, remediation, review) and again before acceptance; failure returns a typed denial and dispatches nothing.
- **FR-008** The envelope MUST pin: the policy digest, the validator-allowlist digest, **structural** digests of the authorised tasks and of their transitive dependencies (FR-085), and digests of listed spec/contract artifacts. `tasks.md` MUST NOT be pinned by raw file bytes.
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
- **FR-020** The agent MUST receive no authority (by contract) to change policy, allowlist, envelope, checkpoints, ledger or other tasks. Protected paths (FR-029) are **detected after the fact** by diff inspection; the Harness does not prevent the agent from writing them, it refuses acceptance and suspends (enforcement class E2, FR-079).
- **FR-021** The agent's structured result (summary, files changed, evidence refs) MUST be treated as a claim; the engine computes the real delta (FR-026) and any mismatch is a `RESULT_MISMATCH` finding.
- **FR-022** A task baseline snapshot MUST be recorded before the first dispatch of the task cycle and never moved during that cycle.
- **FR-023** Harness dispatches MUST set `request.options.timeout_ms` from the envelope. The timeout is **host-enforced (E3)**: the engine neither runs nor interrupts the agent in pull mode, and `NextProjectRunStepRequest.executionOptions` is not forwarded today (E-16), so the Harness supplies the option itself; the only engine-side bound is `dispatchTtlMs` (FR-067).

### 4.4 Verification pipeline (FR-024 … FR-032)

- **FR-024** Validators MUST be executed by an **engine-controlled executor**, never by the agent or host on the engine's behalf. A `ValidatorResult` produced from an agent assertion is invalid by construction.
- **FR-025** Each `ValidatorDefinition` MUST have: stable id, structured `argv` (no shell), working directory relative to the workspace root, timeout, risk class, `required`, `appliesTo`, environment allowlist, output cap, and a definition digest. Agent text MUST NOT be interpolated into argv.
- **FR-026** Snapshots (FR-033..) and validator runs MUST be bound together: a result records the subject `snapshotId`, exit code, signal, timeout/cancellation flags, duration and log references.
- **FR-027** Outcomes are `PASSED`, `FAILED` (ran, non-zero/assertion failure → remediable), `ERROR` (could not run or timed out → suspend). A missing result for a required validator is `ERROR`.
- **FR-028** Any required validator not `PASSED` MUST block acceptance and review dispatch.
- **FR-029** The allowlist, policy, envelope, ledger, checkpoints and evidence store are **protected paths** (the mandatory set in FR-090 cannot be removed by policy); a diff touching them is `OUT_OF_SCOPE_CHANGE`. Detection only (E2): the changes remain in the working tree and the Harness never rolls back.
- **FR-030** Validators MUST run with cwd confined to the workspace (resolved real path), a minimal environment, and no additional permission grants. The MVP executor provides **no network isolation and no filesystem sandbox** (E3): a validator can read any file the OS user can read and reach any network the host allows. Status MUST report `network: "not-enforced"` and `filesystem: "cwd-confinement-only"`.
- **FR-031** Changes to `sensitivePaths` (files that define validator behaviour: test configs, build scripts, `package.json` scripts, test files named by the policy) MUST force the reviewer to give an explicit `verifierTampering` disposition and MAY require a gate, per policy.
- **FR-032** Validators MUST be re-run for every new subject snapshot; results for an older snapshot MUST NOT satisfy a newer one.

### 4.5 Snapshot / diff identity (FR-033 … FR-036)

- **FR-033** A `SnapshotIdentity` MUST contain `baseCommit`, a sorted list of per-path entries (`path`, change kind, mode, content sha-256, or tombstone), and `snapshotId = sha256(canonical form)`. It MUST work on an uncommitted working tree.
- **FR-034** A task's reviewed diff is the delta `taskBaseline → subject`, materialised as a content-addressed artifact whose digest is part of the `ReviewRequest`.
- **FR-035** Acceptance MUST recompute the snapshot and require equality with the snapshot that was validated **and** reviewed.
- **FR-036** Snapshot computation MUST exclude only Harness-owned paths and the explicitly listed `ignoredExclusions` of the policy; every other VCS-ignored file that exists is **hashed** and tracked (content never copied into patches) per FR-084; untracked files MUST be reported, not hidden.

### 4.6 Independent review (FR-037 … FR-040)

- **FR-037** The review MUST be a separate invocation (new `step_id`, new `reviewInvocationId`) under its own contract `harness-review/v1`, receiving no implementer conversation, narrative or verdict.
- **FR-038** The `ReviewResult` MUST echo `snapshotId` and `diffDigest`, give a verdict for **every** acceptance criterion with evidence, list a disposition for **every** file in the delta, and carry reviewer identity and contract version. `PASS` is valid only with all of these and zero open blocking findings.
- **FR-039** Reviewer independence MUST be recorded as `isolationEvidence` (`DISTINCT_INVOCATION_ATTESTED` | `NONE`). The MVP guarantees a separate invocation/context/contract only; it MUST NOT claim process or model isolation.
- **FR-040** Findings MUST use the `HarnessFinding` shape (`contracts/review-contract.md`): id, severity, category, description, impact, recommendation, evidence refs, violated criterion/contract, blocking, snapshot reference, reviewer identity/version, fingerprint, source (`REVIEW` | `VALIDATOR` | `HARNESS`).

### 4.7 Remediation (FR-041 … FR-050) — owner Decision 1

- **FR-041** The Harness allows **exactly three** initial automatic remediation attempts per task (the counter is keyed by `(executionId, taskId)` and each attempt records the envelope lineage that dispatched it, FR-091). The envelope may lower but never raise this number; extra attempts exist only through FR-045 grants.
- **FR-042** An **attempt** is a remediation dispatch that was durably recorded (pending action + incremented counter in one CAS checkpoint) in response to a blocking finding. The first such dispatch is attempt 1.
- **FR-043** The counter is persisted in the checkpoint, survives resume, restart and host change, and never decrements.
- **FR-044** Counting rules for abnormal outcomes are fixed (`contracts/remediation-budget.md` §4): a durably recorded dispatch counts even if the host fails, times out, returns an invalid result, or is abandoned; a dispatch that never became durable (CAS/lock/write failure, authorisation denial, pre-dispatch rejection) does not count; re-presenting the same pending action never counts twice.
- **FR-045** A human answer (`humanAnswers`) MUST NOT reset, replenish or alter the counter. Only a recorded `RemediationBudgetGrant` may extend the limit, bounded to ≤ 3 per grant, linked to a specific suspension.
- **FR-046** After attempt 3 is unsuccessful the Harness MUST suspend with `REMEDIATION_BUDGET_EXHAUSTED`; it MUST NOT accept the task and MUST NOT dispatch a fourth attempt without a grant.
- **FR-047** After every attempt: all affected required validators re-run, then a **new separate review invocation** runs against the new subject snapshot.
- **FR-048** `CRITICAL` findings, unauthorised operations, business ambiguity and out-of-scope changes MUST suspend immediately and MUST NOT cause a new remediation dispatch (so they never consume an attempt of their own; attempts already counted stay counted).
- **FR-049** `NO_PROGRESS` is evaluated exactly as defined in `contracts/remediation-budget.md` §6 (fingerprint normalisation, set comparison, streak). Default: suspend when the streak reaches 2. A policy-defined floor MUST NOT be weakened by an envelope (FR-092).
- **FR-050** The Harness remediation policy applies to Harness executions only. The engine's `decide`/`resolveTransition` and its `MAX_REMEDIATION_ITERATIONS` logic are **never executed** for them (the Harness drives its own writes, FR-099); for non-Harness executions the v0.5.0 behaviour (4 dispatches, human answers replenishing the budget) MUST remain bit-for-bit unchanged.

### 4.8 Evidence ledger and retention (FR-051 … FR-058)

- **FR-051** Historical events MUST be **append-only** in the checkpoint's Harness block; derived fields ("latest result") MAY be updated but MUST NOT remove prior events. The specification MUST NOT call this *immutable*: append-only is enforced by code and hash-chaining, not by storage.
- **FR-052** Events carry a sequence number and `prevHash`; the chain head (`seq`, `hash`) is stored with the counters so truncation or reordering is detectable.
- **FR-053** From the ledger one MUST be able to reconstruct: execution, phase, task, envelope and policy revision, step ids and attempts, snapshot ids, validators and logs, reviewer and findings, remediations, and the final advance/suspend decision.
- **FR-054** Heavy artifacts (diffs, logs) MUST be content-addressed files under `.project-run/evidence/<executionId>/…`; the checkpoint holds only `EvidenceReference` records (path, sha-256, bytes, media type, `redactionStatus`) and **dispatch requests and pending actions carry the same references, never the content** (FR-102).
- **FR-055** Captured output MUST be size-capped (truncation recorded), passed through a redaction pass (policy patterns + values of environment variables named in the validator allowlist), and labelled `REDACTED`, `CLEAN_SCANNED`, or `QUARANTINED`. `QUARANTINED` output MUST NOT be sent to a reviewer or host; the cycle suspends with `EVIDENCE_QUARANTINED`.
- **FR-056** Redaction is best effort and MUST be documented as such; the executor MUST NOT pass secrets to validators unless the policy names the variable.
- **FR-057** Evidence is retained until a human removes it; the Harness never auto-deletes. A reference whose file is missing or whose digest mismatches is `EVIDENCE_MISSING` and cannot support acceptance.
- **FR-058** The Harness MUST verify that `.project-run/evidence/` and `.project-run/runs/` are VCS-ignored, using `git check-ignore` through the `SnapshotProvider` port, as an **internal** diagnostic (`harnessDoctor`) that reports `EVIDENCE_NOT_IGNORED`. The public `runProjectDoctor` and `ProjectDoctorReport` are unchanged (the existing doctor is fs-only and non-spawning, FR-105).
- **FR-059** Invalidation of a validator or review result MUST be recorded as a new `INVALIDATED` event naming the cause (new snapshot, pin mismatch, missing evidence); the original event stays.
- **FR-060** `harnessStatus` (an **internal** read-only function) MUST expose Harness state (enabled, envelope digest/status, cycle step and table row, task states, budgets, chain head, last suspension, `diverged`) without writing; the public `statusProjectRun`/`ProjectRunHostResponse` are unchanged until a Gate C approval (FR-095).

### 4.9 Invalidation (FR-061 … FR-064)

- **FR-061** Before every dispatch and before acceptance the controller MUST recompute every pin **with its artifact-specific canonical digest** (FR-085: structural digests for `tasks.md`, never raw bytes); any mismatch sets the envelope `SUSPENDED_STALE` and returns `PIN_MISMATCH` with the changed artifact names.
- **FR-062** Policy, allowlist or permitted-operation change ⇒ the whole envelope is invalid; a new revision is required.
- **FR-063** A changed **structural definition** (text, acceptance criteria, dependencies, gates, markers) of an authorised task that is not yet accepted, or of any task in its dependency closure ⇒ that task is ineligible until the envelope is amended. A checkbox-only change is never a definition change.
- **FR-064** A changed definition or contract of an **accepted** task ⇒ it stays `ACCEPTED` but flagged `UPSTREAM_CHANGED`; dependents are blocked until a human `UpstreamAcknowledgement` is recorded. Validation and review results are logically invalidated whenever the subject snapshot changes.

### 4.10 Controller, recovery and continuity (FR-065 … FR-072)

- **FR-065** Every controller call MUST follow the evaluation order of `contracts/harness-controller.md` §2: identify/guard → load → lock → platform/schema/chain → **state classification (row or `STATE_INCOHERENT`)** → ports → envelope/pins/baseline → pending action → suspension → the row's recovery action or the cycle machine.
- **FR-066** If a pending action exists it MUST be resumed through the existing protocol (same `step_id`); an equivalent new action MUST NOT be created. The Harness serves it from the persisted record without invoking the engine's decision logic.
- **FR-067** Absence of a host response MUST NOT be treated as success. A pending action older than the envelope's `dispatchTtlMs` MUST cause a `DISPATCH_TIMEOUT` suspension; it MUST NOT be auto-closed or auto-retried.
- **FR-068** A result failing Harness-level validation is rejected without applying it; the pending action stays; **the second rejected submission for the same step** (`maxSubmissionRejections` = 2) closes the step unsuccessful and the cycle suspends `RESULT_INVALID`. The first rejection does not suspend.
- **FR-069** `CHECKPOINT_CONFLICT`, `EXECUTION_LOCKED`, `EXECUTION_LOCK_UNAVAILABLE`, `CHECKPOINT_WRITE_FAILED` MUST each prevent progression, return the existing non-terminal failure code, and leave counters untouched. The controller MUST NOT retry a conflicting call blindly.
- **FR-070** Recovery MUST be defined and tested for every boundary listed in `contracts/harness-controller.md` §5.
- **FR-071** `/loop` MAY request another iteration, but each iteration MUST re-enter the controller (FR-065). Correlation uses `(executionId, cycleId, step_id)`; the spec MUST NOT claim exactly-once external effects.
- **FR-072** The controller MUST honour `HUMAN_INTERVENTION_REQUIRED`, stop points and exhausted limits for every pull-mode caller and host. **Push entry points are not supported for Harness executions and refuse them** (FR-097); push/pull equivalence is therefore not a requirement.

### 4.11 Compatibility and evolution (FR-073 … FR-078)

- **FR-073** The checkpoint MUST gain only **optional** fields (`harness` block); `version` stays `1`; the Harness block carries its own `schema_version`.
- **FR-074** Legacy checkpoints MUST load, display status and resume with no write unless the user performs a mutating turn; no silent migration; absent fields are read as empty and never reconstructed.
- **FR-075** Adopting an existing execution MUST be an explicit human operation (`adoptExecution`) recording the revision at adoption; earlier history is not back-filled. Adoption is accepted **only** from three quiescent tuples at `IMPLEMENT`: `(IMPLEMENT, AWAITING_AGENT_ACTION, engine-created pending IMPLEMENT)` (the engine's pending action is closed by the adoption commit with a digest-only event; a late result for it is `STALE_STEP`), `(IMPLEMENT, IN_PROGRESS, none)`, or `(HUMAN_INTERVENTION_REQUIRED, suspended_from = IMPLEMENT)`; every other tuple is refused (`ADOPTION_STATE_UNSUPPORTED`) and the result is row T0. Starting a brand-new execution directly under the Harness from `INTAKE` is not supported in the MVP.
- **FR-076** A Harness-enabled execution MUST record `min_engine_version`; a tripwire manifest in the evidence directory detects a checkpoint rewritten by an engine that dropped the block (`HARNESS_STATE_DIVERGED`, fail closed).
- **FR-077** Harness contracts MUST stay **internal** (`src/harness/`). The Gate B slice MUST NOT add exports to the package root, new `exports` subpaths, new `bin`/CLI subcommands or new exported names; `package.json` `exports`/`bin`/`files` MUST be byte-identical. The **only** permitted change to existing exported types/classes is the complete list in FR-105 (one optional field and one `@internal` method), proven by a type-surface test. Any other exposure requires a separate, explicit owner approval.
- **FR-078** The decision engine, existing presets and existing public types MUST remain source- and behaviour-compatible; the Harness preset is a new, separate preset id.

### 4.12 Correction-pass requirements (revision 2)

**Enforcement honesty**

- **FR-079** Every rule in the policy and envelope MUST declare an **enforcement class**: **E1** *engine-refused* (the engine will not dispatch/accept/run it: e.g. dispatching an unauthorised task, accepting without validators, running a non-allowlisted validator); **E2** *detected after the fact* (workspace changes outside allowed paths, protected-path edits, new symlinks: detected by diff inspection, acceptance refused, changes stay on disk); **E3** *host- or environment-enforced, otherwise not enforced* (network egress, `git push`/commit, deployment, migrations, database access, reading secrets, any process the agent starts). Specification text, contracts, `status` output and the risk register MUST NOT say an E2 or E3 operation is "prevented" or "blocked"; they say "denied by policy", "detected" or "not enforced by the engine".
- **FR-080** `OPERATION_NOT_PERMITTED` is raised only from **visible evidence**: an operation declared in the agent result, reported by the host, or detected in the workspace diff. Absence of such evidence is **not** evidence of absence; the status output MUST say operations outside the workspace are unobserved unless the host reports them.
- **FR-081** The isolated fixture MUST NOT make unnecessary secrets or credentials available to the agent mock or to validator processes: sanitised environment (only allowlisted names), `HOME` and config directories redirected to an empty temporary directory, no credential files (`.npmrc` tokens, SSH keys, cloud credentials) in or reachable by design from the fixture, no real tokens in CI for the fixture job. The fixture MUST plant canary secrets in the runner's environment and assert their absence in every child process and evidence file (SC-008).

**Baseline and snapshot integrity**

- **FR-082** Default baseline policy is `CLEAN_REQUIRED`: at `issueEnvelope` the working tree MUST have no uncommitted changes, tracked or untracked, other than Harness-owned paths; the committed `HarnessPolicy` file MUST be tracked and unmodified (FR-090). Between tasks the baseline of task *n+1* MUST have the same **`treeDigest`** (digest of the whole non-excluded tree, independent of commit) as the accepted subject snapshot of task *n* (chain of custody), or, after a human commit, as the new clean `HEAD` tree with identical content; anything else is `BASELINE_DRIFT` (suspension; no dispatch).
- **FR-083** A dirty baseline is allowed only if the policy sets `allowDirtyBaseline: true` **and** a human records a `DirtyBaselineApproval` listing every dirty path with its sha-256, change kind, reason and risk class, referencing evidence (the patch against `HEAD` stored as evidence). The approval is part of the envelope pins; the reviewer receives the dirty-baseline file list and patch as context and MUST give a `baselineInfluence` disposition; any change to an approved dirty file, or any new dirty file, is `BASELINE_DRIFT`. No default policy allows it.
- **FR-084** Ignored files are **not** excluded wholesale. Excluded: Harness-owned paths and the policy's explicit `ignoredExclusions` (for example `node_modules/**`, `dist/**`, cache directories). Every other ignored file that exists is included in `treeDigest` by path + mode + sha-256, its **content is never copied** into patches or evidence (secret risk), and a change to one during a cycle is reported as `IGNORED_FILE_CHANGED` and given to the reviewer as a path+hash change that needs a disposition. Ignored files matching `sensitivePaths` force a gate. Excluded directories are listed in the snapshot as `EXCLUDED_BY_POLICY` with the matching rule, so the exclusion is visible to the reviewer.

**Pinning**

- **FR-085** `tasks.md` is pinned only by **structural digests** computed from the canonical task form defined in `contracts/task-graph.md` §2: per task (id, normalised description and acceptance text, sorted dependencies, sorted gates, sorted markers), excluding checkbox state, line numbers, phase headings and unrelated prose, and including the parser version. The envelope pins `taskDefinitionDigests` (authorised tasks), `dependencyClosureDigests` (transitive dependencies) and `parserVersion`. A parser-version change is `PARSER_VERSION_CHANGED` (re-pin required), never a silent re-digest.
- **FR-086** Checkbox reconciliation is permitted without invalidation: a diff touching `tasks.md` is allowed **only** if (a) the structural digest of every task is unchanged and (b) the set of toggled checkboxes is a subset of the dispatched task's own checkbox. Anything else is `OUT_OF_SCOPE_CHANGE`. Human checkbox edits outside a cycle never invalidate pins but are still subject to FR-017 reconciliation.

**State coherence and recovery**

- **FR-087** The embedded `harness.cycle.step` is a *refinement* of the engine's `state`/`lifecycle_status`/`pending_action`, not a second orchestrator. The permitted tuples are the **rows T0–T9** of `contracts/harness-controller.md` §3a, each with a recovery action; they cover every at-rest tuple the Harness' own write sequences can leave, **including crash windows between commits** (FR-101). A tuple that is **not a row** ⇒ `FAIL_CLOSED(STATE_INCOHERENT)`, no repair, no counter or event write. `STATE_INCOHERENT` MUST NOT be returned for a tuple that has a defined recovery.
- **FR-088** The only recovery from `STATE_INCOHERENT` is the human-only `reconcileCycle` operation, which can only move the cycle to `SUSPENDED` (never forward) and records both views as evidence; counters are untouched.
- **FR-089** A submission for an action that was pending when the envelope became `EXPIRED`, `REVOKED` or `SUSPENDED_STALE` MUST be **refused without being applied** at evaluation step 5 (`ENVELOPE_NOT_ACTIVE` / `PIN_MISMATCH`); the pending action is preserved (`HOLD`) or closed by the human at revocation time (`ABANDON`); only a digest of the refused result is recorded. After a new ACTIVE envelope that still authorises the task with matching pins is issued, the same `step_id` may be submitted again and is validated normally against the actual workspace.

**Policy, limits, matching**

- **FR-090** The `HarnessPolicy` lives at **`.project-run/harness/policy.json`** (tracked configuration, distinct from mutable state in `.project-run/runs/` and `.project-run/evidence/`, which MUST be VCS-ignored). A mandatory protected set (`.project-run/harness/**`, `.project-run/config.json`, `.project-run/workflow.json`, `.project-run/runs/**`, `.project-run/evidence/**`, `.git/**`) is built into the engine and cannot be removed by policy or envelope. Issuance requires the policy file to be tracked and unmodified relative to `HEAD`.
- **FR-091** Relation of limits: **policy ceiling** (fixed at 3 in the MVP) ≥ **envelope `limit`** (0…ceiling, only lowers) = **initial automatic attempts**; **`RemediationBudgetGrant`** attempts are *additional*, separately recorded human authorisations, never part of policy or envelope, never created by envelope amendment (amendments carry consumption only). Consumption is tracked per `(executionId, taskId)` across all envelope lineages (re-issuing an envelope cannot reset it). A policy cap `maxGrantedAttemptsPerTask` (default 3) bounds cumulative grants.
- **FR-092** The policy's recurrence setting is a **floor**: an envelope may choose the same or a stricter setting, never a weaker one.
- **FR-093** Path patterns and candidate paths follow `contracts/path-matching.md` (dialect, normalisation, traversal, symlinks, separators, boundaries, test vectors) for `allowedPaths`, `protectedPaths`, `sensitivePaths`, `ignoredExclusions` and diff inspection.
- **FR-094** On `win32` the Harness MUST refuse to start (`HARNESS_PLATFORM_UNSUPPORTED`).
- **FR-095** Exposure of human-only operations, `harnessStatus` or any Harness API to hosts or the CLI is **not** part of Gate B (internal functions only); it requires a separate approval at Gate C. Until then the existing host skill (which resumes by `humanAnswers`) cannot resume a Harness execution, by design.

### 4.14 Technical-review requirements (revision 3, from T049)

**Identification, recovery and answers**

- **FR-096** An execution is a **Harness execution only if its persisted record carries a `harness` block that passes validation** (supported `schema_version`, hash chain, manifest). Identification MUST NOT use the `preset` field, configuration labels (`workflow_version`), file names or any caller-supplied flag. A record with a Harness manifest but no valid block is `HARNESS_STATE_DIVERGED`.
- **FR-097** Harness executions are **pull-only**. Every public entry point that loads the persisted record — `nextProjectRunStep`/`submitProjectRunStep` (via the controller), `executeProjectRun`, `executeProjectResume`, `ProjectRunHost.start/resume`, `reconstructResumeContext` — MUST refuse a Harness execution that is not routed to the controller (`HARNESS_REQUIRES_PULL_API`) **without writing**. The legacy `Coordinator.step/run/prepareNextAction/applyExternalResult` methods are public API that do not know the persisted record and are **not** individually guarded; a caller that builds a Coordinator by hand and runs it on a Harness execution bypasses the guards and is detected afterwards by the tripwire (`HARNESS_STATE_DIVERGED`, FR-076). Non-Harness executions are unaffected.
- **FR-098** A human answer MUST NOT dispatch an agent, clear or replace `last_result`, reset or read `remediation_iteration`, or touch the remediation budget. Answers are validated with the existing `validateHumanAnswers`, recorded in `human_answers` and as an `ANSWER_RECORDED` event, and the same suspension is returned. Resumption is only by typed operations or `resumeSuspension`, which restore the pre-suspension row and re-enter the state machine, authorisation, pins, baseline, budget and the row's recovery; a dispatch can follow only through the controller's own dispatch steps (FR-007, FR-042).

**Persistence and atomic boundaries**

- **FR-099** The Harness MUST write checkpoints only through **one additive `@internal` method, `Coordinator.commit`**, which builds the new record from the **persisted record** (preserving every existing and unknown field), validates state changes with the Harness preset's `isTransitionAllowed`, appends (never replaces) `step_log`/`history`/`human_answers`, supports an explicit `questions` override for suspensions and a literal `PersistedPendingAction`, writes with `expectedRevision`, performs exactly one save, and runs no decision engine, dispatcher or adapter. Every durable boundary (write-ahead counter + pending action, result application, acceptance + advance, suspension, resume, answers) is **one** `commit` (one CAS). No field is added to `CoordinatorExecutionContext` or `CoordinatorOptions`.
- **FR-100** For a Harness execution every Harness-level validation (identity, envelope validity, pins, baseline, result schema, reviewer independence, diff inspection, rejection counting) MUST complete **before** the `commit` that applies the result; a rejected result is never applied and the engine's `applyExternalResult` is never called. The unlocked read-only pass MUST return "needs lock" whenever answering would require a write (move to `heldAction`, record answers, recover a window).
- **FR-101** Every at-rest tuple that the Harness' write sequences (`contracts/harness-controller.md` §3b) can leave — including `(INDEPENDENT_REVIEW|RE_REVIEW|REMEDIATION, IN_PROGRESS, none)` windows and `(IMPLEMENT|REMEDIATION, IN_PROGRESS, none, result applied)` — MUST be a documented row with a recovery action that continues safely without duplicate dispatch or double count; the table's completeness is tested by enumerating the write sequences and injecting a crash before and after each commit.

**Evidence and security of requests**

- **FR-102** Dispatch requests, pending actions, events and the checkpoint MUST carry **references and digests only** (`EvidenceReference`: path, sha-256, bytes, media type, redaction status), never diffs, logs, patches, environment values or secrets; `pending_action.request.context` is limited to 8 KiB and each event `data` to 4 KiB. The engine does **not** sanitise `pending_action` (`scrubSecrets` covers only `state.context`), so the guarantee is by construction and by test, not by scrubbing. Agents read content from the evidence files. The `harness` block MUST stay outside `context` (key names such as `authorizationId`/`authenticated` would be redacted there).
- **FR-103** Harness payloads from the host travel in `AgentResult.metadata.harness` (`HostExecutionMetadata` already allows arbitrary keys) and `evidence` references; the engine validates only `execution_id`, so the controller validates everything else (schema, snapshot echo, invocation ids).
- **FR-104** Pending actions are handled explicitly: **served** (same `step_id`), **held** in `heldAction` when the envelope is invalid, **abandoned** by a human (attempt closed `UNSUCCESSFUL`), **refused** on submission with a digest-only event, or **expired** into a `DISPATCH_TIMEOUT` suspension; none is auto-closed, auto-retried or fabricated into a result.

**Compatibility**

- **FR-105** For non-Harness executions every existing contract is preserved byte-for-byte (checkpoints, responses, remediation behaviour, `human_answers` flow). The **complete** exported-type/API delta of this feature is: (1) `PersistedExecutionState.harness?: unknown` (optional); (2) `Coordinator.commit` (`@internal`). Nothing else changes: not `CoordinatorExecutionContext`, `CoordinatorOptions`, `ProjectRunHostResponse`, `ProjectDoctorReport`, `ExecutionStepKind`, `ExecutionFailureCode`, `CoordinatorState`, or any barrel. Harness failure codes travel in the existing `failureReason` text.
- **FR-106** Before running validators the executor MUST write a run record (`runId`, `pgid`, snapshot id) under the evidence directory; recovery of a verification window finding a live process group MUST suspend `STALE_VALIDATOR_PROCESS` and never start a concurrent run.
- **FR-107** Validators run inside the execution lock; the specification MUST state that a concurrent human operation waits up to the lock wait and may return `EXECUTION_LOCKED`, and that revocation takes effect at the next boundary bounded by the validator timeout.
- **FR-108** Audit time MUST come from Harness events, never from checkpoint `created_at`. For Harness executions the dispatch↔applied-step pairing asserted for non-Harness runs (`tests/phase5-history.test.ts:124`) may not hold after an abandoned, timed-out or adoption-closed action; those are recorded only as Harness events (no new `step_log` kind). Non-Harness runs keep the pairing.


### 4.13 Out of scope / Non-goals

- **NG-1** Parallelism, distributed coordination, cross-machine locks.
- **NG-2** Worktree/branch management; merge, push, PR, release, publish, deploy, migration.
- **NG-3** Dependence on a specific SDK, model, IDE or host.
- **NG-4** Bulk migration of checkpoints.
- **NG-5** Enabling the Harness on Feature 009 (see §7).
- **NG-6** Strong process/model isolation of the reviewer.
- **NG-7** Network sandboxing of validators.
- **NG-8** Authenticating human actors.
- **NG-9** Windows hosts (the Harness fails closed on `win32`, FR-094).
- **NG-10** Technical prevention of prohibited operations; the MVP only refuses to perform them and detects the subset visible in the workspace (FR-079).
- **NG-11** Push-mode execution of Harness executions; handing a Harness execution to the engine's `CONVERGE`/`READY_FOR_PR` stages (OD-14).

## 5. Key entities

`PhaseAuthorizationEnvelope`, `HarnessPolicy`, `TaskGraph`/`TaskNode`/`TaskEligibilityDecision`, `GateDecision`,
`DependencyAttestation`, `VerificationProfile`/`ValidatorDefinition`/`ValidatorResult`, `SnapshotIdentity`,
`ReviewRequest`/`ReviewResult`/`HarnessFinding`, `RemediationBudget`/`RemediationBudgetGrant`,
`EvidenceReference`/`HarnessEvent`, `HarnessDecision` (`CONTINUE | REMEDIATE | ADVANCE_TASK | SUSPEND | FAIL_CLOSED`),
`HarnessSuspension`, `DirtyBaselineApproval`, `PathPattern`, `StateProjection`. Fields and invariants: `data-model.md` and `contracts/`.

## 6. Success criteria (verifiable on the Gate B fixture)

- **SC-001** In the fixture, a complete positive cycle (implement → validators → review with finding → remediation → validators → review PASS → accepted) produces a ledger from which every item in FR-053 can be reconstructed by a test.
- **SC-002** 100 % of scenarios in `acceptance-scenarios.md` marked P1 pass; each negative scenario ends in `SUSPEND` or `FAIL_CLOSED`, never in acceptance.
- **SC-003** After exactly three failed attempts the fixture suspends; across restart, host change and a human answer the counter never changes (property test over resume points).
- **SC-004** For every crash point in `contracts/harness-controller.md` §5 a recovery test shows: no fabricated success, no double-count, no duplicate dispatch.
- **SC-005** The full existing suite (428 tests at baseline) passes unchanged, and a new regression test proves a non-Harness execution reaches identical checkpoints (byte-compared modulo timestamps/ids) before and after the change.
- **SC-006** No test, fixture or document in this feature touches Incito or Feature 009.
- **SC-007** Mutating any pinned artifact in the fixture prevents the next dispatch (`PIN_MISMATCH`) in 100 % of the enumerated cases, while a checkbox-only change to `tasks.md` leaves every pin valid.
- **SC-008** In the fixture, canary secrets planted in the test runner's environment and home directory are absent from every agent-mock and validator process environment and from every evidence file (FR-081).
- **SC-009** 100 % of the path-matching test vectors in `contracts/path-matching.md` §7 pass, including traversal, symlink, separator and boundary cases.
- **SC-010** Property test: every (`CoordinatorState`, `lifecycle_status`, `pending_action`, `HarnessStep`) combination outside the projection table fails closed with `STATE_INCOHERENT` and writes nothing (FR-087).
- **SC-011** Package surface: `package.json` `exports`/`bin`/`files` byte-identical, `src/index.ts` exports unchanged, and the exported-type delta equals exactly the FR-105 list (one optional `PersistedExecutionState.harness?: unknown`, one `@internal Coordinator.commit`).
- **SC-012** No call other than the controller's own dispatch step ever dispatches an agent for a Harness execution: a test drives answers, reads, refused submissions and every human operation except `resumeSuspension`/`extendPendingAction` and asserts zero new dispatches and unchanged counters, `remediation_iteration` and `last_result` (FR-098, I9).
- **SC-013** For every write sequence `W1…W13` and every crash point before and after each `commit`, the tuple found is a row of §3a and its recovery completes with no duplicate dispatch and no double count; the enumerated non-rows are the only `STATE_INCOHERENT` cases (FR-101).
- **SC-014** In the fixture, the largest persisted `pending_action.request` and the largest `harness.events[]` entry stay under fixed size limits (8 KiB and 4 KiB), contain no diff/log/secret text, and every `EvidenceReference` resolves to a file whose digest matches (FR-102).

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

`plan.md` §8: OD-1…OD-9 were **approved on 2026-10-15**. Revision 3 adds OD-10…OD-13 (from T049), which the owner's authorisation to update the artifacts accepts **for specification purposes** (recorded as approved-for-specification; they are re-confirmed in the Gate B request), **OD-15 (open)** (whether host-supplied results need a size/content check, since the engine persists them in full), and **OD-14 (open)**: whether a Harness execution may hand off to the engine's `CONVERGE`/`READY_FOR_PR` stages (default: no, it stays suspended at `PHASE_END`).
