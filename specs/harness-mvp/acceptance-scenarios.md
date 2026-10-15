# Acceptance Scenarios: Harness MVP

Format: `AS-nn [P1|P2|P3] Given / When / Then`. Each lists the requirements it verifies and the test layer (U unit, C contract,
I integration/recovery). All scenarios run on the **Gate B isolated fixture** (temporary git repo + mock host); none touches Incito or Feature 009.

## A. Authorisation and eligibility

- **AS-01 [P1]** Given an envelope listing {T1,T2} with T2 DEPENDS ON T1, When next-step is called, Then only T1 is dispatched and T2's decision records `DEPENDENCY_NOT_SATISFIED:T1`. — FR-014, FR-011 · U/I
- **AS-02 [P1]** Given T3 is not in `authorizedTaskIds`, When it is the only unfinished task, Then nothing is dispatched; suspension `TASK_NOT_AUTHORIZED`. — FR-007, FR-014 · U
- **AS-03 [P1]** Given an envelope whose `permittedOperations` is not a subset of the policy, When issuing, Then rejected; nothing persisted. — FR-004, FR-005 · U
- **AS-04 [P1]** Given an agent result whose diff modifies the allowlist/policy/envelope path (or anything in the mandatory protected set), When inspected, Then `OUT_OF_SCOPE_CHANGE` is **detected after the fact (E2)**: no validators run, no new attempt consumed, acceptance refused, the files stay on disk (no rollback), and status/text never says the write was prevented. — FR-020, FR-029, FR-079 · I
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
- **AS-34 [P2]** `NO_PROGRESS` suspension is raised exactly per `remediation-budget.md` §6 (streak ≥ envelope streak after a non-reducing attempt; the attempt stays counted); `EXHAUST_BUDGET` (only where the policy allows it) disables it. See AS-92/AS-93 for the full table. — FR-049, FR-092 · I
- **AS-35 [P1]** Non-Harness execution with persistent blocking finding still performs 4 remediation dispatches (documented v0.5.0 behaviour). — FR-050, SC-005 · regression
- **AS-36 [P2]** Adopted execution starts with `consumed: 0` and engine `remediation_iteration` is not converted. — FR-075 · I

## F. Recovery and continuity

- **AS-37 [P1]** Crash/fault at each boundary R1–R18 ⇒ documented recovery, no fabricated success, no duplicate dispatch. — FR-070, SC-004 · I
- **AS-38 [P1]** Pending action + repeated `next` (any host) ⇒ same `step_id`; no new event. — FR-066 · I
- **AS-39 [P1]** `CHECKPOINT_CONFLICT`, `EXECUTION_LOCKED`, `EXECUTION_LOCK_UNAVAILABLE`, `CHECKPOINT_WRITE_FAILED` ⇒ no progression, counters untouched, non-terminal codes. — FR-069 · I
- **AS-40 [P1]** Pending action older than `dispatchTtlMs` ⇒ `DISPATCH_TIMEOUT` suspension; not auto-closed or retried. — FR-067 · I
- **AS-41 [P2]** Loop iteration during stop point / `HUMAN_INTERVENTION_REQUIRED` ⇒ returns the suspension, does nothing else. — FR-071, FR-072 · I
- **AS-42 [P1]** Every entry point that loads the record (`executeProjectRun`, `executeProjectResume`, `ProjectRunHost.start/resume`, `reconstructResumeContext`) given a Harness execution refuses with `HARNESS_REQUIRES_PULL_API` and performs **no write**; the same calls on a non-Harness execution behave as in v0.5.0. A hand-built `Coordinator.run` on a Harness execution is *not* blocked but is detected afterwards as `HARNESS_STATE_DIVERGED`. (Replaces the earlier "push/pull equivalence" scenario.) — FR-072, FR-097 · I
- **AS-43 [P1]** Late submit for an abandoned/closed step ⇒ `STALE_STEP`. — FR-066 · I

## G. Persistence and compatibility

- **AS-44 [P1]** Golden v0.4.0/v0.5.0 checkpoints load and resume byte-identically; read paths never write a Harness block. — FR-073, FR-074, SC-005 · C
- **AS-45 [P1]** The Harness block is written only by `Coordinator.commit`, built from the persisted record: an injected unknown field survives every `commit`; `step_log`/`history`/`human_answers` are appended, never replaced; `engine remediation_iteration`, `iteration` and `last_result` are carried unchanged except where the write sequence says so. — FR-099 · C
- **AS-46 [P2]** Chain tamper (edit, truncate, reorder) ⇒ `LEDGER_CHAIN_BROKEN`. — FR-052 · U
- **AS-47 [P2]** Evidence file deleted or altered ⇒ `EVIDENCE_MISSING`; acceptance blocked. — FR-057 · U
- **AS-48 [P2]** Checkpoint rewritten by an engine that drops `harness` ⇒ `HARNESS_STATE_DIVERGED`. — FR-076 · I
- **AS-49 [P1]** `package.json` `exports`, `bin`, `files` and `src/index.ts` exports are byte-identical; Harness names are not exported; no new CLI subcommand exists; human-only operations are not reachable from `submitProjectRunStep`. (The exported-type delta is checked by AS-112.) — FR-077, FR-078, FR-095, SC-011 · C
- **AS-50 [P3]** Reconstruction function rebuilds a full task history from the block + files. — FR-053, SC-001 · I

## H. Invalidation

- **AS-51 [P2]** Each row of the invalidation matrix (`authorization-envelope.md` §7) produces its stated effect. — FR-061..064, SC-007 · U/I
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
- **AS-61 [P1]** Snapshot capture: deterministic for identical trees; `treeDigest` independent of `HEAD`; the task delta contains only changes made after the baseline (the baseline is clean or approved, so no unreviewed dirty content can hide in it); untracked non-ignored files are included; ignored files are hashed (not excluded) unless listed in `ignoredExclusions`; the baseline is captured before the first dispatch and not moved during the cycle; no commit is required. — FR-022, FR-033, FR-034, FR-036, FR-082, FR-084 · U/I
- **AS-62 [P2]** No code path removes or rewrites an existing event; invalidating a result appends an `INVALIDATED` event naming the cause (new snapshot, pin mismatch, missing evidence) and leaves the original. — FR-051, FR-059 · U
- **AS-63 [P2]** Diffs and logs exist only as content-addressed files; the checkpoint holds references (path, sha-256, bytes, redaction status) and no payload. — FR-054 · C
- **AS-64 [P2]** Redaction is best effort and documented as such: a status/contract test asserts the limitation text is present in the evidence contract and in `status` output. — FR-056 · C
- **AS-65 [P3]** The internal `harnessDoctor` reports `EVIDENCE_NOT_IGNORED` when `git check-ignore` says `.project-run/evidence/` or `.project-run/runs/` is not ignored; the public `runProjectDoctor` output and type are unchanged. — FR-058, FR-105 · U
- **AS-66 [P1]** Controller evaluation order: each early exit (unreadable state, lock, divergence, missing ports, stale pin, pending action, active suspension) preempts the later steps and does not run them. — FR-065 · U
- **AS-68 [P1]** After `VALIDATOR_ERROR`, `resumeSuspension` re-runs validators when the environment is fixed and re-raises the same suspension when it is not; a free-text `humanAnswer` alone never advances the cycle. — FR-063, FR-072 · I
- **AS-67 [P2]** With `maxSubmissionRejections = 2`: the **first** rejected submission for a step leaves the pending action in place and does **not** suspend; the **second** rejected submission closes the step (`UNSUCCESSFUL(RESULT_INVALID)`) and raises the `RESULT_INVALID` suspension, with the attempt counted exactly once. — FR-068 · I

## K. Revision 2 additions (correction pass)

**Enforcement honesty (FR-079..081)**
- **AS-69 [P1]** `status`, the policy contract and the docs list each rule with its enforcement class (E1/E2/E3), report `actor.authenticated:false`, `network:"not-enforced"`, `filesystem:"cwd-confinement-only"` and "operations outside the workspace are unobserved unless the host reports them"; a lint test fails if any specification/doc text says an E2 or E3 operation is "prevented" or "blocked". — FR-079, FR-030 · C
- **AS-70 [P1]** `OPERATION_NOT_PERMITTED` is raised for an operation declared in the agent result, reported by the host, or visible in the diff; an unobserved out-of-workspace action (e.g. an actual `git push` the agent ran) yields no event and the test asserts the documentation says so. — FR-080 · I
- **AS-71 [P1]** Fixture hygiene: canary secrets planted in the runner's environment variables and home directory are absent from the agent-mock environment, every validator process environment, and every evidence file; `HOME` points to an empty temp directory; no credential files exist in or are referenced by the fixture. — FR-081, SC-008 · I
- **AS-72 [P2]** A human-only operation invoked by a process holding the same filesystem access succeeds (no authentication) and is recorded as `authenticated:false`; the test documents that this is the limitation, not a defect. — FR-003, NG-8 · C

**Baseline and ignored files (FR-082..084)**
- **AS-73 [P1]** `issueEnvelope` on a tree with a modified tracked file, an untracked non-ignored file, or an untracked file in a Harness-owned path: first two ⇒ `BASELINE_NOT_CLEAN`, the third is ignored by design. — FR-082 · I
- **AS-74 [P1]** Chain of custody: task 2 baseline equals task 1's accepted `treeDigest`; an out-of-band edit between tasks ⇒ `BASELINE_DRIFT`, nothing dispatched; a human commit of exactly the accepted content keeps the chain intact. — FR-082 · I
- **AS-75 [P2]** With `allowDirtyBaseline` and a `DirtyBaselineApproval`: reviewer request includes the dirty files and patch and requires `baselineInfluence`; a new or modified dirty file ⇒ `BASELINE_DRIFT`; with the policy flag false the approval operation is rejected. — FR-083 · I
- **AS-76 [P1]** An ignored `.env.local`-style file changed by the agent: its hash change appears in the review request (`ignoredFileChanges`) with **no content** in any patch/evidence; the review must disposition it or is `REVIEW_INCOMPLETE`; a pre-existing ignored file is part of `treeDigest`. — FR-084 · I
- **AS-77 [P2]** Paths in `ignoredExclusions` appear as `EXCLUDED_BY_POLICY` entries naming the rule; an exclusion overlapping `allowedPaths` or `sensitivePaths` is rejected (`EXCLUSION_CONFLICT`). — FR-084 · U
- **AS-78 [P2]** Validator output files in an ignored, non-excluded directory are recorded as `ignoredSideEffects` and are not `WORKSPACE_MUTATED_DURING_VERIFICATION`; a change to any non-ignored file during verification is. — FR-084, FR-032 · I
- **AS-79 [P1]** The Feature 009 repository and working tree are not referenced by any fixture, test or default; a lint test fails on its path/name. — SC-006 · C

**Structural pinning (FR-085, FR-086, FR-008, FR-061, FR-063)**
- **AS-80 [P1]** Toggling any checkbox in `tasks.md` leaves every pin valid; no `PIN_MISMATCH`, no `SUSPENDED_STALE`. — FR-085, SC-007 · U
- **AS-81 [P1]** Editing a task's description, acceptance text, dependency list, gate marker or markers changes its `definitionDigest`; editing a dependency's definition marks dependents `DEPENDENCY_DEFINITION_CHANGED`. — FR-063, FR-085 · U
- **AS-82 [P1]** A `tasks.md` diff from an implementation result is accepted only if all structural digests are unchanged and only the dispatched task's checkbox toggled; toggling another task's box, or a structural edit combined with a toggle, ⇒ `OUT_OF_SCOPE_CHANGE`. — FR-086 · I
- **AS-83 [P2]** Reflowing whitespace, reordering tasks, editing headings or unrelated prose changes no digest (informational `GRAPH_CHANGED_OUTSIDE_SCOPE` only); a parser version bump ⇒ `PARSER_VERSION_CHANGED`. — FR-085 · U
- **AS-84 [P2]** An envelope that carries a raw-bytes digest of `tasks.md` is rejected as malformed. — FR-008 · U

**State coherence and envelope validity (FR-087..089)**
- **AS-85 [P1]** Completeness test: enumerate the write sequences W1–W13; after each `commit` the tuple is a row of the projection table (T0–T9). Property test over the enumerated non-rows (`state` × `lifecycle_status` × `pending_action` role/kind × `cycle.step` × terminal lifecycle) ⇒ `STATE_INCOHERENT` with zero writes. — FR-087, FR-101, SC-010, SC-013 · U
- **AS-86 [P1]** Induced disagreements (manual checkpoint edit, `pending_action` removed, old-engine rewrite, wrong `suspended_from`) that are **not rows** ⇒ `STATE_INCOHERENT`; `reconcileCycle` moves only to T9 (`SUSPENDED`), never forward, counters unchanged; `TASK_ACCEPTED` never appears at rest. — FR-087, FR-088 · I
- **AS-87 [P1]** Envelope expired/revoked/stale while an action is pending: `next` returns the envelope suspension (not the action); `submit` for that `step_id` is refused and not applied (no validators/review/counter change; `SUBMISSION_REFUSED` with digest only); action is in `heldAction` (HOLD) or closed (ABANDON). — FR-089 · I
- **AS-88 [P1]** After re-authorisation (amend for expired/stale, issue with `resumesFrom` for revoked) with matching pins and baseline, `resumeSuspension` restores the same `step_id`, the held result is accepted and validated against the current workspace; with a changed task definition or a drifted baseline it is refused again. — FR-089 · I
- **AS-89 [P2]** The evaluation order test asserts step 6 (envelope validity) precedes step 7 (pending action) for both `next` and `submit`, and that human operations needed to recover (`amendEnvelope`, `issueEnvelope`, `revokeEnvelope`, `abandonPendingAction`, `reconcileCycle`) skip step 6 only. — FR-065, FR-089 · U

**Policy, limits, NO_PROGRESS (FR-090..092)**
- **AS-90 [P1]** Policy file untracked or modified relative to `HEAD` ⇒ `POLICY_NOT_COMMITTED`; the mandatory protected set cannot be removed by policy or envelope; `loadHarnessPolicy` rejects malformed policy (no policy discovery existed before). — FR-090 · I
- **AS-91 [P1]** Limit relations: envelope `limit` 4 rejected; envelope `limit` 2 ⇒ exactly 2 initial attempts; policy/envelope/amendment cannot create attempts beyond the initial; an amendment carrying grant fields is rejected; a re-issued envelope does not reset consumption; grants beyond `maxGrantedAttemptsPerTask` rejected. — FR-041, FR-045, FR-091 · U/I
- **AS-92 [P1]** `NO_PROGRESS` table tests: equal sets, superset, a new fingerprint with a smaller set, proper subset, empty set (success), dispatch-failed attempt (set unchanged), streak 1/2/3, fingerprint stability across line-number and wording changes, validator-source fingerprint independent of log text. — FR-049 · U
- **AS-93 [P1]** Policy `ESCALATE_ON_NO_PROGRESS` streak 2: an envelope with `EXHAUST_BUDGET` or streak 3 ⇒ `RECURRENCE_WEAKER_THAN_POLICY`; an envelope with streak 1 is accepted; `NO_PROGRESS` never permits a 4th dispatch. — FR-092 · U

**Path matching (FR-093, FR-094)**
- **AS-94 [P1]** All 30 vectors of `contracts/path-matching.md` §7 pass (traversal, absolute, backslash, empty segment, NUL/control, symlink parent, added symlink, NFC/NFD, case, boundaries, deny-wins, mandatory set, invalid patterns). — FR-093, SC-009 · U
- **AS-95 [P2]** Case-fold or NFC collisions inside one snapshot ⇒ `PATH_AMBIGUOUS` suspension; `win32` ⇒ `HARNESS_PLATFORM_UNSUPPORTED`. — FR-093, FR-094 · I
- **AS-96 [P2]** The matcher has no backtracking blow-up: a 4 KB adversarial pattern/path pair completes under a fixed time budget. — FR-093 · U

## L. Revision 3 additions (T049 technical review; PT-nn = proposed test id from `t049-technical-review.md` §7)

- **AS-97 [P1]** (PT-01) Given a Harness execution, the guarded entry points refuse before writing; a hand-built legacy rewrite that drops the block is detected as `HARNESS_STATE_DIVERGED` on the next controller call; a record with an injected unknown top-level field keeps it across every `commit`. — FR-076, FR-097, FR-099 · I
- **AS-98 [P1]** (PT-02) Non-Harness executions produce byte-identical checkpoints (modulo timestamps/ids) and identical responses before and after the Coordinator extension exists, including the 4-dispatch remediation behaviour and the answer-triggered re-dispatch. — FR-105, SC-005 · regression
- **AS-99 [P1]** (PT-03) For every write sequence W1–W13: crash injected before and after the `commit`; the tuple found is a row; the row's recovery action completes the cycle with no duplicate dispatch and no double count (rows T1, T3, T4, T6, T7 in particular). — FR-087, FR-101, SC-013 · I
- **AS-100 [P1]** (PT-04) Accept-and-advance is one `commit`: a conflict or write failure leaves no `TASK_ACCEPTED` and no state change. — FR-099, I1 · I
- **AS-101 [P1]** (PT-05) Write-ahead: the counter increment, the `OPEN` attempt and the pending action are in the same revision; a failed dispatch commit leaves the counter unchanged (row T7 recovery re-dispatches once). — FR-042, FR-099 · I
- **AS-102 [P1]** (PT-06) The refusal matrix of AS-42 holds for each entry point with a before/after revision equality assertion. — FR-097 · I
- **AS-103 [P1]** (PT-07) Probe-2 regression: for Harness executions suspended from `IMPLEMENT`, `REMEDIATION` and `RE_REVIEW`, `next({humanAnswers})` records the answers, returns the same suspension, **dispatches nothing**, and leaves `remediation_iteration`, `last_result`, the budget and `step_log` unchanged; the same call on a non-Harness execution still re-dispatches (v0.5.0 behaviour). — FR-098, SC-012, I9 · I
- **AS-104 [P1]** (PT-08) A record is a Harness execution iff its `harness` block validates: the same record with `preset` = `"v1"`, `"spec-kit-v1"`, absent or arbitrary is handled identically; a record with a Harness MANIFEST but no valid block is `HARNESS_STATE_DIVERGED`. — FR-096 · U/I
- **AS-105 [P1]** (PT-09) For an invalid envelope with a pending action, the read-only pass returns "needs lock"; the locked pass moves the action to `heldAction` in one `commit`; a `submit` is refused **before** any `commit` and `applyExternalResult` is never called; Harness-level result rejections likewise apply nothing. — FR-089, FR-100 · I
- **AS-106 [P1]** (PT-10) `resumeSuspension` restores the held action as the engine `pending_action` with the original `step_id`; a result for it is accepted exactly once and validated against the current workspace; a second submission is `STALE_STEP`. — FR-089, FR-104 · I
- **AS-107 [P1]** (PT-11) The largest persisted `pending_action.request` is ≤ 8 KiB and each event `data` ≤ 4 KiB in the fixture; a scan finds no diff/log/env text; every `EvidenceReference` resolves with a matching digest; a request builder given an oversized or content-bearing payload rejects it; the host payload is read from `AgentResult.metadata.harness` and a result lacking or malforming it is rejected by the controller (the engine validates only `execution_id`). — FR-102, FR-103, SC-014 · C
- **AS-108 [P2]** (PT-12) For each `SuspensionReason` the suspension is surfaced as `human_intervention` with one question `id = suspensionId` and options naming the legal operations; `validateHumanAnswers` accepts answers to it and rejects other ids with `INVALID_HUMAN_ANSWERS`. — FR-098, FR-099 · C
- **AS-109 [P2]** (PT-13) Harness dispatches carry `request.options.timeout_ms` from the envelope; non-Harness dispatches are unchanged (no `options`); the status text classifies the timeout as host-enforced. — FR-023 · C
- **AS-110 [P2]** (PT-14) After `SIGKILL` of the engine during a validator run, recovery finds a live run record ⇒ `STALE_VALIDATOR_PROCESS`; with a dead process ⇒ `VALIDATOR_RUN_INTERRUPTED` and a single re-run; never two concurrent runs. — FR-106 · I
- **AS-111 [P2]** (PT-15) A human `revokeEnvelope` during a running validator returns `EXECUTION_LOCKED` and succeeds after the validator ends or times out; the revocation is effective at the next boundary. — FR-107 · I
- **AS-112 [P1]** (PT-16) Type-surface test: the exported delta equals exactly `PersistedExecutionState.harness?: unknown` and `Coordinator.commit` (`@internal`); `CoordinatorExecutionContext`, `CoordinatorOptions`, `ProjectRunHostResponse`, `ProjectDoctorReport`, `ExecutionStepKind`, `ExecutionFailureCode`, `CoordinatorState` and the consumer-type fixtures are unchanged. — FR-105, SC-011 · C
- **AS-113 [P2]** (PT-17) The `harness` block is outside `context` (a test proves that placing `authorizationId`/`authenticated` under `context` is redacted by `scrubSecrets`, and that the block is not); events never contain keys that match the redaction pattern with sensitive values. — FR-102 · U
- **AS-114 [P2]** (PT-18) The path-matching vectors that need real files (symlink parent, added symlink, NFD/NFC bytes, case-fold collision) pass on a temp repository. — FR-093, SC-009 · I
- **AS-115 [P1]** Adequacy complement to AS-85: every tuple that appears in the probe-1 sequence (`(IMPLEMENT, IN_PROGRESS, none, result)`, `(INDEPENDENT_REVIEW, IN_PROGRESS, none)`, `(INDEPENDENT_REVIEW, AWAITING, pending)`) and its remediation analogues has a row; none is classified `STATE_INCOHERENT`. — FR-101 · U
- **AS-116 [P3]** `created_at` is never read by Harness code; the documented exception to the dispatch↔applied-step pairing holds only after abandonment/timeout and non-Harness runs keep the pairing (`tests/phase5-history.test.ts` unchanged). — FR-108 · C
- **AS-117 [P2]** No preset edge leads to `CONVERGE`; after all authorised tasks are accepted the execution is suspended `PHASE_END` and no engine `CONVERGE` dispatch can occur. — NG-11, OD-14 · I
- **AS-118 [P1]** `adoptExecution` succeeds from each of the three quiescent tuples (closing an engine-created pending IMPLEMENT with a digest-only event; a late result for it is `STALE_STEP`) and yields row T0; every other tuple (e.g. `REMEDIATION`, `INDEPENDENT_REVIEW`, a pending action of another role, `COMPLETED`) is refused `ADOPTION_STATE_UNSUPPORTED` with no write; starting from `INTAKE` under the Harness is refused. — FR-075 · I
