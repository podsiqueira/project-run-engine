# Acceptance Scenarios: Harness MVP

Format: `AS-nn [P1|P2|P3] Given / When / Then`. Each lists the requirements it verifies and the test layer (U unit, C contract,
I integration/recovery). All scenarios run on the **Gate B isolated fixture** (temporary git repo + mock host); none touches Incito or Feature 009.

## A. Authorisation and eligibility

- **AS-01 [P1]** Given an envelope listing {T1,T2} with T2 DEPENDS ON T1, When next-step is called, Then only T1 is dispatched and T2's decision records `DEPENDENCY_NOT_SATISFIED:T1`. — FR-014, FR-011 · U/I
- **AS-02 [P1]** Given T3 is not in `authorizedTaskIds`, When it is the only unfinished task, Then nothing is dispatched; suspension `TASK_NOT_AUTHORIZED`. — FR-007, FR-014 · U
- **AS-03 [P1]** Given an envelope whose `permittedOperations` is not a subset of the policy, When issuing, Then rejected; nothing persisted. — FR-004, FR-005 · U
- **AS-04 [P1]** Given an agent result that modifies the allowlist/policy/envelope path, When inspected, Then `OUT_OF_SCOPE_CHANGE`, no validators run, no attempt consumed. — FR-020, FR-029 · I
- **AS-05 [P2]** Given an expired or revoked envelope, When any call arrives, Then no dispatch; typed suspension. — FR-006, FR-007 · U
- **AS-06 [P2]** Given an envelope with `limit: 5`, When issuing, Then rejected (`> 3`). — FR-041 · U
- **AS-07 [P2]** Given status output, Then effective envelope digest, policy digest, task states, budgets are returned and actor labelled host-asserted. — FR-010, FR-060 · C

## B. Task graph

- **AS-08 [P1]** Duplicate id, unknown dependency, self-dependency, cycle ⇒ `GRAPH_INVALID` listing all errors. — FR-012 · U
- **AS-09 [P1]** Textual order is not a dependency: T2 (no declared deps) listed after T1 is eligible even if T1 is unfinished, and an `IMPLICIT_ORDER_RISK` warning is reported at authorisation. — FR-011 · U
- **AS-10 [P1]** Checkbox ticked, no ledger acceptance ⇒ `RECONCILIATION_REQUIRED`; Harness never edits `tasks.md`; task state is derived from ledger events, not the box. — FR-013, FR-016, FR-017 · U
- **AS-11 [P2]** A task with `OWNER GATE` is never selected without a `GateDecision` bound to its definition digest; editing its text invalidates the decision. — FR-018 · U
- **AS-12 [P2]** Ticking only the checkbox does not change `definitionDigest`; editing the description does and makes an unaccepted task ineligible. — FR-063 · U
- **AS-13 [P2]** Two tasks cannot be `IN_CYCLE`; forged second selection ⇒ `FAIL_CLOSED(IN_CYCLE_INVARIANT)`. — FR-015 · I

## C. Verification

- **AS-14 [P1]** Required validator passes/fails/times out/cannot spawn ⇒ PASSED/FAILED (remediate)/ERROR/ERROR (suspend); every result records snapshot id, exit code, signal, timeout flag, duration and log refs. — FR-026, FR-027, FR-028 · U
- **AS-15 [P1]** Agent claims "all tests green" without result ⇒ ignored; engine runs validators. — FR-021, FR-024 · I
- **AS-16 [P1]** Argv is exactly the allowlist entry; agent text never reaches argv; cwd symlink escape ⇒ ERROR; an environment variable not named in `envAllowlist` (e.g. a planted secret) is absent from the validator process. — FR-025, FR-030, FR-056 · U
- **AS-17 [P2]** Output with a secret value from an allowlisted env var is masked; unmaskable ⇒ `QUARANTINED`, not given to reviewer, suspension. — FR-055 · U/I
- **AS-18 [P1]** Workspace changes between validation and acceptance ⇒ acceptance refused, results invalidated. — FR-035, FR-032 · I
- **AS-19 [P2]** Change to a `sensitivePaths` file forces a `verifierTampering` disposition in the review request. — FR-031 · C
- **AS-20 [P2]** Validator definition edited mid-execution ⇒ `PIN_MISMATCH`. — FR-061 · I

## D. Review

- **AS-21 [P1]** Review request contains snapshot ids, diff digest, criteria, validator results, and no implementer narrative. — FR-037 · C
- **AS-22 [P1]** Review result for another snapshot ⇒ `STALE_SNAPSHOT`, not applied. — FR-038 · U
- **AS-23 [P1]** `PASS` lacking criterion verdicts/file dispositions/evidence ⇒ `REVIEW_INCOMPLETE`. — FR-038 · U
- **AS-24 [P1]** Reviewer invocation id equals implementer's or is absent ⇒ `REVIEW_NOT_INDEPENDENT`. — FR-039 · U
- **AS-25 [P2]** Blocking finding without evidence or violated criterion ⇒ rejected. — FR-040 · U
- **AS-26 [P2]** `CRITICAL` finding ⇒ immediate suspension; no new remediation dispatch (no attempt consumed by the finding itself). — FR-048 · U/I

## E. Remediation (owner Decision 1)

- **AS-27 [P1]** First remediation dispatch ⇒ `consumed = 1`, written in the same checkpoint revision as the pending action. — FR-042 · I
- **AS-28 [P1]** Persistent blocking finding ⇒ exactly 3 remediation dispatches, then suspension `REMEDIATION_BUDGET_EXHAUSTED`; no 4th. — FR-041, FR-046 · I
- **AS-29 [P1]** Counter unchanged across process restart, resume, and different host between attempts. — FR-043 · I (property test over all resume points)
- **AS-30 [P1]** A human answer to the exhaustion suspension does not change `consumed`/`limit`; next-step still suspends. — FR-045 · I
- **AS-31 [P1]** `grantRemediationBudget(2)` linked to the suspension ⇒ exactly 2 more dispatches; each followed by validators and a new review invocation. — FR-045, FR-047 · I
- **AS-32 [P1]** Grant without suspension link, by non-human actor, or twice with the same `decisionId` ⇒ rejected/idempotent. — FR-045 · U
- **AS-33 [P1]** Abnormal outcomes follow the counting table exactly: host failure, timeout, TTL elapsed, invalid result (×2 rejections), abandoned, CAS conflict before dispatch, authorisation denial. — FR-044 · I (one test per row of `remediation-budget.md` §4)
- **AS-34 [P2]** Same blocking fingerprints after two consecutive attempts ⇒ `NO_PROGRESS` suspension (default policy); `EXHAUST_BUDGET` policy disables it. — FR-049 · I
- **AS-35 [P1]** Non-Harness execution with persistent blocking finding still performs 4 remediation dispatches (documented v0.5.0 behaviour). — FR-050, SC-005 · regression
- **AS-36 [P2]** Adopted execution starts with `consumed: 0` and engine `remediation_iteration` is not converted. — FR-075 · I

## F. Recovery and continuity

- **AS-37 [P1]** Crash/fault at each boundary R1–R18 ⇒ documented recovery, no fabricated success, no duplicate dispatch. — FR-070, SC-004 · I
- **AS-38 [P1]** Pending action + repeated `next` (any host) ⇒ same `step_id`; no new event. — FR-066 · I
- **AS-39 [P1]** `CHECKPOINT_CONFLICT`, `EXECUTION_LOCKED`, `EXECUTION_LOCK_UNAVAILABLE`, `CHECKPOINT_WRITE_FAILED` ⇒ no progression, counters untouched, non-terminal codes. — FR-069 · I
- **AS-40 [P1]** Pending action older than `dispatchTtlMs` ⇒ `DISPATCH_TIMEOUT` suspension; not auto-closed or retried. — FR-067 · I
- **AS-41 [P2]** Loop iteration during stop point / `HUMAN_INTERVENTION_REQUIRED` ⇒ returns suspension, does nothing else. — FR-071, FR-072 · I
- **AS-42 [P2]** Push-mode and pull-mode runs of the same fixture produce identical ledgers (modulo ids/times). — FR-072 · I
- **AS-43 [P1]** Late submit for an abandoned/closed step ⇒ `STALE_STEP`. — FR-066 · I

## G. Persistence and compatibility

- **AS-44 [P1]** Golden v0.4.0/v0.5.0 checkpoints load and resume byte-identically; read paths never write a Harness block. — FR-073, FR-074, SC-005 · C
- **AS-45 [P1]** Harness block survives every checkpoint path (carry-forward test). — evidence-ledger §2 · C
- **AS-46 [P2]** Chain tamper (edit, truncate, reorder) ⇒ `LEDGER_CHAIN_BROKEN`. — FR-052 · U
- **AS-47 [P2]** Evidence file deleted or altered ⇒ `EVIDENCE_MISSING`; acceptance blocked. — FR-057 · U
- **AS-48 [P2]** Checkpoint rewritten by an engine that drops `harness` ⇒ `HARNESS_STATE_DIVERGED`. — FR-076 · I
- **AS-49 [P2]** `public-api-surface` and consumer type fixtures unchanged; Harness types not exported from root. — FR-077, FR-078 · C
- **AS-50 [P3]** Reconstruction function rebuilds a full task history from the block + files. — FR-053, SC-001 · I

## H. Invalidation

- **AS-51 [P2]** Each row of the invalidation matrix (`authorization-envelope.md` §6) produces its stated effect. — FR-061..064, SC-007 · U/I
- **AS-52 [P3]** Accepted task's definition changes ⇒ `UPSTREAM_CHANGED`; dependent blocked until `UpstreamAcknowledgement`. — FR-064 · I

## I. End-to-end

- **AS-53 [P1]** Positive cycle: implement → validators → review (1 blocking finding) → remediation (attempt 1) → validators → review PASS → accepted → next task eligible. — SC-001 · I
- **AS-54 [P1]** Negative cycle: finding persists through 3 attempts ⇒ suspension; task not accepted; next task not started. — SC-002, SC-003 · I
- **AS-55 [P1]** No scenario, fixture, path or config references Incito or Feature 009 (lint test over fixture and docs). — SC-006 · C

## J. Additional coverage (added after the first consistency pass)

- **AS-56 [P1]** An execution with no Harness block (new and legacy) takes the exact v0.5.0 code paths: same checkpoints, same responses, no `harness` key written. — FR-001 · regression
- **AS-57 [P1]** An issued envelope cannot be mutated in place: amendment creates revision+1 with `supersedes`, previous becomes `SUPERSEDED`; the envelope records policy/allowlist/task/artifact digests at issuance. — FR-002, FR-008 · U
- **AS-58 [P1]** The agent-facing API (`submitProjectRunStep` and results) has no operation that creates, amends or revokes an envelope; each human-only operation rejects an actor whose kind is not `HUMAN`; actor is reported as host-asserted. — FR-003 · U/C
- **AS-59 [P2]** Cost/token limits are reported `unsupported` (never a number); `maxTaskElapsedMs` is checked at boundaries and produces `LIMIT_REACHED`. — FR-009 · U
- **AS-60 [P1]** The implementation/remediation dispatch contains exactly one task, its acceptance criteria, contract refs, allowed/protected paths, envelope summary, `options.timeout_ms` from the envelope, and the role's required skills resolved and validated as today. — FR-019, FR-023 · C
- **AS-61 [P1]** Snapshot capture: deterministic for identical trees; pre-existing dirty files are in the baseline and absent from the task delta; ignored paths excluded; untracked files included; baseline captured before the first dispatch and not moved during the cycle; no commit required. — FR-022, FR-033, FR-034, FR-036 · U/I
- **AS-62 [P2]** No code path removes or rewrites an existing event; invalidating a result appends an `INVALIDATED` event naming the cause (new snapshot, pin mismatch, missing evidence) and leaves the original. — FR-051, FR-059 · U
- **AS-63 [P2]** Diffs and logs exist only as content-addressed files; the checkpoint holds references (path, sha-256, bytes, redaction status) and no payload. — FR-054 · C
- **AS-64 [P2]** Redaction is best effort and documented as such: a status/contract test asserts the limitation text is present in the evidence contract and in `status` output. — FR-056 · C
- **AS-65 [P3]** `doctor` reports a warning when `.project-run/evidence/` is not VCS-ignored. — FR-058 · U
- **AS-66 [P1]** Controller evaluation order: each early exit (unreadable state, lock, divergence, missing ports, stale pin, pending action, active suspension) preempts the later steps and does not run them. — FR-065 · U
- **AS-68 [P1]** After `VALIDATOR_ERROR`, `resumeSuspension` re-runs validators when the environment is fixed and re-raises the same suspension when it is not; a free-text `humanAnswer` alone never advances the cycle. — FR-063, FR-072 · I
- **AS-67 [P2]** Two rejected submissions for one step (invalid Harness-level result) leave the pending action in place; the third outcome is `RESULT_INVALID` suspension, with the attempt counted exactly once. — FR-068 · I
