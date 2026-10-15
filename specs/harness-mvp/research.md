# Research & Decisions: Harness MVP

Status: DRAFT for Gate A. Each decision lists the choice, rationale, rejected alternatives, and the requirement(s) it drives.
"Owner-fixed" means the decision was given by the owner in the plan or the Phase 2 authorisation and is not re-opened here.

## A. H0 audit summary (evidence base)

Baseline: `main` @ `c1e4054` (`v0.5.0` + 1 docs commit), clean tree, typecheck OK, 37 files / 428 tests passing.

| Area | Verified in code | Partial | Not found |
|---|---|---|---|
| State machine | 13 states, transition matrix, preset-overridable `resolveTransition`/`allowedTransitions` | | |
| Pull API, pending action, `STALE_STEP` | yes | | |
| Revision / CAS / atomic write / per-execution lock | yes | single machine | distributed |
| `history`, `step_log`, `human_answers` | yes (no payloads) | | evidence/diff/log linkage |
| Findings model | `StructuredFinding`, blocking rules | | recurrence, snapshot link |
| Remediation | loop with limit | 4 dispatches, human answer replenishes | per-task budget |
| Independent review | role + state | separate step only | diff binding, evidence rules |
| Task graph / scheduler | | | not found |
| Validator executor / allowlist | | | not found (and `node:child_process` is forbidden by `package-boundary.test.ts`) |
| Stop points | | agent-driven via `BLOCKED` | engine-enforced |
| Envelope / authorisation | | | not found |

Items not verified: line-by-line read of `coordinator.ts`, `host-dispatch-adapter.ts`, `bootstrap.ts`, `doctor.ts`; the Feature 009 `execution-protocol.md`; real-host honesty of reports; `/loop` (host capability).

Simulation (scratchpad, against `dist/`): persistent blocking finding → remediation dispatched at `rem=0,1,2,3` → human intervention at `RE_REVIEW(rem=3)` = **4 dispatches**.

## B. Decisions

### D-01 Who issues / confirms the envelope — *recommended; resolves open decision 1*
**Choice**: **Both, layered.** (1) A repository-level `HarnessPolicy` (file under version control, digest-pinned) defines the *ceiling*: permitted-operation vocabulary, the validator allowlist, default limits, sensitive paths, redaction patterns. (2) Each execution needs an explicit, per-execution **human-confirmed envelope** that can only *narrow* the policy.
**Why**: policy review happens in normal code review; per-execution confirmation records who authorised which phase now.
**Rejected**: policy-only (no per-run accountability); envelope-only (allowlist would be authored per run, no review trail).
**Limit stated**: the engine cannot authenticate humans (NG-8). Protection = channel separation (agents never get these operations), digest tamper-evidence, and an audit record. A local agent with shell access could still invoke the CLI; mitigated only by host permission policy, not by the engine.
**Drives**: FR-003, FR-004, FR-008.

### D-02 Definition of "phase" — *resolves open decision 2*
**Choice**: **A phase is an envelope-scoped label plus an explicit list of authorised task ids** (`phaseId`, `authorizedTaskIds`, optional `sourcePhaseLabel` copied from the `tasks.md` heading for reference). Headings in `tasks.md` are informational and never confer authority.
**Why**: Spec Kit phase headings are prose and mutable; an explicit id list is checkable and digest-pinnable. Matches the plan's recommendation.
**Rejected**: heading-derived phases (silent scope growth when headings change).
**Drives**: FR-014, FR-063.

### D-03 Task completion and dependency satisfaction — *resolves open decision 8*
**Choice**: A task is a satisfied dependency iff the ledger has `TASK_ACCEPTED` (pins valid) or a human `DependencyAttestation`. Checkbox state is reconciled, never trusted. Mismatch in either direction ⇒ `RECONCILIATION_REQUIRED` suspension.
**Why**: Spec Kit agents tick boxes themselves, so the box proves nothing; Feature 009 shows boxes ticked in an uncommitted working tree.
**Consequence**: Tasks completed before adoption need one attestation each (or one attestation covering an explicit id list) with evidence reference.
**Drives**: FR-013, FR-017, SC-006 (no 009 coupling).

### D-04 Snapshot / diff identity — *resolves open decision 7*
**Choice**: `SnapshotIdentity = { baseCommit (HEAD sha), entries[] }`, entries sorted by path: `{path, kind: ADDED|MODIFIED|DELETED|MODE|RENAMED, mode, sha256 | tombstone}`; `snapshotId = sha256(canonical JSON)`. Built from git plumbing with structured argv (`rev-parse`, `status --porcelain=v1 -z --untracked-files=all`, `ls-files`), then hashing file bytes — works on uncommitted trees and does not require a commit.
**Cycle semantics**: `taskBaseline` snapshot taken at first dispatch of the task; the reviewed diff is `delta(taskBaseline → subject)`, written as a content-addressed artifact; `ReviewRequest` carries `baselineSnapshotId`, `subjectSnapshotId`, `diffDigest`.
**Baseline integrity (revised in revision 2)**: the earlier idea of absorbing pre-existing dirty files into the baseline is **withdrawn**: a dirty file can change validator behaviour while never appearing in the reviewed delta. Default is `CLEAN_REQUIRED` (FR-082) with a chain of custody on `treeDigest` between tasks; a dirty baseline needs an explicit, evidence-backed `DirtyBaselineApproval` that the reviewer must address (FR-083). **Ignored files** are not excluded wholesale: only policy-listed `ignoredExclusions` are, everything else is hashed (never copied) and changes are surfaced (FR-084). See D-24.
**TOCTOU**: acceptance recomputes and compares (FR-035).
**Rejected**: commit-based identity (not available pre-commit, and the Harness must not commit); mtime-based (unreliable).
**Limit**: submodules, symlink targets and files above the policy size cap are recorded as opaque (`path`, `lstat` data) and flagged; binary diffs are digest-only (reviewer sees "binary changed").
**Drives**: FR-022, FR-033..036.

### D-05 Evidence retention, log references, secrets — *resolves open decision 6*
**Choice**: local content-addressed files under `.project-run/evidence/<executionId>/<taskId>/<cycle>/<sha256>`; checkpoint stores references only. Output caps; redaction by policy patterns plus *values* of explicitly allowlisted environment variables; `redactionStatus` ∈ {`REDACTED`,`CLEAN_SCANNED`,`QUARANTINED`}. Quarantined output never leaves the machine through the Harness and is never given to a reviewer; the cycle suspends. Executor environment is minimal (`PATH`, `HOME` redirect optional, and only variables the validator declares).
**Retention**: kept until a human deletes; digests in the ledger make deletion detectable; `EVIDENCE_MISSING` blocks reliance.
**Honest limits**: redaction is pattern-based and cannot find every secret; the executor cannot stop a validator from reading files it can access.
**Drives**: FR-054..058.

### D-06 Approval invalidation on upstream change
**Choice**: pins in the envelope (policy digest, allowlist digest, per-task definition digests, pinned artifact digests). Recomputed at every boundary. Granularity table: see FR-061..064 and `contracts/authorization-envelope.md` §6.
**Why fail-closed**: a changed upstream artifact silently re-scoping an approved task is the failure the Harness exists to prevent.
**Revision 2**: `tasks.md` is pinned by canonical *structural* digests, never raw bytes (D-25), so checkbox reconciliation cannot invalidate or smuggle changes.
**Rejected**: only pin at issuance and trust afterwards; invalidating everything on any file change (too noisy: unrelated spec edits would stall runs, so only *listed* artifacts are pinned).
**Drives**: FR-008, FR-061..064.

### D-07 Remediation counting — *owner-fixed (Decision 1), details specified here*
See `contracts/remediation-budget.md`. Key points: write-ahead counting (counter increment and pending action in the same CAS save); abnormal outcomes counted per FR-044; human answers never touch the counter; grants are explicit events; independent from the engine's `remediation_iteration`.
**Existing behaviour recorded, not modified**: E-1, E-2.

### D-08 Recovery rules
Per-boundary table in `contracts/harness-controller.md` §5. Principles: (1) the checkpoint is the only authority for *position* and *counters*; (2) every durable boundary is a single CAS save; (3) anything not durable is as if it did not happen, except evidence files, which are content-addressed and therefore safely re-creatable orphans; (4) no auto-retry of a conflicting write; (5) no timeout is silently converted to a result.

### D-09 Persistence evolution — *resolves the "second source of truth" tension*
**Choice**: one new optional `harness` block **inside the existing checkpoint** (counters, cycle position, envelope reference, append-only `events[]` of scalars/references, chain head). Large artifacts live as content-addressed files; the checkpoint is authoritative for state and decisions, the files are authoritative only for *content whose digest the checkpoint records*. A manifest file in the evidence directory is a tripwire for engines that drop unknown fields (E-8).
**Rejected**: a separate sidecar ledger as source of record (two authorities, ordering hazards); inlining diffs/logs in the checkpoint (size: the Feature 009 checkpoint is already 169 KB without any payloads).
**Cost acknowledged**: `events[]` growth. Mitigation: events store only digests/ids; a compaction policy is **out of scope** and listed as a risk.
**Implementation pitfall to design for**: the coordinator re-persists only what is on the in-memory context (see `humanAnswers`/`stepLog` comments in `src/decision/types.ts`); the Harness block must be carried the same way or it will be silently dropped on the next checkpoint.

### D-10 A Harness workflow preset; no new states
**Choice**: a new preset id (working name `spec-kit-harness-v1`) that overrides `allowedTransitions`/`resolveTransition` for Harness executions only. Added edges (new, additive, preset-local):
`INDEPENDENT_REVIEW|RE_REVIEW → IMPLEMENT` (task accepted, next task), `IMPLEMENT → REMEDIATION` and `REMEDIATION → REMEDIATION` (validator failure routes to remediation without a review), plus Harness-level `HUMAN_INTERVENTION_REQUIRED` entries as today. No `CoordinatorState` is added. The default preset and `MAX_REMEDIATION_ITERATIONS` are untouched.
**Why demonstrated need**: the matrix has no edge back to `IMPLEMENT`, so a per-task loop is impossible without it (E-3).
**Rejected**: new states (public type change, breaks consumer exhaustiveness fixtures such as `must-not-compile-switch.ts`); a controller-owned parallel loop (a second state machine).

### D-11 Validator and snapshot execution port; boundary amendment — **needs owner approval (OD-1)**
**Problem**: executing validators and computing snapshots needs `node:child_process`, and hashing (snapshot ids, digests, event chain) needs `node:crypto`; `package-boundary.test.ts` allows only `node:fs`/`node:path` in `src/`.
**Choice (recommended)**: define `ValidatorExecutor` and `SnapshotProvider` as **ports** in the core (types only) and ship the Node implementation in a **separate, explicitly-scoped module** (`src/harness/node/…`, **internal only, no subpath export** unless separately approved) whose allowed imports are enumerated in an amended boundary test. The amendment is narrow and test-enforced: `node:crypto` (pure, side-effect free) becomes allowed in core; `node:child_process` is allowed only under `src/harness/node/`; core stays free of process spawning. The controller refuses to start without both ports injected (fail closed).
**Rejected**: (a) host executes validators and reports (violates FR-024: results would be assertions); (b) relaxing the boundary globally.

### D-12 Critical findings — *resolves open decision 4*
`CRITICAL` ⇒ immediate suspension, never automatic remediation, no attempt consumed (FR-048).

### D-13 Recurrence / no progress (precise in revision 2)
Defined exactly in `contracts/remediation-budget.md` §6: versioned fingerprint (category | file | criterion | ruleKey, no line numbers, no severity), blocking *set* per attempt, progress iff **proper subset** of the previous set, streak counter, default streak 2. The policy value is a **floor** that an envelope cannot weaken (FR-092). Fingerprints remain heuristic and the contract requires reviewers to supply stable `ruleKey`s.

### D-14 Reviewer independence claim
Guaranteed: separate step, separate `reviewInvocationId`, no implementer narrative, own contract, bound to exact diff, `isolationEvidence` recorded. Not guaranteed: process/model isolation or absence of shared hidden state. Host that cannot supply a distinct invocation identity ⇒ policy `requireDistinctInvocationId` (default true) rejects its reviews.

### D-15 Public API compatibility — *resolves open decision 9 (tightened in revision 2)*
Contracts remain **internal** (`src/harness/`). The **Gate B slice adds no exports at all**: no root export, no new `exports` subpath, no new `bin`/CLI subcommand, no new public types; `package.json` `exports`/`bin`/`files` stay byte-identical (tested, SC-011). Human-only operations are internal functions at Gate B. Exposure to hosts or the CLI is a separate approval at Gate C; a public/subpath API, if ever wanted, is a separate approval after Gate D with `public-api-surface` and consumer-type fixtures extended first.

### D-16 Time / cost limits
Enforceable now: `timeout_ms` per dispatch (existing option), validator timeouts, `dispatchTtlMs`, `maxTaskElapsedMs` (checked at boundaries, not preemptive). Not enforceable: tokens/cost — declared `unsupported` (FR-009).

### D-17 Gates and stop points
Stop points are controller-enforced and recorded as `GateDecision` (human-only, bound to task id + definition digest). The Feature 009 style "agent returns BLOCKED at a stop point" remains legal but is not relied upon.

### D-18 Feature 009
Excluded from fixtures, pilot and tests; H0 inconsistencies carried as risk R-8 until a separate authorisation (Gate D).

### D-19 Existing remediation behaviour
Documented as E-1/E-2; the Harness preset ignores the engine's remediation counter and uses its own; non-Harness executions are untouched.

### D-20 Validator failure vs. error
`FAILED` is routed to remediation as a synthetic `source: VALIDATOR` finding (so it consumes budget like any defect); `ERROR` suspends (environmental, not agent-fixable); flaky validators are not retried automatically (a retry would be an unrecorded second run).

### D-21 Task source and dependency syntax
Parse Spec Kit task lines `- [ ] T### [P]? [US#]? description`, `DEPENDS ON T###(, T###)*` clauses and gate markers present in the consumer's existing tasks (e.g. `OWNER GATE`). Anything not matched is ignored and surfaced in a `GraphParseReport` (never guessed). Format drift ⇒ `GRAPH_INVALID`.

### D-22 Human-only operations
`issueEnvelope`, `amendEnvelope`, `revokeEnvelope`, `adoptExecution`, `recordGateDecision`, `attestDependency`, `acknowledgeUpstreamChange`, `grantRemediationBudget`, `abandonPendingAction`, `extendPendingAction`, `resumeSuspension`, `reconcileCycle`, `approveDirtyBaseline`. All take an `actor`, are idempotent on a client-supplied `decisionId`, are recorded as ledger events, and are not exposed through the agent-facing step API.

## C. Rejected global alternatives

- **Adopt an external agent framework / SDK**: violates NG-3.
- **Make the Harness a host-side skill only** (instructions to the agent): this is today's weakness (E-4, E-5).
- **Put task cycles in a second state machine**: duplicates authority (see D-10).

## D. Decisions added in revision 2 (correction pass)

### D-23 Logical enforcement vs technical prevention
Every rule carries an enforcement class: **E1** engine-refused, **E2** detected after the fact, **E3** not enforced unless host/environment does (FR-079). Text must not say "prevented" for E2/E3. `OPERATION_NOT_PERMITTED` requires visible evidence (FR-080). Human-only operations are logically separated, not authenticated (NG-8). Validators have no network or filesystem isolation (E3). Fixture hygiene: no unnecessary secrets or credentials for agent/validator processes, canary-tested (FR-081, SC-008).
**Why**: an honest security model is the precondition for relying on any other guarantee. **Rejected**: describing the allowlist or the "prohibited operations" list as sandboxing.

### D-24 Baseline integrity and ignored files
Clean tree required at issuance; chain of custody on `treeDigest`; dirty baseline only by evidence-backed approval; ignored files hashed unless explicitly excluded; validator side effects on ignored files are reported, not treated as drift (FR-082..084, verification-pipeline §6).
**Consequence for sequential tasks**: uncommitted accepted work from task *n* is a legitimate baseline for task *n+1* only through the chain-of-custody rule; any out-of-band change is `BASELINE_DRIFT`.
**Feature 009**: its dirty tree is never a baseline or fixture.

### D-25 Structural pinning of `tasks.md`
Canonical per-task records (text, acceptance text, sorted deps/gates/markers), `parserVersion`, dependency-closure digests; checkbox state, headings, ordering and unrelated prose excluded. Resolves the whole-file vs per-task conflict: there is **no whole-file digest**. A `tasks.md` diff is acceptable only if no structural digest changed and only the own checkbox toggled (FR-085, FR-086).

### D-26 One source of truth: `HarnessStep` as refinement
The embedded step refines the engine's `state`/`lifecycle_status`/`pending_action`; the allowed combinations form a closed projection table; anything else fails closed; recovery only by the human `reconcileCycle` (to `SUSPENDED`) (FR-087, FR-088, controller §3a). `TASK_ACCEPTED` is a transient event, not a resting step. A held pending action lives in `harness.cycle.heldAction` because the engine clears `pending_action` on non-awaiting checkpoints.

### D-27 Pending action vs envelope validity
Evaluation step 6 (envelope validity) precedes step 7 (pending action); a submission against a non-valid envelope is refused and not applied, the action is held or abandoned (revocation chooses), and the same `step_id` becomes valid again only after re-authorisation (FR-089, controller §2a).

### D-28 Policy location and limit relations
Policy at `.project-run/harness/policy.json`: tracked, next to the already-tracked `.project-run/config.json`, separate from the ignored mutable dirs `runs/` and `evidence/`; must be committed and unmodified at issuance; mandatory protected set built into the engine (FR-090). Limits: policy ceiling 3 ≥ envelope limit (initial attempts) and grants strictly additional separate authorisations, capped cumulatively, consumption shared across lineages (FR-091). Recurrence floor (FR-092). Verified: `.project-run/` is already a tracked config root (`project-config.ts`, `bootstrap.ts`), and `CONSUMER-GUIDE.md` instructs ignoring only `.project-run/runs/`.

### D-29 Path matching
Closed glob subset, anchored, case-sensitive, POSIX only, validated-not-normalised candidates, deny-wins, symlink and traversal rules, 30 normative vectors (`contracts/path-matching.md`, FR-093, FR-094).
