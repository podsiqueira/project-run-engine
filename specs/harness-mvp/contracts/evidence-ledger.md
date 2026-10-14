# Contract: Evidence Ledger and Additive Checkpoint Evolution (H6)

Drives FR-051..FR-060, FR-073..FR-078, D-05, D-09.

## 1. Where things live

| Thing | Location | Authority for |
|---|---|---|
| Position, counters, envelope reference, chain head, `events[]` (scalars + references) | `harness` block inside the existing checkpoint (`.project-run/runs/<id>.json`) | state and decisions |
| Diffs, logs, review payloads | `.project-run/evidence/<executionId>/<taskId>/<cycleId>/<sha256>` (content-addressed, write-once) | *content* whose sha-256 the checkpoint records |
| Tripwire manifest | `.project-run/evidence/<executionId>/MANIFEST.json` `{ lastSeq, lastRevision, headHash, schemaVersion }` | detecting engines that dropped the block |
| Envelope, policy | policy file in repo; envelope inside `harness` block | see `authorization-envelope.md` |

There is no second ledger file. The manifest is derived and checkable; if it disagrees with the checkpoint the result is `HARNESS_STATE_DIVERGED`, not a silent repair.

## 2. Checkpoint addition (all optional; `version` stays 1)

```ts
interface PersistedExecutionState { /* …existing… */ harness?: HarnessState }
interface HarnessState {
  schema_version: 1; min_engine_version: string; adopted_at_revision: number;
  envelope: PhaseAuthorizationEnvelope;               // current; superseded revisions are kept in events
  cycle?: { cycleId: string; taskId: string; step: HarnessStep; baselineSnapshotId: string; subjectSnapshotId?: string;
            attempt: number; pendingKind?: "IMPLEMENT" | "REMEDIATE" | "REVIEW"; startedAt: string };
  tasks: Record<string, { state: TaskHarnessState; acceptedEventSeq?: number; flags: ("UPSTREAM_CHANGED"|"RECONCILIATION")[] }>;
  budgets: Record<string /* lineageId|taskId */, RemediationBudget>;
  latest: { validators?: ValidatorResult[]; review?: ReviewSummary };    // derived; MAY be overwritten
  events: HarnessEvent[];                                             // append-only
  chain: { seq: number; hash: string };
}
type HarnessStep = "TASK_ELIGIBILITY_CHECK" | "IMPLEMENTATION_PENDING" | "VERIFICATION_PENDING" | "REVIEW_PENDING"
                 | "FINDINGS_EVALUATION" | "REMEDIATION_PENDING" | "TASK_ACCEPTED" | "SUSPENDED";
```
Carry-forward: the block is carried on `CoordinatorExecutionContext` exactly like `stepLog`/`history`/`humanAnswers`; a test MUST prove it survives every checkpoint path (start, next-step, submit, resume, human-answer, failure marker).

## 3. `HarnessEvent` (append-only)

```ts
interface HarnessEvent { seq: number; prevHash: string; hash: string; at: string; kind: HarnessEventKind;
  taskId?: string; cycleId?: string; stepId?: string; revision: number; actor?: Actor; data: Record<string, unknown> /* scalars + refs only */ }
```
`hash = sha256(canonical({seq, prevHash, at, kind, taskId, cycleId, stepId, revision, actor, data}))`.
Kinds: `ENVELOPE_ISSUED|AMENDED|REVOKED|STALE`, `POLICY_PINNED`, `GRAPH_BUILT`, `ELIGIBILITY_DECIDED`, `GATE_DECIDED`,
`DEPENDENCY_ATTESTED`, `UPSTREAM_ACKNOWLEDGED`, `CYCLE_STARTED`, `BASELINE_CAPTURED`, `DISPATCHED{kind,attempt,stepId}`,
`RESULT_RECEIVED`, `RESULT_REJECTED{reason}`, `DIFF_INSPECTED`, `SNAPSHOT_CAPTURED`, `VALIDATOR_RAN`, `REVIEW_REQUESTED`,
`REVIEW_RECEIVED`, `FINDINGS_EVALUATED`, `REMEDIATION_ATTEMPT_OPENED|CLOSED`, `BUDGET_GRANTED`, `FINDING_DISPOSITION`,
`PENDING_ABANDONED|EXTENDED`, `INVALIDATED{ofEventSeq, by}`, `TASK_ACCEPTED`, `SUSPENDED{reason}`, `RESUMED`, `ADOPTED`.
`data` holds only ids, digests, enums, numbers and `EvidenceReference`s — never payloads.

## 4. Append-only and honesty

- Code never rewrites or removes an existing event; "invalidated" is a *new* event (`INVALIDATED`), and `latest` is derived.
- Verification on every load: chain recomputed; mismatch ⇒ `FAIL_CLOSED(LEDGER_CHAIN_BROKEN)`.
- The spec does **not** claim immutability: anyone with filesystem access can rewrite the file *and* recompute the chain. The chain detects accidents, truncation and naïve edits only.

## 5. `EvidenceReference`

```ts
interface EvidenceReference { ref: string /* relative path under evidence root */; sha256: string; bytes: number;
  mediaType: string; redactionStatus: "REDACTED" | "CLEAN_SCANNED" | "QUARANTINED"; truncated: boolean; createdAt: string }
```
Resolution re-hashes the file; mismatch or absence ⇒ `EVIDENCE_MISSING`, which makes any decision that relied on it unsupported (acceptance blocked; suspension).

## 6. Reconstruction guarantee (FR-053)

A reader function `reconstructTask(state, taskId)` MUST return, from the block alone plus referenced files: envelope and policy revision, every `step_id` with attempt number, baseline/subject snapshots, validator results with logs, reviews and findings, remediations, and the final decision. Tested against the Gate B fixture (SC-001).

## 7. Compatibility rules (FR-073..078)

1. Optional field; absent ⇒ legacy execution; all existing readers ignore it; `CURRENT_STATE_SCHEMA_VERSION` stays 1 (a separate `harness.schema_version` evolves independently; `STATE_VERSION_UNSUPPORTED` analogue for harness: `HARNESS_SCHEMA_UNSUPPORTED`).
2. No read path writes. `status` and `next-step` on a legacy checkpoint do not add a Harness block.
3. Adoption (`adoptExecution`, human-only): requires state `HUMAN_INTERVENTION_REQUIRED` or `AWAITING_AGENT_ACTION` with no pending Harness cycle, records `adopted_at_revision`, takes a CAS save; no history back-fill (history before adoption stays as is).
4. Mixed-version: an older engine saving the file drops `harness`; the next Harness-aware load sees a MANIFEST with no block ⇒ `HARNESS_STATE_DIVERGED` ⇒ no progress; recovery is a human operation (restore the checkpoint from backup or declare the execution non-Harness). Older engines are otherwise unsupported for such executions (already unsupported per backlog).
5. Size: `events[]` grows with use; a compaction/rotation policy is **out of scope** (risk R-6); the spec requires events to stay payload-free so growth is bounded by event count, not content.
6. Legacy test: a golden set of v0.4.0/v0.5.0 checkpoints (including a Phase-5 one with history, and a pre-Phase-5 one) MUST load and resume byte-identically with the Harness code present.

## 8. Retention and secrets

See D-05 and FR-054..058. Additional rule: logs given to the reviewer or any host come only from `REDACTED|CLEAN_SCANNED` evidence; `QUARANTINED` never leaves the evidence store through the Harness.

## 9. Status output (FR-060)

`status` MUST expose: `harness.enabled`, envelope digest/status, cycle step, task states, budgets, chain head, last suspension, and `diverged: boolean`.

## 10. Test list (H6)

legacy load/resume identical · no write on read · adoption CAS · carry-forward through every checkpoint path · chain verify and tamper detection · truncation detection · evidence digest mismatch · missing file · quarantine not delivered · reconstruction function · old-engine drop ⇒ DIVERGED · event payload-free lint · size bound of a 3-task fixture.
