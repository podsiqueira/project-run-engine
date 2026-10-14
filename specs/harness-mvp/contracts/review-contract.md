# Contract: Independent Reviewer and Structured Findings (H4)

Drives FR-037..FR-040, FR-047..FR-049, D-12, D-13, D-14. Contract id: `harness-review/v1`.

## 1. Separation (what is and is not guaranteed)

Guaranteed by the engine: a **new pending action** (own `step_id`) with role `INDEPENDENT_REVIEW`, own `reviewInvocationId`,
a request built only by the engine from verified inputs, no implementer conversation/narrative/verdict, bound to an exact
diff. Required reviewer skills resolve through the existing skill mechanism.
Not guaranteed (NG-6): process/model isolation, absence of shared hidden state, reviewer honesty. Recorded as
`isolationEvidence: "DISTINCT_INVOCATION_ATTESTED" | "NONE"`.

## 2. `ReviewRequest` (engine → host)

```ts
interface ReviewRequest {
  contract: "harness-review/v1";
  reviewInvocationId: string;           // fresh; MUST differ from every implementation/remediation invocation id of the cycle
  executionId: string; taskId: string; cycleId: string; attempt: number; // attempt 0 = first review, n = after remediation n
  baselineSnapshotId: string; subjectSnapshotId: string;
  diff: { digest: string; files: string[]; patchRef: EvidenceReference };
  acceptanceCriteria: { id: string; text: string }[];   // from the task definition + spec refs
  contractRefs: EvidenceReference[];                    // spec/plan/contract excerpts, pinned digests
  validatorResults: ValidatorResultSummary[];           // only engine-produced, with log refs (redacted only)
  priorFindings?: HarnessFinding[];                     // for re-review: findings to re-check, status OPEN
  sensitivePathTouches: string[];                       // forces verifierTampering disposition
  implementerSummary?: never;                           // excluded in the MVP (default) – bias control
}
```

## 3. `ReviewResult` (host → engine) and acceptance rules

```ts
interface ReviewResult {
  contract: "harness-review/v1"; reviewInvocationId: string; executionId: string; taskId: string; cycleId: string;
  snapshotId: string; diffDigest: string;
  reviewer: { identity: string; logicalVersion: string; invocationId: string };
  verdict: "PASS" | "FINDINGS" | "BLOCKED";
  criteria: { criterionId: string; verdict: "MET" | "NOT_MET" | "NOT_VERIFIABLE"; evidence: EvidenceItem[] }[];
  fileDispositions: { path: string; disposition: "REVIEWED_OK" | "FINDING" | "NOT_APPLICABLE_OPAQUE"; note?: string }[];
  verifierTampering?: { disposition: "NONE_FOUND" | "FINDING"; note: string };
  findings: HarnessFinding[];
}
```
Rejection reasons (result is **not applied**, pending action stays — FR-068): `STALE_SNAPSHOT` (snapshot/diff mismatch) ·
`REVIEW_INCOMPLETE` (missing criterion verdict or file disposition, `PASS` without evidence, `NOT_VERIFIABLE` on a required
criterion) · `REVIEW_NOT_INDEPENDENT` (reviewer invocation id equals an implementer id, or missing while required) ·
`CONTRACT_MISMATCH` · `PASS_WITH_BLOCKING_FINDINGS` · `UNKNOWN_FINDING_REFERENCE`.
A `PASS` is valid iff: all criteria `MET` with evidence, every delta file dispositioned, `verifierTampering` answered when
required, zero open blocking findings, snapshot/diff echoes match. The engine re-derives `blocking` itself (`blocking` flag from
the reviewer is advisory input: an open `CRITICAL|HIGH|MEDIUM` finding is blocking unless the existing rules in
`isFindingBlocking` say otherwise).

## 4. `HarnessFinding` (additive over `StructuredFinding`)

```ts
interface HarnessFinding extends StructuredFinding {       // id, severity, category, location, evidence, status, blocking …
  description: string; impact: string; recommendation: string;
  evidenceRefs: EvidenceReference[];                       // ≥1 required for blocking findings
  violatedCriterion?: string; violatedContract?: string;   // one of the two is required for blocking findings
  snapshotId: string; reviewer?: { identity: string; logicalVersion: string };
  fingerprint: string;                                     // engine-computed (D-13)
  preExisting?: boolean;                                   // reviewer claim, needs evidence; never lowers blocking status
  source: "REVIEW" | "VALIDATOR" | "HARNESS";              // HARNESS: result mismatch, out-of-scope, etc.
  firstSeenAttempt: number; lastSeenAttempt: number;
}
```
Severity vocabulary stays `CRITICAL|HIGH|MEDIUM|LOW|ADVISORY` (existing). Normalisation: unknown severities ⇒ `HIGH` blocking.
A blocking finding without evidence refs or without a violated criterion/contract is rejected (`REVIEW_INCOMPLETE`), not downgraded.

## 5. Findings evaluation (`FINDINGS_EVALUATION`, pure function)

Inputs: validator results, review result, budget state, policy. Output `HarnessDecision`:
1. any `CRITICAL`, `OPERATION_NOT_PERMITTED`, out-of-scope, business-ambiguity marker ⇒ `SUSPEND` (no attempt consumed);
2. `BLOCKED` verdict ⇒ `SUSPEND`;
3. blocking findings (review or validator) and budget remaining and no `NO_PROGRESS` ⇒ `REMEDIATE`;
4. blocking findings and budget exhausted ⇒ `SUSPEND(REMEDIATION_BUDGET_EXHAUSTED)`;
5. `NO_PROGRESS` ⇒ `SUSPEND(NO_PROGRESS)`;
6. no blocking findings, all validators passed, valid `PASS`, snapshots equal ⇒ `ADVANCE_TASK`;
7. any inconsistency ⇒ `FAIL_CLOSED`.
Human answers never change a finding's status to `RESOLVED`/`ACCEPTED`; a human may only record a `FindingDisposition` (accept risk) as an explicit event bound to a finding fingerprint and snapshot; it does not satisfy "no open blocking findings" for a *different* snapshot.

## 6. Re-review after remediation

Always a **new** `ReviewRequest` (new invocation id) over the new subject snapshot with `priorFindings`; results for earlier snapshots are logically invalidated.

## 7. Test list (H4)

PASS without evidence · PASS for earlier snapshot · PASS missing file disposition · reviewer id == implementer id · blocking finding without evidence · severity normalisation · CRITICAL ⇒ no remediation · fingerprint stable across rewording · NO_PROGRESS after two non-reducing attempts · human disposition does not clear a new-snapshot finding · re-review uses new invocation id · request contains no implementer summary.
