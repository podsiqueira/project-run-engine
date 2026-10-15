# Data Model: Harness MVP

Index of entities, ownership, and cross-entity invariants. Field-level definitions live in the contract named in the last column.

| Entity | Persisted where | Mutability | Defined in |
|---|---|---|---|
| `HarnessPolicy` | tracked file `.project-run/harness/policy.json`; digest pinned in envelope | edited by humans via normal code review; any change ⇒ envelope stale | `contracts/authorization-envelope.md` §1 |
| `PhaseAuthorizationEnvelope` | `harness.envelope` + `ENVELOPE_*` events | immutable per revision; amend = new revision | same §2 |
| `TaskGraph` / `TaskNode` | derived from `tasks.md` (not persisted; **structural** digests + `GRAPH_BUILT` event; never raw bytes) | recomputed each boundary | `contracts/task-graph.md` |
| `TaskEligibilityDecision` | `ELIGIBILITY_DECIDED` event | append-only | same §2 |
| `GateDecision`, `DependencyAttestation`, `UpstreamAcknowledgement`, `FindingDisposition` | events (human-only) | append-only | `contracts/harness-controller.md` §7, `evidence-ledger.md` §3 |
| `ValidatorDefinition` | policy | protected | `contracts/verification-pipeline.md` §2 |
| `ValidatorResult` | `VALIDATOR_RAN` event + evidence files | append-only; invalidated by event | same §4 |
| `SnapshotIdentity`, `DiffArtifact` | `SNAPSHOT_CAPTURED` event + evidence file | write-once | same §6 |
| `ReviewRequest` / `ReviewResult` | evidence files + `REVIEW_*` events | write-once | `contracts/review-contract.md` |
| `HarnessFinding` | inside review/validator evidence; open set in `harness.latest` | status transitions by new events only | same §4 |
| `RemediationBudget`, `RemediationAttemptRecord`, `RemediationBudgetGrant` | `harness.budgets` (+ events) | counters monotonic | `contracts/remediation-budget.md` |
| `DirtyBaselineApproval` | `harness.dirtyBaselineApproval` + `BASELINE_APPROVED` event (human-only; absent by default) | immutable | `contracts/verification-pipeline.md` §6.1 |
| `PathPattern` / scope decision | policy and envelope fields; pure function | validated, never rewritten | `contracts/path-matching.md` |
| `StateProjection` (table rows T0–T9 and write sequences W1–W13) | specification table, enforced at evaluation step 4; completeness proved by enumerating W-sequences | fixed | `contracts/harness-controller.md` §3a/§3b |
| `HarnessEvent` | `harness.events[]` | append-only, hash-chained | `contracts/evidence-ledger.md` §3 |
| `EvidenceReference` | inside events | immutable | same §5 |
| `HarnessSuspension` | existing `human_intervention` (+ `SUSPENDED` event) | replaced per suspension (as today); history in events | `contracts/harness-controller.md` §4 |
| `HarnessDecision` | `FINDINGS_EVALUATED` event | pure output | `contracts/review-contract.md` §5 |

## Cross-entity invariants

1. `budgets[taskId].consumed == count(events kind=REMEDIATION_ATTEMPT_OPENED for the task)` and equals `attempts.length`.
2. Every `DISPATCHED{kind:"REMEDIATE"}` event shares its checkpoint revision with a `REMEDIATION_ATTEMPT_OPENED` event and a `pending_action`.
3. Every `TASK_ACCEPTED` event references: one implementation result event, the validator results for snapshot S, a `REVIEW_RECEIVED` with `snapshotId == S`, and carries `checkpointRevision`.
4. `harness.cycle` exists iff exactly one task is `IN_CYCLE` or `SUSPENDED` (a suspended task keeps the slot).
5. `chain.seq == events.length` and `chain.hash == events[last].hash`; MANIFEST agrees.
6. For every envelope revision *r > 1*: `supersedes` points at revision `r−1` which is `SUPERSEDED`.
7. No event `data` contains payload (enforced by a schema allowing only ids, digests, numbers, enums, ISO times, `EvidenceReference`).
8. The engine's own fields (`remediation_iteration`, `iteration`, `history`, `step_log`) keep their v0.5.0 meaning; Harness code writes them only through the existing coordinator paths.
9. `cycle.baselineTreeDigest` equals the previous accepted subject's `treeDigest` (or `envelope.baseline.startTreeDigest` for the first task) unless an approved dirty baseline applies; otherwise `BASELINE_DRIFT`.
10. After every `commit` the tuple (`state`, `lifecycle_status`, `pending_action`, `cycle.step`) is one of the rows T0–T9 (controller §3a); `cycle.heldAction` exists only in T9; a tuple outside the rows is `STATE_INCOHERENT`, never a tuple that has a recovery action.
11. `Σ grants.additionalAttempts ≤ policy.remediation.maxGrantedAttemptsPerTask`; `baseLimit` never changes after first authorisation of the task.

## State diagram (per task)

`NOT_STARTED → IN_CYCLE → ACCEPTED` · `IN_CYCLE → SUSPENDED → IN_CYCLE` (human) · `SUSPENDED → EXCLUDED` (via envelope amendment removing the task) · `ACCEPTED → ACCEPTED+UPSTREAM_CHANGED` (flag only).

12. Every `commit` is one CAS save built from the persisted record; the engine's `remediation_iteration`, `iteration` and `last_result` are changed only where the write sequence says so (never by a human answer); `history`/`step_log`/`human_answers` are append-only.
13. `request.context` of any persisted `pending_action` ≤ 8 KiB and each event `data` ≤ 4 KiB, references and digests only (FR-102).
14. A record is a Harness execution iff its `harness` block validates; `preset` and configuration labels never decide it (FR-096).