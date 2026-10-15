# Contract: Harness Controller, Transitions and Recovery (H7)

Drives FR-063..FR-072. The controller composes existing calls; it owns **no** state of its own beyond the `harness` block.

## 1. Entry points (names provisional)

Agent-facing (existing, unchanged shape): `nextProjectRunStep`, `submitProjectRunStep`. When the execution has a Harness
block these delegate to `HarnessController.next()` / `.submit()` after the same lock/CAS discipline.
Human-only (D-22; **logically** separated from the agent API, not technically prevented, NG-8; internal functions only at Gate B, FR-095): `issueEnvelope`, `amendEnvelope`, `revokeEnvelope`, `adoptExecution`, `recordGateDecision`,
`attestDependency`, `acknowledgeUpstreamChange`, `grantRemediationBudget`, `abandonPendingAction`, `extendPendingAction`, `resumeSuspension`, `reconcileCycle`, `approveDirtyBaseline`.
Read-only: `status` (never writes).

All mutating entries run inside the existing per-execution lock (`runLockedTurn`) and every durable boundary is one
CAS `save({expectedRevision})`.

## 2. Evaluation order on every call (FR-065)

Applies identically to `next`, `submit` and every mutating human operation (except where §2a says otherwise).

1. Load checkpoint → unreadable/`INVALID_PERSISTED_STATE` ⇒ fail closed.
2. Lock acquired? else `EXECUTION_LOCKED` / `EXECUTION_LOCK_UNAVAILABLE` (non-terminal, nothing done).
3. Platform supported (`HARNESS_PLATFORM_UNSUPPORTED`); Harness block present with supported `schema_version`; manifest agrees; chain verifies ⇒ else `HARNESS_STATE_DIVERGED` / `LEDGER_CHAIN_BROKEN` / `HARNESS_SCHEMA_UNSUPPORTED` (fail closed).
4. **State coherence** (§3a): projection of (`state`, `lifecycle_status`, `pending_action`, `harness.cycle.step`) is permitted ⇒ else `FAIL_CLOSED(STATE_INCOHERENT)`.
5. Ports present (`ValidatorExecutor`, `SnapshotProvider`) ⇒ else `HARNESS_PORTS_MISSING`.
6. Envelope `ACTIVE`, not expired, all pins recomputed equal, baseline chain intact ⇒ else `ENVELOPE_*` / `PIN_MISMATCH` / `BASELINE_DRIFT` (suspension).
7. **Pending action present?** ⇒ `next` returns it (same `step_id`); `submit` validates and applies it; or, if `dispatchTtlMs` elapsed, suspend `DISPATCH_TIMEOUT`.
8. Active suspension? ⇒ return it unchanged (loops included) unless a human operation just resolved it.
9. Else run the cycle step machine (§3).

### 2a. Interaction of step 6 with a pending action (resolves the revocation/expiry rule; FR-089)

Step 6 precedes step 7, so **a pending action is never served or applied while the envelope is not valid**:
- `next` while the envelope is not `ACTIVE`/valid: returns the envelope suspension, **not** the pending action.
- When a call finds the envelope not valid while an action is pending, the same save that raises the suspension **moves the pending action into `harness.cycle.heldAction`** (engine → `HUMAN_INTERVENTION_REQUIRED`, which by existing engine behaviour clears `pending_action`). Nothing is lost: `heldAction` is the literal `PersistedPendingAction`.
- `submit` for the held `step_id` while the envelope is not valid (the Harness controller intercepts it before the engine's own `NO_PENDING_ACTION` path): **refused and not applied** (`ENVELOPE_NOT_ACTIVE`/`ENVELOPE_EXPIRED`/`PIN_MISMATCH`/`BASELINE_DRIFT`); no validator, review, counter or state change; one `SUBMISSION_REFUSED{stepId, resultDigest, reason}` event (digest only, the host keeps the payload).
- Revocation chooses the disposition (`HOLD` default | `ABANDON` closes it, authorization-envelope §6). Expiry and staleness are always `HOLD`.
- After a new `ACTIVE` envelope (amend, or issue with `resumesFrom`) that authorises the task with matching pins and baseline, `resumeSuspension` restores `heldAction` as the engine `pending_action` (one CAS save; engine back to `suspended_from`, `AWAITING_AGENT_ACTION`), evaluation reaches step 7 and the **same `step_id`** is served/accepted again; the result is validated against the *current* workspace like any other submission. If the task is no longer authorised the human closes it with `abandonPendingAction`.
- Human operations that must work while the envelope is not valid (`amendEnvelope`, `issueEnvelope`, `revokeEnvelope`, `abandonPendingAction`, `reconcileCycle`) skip step 6 only; steps 1–5 still apply.

## 3. Harness decision machine (maps onto existing states; no new `CoordinatorState`)

```
TASK_ELIGIBILITY_CHECK            engine state: IMPLEMENT (entering) | none yet
  ├─ eligible → capture baseline → IMPLEMENTATION_PENDING            [dispatch: IMPLEMENTATION; counted nowhere]
  └─ none eligible → SUSPEND(PHASE_END | BLOCKED_TASKS)
IMPLEMENTATION_PENDING            engine: IMPLEMENT, lifecycle AWAITING_AGENT_ACTION
  └─ result valid → DIFF_INSPECTED → (out-of-scope? SUSPEND) → VERIFICATION_PENDING
VERIFICATION_PENDING              engine: lifecycle IN_PROGRESS (engine-run, no agent)
  ├─ all required PASSED → REVIEW_PENDING
  ├─ any required FAILED → synthetic findings → FINDINGS_EVALUATION (no review)
  └─ any ERROR / missing → SUSPEND(VALIDATOR_ERROR)
REVIEW_PENDING                    engine: INDEPENDENT_REVIEW (attempt 0) | RE_REVIEW (after remediation)
  └─ result valid → FINDINGS_EVALUATION
FINDINGS_EVALUATION (pure)        → ADVANCE_TASK | REMEDIATE | SUSPEND | FAIL_CLOSED     (review-contract.md §5)
REMEDIATION_PENDING               engine: REMEDIATION, AWAITING_AGENT_ACTION; counter saved with pending action
  └─ result valid → DIFF_INSPECTED → VERIFICATION_PENDING
TASK_ACCEPTED                     one CAS save: TASK_ACCEPTED event + task state + cycle cleared + snapshot equality re-check
  └─ → TASK_ELIGIBILITY_CHECK (preset edge INDEPENDENT_REVIEW|RE_REVIEW → IMPLEMENT) | PHASE_END stop
```
Preset edges added for Harness executions only (D-10): `INDEPENDENT_REVIEW→IMPLEMENT`, `RE_REVIEW→IMPLEMENT`,
`IMPLEMENT→REMEDIATION`, `REMEDIATION→REMEDIATION`. Existing edges unchanged. `CONVERGE` is reached only after the human
confirms `PHASE_END` with all feature tasks satisfied.

### 3a. Relationship to `CoordinatorState` / `lifecycle_status`; projection table (FR-087, FR-088)

**One operational source of truth.** `harness.cycle.step` is an *embedded refinement* of the engine's own position; it is never an independent orchestrator. Authority split (and why disagreement cannot be resolved automatically):
- engine fields (`state`, `lifecycle_status`, `pending_action`, `suspended_from`, `human_intervention`) are authoritative for **protocol position** (is an agent action outstanding, is the run suspended);
- the Harness block is authoritative for **cycle position and counters** (which task, which attempt, validator/review results).
Neither can safely override the other, so **any combination not in this table is `FAIL_CLOSED(STATE_INCOHERENT)`**: no repair, no counter/event write (a diagnostic is returned to the caller only).

| `harness.cycle.step` (at rest) | engine `state` | `lifecycle_status` | `pending_action` | pending `kind` |
|---|---|---|---|---|
| *(no cycle; between tasks / before first)* | `IMPLEMENT` | `IN_PROGRESS` | none | — |
| `TASK_ELIGIBILITY_CHECK` | `IMPLEMENT` | `IN_PROGRESS` | none | — |
| `IMPLEMENTATION_PENDING` | `IMPLEMENT` | `AWAITING_AGENT_ACTION` | role `IMPLEMENTATION` | `IMPLEMENT` |
| `VERIFICATION_PENDING` | `IMPLEMENT` or `REMEDIATION` (the state that dispatched the work) | `IN_PROGRESS` | none | — |
| `REVIEW_PENDING` | `INDEPENDENT_REVIEW` (attempt 0) or `RE_REVIEW` (attempt ≥ 1) | `AWAITING_AGENT_ACTION` | role `INDEPENDENT_REVIEW` | `REVIEW` |
| `FINDINGS_EVALUATION` | `INDEPENDENT_REVIEW` or `RE_REVIEW` | `IN_PROGRESS` | none | — |
| `REMEDIATION_PENDING` | `REMEDIATION` | `AWAITING_AGENT_ACTION` | role `REMEDIATION` | `REMEDIATE` |
| `SUSPENDED` | `HUMAN_INTERVENTION_REQUIRED` | `HUMAN_INTERVENTION_REQUIRED` | none (the engine drops `pending_action` on any non-awaiting checkpoint); a **held** action lives in `harness.cycle.heldAction` (the literal `PersistedPendingAction`) | — |

Notes:
- `TASK_ACCEPTED` is **transient**: acceptance happens inside one CAS save that also sets the engine to `IMPLEMENT`/`IN_PROGRESS` with step `TASK_ELIGIBILITY_CHECK` (or suspends at `PHASE_END`). It is never an at-rest `HarnessStep` (an event only).
- `lifecycle_status` `COMPLETED` or `FAILED` ⇒ there must be **no** `harness.cycle`; otherwise `STATE_INCOHERENT`.
- `harness.cycle.taskId` must be the task `IN_CYCLE`/`SUSPENDED` in `harness.tasks`; the pending action's `step_id` must equal the one in the last `DISPATCHED` event for the cycle.
- After an engine-level `resume`, the engine reconstructs state from `suspended_from`; the Harness verifies the reconstructed (`state`, `step`) pair against this table (risk R-13). If it does not match, the step is `STATE_INCOHERENT`.
- `reconcileCycle(decisionId, actor, reason)` (human-only, skips step 4 only) is the **only** way out: it can move the cycle to `SUSPENDED` (engine to `HUMAN_INTERVENTION_REQUIRED` with `suspended_from` preserved), never forward, records both views as evidence, leaves counters untouched. Further recovery is then through the normal typed operations (e.g. `abandonPendingAction`, amendment excluding the task).

### Invariants (enforced + tested)

I1 `TASK_ACCEPTED` ⇒ implementation result received ∧ every required validator `PASSED` on S ∧ valid review `PASS` on S ∧ no open blocking finding ∧ snapshot(now) = S ∧ persisted via valid CAS.
I2 A task is accepted at most once; its `TASK_ACCEPTED` event is unique per `(taskId, lineage)`.
I3 Changing the subject snapshot invalidates all validator/review results not bound to it.
I4 A task outside the envelope, ineligible, or with a failing pin is never dispatched.
I5 Persistence failure/conflict/lock loss ⇒ no progression and no counter change.
I6 At most one task `IN_CYCLE`, at most one pending action, at most one `OPEN` attempt.
I7 A business decision, or a protected/non-authorisable operation that the Harness *sees* (workspace diff, agent declaration, host report), ⇒ suspension. Operations it cannot observe are not covered (E3).
I8 No at-rest (`state`, `lifecycle_status`, `pending_action`, `harness.cycle.step`) combination outside §3a exists after any successful save.

## 4. `HarnessSuspension`

```ts
interface HarnessSuspension { suspensionId: string; reason: SuspensionReason; taskId?: string; cycleId?: string;
  detail: string; evidence: EvidenceReference[]; options: HumanOption[]; raisedAtRevision: number }
type SuspensionReason = "STOP_POINT" | "GATE_REQUIRED" | "PHASE_END" | "BLOCKED_TASKS" | "TASK_NOT_AUTHORIZED"
  | "OUT_OF_SCOPE_CHANGE" | "OPERATION_NOT_PERMITTED" | "CRITICAL_FINDING" | "BUSINESS_DECISION" | "VALIDATOR_ERROR"
  | "REMEDIATION_BUDGET_EXHAUSTED" | "NO_PROGRESS" | "DISPATCH_TIMEOUT" | "RESULT_INVALID" | "EVIDENCE_QUARANTINED"
  | "EVIDENCE_MISSING" | "PIN_MISMATCH" | "RECONCILIATION_REQUIRED" | "WORKSPACE_MUTATED_DURING_VERIFICATION"
  | "GRAPH_INVALID" | "ENVELOPE_EXPIRED" | "ENVELOPE_REVOKED" | "LIMIT_REACHED" | "BASELINE_NOT_CLEAN" | "BASELINE_DRIFT" | "IGNORED_FILE_CHANGED" | "PATH_AMBIGUOUS" | "SUBMISSION_REFUSED";
```
It is surfaced through the **existing** `HUMAN_INTERVENTION_REQUIRED` mechanism (reason + structured question), so hosts
need no new UI; `options` enumerates the legal human operations. `FAIL_CLOSED` reasons (`HARNESS_STATE_DIVERGED`,
`LEDGER_CHAIN_BROKEN`, `ENVELOPE_TAMPERED`, `IN_CYCLE_INVARIANT`, `STATE_INCOHERENT`, `HARNESS_PLATFORM_UNSUPPORTED`) refuse all progress until a human resolves them outside the Harness.

## 5. Recovery by boundary (FR-070, SC-004)

| # | Crash / fault at | Durable at that moment | Recovery behaviour | Counted? |
|---|---|---|---|---|
| R1 | after eligibility decision, before cycle checkpoint | previous checkpoint | decision recomputed (pure) | no |
| R2 | after baseline captured, before dispatch checkpoint | previous | baseline re-captured (idempotent: same tree ⇒ same id); evidence file orphan tolerated | no |
| R3 | dispatch checkpoint saved, host not yet told / host crashed | pending action (+ counter if remediation) | next call returns **same** `step_id` | already counted once |
| R4 | host worked, crashed before submit | pending action | same as R3; workspace delta is whatever exists; verified at submit | once |
| R5 | submit received, validation of result fails | pending action | `RESULT_REJECTED` event; **1st** rejection: pending stays, no suspension; **2nd** rejection (`maxSubmissionRejections`=2): step closed unsuccessful, `RESULT_INVALID` suspension | no extra |
| R6 | submit applied, checkpoint **not** saved (conflict/write failure) | pending action | non-terminal failure; host re-submits same `step_id`; applies once (STALE_STEP protects) | no extra |
| R7 | after result applied (cycle=VERIFICATION_PENDING), before validators | cycle step | validators run | no |
| R8 | mid-validator | cycle step | orphan partial logs ignored; whole validator set re-run (results reusable only if recorded for same snapshot + validator digest) | no |
| R9 | validators done, results saved, review not dispatched | results | review dispatched; if snapshot changed ⇒ results invalidated, re-verify | no |
| R10 | review pending, host lost | pending action | R3 semantics; TTL ⇒ `DISPATCH_TIMEOUT` suspension | no |
| R11 | review result applied, findings not evaluated | `REVIEW_RECEIVED` | evaluation is pure ⇒ recomputed | no |
| R12 | acceptance CAS conflict | previous | re-read; acceptance re-evaluated against current state (snapshot may differ ⇒ stale) | no |
| R13 | after acceptance saved, before next eligibility | accepted | next call evaluates eligibility | no |
| R14 | `CHECKPOINT_WRITE_FAILED` at any boundary | last durable | existing non-terminal code; fix storage; same call retried by caller | no |
| R15 | lock lost / held elsewhere | — | `EXECUTION_LOCKED`; nothing done | no |
| R16 | envelope revoked/expired/stale while action pending | pending | per §2a: `next` returns the envelope suspension; `submit` is **refused and not applied** at step 6, `SUBMISSION_REFUSED` digest event, action moved to `heldAction` (or abandoned at revocation); same `step_id` valid again after a new ACTIVE envelope + `resumeSuspension` | already counted once; no recount |
| R19 | engine `state`/`lifecycle`/`pending_action` disagree with `harness.cycle.step` (e.g. after a manual file edit, an old engine, a faulty resume) | as found | `FAIL_CLOSED(STATE_INCOHERENT)`; only `reconcileCycle` proceeds | no |
| R17 | evidence file missing at acceptance | refs | `EVIDENCE_MISSING` suspension; re-run validators/review to regenerate | no |
| R18 | process killed (`SIGKILL`) holding the lock | — | existing dead-holder reclaim by pid probe | no |

**Timeout/invalid result summary**: no timeout is converted to success or failure automatically; a timed-out dispatch, or one whose result was rejected twice, is *counted* (if remediation) and ends in a human decision, never in an automatic re-dispatch (FR-067/068).

## 6. Idempotency and `/loop`

Correlation = `(executionId, cycleId, step_id)`. A repeated `next` with a pending action is a pure read of that action. A
repeated `submit` with a consumed `step_id` is `STALE_STEP`. `/loop` is an external caller: each iteration is a fresh
`next()` and re-runs §2; there is no loop state in the engine. External side effects performed by validators or agents are
*at-least-once* from the engine's perspective; the spec does not claim exactly-once. Validators are required to be idempotent
by policy review (risk R-5).

## 7. Human operations: common rules

Each: validates `actor.kind==="HUMAN"`; takes `decisionId` (idempotent; replays return the original result); runs under the
lock + CAS; appends exactly one event; never mutates the envelope in place; refuses when the execution has a *different*
active suspension than the one it names.

## 7a. Resolving suspensions (`resumeSuspension`) and the existing `humanAnswers`

The existing `resume` + `humanAnswers` path is **kept as the audit/question channel** (answers are validated and recorded as
today) but a free-text answer **never** changes Harness state. A suspension is cleared only by (a) a typed human operation that
names it (`recordGateDecision`, `grantRemediationBudget`, `abandonPendingAction`, `extendPendingAction`, `attestDependency`,
`acknowledgeUpstreamChange`, amend/revoke envelope) or (b) `resumeSuspension(suspensionId, decisionId, actor)` for causes the
human fixed outside the Harness (e.g. a validator environment). `resumeSuspension` only re-runs the evaluation order (§2): if
the cause persists the same suspension is raised again (no counter change, one `SUSPENDED` event per distinct raise). The
engine's resume reconstruction (`suspended_from`) MUST yield a state consistent with `harness.cycle.step`; an inconsistency is
`FAIL_CLOSED(IN_CYCLE_INVARIANT)`.

## 8. Test list (H7)

every row of §5 (R1–R19) · §2a matrix (revoked/expired/stale × next/submit × HOLD/ABANDON × re-authorisation) · projection-table property test (every disallowed combination ⇒ STATE_INCOHERENT, no writes) · reconcileCycle only moves to SUSPENDED · resume after fixed vs unfixed cause · free-text answer never advances · evaluation-order table (each early exit) · I1–I7 as property/invariant tests · human op idempotency and wrong-suspension refusal · loop does not bypass suspension · push and pull equivalence · host change mid-cycle · preset edges absent from default preset (regression) · legacy execution unaffected.
