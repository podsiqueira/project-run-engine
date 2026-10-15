# Contract: Evidence Ledger and Additive Checkpoint Evolution (H6)

Drives FR-051..FR-060, FR-073..FR-078, D-05, D-09.

## 1. Where things live

| Thing | Location | Authority for |
|---|---|---|
| Position, counters, envelope reference, chain head, `events[]` (scalars + references) | `harness` block inside the existing checkpoint (`.project-run/runs/<id>.json`) | state and decisions |
| Diffs, logs, review payloads | `.project-run/evidence/<executionId>/<taskId>/<cycleId>/<sha256>` (content-addressed, write-once) | *content* whose sha-256 the checkpoint records |
| Tripwire manifest | `.project-run/evidence/<executionId>/MANIFEST.json` `{ lastSeq, lastRevision, headHash, schemaVersion }` | detecting engines that dropped the block |
| Policy | tracked file `.project-run/harness/policy.json` (digest-pinned) | see `authorization-envelope.md` §1 |
| Envelope | inside the `harness` block | see `authorization-envelope.md` §2 |

There is no second ledger file. The manifest is derived and checkable; if it disagrees with the checkpoint the result is `HARNESS_STATE_DIVERGED`, not a silent repair.

## 2. Checkpoint addition (all optional; `version` stays 1)

```ts
interface PersistedExecutionState { /* …existing… */ harness?: HarnessState }
interface HarnessState {
  schema_version: 1; min_engine_version: string; adopted_at_revision: number;
  envelope: PhaseAuthorizationEnvelope;               // current; superseded revisions are kept in events
  dirtyBaselineApproval?: DirtyBaselineApproval;        // only with an approved dirty baseline (FR-083)
  suspension?: HarnessSuspension;                       // the active suspension (row T9), also when no cycle exists (PHASE_END, GRAPH_INVALID, ENVELOPE_*)
  cycle?: { cycleId: string; taskId: string; step: HarnessStep; baselineSnapshotId: string; baselineTreeDigest: string; subjectSnapshotId?: string;
            attempt: number; pendingKind?: "IMPLEMENT" | "REMEDIATE" | "REVIEW"; startedAt: string;
            heldAction?: PersistedPendingAction; rejections?: number };   // heldAction: see harness-controller §2a
  tasks: Record<string, { state: TaskHarnessState; acceptedEventSeq?: number; flags: ("UPSTREAM_CHANGED"|"RECONCILIATION")[] }>;
  budgets: Record<string /* taskId (execution-wide, FR-091) */, RemediationBudget>;
  latest: { validators?: ValidatorResult[]; review?: ReviewSummary };    // derived; MAY be overwritten
  events: HarnessEvent[];                                             // append-only
  chain: { seq: number; hash: string };
}
type HarnessStep = "IMPLEMENTATION_PENDING" | "VERIFICATION_PENDING" | "REVIEW_PENDING"
                 | "FINDINGS_EVALUATION" | "REMEDIATION_PENDING" | "SUSPENDED";   // at-rest steps only; TASK_ELIGIBILITY_CHECK and TASK_ACCEPTED are transient (row T0 = no cycle)
// Permitted combinations with the engine fields: harness-controller.md §3a (rows T0–T9, including crash windows); anything not a row ⇒ STATE_INCOHERENT.
```
**Writing the block (revision 3, replaces the earlier "carry on the context" design).** The block is written **only** by `Coordinator.commit` (harness-controller.md §8), which starts from the persisted record, so every existing and unknown field survives and no field is added to `CoordinatorExecutionContext`/`CoordinatorOptions`. The Harness never uses the legacy write paths; entry points that load the record refuse a Harness execution (FR-097), and a hand-built Coordinator that rewrites the record is detected by the manifest tripwire (FR-076). A test (PT-01) injects the block and proves: the guarded entry points refuse without writing and an unguarded legacy rewrite is detected as `HARNESS_STATE_DIVERGED`; `commit` preserves unknown fields and appends logs; non-Harness executions never gain a `harness` key.

**Size and payload discipline (FR-102)**: `pending_action.request.context` ≤ 8 KiB and each event `data` ≤ 4 KiB, references and digests only; the block lives outside `context` because `scrubSecrets` redacts keys matching `password|secret|token|api key|auth|bearer|private key` there (e.g. `authorizationId`, `authenticated`). The engine does not sanitise `pending_action`; the guarantee is by construction and by test (SC-014).

**Host-supplied results (revision 4, OD-15 approved)**: validated against a closed schema with explicit limits before any `commit` (`contracts/result-validation.md`); for Harness executions the `step_log` copy of each finding is the compact form (`id`, `severity`, `category`, `blocking`, `fingerprint`, `evidenceRef`, ≤ 512 B) and full text lives only in `last_result` and evidence files.

**Time**: audit timestamps come from events; checkpoint `created_at` is rewritten on every save and is never used (FR-108).

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
`PENDING_ABANDONED|EXTENDED|HELD`, `SUBMISSION_REFUSED{stepId,resultDigest,reason}`, `BASELINE_APPROVED|DRIFT`, `ANSWER_RECORDED{questionIds}`, `VALIDATOR_RUN_STARTED|INTERRUPTED{runId}`, `STATE_INCOHERENT_REPORTED` (only via `reconcileCycle`), `CYCLE_RECONCILED`, `INVALIDATED{ofEventSeq, by}`, `TASK_ACCEPTED`, `SUSPENDED{reason}`, `RESUMED`, `ADOPTED`.
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

## 7. Compatibility rules (FR-073..078, FR-105)

**Exported-type delta (complete)**: `PersistedExecutionState.harness?: unknown` and one `@internal Coordinator.commit`; nothing else (harness-controller.md §8). Verified by a type-surface test (PT-16).

1. Optional field; absent ⇒ legacy execution; all existing readers ignore it; `CURRENT_STATE_SCHEMA_VERSION` stays 1 (a separate `harness.schema_version` evolves independently; `STATE_VERSION_UNSUPPORTED` analogue for harness: `HARNESS_SCHEMA_UNSUPPORTED`).
2. No read path writes. `status` and `next-step` on a legacy checkpoint do not add a Harness block.
3. Adoption (`adoptExecution`, human-only, FR-075): accepted only from `(IMPLEMENT, AWAITING_AGENT_ACTION, engine pending IMPLEMENT)`, `(IMPLEMENT, IN_PROGRESS, none)` or `(HUMAN_INTERVENTION_REQUIRED, suspended_from = IMPLEMENT)`; one `commit` (W0) creates the `harness` block, records `adopted_at_revision`, closes an engine-created pending action with a digest-only event, and leaves row T0; no history back-fill; any other tuple ⇒ `ADOPTION_STATE_UNSUPPORTED`; starting a new execution directly under the Harness from `INTAKE` is not supported.
4. Mixed-version (the Harness block carries a tripwire; no mitigation is technically preventive, FR-079): an older engine saving the file drops `harness`; the next Harness-aware load sees a MANIFEST with no block ⇒ `HARNESS_STATE_DIVERGED` ⇒ no progress; recovery is a human operation (restore the checkpoint from backup or declare the execution non-Harness). Older engines are otherwise unsupported for such executions (already unsupported per backlog).
5. Size: `events[]` grows with use; a compaction/rotation policy is **out of scope** (risk R-6); the spec requires events to stay payload-free so growth is bounded by event count, not content.
6. Legacy test: a golden set of v0.4.0/v0.5.0 checkpoints (including a Phase-5 one with history, and a pre-Phase-5 one) MUST load and resume byte-identically with the Harness code present.

## 8. Retention and secrets

See D-05 and FR-054..058. Additional rule: logs given to the reviewer or any host come only from `REDACTED|CLEAN_SCANNED` evidence; `QUARANTINED` never leaves the evidence store through the Harness.

## 9. Status output (FR-060)

Provided by the **internal** function `harnessStatus`; the public `statusProjectRun`/`ProjectRunHostResponse` are unchanged.

`status` MUST expose: `harness.enabled`, envelope digest/status, cycle step, task states, budgets, chain head, last suspension, and `diverged: boolean`.

## 10. Test list (H6)

legacy load/resume identical · no write on read · adoption CAS · legacy write paths refuse a Harness execution without writing · `commit` preserves unknown fields and appends logs · request/event size and content discipline · chain verify and tamper detection · truncation detection · evidence digest mismatch · missing file · quarantine not delivered · reconstruction function · old-engine drop ⇒ DIVERGED · event payload-free lint · size bound of a 3-task fixture.
