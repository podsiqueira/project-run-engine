# Contract: Remediation Policy and Persisted Budget (H5)

Implements owner **Decision 1**. Drives FR-041..FR-050, D-07, D-19. Existing v0.5.0 behaviour (E-1, E-2) is documented in
`spec.md` §2 and is **not modified**.

## 1. Definitions

- **Attempt**: a remediation dispatch that was *durably recorded* — the pending action and the incremented counter are written in **one CAS checkpoint** — in response to a blocking finding. The first such dispatch is **attempt 1**. (Not "iteration", not the engine's `remediation_iteration`.)
- **Unsuccessful attempt**: an attempt after which any of: required validator `FAILED`; review not `PASS` or open blocking findings; dispatch failed / timed out / abandoned; result invalid; `BLOCKED`.
- **Budget key**: `(lineageId, taskId)`.

## 2. State

```ts
interface RemediationBudget {
  lineageId: string; taskId: string;
  limit: number;              // = envelope.remediation.limit (0..3) + Σ grants
  baseLimit: 0 | 1 | 2 | 3;
  consumed: number;           // monotonic; = number of durable remediation dispatches; never decremented
  grants: RemediationBudgetGrant[];   // append-only
  attempts: RemediationAttemptRecord[];   // append-only
  exhaustedAt?: string; exhaustionReason?: "BUDGET_EXHAUSTED" | "NO_PROGRESS";
}
interface RemediationAttemptRecord {
  attempt: number;            // 1-based
  stepId: string; dispatchedAt: string; revisionAtDispatch: number;
  triggeringFindingFingerprints: string[];
  outcome: "OPEN" | "SUCCEEDED" | "UNSUCCESSFUL";
  closeReason?: "VALIDATOR_FAILED" | "REVIEW_FINDINGS" | "DISPATCH_FAILED" | "DISPATCH_TIMEOUT"
              | "RESULT_INVALID" | "ABANDONED_BY_HUMAN" | "BLOCKED" | "NO_PROGRESS";
  resultingSnapshotId?: string; blockingFingerprintsAfter?: string[];
}
interface RemediationBudgetGrant {
  grantId: string; decisionId: string;    // idempotency key
  additionalAttempts: 1 | 2 | 3;
  linkedSuspensionId: string; reason: string;
  actor: Actor; grantedAt: string;
}
```
Invariants: `consumed ≤ limit` at dispatch time; `consumed == attempts.length`; at most one attempt `OPEN`; `limit` only increases via a grant.

## 3. Rules

1. **Write-ahead counting**: before any remediation dispatch is returned to the host, a CAS save persists `consumed+1`, the `OPEN` attempt record, and the pending action. If that save fails (conflict, lock, write failure) nothing was dispatched and nothing counts.
2. **Pre-check**: dispatch allowed iff `consumed < limit` **and** authorisation (FR-007) passes **and** no `CRITICAL`/out-of-scope condition exists. Otherwise `SUSPEND`.
3. **After 3 unsuccessful attempts** (limit reached) the controller sets `exhaustedAt`, suspends with `REMEDIATION_BUDGET_EXHAUSTED`, and will not dispatch again for that task until a grant is recorded.
4. **Human answers never touch the counter**: `humanAnswers` processing and `resume` MUST NOT read or write `RemediationBudget`. A human may (a) abandon the pending action, (b) record a finding disposition, (c) record a `RemediationBudgetGrant`, (d) revoke the envelope. Only (c) increases `limit`.
5. **Grants**: human-only (`grantRemediationBudget`), bound to the *current* suspension id, `additionalAttempts ≤ 3` per grant, idempotent on `decisionId`; grants carry the same rules (validators + new review after each).
6. **Independence from the engine counter**: the Harness preset's `resolveTransition` does not read `remediation_iteration`/`MAX_REMEDIATION_ITERATIONS`; it reads `RemediationBudget`. The engine's own counter is still updated for display compatibility only.
7. **Preset-scoped**: only executions with a persisted Harness block use this policy (FR-050).

## 4. Counting table for abnormal outcomes (no ambiguity)

| Situation | Counts as an attempt? | Resulting state |
|---|---|---|
| Pending action + counter saved, host never picks it up, process restarts | Yes (already counted, **once**); re-presenting the same `step_id` never counts again | attempt stays `OPEN` |
| Host reports failure / crash (`FAIL`, `lifecycle_status: FAILED`) | Yes | attempt `UNSUCCESSFUL(DISPATCH_FAILED)`; next dispatch consumes the next attempt |
| Host reports timeout (`TIMED_OUT`) or `dispatchTtlMs` elapsed with no result | Yes | attempt stays `OPEN`; cycle **suspends** `DISPATCH_TIMEOUT` (no auto-retry); human chooses `abandonPendingAction` (⇒ `UNSUCCESSFUL(ABANDONED_BY_HUMAN)`) or `extendPendingAction` (same attempt, no recount) |
| Result fails Harness validation (malformed, wrong ids) | Yes (dispatch already counted); rejections are not recounted | pending action stays; after `maxSubmissionRejections` (2) ⇒ `UNSUCCESSFUL(RESULT_INVALID)` and suspend |
| Result accepted, validators `FAILED` | Yes | `UNSUCCESSFUL(VALIDATOR_FAILED)` |
| Result accepted, validators `ERROR` | Yes (the dispatch happened) | attempt closed `UNSUCCESSFUL` **but** cycle suspends `VALIDATOR_ERROR`; environment fix + resume continue with no extra count until the next dispatch |
| Result accepted, review has blocking findings | Yes | `UNSUCCESSFUL(REVIEW_FINDINGS)` |
| Review ⇒ `PASS`, validators pass | Yes (it was an attempt) | `SUCCEEDED`; task accepted |
| `CHECKPOINT_CONFLICT`/lock/write failure before the dispatch checkpoint | **No** (not durable) | non-terminal failure, re-read |
| Authorisation denied / `PIN_MISMATCH` before dispatch | **No** | suspension |
| `CRITICAL`/out-of-scope detected | **No** (no dispatch happens) | suspension |
| Same pending action resumed by another host | **No** | same `step_id` |

## 5. After each attempt (FR-047)

validators (engine-executed, new subject snapshot) ⇒ **new** review invocation ⇒ findings evaluation. The attempt record is
closed only when this chain ends or a suspension interrupts it.

## 6. Early escalation (`NO_PROGRESS`)

Default policy `ESCALATE_ON_NO_PROGRESS`: if after attempt *n* and *n−1* the blocking fingerprint set is not a strict reduction
of the previous one, suspend `NO_PROGRESS` (attempt *n* stays counted). `EXHAUST_BUDGET` disables this. Never lets a 4th dispatch happen.

## 7. Migration/compatibility

No existing checkpoint contains a `RemediationBudget`. Enabling the Harness on an execution (`adoptExecution`) initialises
budgets for authorised tasks with `consumed: 0`; the engine's historical `remediation_iteration` is **not** converted.
Documented consequence: an adopted execution that already used engine remediation iterations starts the Harness budget at 0.

## 8. Test list (H5)

attempt numbering (first = 1) · counter in same checkpoint as pending action · CAS failure ⇒ no count · restart/resume/host change preserve · human answer no-op on counter · 4th dispatch refused · grant of 1/2/3 · grant without suspension link rejected · grant idempotency · each table row in §4 · NO_PROGRESS · counter property test across all resume points · engine default behaviour (4 dispatches) unchanged for non-Harness runs · re-review uses new invocation · adopted run starts at 0.
