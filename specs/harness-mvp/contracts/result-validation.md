# Contract: Validation of Host-Supplied Results (OD-15)

**Status: architecture APPROVED 2026-10-15 (OD-15); structural-rejection semantics APPROVED 2026-10-15 (OD-16, Option A); the numeric limits of §5 are PROVISIONAL INITIAL SPECIFICATION LIMITS, not empirically validated production limits.** This is a *specification* approval, not an implementation authorisation (implementation is covered only by the Gate B authorisation of 2026-10-15: isolated vertical slice). Written in revision 4; drives FR-109…FR-114, SC-015, SC-016, AS-119…AS-129, T060…T065.
**Scope**: Harness executions only. Non-Harness executions keep v0.5.0 behaviour byte-for-byte (FR-113).

## 1. Problem (evidence)

The engine validates only `AgentResult.execution_id` on submit (`project-run-step.ts:522–529`) and then persists the whole result: `last_result` (`coordinator.ts:227`) and, in `step_log`, a copy of every finding (`coordinator.ts:367`, `appendStepRecord`). `AgentResult.evidence` is `unknown[]`, findings are `(StructuredFinding | unknown)[]` and `StructuredFinding` has an index signature (`domain/types.ts`). The 8 KiB (`pending_action.request.context`) and 4 KiB (event `data`) limits of FR-102 constrain only Harness-built objects, so a host result is unbounded and unvalidated. This contract adds a validation layer that runs **before any durable state change** and is **specific to Harness executions**.

## 2. Pipeline position

In `contracts/harness-controller.md` §6.2 the order is: engine identity checks (`NO_PENDING_ACTION`, `STALE_STEP`, `execution_id`, all zero-write today) → evaluation steps 0–8 (envelope, pins, pending action) → **result validation (this contract, class A)** → Harness semantic checks (class B: snapshot echo, reviewer independence, criteria/file coverage, diff inspection) → `commit`. A result is **never** applied, never passed to `applyExternalResult`, and never stored until every class-A and class-B check has passed.

## 3. Rejection classes and effects

| Class | Reasons (`failureReason` prefix) | Durable effect | Counts toward `maxSubmissionRejections`? |
|---|---|---|---|
| **A: structural** | `RESULT_REJECTED_TOO_LARGE`, `RESULT_REJECTED_MALFORMED`, `RESULT_REJECTED_EVIDENCE` | **none**: no `commit`, no event, no counter, no evidence file, no revision change; the pending action and its `requested_at` stay as they were | **No** |
| **B: semantic** | `STALE_SNAPSHOT`, `REVIEW_INCOMPLETE`, `REVIEW_NOT_INDEPENDENT`, `RESULT_MISMATCH`, … (review-contract §3) | as FR-068: `RESULT_REJECTED` event, rejection counter; second rejection ⇒ `RESULT_INVALID` suspension | Yes (OD-16 Option A: unchanged FR-068, durable) |

Precedent in the existing engine: `INVALID_RESULT` (execution_id mismatch, `project-run-step.ts:522`) and `INVALID_HUMAN_ANSWERS` are already zero-write, non-terminal rejections that name a code in `failureReason` and leave the execution untouched. Class A follows that pattern and adds no member to the exported `ExecutionFailureCode` union (codes travel in `failureReason` text, FR-105).

**Response**: the existing non-terminal failed-step response with `failureReason = "<CODE>: <bounded diagnostic>"`; terminal=false; `state` = the persisted state. Diagnostics follow the `INVALID_HUMAN_ANSWERS` discipline: at most 20 issues, ids clipped to 64 characters with control characters neutralised, **never echoing payload text**, reporting the *path* of the offending field and the limit that was exceeded.

**Recovery path (precise)**:
1. The execution is unchanged and still `AWAITING_AGENT_ACTION` with the same `step_id` (rows T2/T5/T8 of the projection table; the tuple is a row before and after).
2. The host fixes the result and resubmits for the **same `step_id`**; a corrected result is accepted exactly once (the existing guards then reject any further submission: `STALE_STEP` if another action is pending, `NO_PENDING_ACTION` if none is).
3. If the host never produces a valid result, `dispatchTtlMs` (counted from the pending action's `requested_at`, which class A does not move) ends in the existing `DISPATCH_TIMEOUT` suspension (controller §2 step 7); the human then uses `abandonPendingAction` / `extendPendingAction` (§7). A remediation attempt was already counted at dispatch and is **not** counted again by any class-A rejection (remediation-budget §4).
4. Nothing is written for class A, so there is no durable "rejection history" to recover; the host response and the host's own logs are the only record. **Observability trade-off (accepted by OD-16 Option A):** repeated structural rejections cannot be counted, audited or alerted on from the checkpoint; they are bounded only by `dispatchTtlMs`, and a hostile or buggy host can retry until the TTL at the cost of read-only validation work (bounded by §7). If this proves insufficient in practice, a digest-only audit event can be proposed later as a separate decision; it is **not** part of this specification.

## 4. Closed schema (`harness-result/v1`)

Plain JSON values only: object, array, string, finite number, boolean, null. Rejected as `RESULT_REJECTED_MALFORMED`: `undefined` inside arrays or as a value, functions, symbols, `BigInt`, `NaN`/`±Infinity`, `Date` and other class instances, circular references, getters that throw, keys `__proto__`, `constructor`, `prototype`, and duplicate keys after JSON round-trip.

**Top level (`AgentResult`)** — allowed keys only: `execution_id`, `agent`, `state`, `status`, `evidence`, `findings`, `metadata`, `execution_metadata`. `status` ∈ `PASS | FINDINGS | FAIL | BLOCKED`. `agent`, `state` must equal the pending action's role/state. Any other key ⇒ malformed (Harness executions only; the engine's own type is open).
**`evidence`**: array of `EvidenceReference` objects (`ref`, `sha256`, `bytes`, `mediaType`, `redactionStatus`, `truncated`, `createdAt`); **no inline evidence items** (strings, free objects) for Harness executions.
**`findings`**: array of `HarnessFinding`-shaped objects with the closed key set of review-contract §4 (`id`, `severity`, `category`, `location{file,line,column}`, `status`, `blocking`, `description`, `impact`, `recommendation`, `violatedCriterion`, `violatedContract`, `ruleKey`, `evidenceRefs[]`, `snapshotId`, `preExisting`, `source`); `id` unique within the result; `severity` in the existing vocabulary.
**`execution_metadata`**: allowed only with the same five scalar keys; it MUST NOT contain `harness` and, if present together with `metadata`, a scalar key present in both must hold the same value (in push mode `executeWithHostGuards` merges both objects, `host-execution-contract.ts:250–262`; pull mode never merges, so the schema must not leave room for two diverging copies).
**`metadata`**: `HostExecutionMetadata` scalars only (`runtime`, `lifecycle_status`, `duration_ms`, `started_at`, `completed_at`) plus the single object key `harness`; no other keys.
**`metadata.harness`** (`HarnessResultPayload`): `schema: "harness-result/v1"`, `kind: "IMPLEMENT"|"REMEDIATE"|"REVIEW"` (must equal the pending kind), `invocationId` (string ≤ 128, charset `[A-Za-z0-9._:-]`), `snapshotId`/`diffDigest` (hex sha-256, required for `REVIEW`), `filesChanged[]` (workspace-relative paths validated by `path-matching.md` §2, ≤ 256 entries, claims only), `operations[]` (closed enum of declarable operations, ≤ 16), `criteria[]` and `fileDispositions[]` **inline only when within the limits below, otherwise as references** (`criteriaRef`, `fileDispositionsRef`: `EvidenceReference` to a file validated by §6), `summary` (string ≤ 1 KiB, informational, never an authority).

## 5. Limits (provisional initial specification limits; separate from the 8 KiB / 4 KiB limits)

Policy fields `limits.result.*` (new, in `HarnessPolicy`); the envelope may only **lower** them; the hard ceilings below are fixed by this specification. All sizes are **UTF-8 bytes** of the canonical JSON (keys sorted), measured with an aborting counter (§7), never character counts.

| Limit | Default | Hard ceiling | Justification |
|---|---|---|---|
| `maxResultBytes` (whole `AgentResult`) | 65 536 | 262 144 | H0 measured a 169 KB checkpoint after 76 agent steps and 83 decisions (≈ 2.2 KB per step including everything); 64 KiB is ≈ 30× a typical step, yet only one `last_result` is held at a time, so the checkpoint grows by at most this once, not per step |
| `maxStringBytes` (any string value) | 1 024 | 4 096 | the longest finding text seen in H0 was ≈ 0.6 KB; anything longer is bulk content that belongs in an evidence file |
| `maxFindings` | 32 | 128 | a review that needs more is split by severity or reported by reference |
| `maxFindingBytes` (one finding, serialized) | 2 048 | 8 192 | 32 × 2 KiB = 64 KiB = `maxResultBytes`: the findings cap and the total cap agree |
| `maxEvidenceRefs` (per result and per finding) | 16 | 64 | reference objects are ≈ 300 bytes; 16 × 0.3 KB ≪ total cap |
| `maxMetadataHarnessBytes` | 16 384 | 65 536 | inline criteria/dispositions beyond this must be a reference |
| `maxMetadataOtherBytes` | 1 024 | 4 096 | only the five scalar keys are allowed |
| `maxDepth` | 6 | 8 | the schema nests at most `finding.location` and `evidenceRefs[]` |
| `maxKeysPerObject` | 64 | 128 | closed schemas have fewer than 20 keys |
| `maxEvidenceFileBytes` (each referenced file, §6) | 1 048 576 | 8 388 608 | review detail and file dispositions for a large delta (≈ 1 000 files × 200 B) |
| `maxTotalEvidenceBytes` (sum of all referenced files in one result, hashed under the execution lock) | 4 194 304 | 33 554 304 | bounds submission-time I/O: with per-file and per-result reference limits alone the worst case would be 64 × 8 MiB = 512 MiB read and hashed while holding the lock |
| `maxFilesChanged` / `maxOperations` | 256 / 16 | 1 024 / 32 | claims only; the real delta is computed by the engine |

These numbers are **provisional initial specification limits**: explicit and testable (each is a policy field with a hard ceiling, and each has a boundary test), derived from the stated justifications, and **not empirically validated production limits**. T065 records the observed maxima on the Gate B fixture and the limits are confirmed or amended by a later, explicit specification change. They are deliberately not derived from, and not constrained by, the 8 KiB (request context) and 4 KiB (event data) limits; result, request-context, event, per-file and aggregate-evidence limits remain five separate limits.

## 6. Evidence-reference verification at submission (class A, `RESULT_REJECTED_EVIDENCE`)

For every `EvidenceReference` in `evidence`, `findings[].evidenceRefs`, and `metadata.harness`: `ref` is a relative path that passes `path-matching.md` §2 and resolves **inside** `.project-run/evidence/<executionId>/` (no traversal, no absolute path, no symlink in any component); the file exists, is a regular file, `bytes` ≤ `maxEvidenceFileBytes` and equals the actual size (the running sum over the result ≤ `maxTotalEvidenceBytes`, checked from the declared `bytes` **before** any file is read), the re-computed sha-256 equals `sha256`, `mediaType` ∈ the policy allowlist, `redactionStatus` ∈ {`REDACTED`, `CLEAN_SCANNED`} (a `QUARANTINED` reference is never accepted from a host); a required evidence kind that is **missing** (for `REVIEW`: diff reference, criteria coverage; for `IMPLEMENT`/`REMEDIATE`: none required beyond declared references) is also `RESULT_REJECTED_EVIDENCE`. Files referenced by `criteriaRef`/`fileDispositionsRef` are additionally parsed against their own closed schema under the same limits. Verification is read-only: it creates no file and writes no event. It is a point-in-time check: evidence files are re-hashed again before acceptance (`EVIDENCE_MISSING`, row R17), because a file can change after submission.

## 7. Bounded measurement (part of FR-109)

1. Measure size with a **counting serializer that aborts at `limit + 1` bytes**, so an arbitrarily large in-process object is rejected after reading at most `limit + 1` bytes, before any deep traversal or evidence I/O.
2. Traverse with an explicit stack (no recursion), enforcing depth, key-count and array-length limits as it goes; never use `eval`, dynamic `RegExp` from submitted text, or `JSON.parse` of unbounded strings.
3. Only after structure passes, scan string values against the policy's redaction patterns; a match ⇒ `RESULT_REJECTED_MALFORMED` (reason `SECRET_PATTERN`, field path only, never the text). Patterns are best-effort (R-28).
4. Order inside class A: size → structure/types → schema keys → string limits and secret patterns → evidence references (the only step that does I/O).

## 8. Harness-only isolation (FR-113, SC-016)

The validator is reachable only from the Harness controller after a Harness execution has been identified (FR-096). It is not called from `submitProjectRunStepUnlocked`'s legacy path, `applyExternalResult`, `Coordinator.step/run`, or any push entry point. Tests prove that the same oversized, malformed and evidence-less results submitted to a **non-Harness** execution are accepted and persisted exactly as in v0.5.0, with the validator spy at zero calls.

## 9. Interplay with other contracts (conflicts surfaced, not silently resolved)

- **CF-1 (conflict with FR-068 / controller R5) — RESOLVED 2026-10-15 by OD-16, Option A**: revision 3 counted *every* Harness-level rejection (`RESULT_REJECTED` event, rejection counter, suspension on the second), which contradicted "rejection must not mutate durable Harness state". Decision: class A is zero-write and uncounted (never a durable event or counter, never `applyExternalResult`); class B keeps FR-068 unchanged with its durable event and counter. Options B (digest-only event for class A) and C (drop counting) were **not** chosen.
- **CF-2 (clarification)**: the digest-only `SUBMISSION_REFUSED` event for an invalid envelope (FR-089) is written at evaluation step 6, *before* result validation; it is outside OD-15's scope and unchanged.
- **CF-3 (clarification)**: the `step_log` findings copy for Harness executions is compacted to ≤ 512 B per finding (FR-111) so that the new result limits do not multiply into permanent checkpoint growth; non-Harness `step_log` is unchanged.

## 10. Tests (T060…T065)

Boundary: every limit exactly at its default passes (including a multi-byte UTF-8 string whose **byte** length equals the limit while its character count is smaller) and at `limit + 1` fails; depth 6/7; 64/65 keys; 16/17 refs; 32/33 findings.
Negative structure: unknown key at each level, missing required key, wrong type, wrong `schema`/`kind`, wrong `invocationId` charset, duplicate finding ids, `__proto__`/`constructor`/`prototype` keys, `undefined`/function/symbol/BigInt/NaN/Infinity/Date/circular values, a throwing getter, inline evidence items, secret-pattern strings.
Evidence: absent required reference, nonexistent file, digest mismatch, wrong `bytes`, path outside the evidence root, traversal, absolute path, symlinked component, oversize file, disallowed media type, `QUARANTINED`, over-limit file contents, referenced JSON failing its own schema.
Zero-write proof for **every** class-A case: checkpoint bytes, revision, `events[]`, counters, pending action, `requested_at`, evidence directory listing, `step_log`, `history`, `human_answers` identical before/after; `commit` and `applyExternalResult` spies at zero.
Recovery: corrected resubmission accepted once for the same `step_id`; repeated class-A rejection until TTL ⇒ `DISPATCH_TIMEOUT`; `abandonPendingAction` after class-A rejections; class A never touches `maxSubmissionRejections`.
Diagnostics: bounded, non-echoing. Cost: the counting serializer aborts at `limit + 1` (spy on bytes read). Isolation: same inputs on a non-Harness execution behave as v0.5.0.
