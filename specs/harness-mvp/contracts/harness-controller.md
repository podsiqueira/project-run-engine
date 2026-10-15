# Contract: Harness Controller, Transitions and Recovery (H7)

**Revision 3** (incorporates the T049 technical review, `t049-technical-review.md`). Drives FR-063..FR-072, FR-087..FR-089, FR-096..FR-108.
The controller composes existing contracts and owns **no state of its own** beyond the `harness` block. It does not replace the Coordinator's
state fields; it refines them (§3a) and writes them only through one additive Coordinator method (`commit`, §8).

## 0. Design decisions that revision 3 fixes (from code evidence)

| Evidence (v0.5.0) | Decision |
|---|---|
| `Coordinator.checkpoint()` builds the record field by field (`coordinator.ts:213–244`); contexts are rebuilt field by field in submit and resume (`project-run-step.ts:537`, `project-run.ts:757`) | A Harness execution is **never** written by those paths. All its writes go through `Coordinator.commit` (§8), which starts from the **persisted record** (all fields, including unknown ones, preserved) and overrides only what the Harness changes |
| `reconstructResumeContext` clears results, resets `remediation_iteration` and re-dispatches (`project-run.ts:700–726,766`); probe: a human answer re-dispatched IMPLEMENT with a new `step_id` | A Harness execution is **never** routed to `reconstructResumeContext`, `executeProjectRun`, `executeProjectResume` or `ProjectRunHost.start/resume` (FR-097). Human answers are audit records only (§7a) |
| `buildStepCoordinator` hard-wires `new CoordinatorDecisionEngine()` and `preset` is a free label (`project-run-step.ts:602,614`) | A Harness execution is identified **only** by a validated `harness` block (FR-096). The Harness preset supplies `allowedTransitions`/`stateToRole` for validation; the engine's `decide`/`resolveTransition` and its remediation counter are not executed for these executions |
| One submit writes three checkpoints; transition checkpoints are `IN_PROGRESS` with no pending action (probe 1) | The projection table (§3a) lists **every** at-rest tuple the Harness' own write sequences (§3b) can leave, each with a recovery action |
| `pending_action.request` is persisted unscrubbed; `scrubSecrets` covers only `context` | Requests carry references and digests only (FR-102) |

## 1. Entry points and delegation points (FR-096, FR-097, FR-100)

**Agent-facing (existing signatures unchanged)**: `nextProjectRunStep`, `submitProjectRunStep`. For an execution whose persisted record carries a `harness` key, they delegate to the controller **at these points**, before any engine logic runs:

| Existing code | Delegation |
|---|---|
| `nextProjectRunStepGuarded` pass 1 (read-only, unlocked, `project-run-step.ts:189`) | evaluate §2 steps 0–7 read-only; return the pending action / suspension / terminal; if answering needs a write (moving a pending action to `heldAction`, recording answers, recovering a window) return `needsLock` |
| `nextProjectRunStepImpl` branches `AWAITING_AGENT_ACTION`, `HUMAN_INTERVENTION_REQUIRED` (with and without answers), `IN_PROGRESS`/default, `COMPLETED`/`FAILED` | all handled by the controller; the engine branches that call `reconstructResumeContext` or `runPrepare` are **unreachable** for Harness executions |
| `submitProjectRunStepUnlocked` after its identity checks (`STALE_STEP`, `execution_id`) and **before** `coordinator.applyExternalResult` (`:566`) | Harness validation (§2a, §6.2) runs first; the result is applied only by `commit` |
| `executeProjectRun`, `executeProjectResume`, `ProjectRunHost.start/resume`, `reconstructResumeContext` | refuse with `HARNESS_REQUIRES_PULL_API`, **no write**, when the persisted record carries `harness` (entry guards; these functions already load the record). The legacy `Coordinator.step/run/prepareNextAction/applyExternalResult` are public API that cannot see the persisted record and are **not** guarded; misuse by a hand-built Coordinator is detected afterwards by the tripwire (`HARNESS_STATE_DIVERGED`, FR-076) |

An execution without a `harness` key takes exactly the v0.5.0 code paths (FR-001). A record whose evidence directory has a `MANIFEST.json` but **no** `harness` key is `HARNESS_STATE_DIVERGED` (an older engine dropped the block), not "non-Harness".

**Human-only operations** (D-22; **logically** separated from the agent API, not technically prevented, NG-8; internal functions only at Gate B, FR-095): `issueEnvelope`, `amendEnvelope`, `revokeEnvelope`, `adoptExecution`, `recordGateDecision`, `attestDependency`, `acknowledgeUpstreamChange`, `grantRemediationBudget`, `abandonPendingAction`, `extendPendingAction`, `resumeSuspension`, `reconcileCycle`, `approveDirtyBaseline`.
**Read-only**: `harnessStatus` (internal function; the public `statusProjectRun`/`ProjectRunHostResponse` are unchanged, FR-060, FR-105).

All mutating entries run inside the existing per-execution lock (`runLockedTurn`) and **every durable boundary is one CAS `commit`** with `expectedRevision`.

## 2. Evaluation order on every call (FR-065)

Applies to `next`, `submit` and every mutating human operation (except where §2a/§7 say otherwise).

0. **Identify and guard**: `harness` key present? If yes, the controller owns the call (§1). If a legacy engine function was entered with such an execution, refuse (FR-097).
1. Load checkpoint → unreadable/`INVALID_PERSISTED_STATE` ⇒ fail closed.
2. Lock acquired? else `EXECUTION_LOCKED` / `EXECUTION_LOCK_UNAVAILABLE` (non-terminal, nothing done).
3. Platform supported (`HARNESS_PLATFORM_UNSUPPORTED`); `harness.schema_version` supported; manifest agrees; chain verifies ⇒ else `HARNESS_SCHEMA_UNSUPPORTED` / `HARNESS_STATE_DIVERGED` / `LEDGER_CHAIN_BROKEN`.
4. **State classification** (§3a): the tuple is a row of the table ⇒ continue **with that row's recovery action pending**; a tuple that is **not** a row ⇒ `FAIL_CLOSED(STATE_INCOHERENT)`. A legitimate crash window is a row, never `STATE_INCOHERENT`.
5. Ports present (`ValidatorExecutor`, `SnapshotProvider`) ⇒ else `HARNESS_PORTS_MISSING`.
6. Envelope `ACTIVE`, not expired, and the **cheap pins** (policy, allowlist, structural task digests, pinned artifacts) recomputed equal ⇒ else `ENVELOPE_*` / `PIN_MISMATCH` (suspension). The **baseline chain** (`treeDigest`, a whole-tree hash) is **not** recomputed on pure reads (serving a pending action or a suspension); it is checked at the boundaries that need it: before every dispatch (W2, W5, W8), at result submission (diff inspection, W3/W6) and before acceptance (W10) ⇒ `BASELINE_DRIFT`.
7. **Pending action present?** ⇒ `next` returns it (same `step_id`); `submit` validates and applies it; or, if `dispatchTtlMs` elapsed, suspend `DISPATCH_TIMEOUT`.
8. Active suspension? ⇒ return it unchanged (loops included) unless a human operation just resolved it.
9. Else run the recovery action of the row found in step 4 (§3a), or, for the "between tasks" row, the cycle step machine (§3).

### 2a. Pending action vs envelope validity (FR-089, FR-100)

Step 6 precedes step 7, so **a pending action is never served or applied while the envelope is not valid**:
- `next` while the envelope is not valid: returns the envelope suspension, **not** the pending action.
- The save that raises that suspension **moves the pending action into `harness.cycle.heldAction`** (the literal `PersistedPendingAction`; the engine drops `pending_action` on any non-awaiting checkpoint, `coordinator.ts:237–242`, so nothing else could keep it). In pass 1 this is a write ⇒ `needsLock`.
- `submit` for the held `step_id` while the envelope is not valid: **refused and not applied**, *before* any `commit` (and therefore before any applying of the result): no validator, review, counter or state change; one `SUBMISSION_REFUSED{stepId, resultDigest, reason}` event (digest only; the host keeps the payload). The same ordering holds for every other Harness-level rejection (`STALE_SNAPSHOT`, `REVIEW_INCOMPLETE`, result schema, baseline) — the result is applied only by the `commit` that follows successful validation.
- Revocation chooses the disposition (`HOLD` default | `ABANDON`, authorization-envelope §6). Expiry and staleness are always `HOLD`.
- After a new `ACTIVE` envelope that still authorises the task with matching pins and baseline, `resumeSuspension` restores `heldAction` as the engine `pending_action` (one `commit`; engine back to `suspended_from`, `AWAITING_AGENT_ACTION`); the **same `step_id`** is served and a result is validated against the *current* workspace. Otherwise the human closes it with `abandonPendingAction`.
- Human operations needed to recover (`amendEnvelope`, `issueEnvelope`, `revokeEnvelope`, `abandonPendingAction`, `reconcileCycle`) skip step 6 only; steps 0–5 still apply (`reconcileCycle` also skips step 4).

## 3. Harness decision machine

```
TASK_ELIGIBILITY_CHECK            → eligible: capture baseline → create cycle → IMPLEMENTATION_PENDING (ready, then dispatched)
                                  → none eligible: SUSPEND(PHASE_END | BLOCKED_TASKS)
IMPLEMENTATION_PENDING            dispatch IMPLEMENTATION; result valid → DIFF_INSPECTED (out-of-scope? SUSPEND) → VERIFICATION_PENDING
VERIFICATION_PENDING              engine-run validators: all required PASSED → REVIEW_PENDING (ready, then dispatched)
                                  any required FAILED → synthetic findings → FINDINGS_EVALUATION (no review)
                                  any ERROR / missing → SUSPEND(VALIDATOR_ERROR)
REVIEW_PENDING                    dispatch INDEPENDENT_REVIEW (new invocation id); result valid → FINDINGS_EVALUATION
FINDINGS_EVALUATION (pure)        → ADVANCE_TASK | REMEDIATE | SUSPEND | FAIL_CLOSED     (review-contract.md §5)
REMEDIATION_PENDING               ready: budget re-checked; dispatch REMEDIATION with counter+1 in the SAME commit
                                  result valid → DIFF_INSPECTED → VERIFICATION_PENDING
TASK_ACCEPTED (transient)         one commit: event + task state + cycle cleared + snapshot re-check → TASK_ELIGIBILITY_CHECK | PHASE_END
```
Harness preset (D-10, revision 3): extends the Spec Kit preset (inheriting `getExpectedOutput`, `getStateSkillConfig`, `getSkillsForRole`) and supplies `validStates`, `allowedTransitions`, `stateToRole` **only for validating and labelling the Harness' own writes and for building dispatch requests** (`CoordinatorDecisionEngine.isTransitionAllowed`). Added edges (preset-local, additive): `INDEPENDENT_REVIEW→IMPLEMENT`, `RE_REVIEW→IMPLEMENT`, `IMPLEMENT→REMEDIATION`, `REMEDIATION→REMEDIATION`. There is **no** edge to `CONVERGE` in the MVP (OD-14, §10). The engine's `decide`/`resolveTransition` and `MAX_REMEDIATION_ITERATIONS` logic are never executed for a Harness execution, which makes FR-050 unconditional.

### 3a. Projection table: engine fields refined by `harness.cycle.step` (FR-087, FR-088, FR-101)

`harness.cycle.step` is an *embedded refinement* of the engine's own position, never an independent orchestrator. Authority: engine fields (`state`, `lifecycle_status`, `pending_action`, `suspended_from`, `human_intervention`) for **protocol position**; the Harness block for **cycle position and counters**. Every row below is a tuple the Harness' own write sequences (§3b) can leave at rest, **including crash windows between two commits**. Each row has a **recovery action** that makes it safe to continue; only tuples that are *not rows* are `STATE_INCOHERENT`.

| Row | engine `state` | `lifecycle_status` | engine `pending_action` | `cycle.step` | Meaning | Recovery action (step 9) |
|---|---|---|---|---|---|---|
| T0 | `IMPLEMENT` | `IN_PROGRESS` | none | *(no cycle)* | between tasks / before the first | run `TASK_ELIGIBILITY_CHECK` |
| T1 | `IMPLEMENT` | `IN_PROGRESS` | none | `IMPLEMENTATION_PENDING` | cycle created, **not yet dispatched** | re-check envelope/baseline; dispatch (write-ahead `commit` → T2) |
| T2 | `IMPLEMENT` | `AWAITING_AGENT_ACTION` | role `IMPLEMENTATION`, kind `IMPLEMENT` | `IMPLEMENTATION_PENDING` | dispatched | serve the same `step_id` |
| T3 | `IMPLEMENT` or `REMEDIATION` (the dispatching state) | `IN_PROGRESS` | none | `VERIFICATION_PENDING` | result applied, **verification not finished** | diff inspection + validators (reuse results only for same snapshot + validator digest, R8/R9) |
| T4 | `INDEPENDENT_REVIEW` (attempt 0) or `RE_REVIEW` (attempt ≥ 1) | `IN_PROGRESS` | none | `REVIEW_PENDING` | validators passed, review **not yet dispatched** | re-check pins; dispatch review with a new invocation id (→ T5) |
| T5 | same as T4 | `AWAITING_AGENT_ACTION` | role `INDEPENDENT_REVIEW`, kind `REVIEW` | `REVIEW_PENDING` | review dispatched | serve the same `step_id` |
| T6 | `INDEPENDENT_REVIEW` or `RE_REVIEW` | `IN_PROGRESS` | none | `FINDINGS_EVALUATION` | review applied, **not yet evaluated** | evaluate (pure) → one of W7/W9/W10/W11 |
| T7 | `REMEDIATION` | `IN_PROGRESS` | none | `REMEDIATION_PENDING` | decided to remediate, **not yet dispatched; counter not yet incremented** | re-check budget and authorisation; dispatch with counter+1 in the same `commit` (→ T8) or suspend `REMEDIATION_BUDGET_EXHAUSTED`/`NO_PROGRESS` |
| T8 | `REMEDIATION` | `AWAITING_AGENT_ACTION` | role `REMEDIATION`, kind `REMEDIATE` | `REMEDIATION_PENDING` | dispatched, counter already incremented | serve the same `step_id` (never recount) |
| T9 | `HUMAN_INTERVENTION_REQUIRED` | `HUMAN_INTERVENTION_REQUIRED` | none (the engine drops it); a held action lives in `cycle.heldAction` | `SUSPENDED` (or no cycle for `PHASE_END`/envelope suspensions between tasks) | suspended | return the suspension; only typed human operations leave it (§7) |

Rules that apply to every row:
- `lifecycle_status` `COMPLETED`/`FAILED` with any `cycle` ⇒ `STATE_INCOHERENT`; with no `harness` evidence either they are ordinary terminal states.
- `cycle.taskId` must be the task `IN_CYCLE`/`SUSPENDED` in `harness.tasks`; the pending action's `step_id` must equal the one in the last `DISPATCHED` event of the cycle; in T3/T6 `last_result` must be the result whose digest is in the last `RESULT_RECEIVED`/`REVIEW_RECEIVED` event.
- The engine's `remediation_iteration`/`iteration` are carried unchanged by every `commit` (the Harness never resets or increments them; its own counter lives in `harness.budgets`).
- `TASK_ACCEPTED` is a transient event, never a resting step. T9 may also describe a suspension raised before any cycle exists (no `cycle`, e.g. `PHASE_END`, `GRAPH_INVALID`, `ENVELOPE_*`).
- **Not rows (⇒ `STATE_INCOHERENT`)**, for example: `(IMPLEMENT, AWAITING, role REMEDIATION)`; `(REMEDIATION, AWAITING, step=IMPLEMENTATION_PENDING)`; `pending_action` present with no cycle; step `SUSPENDED` while `lifecycle_status` is not `HUMAN_INTERVENTION_REQUIRED`; `state` outside `{IMPLEMENT, INDEPENDENT_REVIEW, REMEDIATION, RE_REVIEW, HUMAN_INTERVENTION_REQUIRED}` for a Harness execution in `IN_PROGRESS`/`AWAITING_AGENT_ACTION`; `heldAction` outside T9.
- `reconcileCycle` (human-only, skips step 4) is the only exit from `STATE_INCOHERENT`: it can only move to T9 (`SUSPENDED`, `suspended_from` preserved), never forward; both views are recorded as evidence; counters untouched.

### 3b. Write sequences (completeness argument; each arrow is exactly one `commit` = one CAS save)

```
W0  adoption → T0               adoptExecution from the three quiescent tuples (FR-075); closes an engine-created pending action
W1  T0 → T1                    eligibility + baseline + cycle created (may be merged with W2)
W2  T0|T1 → T2                 dispatch implementation; events DISPATCHED
W3  T2 → T3                    result validated, applied: last_result, step_log AGENT_STEP, RESULT_RECEIVED
W4  T3 → T4 | T5               validators passed: transition to INDEPENDENT_REVIEW/RE_REVIEW (history), optionally with review dispatch (T5)
W5  T4 → T5                    dispatch review
W6  T5 → T6                    review validated, applied
W7  T6 → T7                    findings evaluated ⇒ REMEDIATE (transition REMEDIATION, history)
W9  T3 → T7                    validator FAILED ⇒ synthetic findings ⇒ REMEDIATE (edge IMPLEMENT|REMEDIATION → REMEDIATION)
W8  T7 → T8                    dispatch remediation: counter+1, attempt OPEN, pending action — one commit
W3' T8 → T3                    remediation result validated, applied
W10 T6 → T0 | T9(PHASE_END)    accept: TASK_ACCEPTED, cycle cleared, edge → IMPLEMENT
W11 any → T9                   suspend (questions from the Harness suspension, §4)
W12 T9 → T1|T2|T4|T5|T7|T8     resumeSuspension: state restored to the pre-suspension row (held action restored if any)
W13 any row → same row         answers recorded; human operation events; refused-submission event; no tuple change
```
Completeness test (PT-03, SC-010): enumerate every `W*`; assert the tuple after each commit is a row; crash-inject after every commit and before it; assert that the recovery action of the found row completes the cycle with no duplicate dispatch and no double count.

### Invariants (enforced + tested)

I1 `TASK_ACCEPTED` ⇒ implementation result received ∧ every required validator `PASSED` on S ∧ valid review `PASS` on S ∧ no open blocking finding ∧ snapshot(now) = S ∧ persisted via valid CAS.
I2 A task is accepted at most once; its `TASK_ACCEPTED` event is unique per `(taskId, lineage)`.
I3 Changing the subject snapshot invalidates all validator/review results not bound to it.
I4 A task outside the envelope, ineligible, or with a failing pin is never dispatched.
I5 Persistence failure/conflict/lock loss ⇒ no progression and no counter change.
I6 At most one task `IN_CYCLE`/`SUSPENDED`, at most one pending action, at most one `OPEN` attempt.
I7 A business decision, or a protected/non-authorisable operation that the Harness *sees* (workspace diff, agent declaration, host report), ⇒ suspension. Operations it cannot observe are not covered (E3).
I8 After any successful `commit` the tuple is a row of §3a.
I9 No agent dispatch happens in any call that is not the controller's own dispatch step (FR-098): human answers, operations other than `resumeSuspension`/`extendPendingAction`, and reads never dispatch.

## 4. `HarnessSuspension` (FR-098)

```ts
interface HarnessSuspension { suspensionId: string; reason: SuspensionReason; taskId?: string; cycleId?: string;
  detail: string; evidence: EvidenceReference[]; options: HumanOption[]; raisedAtRevision: number;
  restoreRow: "T0"|"T1"|"T2"|"T3"|"T4"|"T5"|"T6"|"T7"|"T8" }   // the row `resumeSuspension` restores (W12); recorded when the suspension is raised
type SuspensionReason = "STOP_POINT" | "GATE_REQUIRED" | "PHASE_END" | "BLOCKED_TASKS" | "TASK_NOT_AUTHORIZED"
  | "OUT_OF_SCOPE_CHANGE" | "OPERATION_NOT_PERMITTED" | "CRITICAL_FINDING" | "BUSINESS_DECISION" | "VALIDATOR_ERROR"
  | "REMEDIATION_BUDGET_EXHAUSTED" | "NO_PROGRESS" | "DISPATCH_TIMEOUT" | "RESULT_INVALID" | "EVIDENCE_QUARANTINED"
  | "EVIDENCE_MISSING" | "PIN_MISMATCH" | "RECONCILIATION_REQUIRED" | "WORKSPACE_MUTATED_DURING_VERIFICATION"
  | "GRAPH_INVALID" | "ENVELOPE_EXPIRED" | "ENVELOPE_REVOKED" | "LIMIT_REACHED" | "BASELINE_NOT_CLEAN" | "BASELINE_DRIFT"
  | "IGNORED_FILE_CHANGED" | "PATH_AMBIGUOUS" | "SUBMISSION_REFUSED" | "STALE_VALIDATOR_PROCESS";
```
It is surfaced through the **existing** `HUMAN_INTERVENTION_REQUIRED` fields: `human_intervention.reason` and `human_intervention.questions`. Because the Coordinator derives questions from findings (`deriveHumanQuestions`, which yields one generic `intervention-required` question when there are none), `commit` accepts an explicit `questions` override: one `HumanQuestion` per suspension with `id = suspensionId`, `question` = reason + detail, and `options` = the legal human operations (`HumanQuestionOption{id,label,description}`, no new type). `validateHumanAnswers` then validates answers against these ids exactly as today.
`FAIL_CLOSED` reasons (`HARNESS_STATE_DIVERGED`, `LEDGER_CHAIN_BROKEN`, `ENVELOPE_TAMPERED`, `IN_CYCLE_INVARIANT`, `STATE_INCOHERENT`, `HARNESS_PLATFORM_UNSUPPORTED`, `HARNESS_REQUIRES_PULL_API`, `ADOPTION_STATE_UNSUPPORTED`) refuse all progress until a human resolves them outside the Harness.

## 5. Recovery by boundary (FR-070, SC-004)

| # | Crash / fault at | Durable at that moment | Recovery behaviour | Counted? |
|---|---|---|---|---|
| R1 | after eligibility decision, before the cycle commit | T0 | decision recomputed (pure) | no |
| R2 | after baseline captured, before the commit | T0 | baseline re-captured (same tree ⇒ same id); orphan evidence file tolerated | no |
| R3 | dispatch commit saved, host not yet told / host crashed | T2/T8 | next call returns the **same** `step_id` | already counted once (remediation) |
| R4 | host worked, crashed before submit | T2/T5/T8 | as R3; delta verified at submit | once |
| R5 | submit received, Harness validation fails | T2/T5/T8 | `RESULT_REJECTED` event; **1st** rejection: pending stays, no suspension; **2nd** (`maxSubmissionRejections`=2): step closed unsuccessful, `RESULT_INVALID` suspension | no extra |
| R6 | validation passed, `commit` not saved (conflict/write failure) | T2/T5/T8 | non-terminal failure; host re-submits the same `step_id`; applies once | no extra |
| R7 | after W3 (T3), before validators | T3 | validators run | no |
| R8 | mid-validator | T3 | partial logs ignored; whole set re-run; **stale-process check first** (R20) | no |
| R9 | validators done, W4 not saved | T3 | results reusable only for same snapshot + validator digest, else re-run | no |
| R10 | review dispatched, host lost | T5 | as R3; TTL ⇒ `DISPATCH_TIMEOUT` suspension | no |
| R11 | after W6 (T6), before evaluation | T6 | evaluation is pure ⇒ recomputed | no |
| R12 | acceptance CAS conflict | T6 | re-read; evaluation re-run against the current state (snapshot may differ ⇒ stale) | no |
| R13 | after W10, before next eligibility | T0 | eligibility evaluated | no |
| R14 | `CHECKPOINT_WRITE_FAILED` at any boundary | last durable row | existing non-terminal code; fix storage; same call retried | no |
| R15 | lock held elsewhere | — | `EXECUTION_LOCKED`; nothing done | no |
| R16 | envelope revoked/expired/stale while action pending | T2/T5/T8 | §2a | already counted once; no recount |
| R17 | evidence file missing at acceptance | T6 | `EVIDENCE_MISSING` suspension; re-run validators/review | no |
| R18 | `SIGKILL` of the engine holding the lock | any row | existing dead-holder reclaim by pid probe; then the row's recovery action | no |
| R19 | tuple is not a row of §3a | as found | `FAIL_CLOSED(STATE_INCOHERENT)`; only `reconcileCycle` | no |
| R20 | engine killed while a validator child still runs | T3 | validator run record (§9) shows a live process group ⇒ `STALE_VALIDATOR_PROCESS` suspension; never a second concurrent run | no |
| R21 | crash between W1 and W2 (T1) | T1 | dispatch performed by recovery (counts nothing for implementation) | no |
| R22 | crash between W4 and W5 (T4) | T4 | pins re-checked; review dispatched with a **new** invocation id | no |
| R23 | crash between W7/W9 and W8 (T7) | T7 | budget and authorisation re-checked; counter+1 written together with the pending action | no (until W8) |
| R24 | host never resubmits a held step after re-authorisation | T2/T5/T8 | `DISPATCH_TIMEOUT` after TTL; human `abandonPendingAction`/`extendPendingAction` | already counted |
| R25 | human answers submitted while suspended | T9 | answers validated and recorded (W13); **nothing else happens** | no |
| R26 | human answers submitted while not suspended | any non-T9 row | ignored, as in the engine (no write) | no |
| R27 | `resumeSuspension` while the cause persists | T9 | same suspension re-raised; one `SUSPENDED` event per distinct raise | no |

**Timeout/invalid result summary**: no timeout is converted to success or failure automatically; a timed-out dispatch, or one whose result was rejected twice, is *counted* (if remediation) and ends in a human decision, never in an automatic re-dispatch (FR-067/068).

## 6. Context reconstruction for Harness executions (replaces `reconstructResumeContext`)

### 6.1 `reconstructHarnessState(persisted)`
Builds the in-memory view from the **persisted record only**, never mutating engine counters or results: `state = persisted.state` (restored from `suspended_from` only by `resumeSuspension`, §7); `last_result` preserved (never cleared); `remediation_iteration`/`iteration` copied unchanged; `human_approved`/`human_resolved` are **not** set; no `shouldReverifyOnResume`. The `harness` block is copied byte-for-byte except for the fields a `commit` changes.

### 6.1a Dispatch request construction
Requests are built with the engine's public `resolveDispatch` on a transient context derived from the persisted record (so roles, skills and `expected_output` come from the same preset machinery), enriched/validated by `dispatcher.prepareRequest` (skill validation unchanged; a `SkillValidationError` becomes the existing `BLOCKED_MISSING_SKILLS` response and writes nothing), and then the `context` field is **replaced** by the references-only Harness payload (FR-102). `options.timeout_ms` is set from the envelope (FR-023).

### 6.2 Submission pipeline (before any write)
1. engine-level checks as today (`NO_PENDING_ACTION`, `STALE_STEP`, `execution_id`);
2. §2 steps 0–8;
3. result schema (`AgentResult.metadata.harness`, FR-103), identity, snapshot/diff inspection, reviewer independence, rejection counting;
4. only then `commit` (W3 or W6). No call to `applyExternalResult`.

## 7. Human operations: common rules and answers (FR-098)

Each operation: validates `actor.kind==="HUMAN"`; takes `decisionId` (idempotent; replays return the original result); runs under the lock + `commit`; appends exactly one event; never mutates the envelope in place; refuses when the execution has a *different* active suspension than the one it names.

### 7a. Human answers and resumption
- `next({humanAnswers})` on a Harness execution **only audits**: under the lock, answers are validated with the existing `validateHumanAnswers` against the suspension's questions (ids = `suspensionId`), recorded in `human_answers` and as an `ANSWER_RECORDED{questionIds}` event (W13) by one `commit`, and the response is the **same suspension**. It never dispatches, never clears or replaces `last_result`, never reads or writes `remediation_iteration` or the budget. Answers to a non-suspended execution are ignored like today (R26). `INVALID_HUMAN_ANSWERS` keeps its existing semantics.
- A suspension is cleared **only** by a typed operation that names it (`recordGateDecision`, `grantRemediationBudget`, `abandonPendingAction`, `extendPendingAction`, `attestDependency`, `acknowledgeUpstreamChange`, `approveDirtyBaseline`, amend/revoke envelope) or by `resumeSuspension(suspensionId, decisionId, actor)`.
- `resumeSuspension` restores the **pre-suspension row** (W12: `state = suspended_from`, held action restored if any) and then evaluates §2 from step 5. Resuming therefore passes through the state machine and through authorisation, pins, baseline, budget and recovery of the restored row; a dispatch can follow **only** via W2/W5/W8 under FR-007 and FR-042. If the cause persists the same suspension is raised again (R27).
- Real hosts can reach these operations only after Gate C exposure (FR-095); until then the existing host skill (which resumes by `humanAnswers`) cannot resume a Harness execution — by design.

## 8. Coordinator extension point (FR-099) and exported-type delta (FR-105)

**One additive method**, marked `@internal`, used only by the Harness:

```ts
Coordinator.commit(persisted: PersistedExecutionState, change: {
  state?: CoordinatorState; lifecycle: ExecutionLifecycleState;
  pendingAction?: PersistedPendingAction;              // required iff lifecycle = AWAITING_AGENT_ACTION; otherwise omitted (cleared)
  suspension?: { suspendedFrom: CoordinatorState; reason: string; questions: HumanQuestion[]; findings: StructuredFinding[] }; // iff HIR
  lastResult?: AgentResult;
  appendStepLog?: ExecutionStepRecord[]; appendHistory?: DecisionRecord[];
  appendHumanAnswers?: HumanAnswerRecord[];
  harness: unknown;                                    // the complete next harness block
}): Promise<{ revision: number }>
```
Semantics: builds the new record as `{ ...persisted, ...overrides }` (so every existing and unknown field is preserved), validates `state` transitions with the Harness preset's `isTransitionAllowed` (no-op `X→X` allowed; `HUMAN_INTERVENTION_REQUIRED → suspended_from` allowed **only** for `resumeSuspension`, because the engine matrix gives `HUMAN_INTERVENTION_REQUIRED` no outgoing edges; `adoptExecution` W0 is the only other special case), appends (never replaces) `step_log`/`history`/`human_answers`, writes with `expectedRevision = persisted.revision`, and throws the existing `CheckpointWriteError`/`CheckpointConflictError`. It performs **one** save. It does not run the decision engine, a dispatcher or any adapter.
Because it starts from the persisted record, the carry-forward hazard of E-8 does not exist for Harness executions, and **no field is added to `CoordinatorExecutionContext` or `CoordinatorOptions`**.

**Exported type/API delta (complete list; anything else is a spec violation, FR-105, SC-011)**:
1. `PersistedExecutionState.harness?: unknown` (optional; absent for all existing records);
2. `Coordinator.commit` (one `@internal` method);
3. no new exported names, no new `exports` subpaths, no new `bin`/CLI subcommand, no change to `ProjectRunHostResponse`, `ProjectDoctorReport`, `ExecutionStepKind`, `CoordinatorState`, `CoordinatorExecutionContext`, `CoordinatorOptions`.
The new failure codes (`HARNESS_REQUIRES_PULL_API`, …) are carried in the existing `failureReason` text (prefix convention) and are not added to the exported `ExecutionFailureCode` union at Gate B.

## 9. Validator process records and lock semantics (FR-106, FR-107)

- Before spawning, the executor writes `.project-run/evidence/<exec>/runs/<runId>.json` `{ runId, validatorId, pgid, startedAt, snapshotId }`, and removes the record when the process group has exited. Recovery of T3 lists run records: a live process group (pid probe on the group leader) ⇒ `STALE_VALIDATOR_PROCESS` suspension (never a second concurrent run); a dead one ⇒ the record is closed with an `INTERRUPTED` event and the validators are re-run.
- Validators run **inside** the execution lock. A human operation arriving meanwhile waits up to the lock wait (default 30 s) and then returns the existing non-terminal `EXECUTION_LOCKED`; effect of a revocation is therefore at the next boundary, bounded by the validator timeout. Pass-1 reads (`next` without mutation) are unaffected.

## 10. Scope boundary of the MVP loop (OD-14, open)

The Harness governs `IMPLEMENT … RE_REVIEW` only. After all authorised tasks are accepted the execution **stays suspended** with `PHASE_END`; the Harness does not transition to `CONVERGE`/`READY_FOR_PR`, because those stages would run under the engine's own remediation loop, outside the Harness budget. Handing off to the engine's later stages is a separate decision (OD-14); until then the engine's `CONVERGE` is not reachable from a Harness execution.

## 11. Idempotency and `/loop`

Correlation = `(executionId, cycleId, step_id)`. A repeated `next` with a pending action is a pure read. A repeated `submit` with a consumed `step_id` is `STALE_STEP`. `/loop` is an external caller: each iteration is a fresh `next()` and re-runs §2; there is no loop state in the engine. External effects of validators or agents are *at-least-once*; the spec does not claim exactly-once. Validators are required to be idempotent by policy review (R-5). Timestamps used for audit come from Harness events, never from checkpoint `created_at` (rewritten on every save, `coordinator.ts:244`).

## 12. Test list (H7)

every row T0–T9 (recovery action) and every `W*` (tuple is a row; crash before/after) · R1–R27 · §2a matrix (revoked/expired/stale × next/submit × HOLD/ABANDON × re-authorisation) · projection-table completeness (enumerated non-rows ⇒ `STATE_INCOHERENT`, no write; `reconcileCycle` only to T9) · entry guards (push entries, `reconstructResumeContext`, Coordinator legacy methods refuse, no write) · human answers audit-only (no dispatch, no counter/`remediation_iteration`/`last_result` change) · `resumeSuspension` fixed vs unfixed cause · evaluation-order table (each early exit) · I1–I9 · human operation idempotency and wrong-suspension refusal · loop does not bypass suspension · host change mid-cycle · non-Harness executions byte-identical · `commit` preserves unknown fields and appends logs · exported-type delta test.
