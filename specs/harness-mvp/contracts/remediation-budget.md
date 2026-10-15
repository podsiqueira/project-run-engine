# Contract: Remediation Policy and Persisted Budget (H5)

Implements owner **Decision 1**. Drives FR-041..FR-050, D-07, D-19. Existing v0.5.0 behaviour (E-1, E-2) is documented in
`spec.md` §2 and is **not modified**.

## 1. Definitions

- **Attempt**: a remediation dispatch that was *durably recorded* — the pending action and the incremented counter are written in **one CAS checkpoint** — in response to a blocking finding. The first such dispatch is **attempt 1**. (Not "iteration", not the engine's `remediation_iteration`.)
- **Unsuccessful attempt**: an attempt after which any of: required validator `FAILED`; review not `PASS` or open blocking findings; dispatch failed / timed out / abandoned; result invalid; `BLOCKED`.
- **Budget key**: `(executionId, taskId)`. Each attempt records the `authorizationId`/`lineageId` of the envelope that dispatched it, so consumption is reportable **per task and per envelope**, but is **shared across all envelope lineages of the execution** so that re-issuing or superseding an envelope can never reset it (FR-091).

## 2. State

```ts
interface RemediationBudget {
  executionId: string; taskId: string;
  limit: number;              // = baseLimit + Σ grants.additionalAttempts
  baseLimit: 0 | 1 | 2 | 3;   // initial automatic attempts = envelope.remediation.limit at first authorisation of the task; never raised by amendment
  consumed: number;           // monotonic; = number of durable remediation dispatches; never decremented
  grants: RemediationBudgetGrant[];   // append-only
  attempts: RemediationAttemptRecord[];   // append-only
  exhaustedAt?: string; exhaustionReason?: "BUDGET_EXHAUSTED" | "NO_PROGRESS";
}
interface RemediationAttemptRecord {
  attempt: number;            // 1-based
  authorizationId: string; lineageId: string;
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
Invariants: `consumed ≤ limit` at dispatch time; `consumed == attempts.length`; at most one attempt `OPEN`; `limit` only increases via a grant; `Σ grants.additionalAttempts ≤ policy.remediation.maxGrantedAttemptsPerTask` (default 3, so at most 6 attempts in total per task); `baseLimit` is fixed when the task is first authorised and an amendment that lists the task again cannot change it.

## 3. Rules

1. **Write-ahead counting**: before any remediation dispatch is returned to the host, a CAS save persists `consumed+1`, the `OPEN` attempt record, and the pending action. If that save fails (conflict, lock, write failure) nothing was dispatched and nothing counts.
2. **Pre-check**: dispatch allowed iff `consumed < limit` **and** authorisation (FR-007) passes **and** no `CRITICAL`/out-of-scope condition exists. Otherwise `SUSPEND`.
3. **After 3 unsuccessful attempts** (limit reached) the controller sets `exhaustedAt`, suspends with `REMEDIATION_BUDGET_EXHAUSTED`, and will not dispatch again for that task until a grant is recorded.
4. **Human answers never touch the counter or dispatch**: `humanAnswers` are audit-only for Harness executions (harness-controller §7a, FR-098); they MUST NOT read or write `RemediationBudget`, the engine's `remediation_iteration`, or `last_result`, and they never cause a dispatch (existing engine behaviour E-2/E-13 does not apply to Harness executions). A human may (a) abandon the pending action, (b) record a finding disposition, (c) record a `RemediationBudgetGrant`, (d) revoke the envelope. Only (c) increases `limit`.
5. **Grants**: human-only (`grantRemediationBudget`), a **separate recorded authorisation** bound to the *current* `REMEDIATION_BUDGET_EXHAUSTED` or `NO_PROGRESS` suspension id, `additionalAttempts ∈ {1,2,3}` per grant, idempotent on `decisionId`, refused beyond `policy.remediation.maxGrantedAttemptsPerTask`. Grants carry the same rules (validators + new review after each). **The initial three attempts are never created, raised or replaced by a grant, a policy edit, an envelope, an amendment, or a human answer**; an amendment may neither contain nor imply a grant (FR-091). The relation is: `policy.initialLimit (3) ≥ envelope.remediation.limit (initial attempts) ` and `grants` are strictly additional.
6. **Independence from the engine counter**: the engine's `decide`/`resolveTransition` and `MAX_REMEDIATION_ITERATIONS` logic are **never executed** for a Harness execution; the controller reads `RemediationBudget` only. The engine's `remediation_iteration` is carried unchanged by every `commit` (adoption value) and is not used.
7. **Preset-scoped**: only executions with a persisted Harness block use this policy (FR-050).

## 4. Counting table for abnormal outcomes (no ambiguity)

| Situation | Counts as an attempt? | Resulting state |
|---|---|---|
| Pending action + counter saved, host never picks it up, process restarts | Yes (already counted, **once**); re-presenting the same `step_id` never counts again | attempt stays `OPEN` |
| Host reports failure / crash (`FAIL`, `lifecycle_status: FAILED`) | Yes | attempt `UNSUCCESSFUL(DISPATCH_FAILED)`; next dispatch consumes the next attempt |
| Host reports timeout (`TIMED_OUT`) or `dispatchTtlMs` elapsed with no result | Yes | attempt stays `OPEN`; cycle **suspends** `DISPATCH_TIMEOUT` (no auto-retry); human chooses `abandonPendingAction` (⇒ `UNSUCCESSFUL(ABANDONED_BY_HUMAN)`) or `extendPendingAction` (same attempt, no recount) |
| Result fails Harness validation (malformed, wrong ids) | Yes (dispatch already counted); rejections are not recounted | **1st rejected submission**: pending action stays, no suspension. **2nd rejected submission** (`maxSubmissionRejections` = 2): `UNSUCCESSFUL(RESULT_INVALID)` and suspend |
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

## 6. `NO_PROGRESS` (precise definition; FR-049, FR-092)

**Finding fingerprint** (`fingerprint`, engine-computed, version-prefixed so it can evolve): `fp = sha256("fp1|" + category + "|" + file + "|" + criterion + "|" + rule)` where
- `category` = lower-cased, trimmed `finding.category` (`""` if absent);
- `file` = the finding's `location.file` after path validation (`path-matching.md` §2), or `""` (line/column are **never** part of the fingerprint);
- `criterion` = `violatedCriterion` id, else `violatedContract` id, else `""` (ids, never free text);
- `rule` = the reviewer-supplied stable `ruleKey` (required on blocking findings); if absent, a derived key: the finding title lower-cased, NFC-normalised, digits and quotes removed, whitespace collapsed;
- for `source: "VALIDATOR"`: `category = "validator"`, `file = ""`, `criterion = validatorId`, `rule = "exit:" + exitCode`; log text is never part of it.
Severity and wording of description/impact/recommendation are not part of the fingerprint.

**Blocking set** `B_k` = the set of fingerprints of open blocking findings (review and validator) after attempt *k*; `B_0` = the set after the first review/verification that triggered remediation. Duplicates collapse (it is a set). An attempt that yields no review (dispatch failed/timed out/abandoned/invalid result) leaves the set unchanged: `B_k = B_{k−1}`.

**Progress**: attempt *k ≥ 1* made progress **iff `B_k ⊊ B_{k−1}`** (a *proper subset*: at least one previously blocking fingerprint is gone **and no new blocking fingerprint appeared**). `B_k = ∅` is success, not a no-progress case. Otherwise (equal, superset, or any new fingerprint) it made **no progress**.

**Streak**: `streak_k = 0` if progress, else `streak_{k−1} + 1` (`streak_0 = 0`). When `streak_k ≥ E.streak` (envelope) the Harness suspends `NO_PROGRESS` immediately after attempt *k* is evaluated (the attempt stays counted). Default `E.streak = 2` ⇒ earliest at attempt 2, so a third attempt never starts after two non-reducing attempts.

**Policy floor** (FR-092): the envelope's `recurrence` must not be weaker than the policy's (authorization-envelope §4a): a policy `ESCALATE_ON_NO_PROGRESS, streak 2` forbids an envelope from choosing `EXHAUST_BUDGET` or a larger streak. `NO_PROGRESS` never allows a 4th dispatch; it can only shorten the sequence. A grant after `NO_PROGRESS` resets `streak` to 0 only if the grant states `resetStreak: true` (default false) and is recorded in the event.

Known limitation: fingerprints are heuristic (reviewer rewording of `ruleKey` can split or merge sets); the reviewer contract therefore requires stable `ruleKey`s and the re-review receives `priorFindings` with their keys.

## 7. Migration/compatibility

No existing checkpoint contains a `RemediationBudget`. Enabling the Harness on an execution (`adoptExecution`) initialises
budgets for authorised tasks with `consumed: 0`; the engine's historical `remediation_iteration` is **not** converted.
Documented consequence: an adopted execution that already used engine remediation iterations starts the Harness budget at 0.

## 8. Test list (H5)

attempt numbering (first = 1) · counter in same checkpoint as pending action · CAS failure ⇒ no count · restart/resume/host change preserve · human answer no-op on counter · 4th dispatch refused · grant of 1/2/3 · grants beyond the cap rejected · grant without suspension link rejected · grant idempotency · amendment with grant fields rejected · re-issue does not reset consumption · each table row in §4 · NO_PROGRESS table tests (equal set, superset, new fingerprint with smaller size, proper subset, empty, dispatch-failed attempt, streak 1/2/3, policy-floor refusal) · counter property test across all resume points · engine default behaviour (4 dispatches) unchanged for non-Harness runs · re-review uses new invocation · adopted run starts at 0.
