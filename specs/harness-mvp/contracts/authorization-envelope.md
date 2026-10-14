# Contract: Phase Authorization Envelope and Harness Policy (H1)

Provisional names. Types are illustrative TypeScript; final shapes are fixed at Gate B.
Drives FR-001..FR-010, FR-061..064.

## 1. `HarnessPolicy` (repository configuration, trusted, versioned)

```ts
interface HarnessPolicy {
  schemaVersion: 1;
  policyId: string;
  /** sha256 of canonical JSON of this object; recomputed by the engine, never taken from the file. */
  digest: string;
  permittedOperationVocabulary: PermittedOperation[];   // ceiling
  validators: ValidatorDefinition[];                    // the allowlist (contracts/verification-pipeline.md)
  defaults: { remediationLimit: 3; dispatchTtlMs: number; maxSubmissionRejections: 2;
              recurrence: "ESCALATE_ON_NO_PROGRESS" | "EXHAUST_BUDGET";
              requireDistinctInvocationId: true };
  protectedPaths: string[];   // globs, workspace-relative
  sensitivePaths: string[];   // verifier-defining files (FR-031)
  redaction: { patterns: string[]; maxOutputBytes: number };
  limits: { maxTaskElapsedMs?: number; cost: "unsupported" };
}
type PermittedOperation =
  | "EDIT_FILES_IN_ALLOWED_PATHS" | "CREATE_FILES_IN_ALLOWED_PATHS" | "DELETE_FILES_IN_ALLOWED_PATHS"
  | "RUN_ALLOWLISTED_VALIDATORS" | "TOGGLE_OWN_TASK_CHECKBOX";
```

Un-grantable in the MVP (never in the vocabulary): destructive data operations, migrations, deployment, infrastructure,
network egress, business decisions, scope expansion, policy/allowlist/envelope edits, `git commit|push|merge|tag`, PR,
release, publish. An agent request for any of them is `OPERATION_NOT_PERMITTED`.

## 2. `PhaseAuthorizationEnvelope`

```ts
interface PhaseAuthorizationEnvelope {
  schemaVersion: 1;
  authorizationId: string;          // unique
  lineageId: string;                // stable across supersession; key for budgets (remediation-budget.md)
  revision: number;                 // 1,2,… ; amendment = new revision with supersedes
  supersedes?: { authorizationId: string; revision: number };
  executionId: string;
  phaseId: string;
  sourcePhaseLabel?: string;        // informational copy of the tasks.md heading
  feature: string;
  tasksSource: { path: string; digest: string };            // tasks.md digest at issuance
  authorizedTaskIds: string[];      // closed list (D-02)
  taskDefinitionDigests: Record<string, string>;            // per authorised task
  allowedPaths: string[];           // globs the task may change
  permittedOperations: PermittedOperation[];                // ⊆ policy vocabulary
  validatorIds: string[];           // ⊆ policy.validators; each flagged required in the policy or here
  stopPoints: StopPoint[];
  remediation: { limit: 0 | 1 | 2 | 3; recurrence: "ESCALATE_ON_NO_PROGRESS" | "EXHAUST_BUDGET";
                 budgetCarryOver: "CARRY" | "GRANT" ; grantReason?: string };  // see §5
  limits: { dispatchTimeoutMs: number; dispatchTtlMs: number; maxTaskElapsedMs?: number; cost: "unsupported" };
  review: { requireDistinctInvocationId: boolean };
  pins: { policyDigest: string; allowlistDigest: string; artifacts: Record<string, string> }; // path → sha256
  issuedAt: string; issuedBy: Actor;                        // Actor.kind MUST be "HUMAN"
  expiresAt?: string;
  status: "ACTIVE" | "SUSPENDED_STALE" | "EXPIRED" | "REVOKED" | "SUPERSEDED" | "COMPLETED";
  digest: string;                   // sha256 of all fields above except status/derived
}
interface StopPoint { kind: "BEFORE_TASK" | "AFTER_TASK" | "PHASE_END"; taskId?: string }
interface Actor { kind: "HUMAN"; id: string; assertedBy: "HOST" }   // not authenticated by the engine (NG-8)
```

## 3. Issuance and amendment rules

1. Only `issueEnvelope`, `amendEnvelope`, `revokeEnvelope` (human-only operations, D-22) write envelopes; they validate:
   `permittedOperations ⊆ policy`, `validatorIds ⊆ policy.validators`, `remediation.limit ≤ policy.defaults.remediationLimit ≤ 3`,
   every `authorizedTaskIds` exists in the validated `TaskGraph`, digests match current files, `allowedPaths` exclude every `protectedPaths` glob.
2. An envelope is **immutable**. `amendEnvelope` creates `revision+1`, marks the previous `SUPERSEDED`, and MUST declare `budgetCarryOver`.
3. An agent-originated request to change any field is rejected at the type level (no such operation on the agent-facing API) and, if smuggled in a result, by diff inspection of protected paths (`OUT_OF_SCOPE_CHANGE`).
4. At most one `ACTIVE` envelope per execution.

## 4. Pre-dispatch authorisation check (FR-007)

Order (first failure wins, all recorded as `AuthorizationDecision{allowed:false, reason}`):
`ENVELOPE_NOT_ACTIVE` → `ENVELOPE_EXPIRED` → `PIN_MISMATCH` → `TASK_NOT_AUTHORIZED` → `GATE_NOT_SATISFIED` →
`OPERATION_NOT_PERMITTED` → `LIMIT_REACHED`. Nothing is dispatched on denial; the result is a `HarnessSuspension` or, for `PIN_MISMATCH`, `SUSPENDED_STALE`.

## 5. Budget carry-over on amendment

`CARRY` (default): consumed attempts and grants for each `(lineageId, taskId)` continue. `GRANT`: requires a `grantReason`;
equivalent to a `RemediationBudgetGrant` event recorded atomically with the amendment, bounded by §4 of `remediation-budget.md`.
A **new `lineageId`** is only legal for a different phase and never resets counters of tasks that remain authorised in the old lineage.

## 6. Invalidation matrix (FR-061..064)

| Changed artifact | Effect |
|---|---|
| `HarnessPolicy` (any field) | envelope → `SUSPENDED_STALE`; new revision required |
| Validator allowlist / a `ValidatorDefinition` used | same |
| Envelope itself edited out-of-band (digest mismatch) | `FAIL_CLOSED` (`ENVELOPE_TAMPERED`) |
| `tasks.md` definition of a **not accepted** authorised task | that task ineligible (`TASK_DEFINITION_CHANGED`) until amended |
| Definition/contract of an **accepted** task | stays accepted, flagged `UPSTREAM_CHANGED`; dependents blocked until `UpstreamAcknowledgement` |
| Pinned spec/contract artifact | `SUSPENDED_STALE` listing the artifact |
| Unpinned file | no effect (only listed artifacts are pinned) |
| Subject snapshot changes | validator/review results for the old snapshot logically invalid (`invalidatedBy`) |

## 7. Status exposure

`status` returns: effective envelope (digest, revision, status), policy digest, per-task state, remaining budget per task, current cycle step, last decision. It labels `Actor` as "host-asserted".

## 8. Rejection cases (test list for H1)

widening beyond policy · task not in graph · protected path in `allowedPaths` · `limit > 3` · `Actor.kind ≠ HUMAN` · expired on issue · second ACTIVE envelope · amendment without `budgetCarryOver` · digest mismatch on load · attempt to enable an un-grantable operation.
