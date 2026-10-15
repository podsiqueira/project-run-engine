# Contract: Phase Authorization Envelope and Harness Policy (H1)

Provisional names. Types are illustrative TypeScript; final shapes are fixed at Gate B. **Revision 2** (correction pass).
Drives FR-001..FR-010, FR-061..064, FR-079..FR-092.

## 0. Logical enforcement vs technical prevention (read first)

Nothing in this contract makes an operation *impossible*. Each rule has an **enforcement class** (FR-079):

| Class | Meaning | What the Harness actually does | Examples |
|---|---|---|---|
| **E1** engine-refused | The engine itself will not perform or accept it | refuses to dispatch / run / accept; typed denial | dispatching an unauthorised or ineligible task; accepting without validators; running a non-allowlisted validator; accepting an unreviewed snapshot |
| **E2** detected after the fact | The change can happen; the engine sees it in the workspace and reacts | diff inspection ⇒ `OUT_OF_SCOPE_CHANGE`, acceptance refused, suspension; the change stays on disk; **no rollback** | edits to protected paths, edits outside `allowedPaths`, new symlinks, edits to policy/allowlist/envelope files, `tasks.md` changes beyond the own checkbox |
| **E3** host/environment-enforced, otherwise not enforced | The engine cannot observe or stop it | nothing, unless the host reports it; `OPERATION_NOT_PERMITTED` only on visible evidence (FR-080) | network egress, `git commit/push`, deployment, migrations, database access, reading secrets, any process the agent starts, validator network/file access |

Consequences that MUST appear in `status` output, docs and tests:
- "Prohibited" in this document means *denied by policy* (E1 for engine actions, E2 where the workspace shows it, E3 otherwise). It never means technically blocked unless the host or environment demonstrably enforces it.
- Human-only operations (§3) are **logically separated** from the agent-facing API; the engine does not authenticate the actor (NG-8), and a local process with the same OS user, filesystem and shell can call internal functions or edit files directly (E3). Protection comes from host permission policy, from the hash chain that makes naive edits detectable, and from the audit trail, not from the engine.
- Validators run with **no network isolation and no filesystem sandbox**; only cwd confinement, a minimal environment and a timeout are applied (E3 for everything else).
- Gate B fixture hygiene (FR-081): no unnecessary secrets or credentials available to agent or validator processes.

## 1. `HarnessPolicy` (tracked configuration)

Location: **`.project-run/harness/policy.json`** (resolved OD-5). Rationale and verification: tracked configuration alongside the already-tracked
`.project-run/config.json`; separate from mutable state (`.project-run/runs/`, ignored by convention per `CONSUMER-GUIDE.md`; and
`.project-run/evidence/`, which `doctor` requires to be ignored, FR-058). Issuance requires the file to be tracked and unmodified relative to `HEAD` (`POLICY_NOT_COMMITTED` otherwise), so a policy change always has a review trail.

```ts
interface HarnessPolicy {
  schemaVersion: 1;
  policyId: string;
  digest: string;                                       // sha256 of canonical JSON, recomputed by the engine, never read from the file
  permittedOperationVocabulary: PermittedOperation[];   // ceiling; each entry carries its enforcement class
  validators: ValidatorDefinition[];                    // the allowlist (verification-pipeline.md)
  remediation: { initialLimit: 3;                       // fixed in the MVP
                 maxGrantedAttemptsPerTask: number;     // default 3; bounds cumulative RemediationBudgetGrants (FR-091)
                 maxSubmissionRejections: 2; dispatchTtlMs: number };
  recurrence: { mode: "ESCALATE_ON_NO_PROGRESS" | "EXHAUST_BUDGET"; streak: number };  // FLOOR for envelopes (FR-092); default {ESCALATE…, 2}
  baseline: { mode: "CLEAN_REQUIRED"; allowDirtyBaseline: boolean };                   // default false (FR-082/083)
  protectedPaths: string[];     // additive to the mandatory set below
  sensitivePaths: string[];     // verifier-defining files (FR-031)
  ignoredExclusions: string[];  // the ONLY ignored paths excluded from snapshots (FR-084)
  redaction: { patterns: string[]; maxOutputBytes: number };
  review: { requireDistinctInvocationId: true };
  limits: { maxTaskElapsedMs?: number; cost: "unsupported" };
}
type PermittedOperation =
  | "EDIT_FILES_IN_ALLOWED_PATHS" | "CREATE_FILES_IN_ALLOWED_PATHS" | "DELETE_FILES_IN_ALLOWED_PATHS"
  | "RUN_ALLOWLISTED_VALIDATORS" | "TOGGLE_OWN_TASK_CHECKBOX";
```

**Mandatory protected set** (built into the engine, not removable by policy or envelope; patterns per `path-matching.md`):
`.project-run/harness/**`, `.project-run/config.json`, `.project-run/workflow.json`, `.project-run/runs/**`, `.project-run/evidence/**`, `.git/**`.

**Not authorisable in the MVP** (never in the vocabulary): destructive data operations, migrations, deployment, infrastructure, network egress,
business decisions, scope expansion, policy/allowlist/envelope edits, `git commit|push|merge|tag`, PR, release, publish. The engine does not
perform them (E1), flags the ones visible in the workspace (E2) or reported by the host, and cannot stop the rest (E3).

## 2. `PhaseAuthorizationEnvelope`

```ts
interface PhaseAuthorizationEnvelope {
  schemaVersion: 1;
  authorizationId: string; lineageId: string;           // lineageId: audit grouping across amendments
  revision: number; supersedes?: { authorizationId: string; revision: number };
  executionId: string; phaseId: string; sourcePhaseLabel?: string; feature: string;
  authorizedTaskIds: string[];                          // closed list (D-02)
  allowedPaths: string[];                               // patterns (path-matching.md); must not match the mandatory/protected set
  permittedOperations: PermittedOperation[];            // ⊆ policy vocabulary
  validatorIds: string[];                               // ⊆ policy.validators
  stopPoints: StopPoint[];
  remediation: { limit: 0 | 1 | 2 | 3 };                // initial automatic attempts; ≤ policy.initialLimit; no other fields (FR-091)
  recurrence: { mode: "ESCALATE_ON_NO_PROGRESS" | "EXHAUST_BUDGET"; streak: number };  // not weaker than policy.recurrence (FR-092)
  baseline: { mode: "CLEAN_REQUIRED" | "DIRTY_APPROVED"; dirtyApprovalId?: string; startTreeDigest: string; startCommit: string };
  limits: { dispatchTimeoutMs: number; dispatchTtlMs: number; maxTaskElapsedMs?: number; cost: "unsupported" };
  review: { requireDistinctInvocationId: boolean };     // may not be false when policy says true
  pins: {
    policyDigest: string; allowlistDigest: string;
    tasks: { path: string; parserVersion: string };      // structural pins only; NO raw-bytes digest of tasks.md (FR-085)
    taskDefinitionDigests: Record<string, string>;       // authorised tasks
    dependencyClosureDigests: Record<string, string>;    // every transitive dependency not in the authorised list
    artifacts: Record<string, string>;                   // other pinned files (spec/contracts) → sha256 of bytes
  };
  pendingDisposition?: undefined;                        // only set by revokeEnvelope, see §6
  issuedAt: string; issuedBy: Actor; expiresAt?: string;
  status: "ACTIVE" | "SUSPENDED_STALE" | "EXPIRED" | "REVOKED" | "SUPERSEDED" | "COMPLETED";
  digest: string;                                        // over all fields except status
}
interface StopPoint { kind: "BEFORE_TASK" | "AFTER_TASK" | "PHASE_END"; taskId?: string }
interface Actor { kind: "HUMAN"; id: string; assertedBy: "HOST"; authenticated: false }   // NG-8
```
There is deliberately **no** `budgetCarryOver`, `GRANT` mode or grant field in the envelope: grants are separate events (§5).

## 3. Issuance and amendment rules

1. Only `issueEnvelope`, `amendEnvelope`, `revokeEnvelope` (human-only operations, D-22) write envelopes. They validate: `permittedOperations ⊆ policy`; `validatorIds ⊆ policy.validators`;
   `remediation.limit ≤ policy.remediation.initialLimit (3)`; `recurrence` not weaker than policy (§4a); every authorised task exists in the validated `TaskGraph`; all pins match current files;
   `allowedPaths` valid patterns that do not intersect the mandatory or policy protected set; policy file tracked and clean; **baseline rule (FR-082)**: clean tree (or an approved dirty baseline, FR-083) and `startTreeDigest`/`startCommit` recorded; platform supported (FR-094).
2. An envelope is **immutable**. `amendEnvelope` creates `revision+1`, marks the previous `SUPERSEDED`. An amendment can add or remove tasks and change paths/validators within the policy; it cannot raise `remediation.limit` for any task that already consumed attempts and carries no budget change at all (§5).
3. An agent-originated change to any field is not an operation of the agent-facing API; if attempted by editing files, it is detected (E2, `OUT_OF_SCOPE_CHANGE`) or by digest mismatch (`ENVELOPE_TAMPERED`, `FAIL_CLOSED`). It is **not prevented**.
4. At most one `ACTIVE` envelope per execution.

### 4a. Recurrence floor (FR-092)

Let `P = policy.recurrence`, `E = envelope.recurrence`. Valid iff:
- `P.mode = ESCALATE_ON_NO_PROGRESS` ⇒ `E.mode = ESCALATE_ON_NO_PROGRESS` and `E.streak ≤ P.streak` and `E.streak ≥ 1`;
- `P.mode = EXHAUST_BUDGET` ⇒ `E` may be either mode; if `ESCALATE…`, any `streak ≥ 1`.
Otherwise `issueEnvelope`/`amendEnvelope` fails with `RECURRENCE_WEAKER_THAN_POLICY`.

## 4. Pre-dispatch authorisation check (FR-007)

Order (first failure wins; recorded as `AuthorizationDecision{allowed:false, reason}`):
`ENVELOPE_NOT_ACTIVE` → `ENVELOPE_EXPIRED` → `PIN_MISMATCH` → `TASK_NOT_AUTHORIZED` → `GATE_NOT_SATISFIED` → `BASELINE_DRIFT` → `OPERATION_NOT_PERMITTED` (only on visible evidence) → `LIMIT_REACHED`.
Nothing is dispatched on denial; the result is a `HarnessSuspension` (`SUSPENDED_STALE` envelope status for pin failures).

## 5. Remediation limit, grants and the policy ceiling (FR-041, FR-045, FR-091)

```
policy.initialLimit (3)  ≥  envelope.remediation.limit (0..3)  =  initial automatic attempts per task
                                         +  RemediationBudgetGrant attempts (separate human authorisations)  ≤  policy.maxGrantedAttemptsPerTask
```
- The initial automatic attempts are exactly `envelope.remediation.limit` (3 unless the envelope lowers it).
- Anything beyond requires a recorded `RemediationBudgetGrant` (human-only, linked to a suspension). Neither policy nor envelope nor amendment can create or imply one; amendments only carry consumption forward.
- Consumption is tracked per `(executionId, taskId)` across all envelope lineages; every attempt record stores the `authorizationId`/`lineageId` that dispatched it, so the budget is also reportable per envelope. Re-issuing or superseding an envelope never resets consumption.

## 6. Revocation, expiry, staleness and pending actions (FR-089)

`revokeEnvelope(decisionId, actor, pendingDisposition)` MUST carry `pendingDisposition ∈ {HOLD, ABANDON}`:
- `HOLD` (default): the pending action stays in the checkpoint but is **not submittable**; `next` returns the suspension instead of the pending action; `submit` is refused (below).
- `ABANDON`: the pending action is closed (`PENDING_ABANDONED`); a remediation attempt becomes `UNSUCCESSFUL(ABANDONED_BY_HUMAN)` (already counted).
Expiry and `SUSPENDED_STALE` are always `HOLD`.

A `submit` for a pending action while the envelope is not `ACTIVE` is processed at evaluation step 5 (controller §2), **before** the pending-action step: it is refused, **not applied**, no validators/review run, no counter changes; a `SUBMISSION_REFUSED{stepId, resultDigest, reason}` event is recorded (digest only; the host keeps the payload). Re-authorisation path: `amendEnvelope` (for expired/stale) or `issueEnvelope` with `resumesFrom` (for revoked) producing a new `ACTIVE` envelope that still authorises the task with matching pins and baseline; then the **same `step_id`** may be submitted again and is validated normally against the actual workspace and baseline chain. If the task is no longer authorised or pins differ, the pending action is closed by the human (`abandonPendingAction`).

## 7. Invalidation matrix (FR-061..064, FR-085, FR-086)

| Changed artifact | Effect |
|---|---|
| `HarnessPolicy` (any field) | envelope → `SUSPENDED_STALE`; new revision required |
| Allowlist / a used `ValidatorDefinition` | same |
| Envelope edited out-of-band (digest mismatch) | `FAIL_CLOSED(ENVELOPE_TAMPERED)` |
| `tasks.md`: checkbox state only | **no effect** (not part of any pin) |
| `tasks.md`: structural change to an authorised, not-accepted task (text, acceptance criteria, deps, gates, markers) | that task ineligible (`DEFINITION_CHANGED`) until amended |
| `tasks.md`: structural change to a task in an authorised task's dependency closure | dependents ineligible (`DEPENDENCY_DEFINITION_CHANGED`) until amended |
| `tasks.md`: structural change to an **accepted** task | stays accepted, flagged `UPSTREAM_CHANGED`; dependents blocked until `UpstreamAcknowledgement` |
| `tasks.md`: change to unrelated tasks or prose | no effect (reported as `GRAPH_CHANGED_OUTSIDE_SCOPE` informational) |
| Parser version change | `PARSER_VERSION_CHANGED` ⇒ `SUSPENDED_STALE` (re-pin) |
| Pinned spec/contract artifact | `SUSPENDED_STALE` naming it |
| Approved dirty-baseline file changes or new dirty file | `BASELINE_DRIFT` |
| Subject snapshot changes | results for the old snapshot logically invalid (`INVALIDATED` event) |

## 8. Status exposure

`status` returns: envelope digest/revision/status, policy digest and path, per-task state, remaining budget per task (initial + grants), cycle step, last decision, and the **enforcement table** (E1/E2/E3 per rule), `actor.authenticated:false`, `network:"not-enforced"`, `filesystem:"cwd-confinement-only"`, "operations outside the workspace are unobserved unless reported by the host".

## 9. Rejection cases (test list for H1)

widening beyond policy · task not in graph · protected/mandatory path in `allowedPaths` · `limit > 3` · `Actor.kind ≠ HUMAN` · expired on issue · second ACTIVE envelope · weaker recurrence (`RECURRENCE_WEAKER_THAN_POLICY`) · dirty tree without approval (`BASELINE_NOT_CLEAN`) · policy file untracked/modified (`POLICY_NOT_COMMITTED`) · digest mismatch on load · attempt to enable a non-authorisable operation · amendment carrying grant fields · `win32` · raw-bytes pin of `tasks.md` rejected as malformed.
