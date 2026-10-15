# Implementation Plan: Autonomous Engineering Harness MVP

**Branch/Location**: `specs/harness-mvp/` · **Status**: Gate A APPROVED 2026-10-15 (specification phase concluded, revision 2) · **Gate B: BLOCKED** (needs T049 technical review and a new explicit authorisation) · **Spec**: `spec.md`
**Input**: `spec.md`, `research.md`, `data-model.md`, `contracts/*`, `acceptance-scenarios.md`
> This plan describes *future* work. Nothing here authorises implementation.

## 1. Technical context

| Item | Value |
|---|---|
| Language/runtime | TypeScript (ESM), Node ≥ 18, tests with Vitest 4 |
| Dependencies | none at runtime today; none added (hashing via `node:crypto`, spawning via `node:child_process` in the isolated module only) |
| Storage | existing `FileExecutionStateStore` (revision + CAS + advisory lock); new content-addressed evidence dir |
| Target | single machine, local filesystem (NG-1) |
| Public surface | **unchanged**: no new exports, subpaths, bin or public types at Gate B (`package.json` byte-identical, SC-011) |
| Compatibility | `version: 1` checkpoints, existing public types, default preset and `MAX_REMEDIATION_ITERATIONS` untouched |
| Baseline | 37 test files / 428 tests; typecheck clean |

## 2. Constitution / engineering-principle check

The repository has no `.specify/memory/constitution.md`. The binding principles are `ARCHITECTURE.md` §2 *Core Invariants*
and the package boundary test. Mapping:

| Principle (source) | Plan stance |
|---|---|
| Provider-neutral core, no SDKs (§2, NG-3) | holds; ports for process/FS work |
| Core only imports `node:fs`/`node:path` (test) | **needs amendment**: `node:crypto` in core; `node:child_process` only in `src/harness/node/` (internal, not exported) — OD-1, blocks Gate B |
| Engine never fabricates an `AgentResult`, never spawns a provider (§4.11) | holds: Harness spawns *validators* (not providers) and fabricates no agent results; synthetic *findings* are labelled `source:"VALIDATOR"/"HARNESS"` |
| Progress is durable or not reported (§4.17) | holds: single CAS save per boundary |
| Fail closed on lock/persistence faults | holds and extended (FR-069) |
| Additive evolution, no silent rewrite | holds (FR-073..076) |

No principle is violated without a recorded, owner-visible amendment request.

## 3. Proposed structure (future; names provisional)

```text
src/harness/
  index.ts                  internal barrel (NOT re-exported from src/index.ts)
  types.ts                  HarnessState, HarnessEvent, suspension codes
  policy.ts                 HarnessPolicy load/validate/digest
  envelope.ts               envelope types, human-only ops, pins, invalidation
  task-graph.ts             parser, validator, eligibility, reconciliation
  snapshot.ts               SnapshotIdentity canonical form, port types
  validators.ts             ValidatorDefinition, results, port types, gate semantics
  review.ts                 ReviewRequest builder, ReviewResult validator, findings, fingerprints
  remediation.ts            RemediationBudget, counting, grants
  ledger.ts                 events, hash chain, reconstruct, evidence references
  evidence-store.ts         content-addressed store, redaction, caps (fs/path/crypto only)
  controller.ts             evaluation order, step machine, human operations
  preset.ts                 spec-kit-harness-v1 preset (transition overrides)
  node/                     ONLY place allowed node:child_process (OD-1); internal, not exported
  path-matching.ts          closed glob subset, scope decision, symlink checks (contracts/path-matching.md)
    validator-executor.ts   ValidatorExecutor implementation
    snapshot-provider.ts    SnapshotProvider implementation (git plumbing via argv)
tests/harness/…             unit/contract/integration/recovery + fixtures (isolated temp repos)
```
Touch points in existing code (minimal, additive): `PersistedExecutionState.harness?` and carry-forward in the coordinator
checkpoint path; delegation in `nextProjectRunStep`/`submitProjectRunStep` when the block exists; status projection;
`doctor` check; boundary test amendment. No change to `CoordinatorState`, `DEFAULT_ALLOWED_TRANSITIONS` or the default preset.

## 4. Phases and gates

| Phase | Content | Gate to enter |
|---|---|---|
| **A – Specification** (this document set; H0–H7) | spec, research, data model, contracts, scenarios, tasks, analysis | **Gate A** (owner review of this package) |
| **B – Vertical slice** (H8) | Everything in `tasks.md` Phases 2–6 on an isolated fixture; no real consumer | explicit owner authorisation + OD-1 decision |
| **C – Host & continuity** (H9) | real-host adapter validation and `/loop`; no permission bypass | Gate B passed + authorisation |
| **D – Consumer pilot** (H10) | limited pilot; **Feature 009 excluded until separate review** | Gates B, C + explicit authorisation |

H0–H7 traceability to artifacts:

| Plan item | Artifact |
|---|---|
| H0 audit | `research.md` §A (+ H0 report delivered in session) |
| H1 envelope/stop points | `contracts/authorization-envelope.md`, `contracts/task-graph.md` §7, `contracts/path-matching.md` |
| H2 task graph | `contracts/task-graph.md` |
| H3 verification | `contracts/verification-pipeline.md` |
| H4 reviewer | `contracts/review-contract.md` |
| H5 remediation | `contracts/remediation-budget.md` |
| H6 ledger/compat | `contracts/evidence-ledger.md`, `data-model.md` |
| H7 controller/recovery | `contracts/harness-controller.md` |

## 5. Resolved open decisions (from plan §13 and Phase 2 authorisation)

| Question | Resolution | Where |
|---|---|---|
| Who issues/confirms the envelope | policy (repo, digest-pinned) + per-execution human-confirmed envelope that only narrows | D-01, FR-003/004 |
| What is a phase | label + explicit authorised task-id list | D-02 |
| Remediation limit unit | exactly 3 initial attempts per `(executionId, taskId)` (each attempt records its envelope); persisted, never reset by humans, hosts, re-issue or amendment; grants are separate, additional, capped authorisations | D-07, D-28, FR-041..046, FR-091 |
| Critical findings | immediate suspension, no attempt consumed | D-12 |
| Default validators | defined only in the versioned policy; Harness invents none | FR-025 |
| Log retention/secrets | local content-addressed refs, caps, redaction/quarantine, retained until human removal | D-05 |
| Diff snapshot identity | base commit + canonical per-path content hashes; baseline/subject delta | D-04 |
| Task completion | ledger acceptance or human attestation; checkbox only reconciled | D-03 |
| Public API | internal; **Gate B adds no exports/subpaths/CLI** (package surface byte-identical); exposure needs separate approval | D-15, FR-077, FR-095 |
| Upstream change invalidation | digest pins; matrix in envelope contract §7 | D-06 |
| Recovery, timeouts, invalid results, conflicts | per-boundary table | controller §5 |
| Checkpoint compatibility | optional `harness` block, no migration, adoption op, tripwire | D-09, evidence-ledger §7 |

## 6. Test strategy (summary; details in each contract and `acceptance-scenarios.md`)

- **Unit**: envelope, graph/scheduler, allowlist/executor argv rules, findings/fingerprints, budget arithmetic, hash chain.
- **Contract**: host adapter shape unchanged; reviewer binds to snapshot; `ValidatorResult` only from executor; additive persistence; public API surface; skills still resolved per role.
- **Integration/recovery**: positive and negative cycles; R1–R19; restart with pending action; CAS/lock/write faults; `/loop`; push/pull equivalence; non-Harness regression (4-dispatch behaviour retained).
- **Property**: counter monotonic and invariant across every resume point; I1–I8; projection-table coherence; path-matching vectors (30).
- **Golden**: v0.4.0/v0.5.0 checkpoints load/resume identically.
- Real subprocesses (not mocks) for the Node executor and the lock tests, consistent with the existing multi-process tests.

## 7. Complexity tracking

| Added complexity | Why needed | Simpler alternative rejected because |
|---|---|---|
| Harness preset with 4 additive edges | no loop back to `IMPLEMENT` exists | new states break exhaustive consumer switches |
| Hash-chained events | tamper/truncation detection | plain array can't detect truncation |
| Content-addressed evidence dir | payloads can't live in checkpoint (size) | inlining bloats CAS-saved file |
| Ports + Node module | keep core boundary | spawning in core breaks invariant |
| Write-ahead counter | exact "attempt = durable dispatch" semantics | count-on-result would under-count failed dispatches |

## 8. Open decisions and risks

### Owner decisions: all nine (OD-1…OD-9) approved on 2026-10-15

Approval covers the decisions as written in this plan. OD-1 approves the boundary amendment in principle; the test change itself (T003) stays blocked until Gate B.

- **OD-1 (blocks Gate B)** **[APPROVED 2026-10-15]** Approve the boundary amendment: `node:crypto` allowed in core; `node:child_process` and `node:os` (env/tmp only if needed) allowed solely in `src/harness/node/`; updated `package-boundary.test.ts`.
- **OD-2** **[APPROVED 2026-10-15]** Confirm the Harness preset's extra transitions (D-10) as the mechanism for the per-task loop (vs. any alternative the owner prefers).
- **OD-3** **[APPROVED 2026-10-15]** Confirm the default `NO_PROGRESS` streak of 2 (D-13); the policy value is a floor envelopes cannot weaken.
- **OD-4** **[APPROVED 2026-10-15]** Evidence/ledger growth: accept "no compaction in MVP" (R-6) or require a rotation design before Gate B.
- **OD-5** ~~Policy location~~ **RESOLVED (revision 2) and APPROVED 2026-10-15**: `.project-run/harness/policy.json` (D-28).
- **OD-6** **[APPROVED 2026-10-15]** Confirm the cumulative cap on `RemediationBudgetGrant`s (`maxGrantedAttemptsPerTask`, default 3, i.e. at most 6 attempts per task in total).
- **OD-7** **[APPROVED 2026-10-15]** Confirm that consumption is tracked per `(executionId, taskId)` across envelope lineages (each attempt still records its envelope), a conservative reading of "per task and authorization envelope" so that re-issuing an envelope cannot reset the budget.
- **OD-8 (blocks Gate B)** **[APPROVED 2026-10-15]** Confirm the path-matching dialect and POSIX-only platform scope (`contracts/path-matching.md`, FR-093/094) and the `CLEAN_REQUIRED` default baseline (FR-082).
- **OD-9** **[APPROVED 2026-10-15]** Defer host/CLI exposure of human-only operations and status to Gate C (FR-095); at Gate B they are internal functions only.

### Risk register

| ID | Risk | Mitigation | Residual |
|---|---|---|---|
| R-1 | Agent claims success without work | engine-run validators + engine-computed diff | semantic quality depends on tests/review |
| R-2 | Reviewer shares implementer bias | separate invocation, no narrative, exact diff, `isolationEvidence` | no process/model isolation (NG-6) |
| R-3 | Allowlisted command runs agent-edited repo code | sensitive-path rule, review disposition, digest-bound results | cannot prevent test tampering outright |
| R-4 | `tasks.md` dependencies unstated/prose | explicit-only parsing, `IMPLICIT_ORDER_RISK`, closed authorised list | human must author deps |
| R-5 | Retries duplicate external effects | no auto-retry of dispatches; idempotent-validator policy | at-least-once only |
| R-6 | `events[]` growth | payload-free events | no compaction in MVP |
| R-7 | Older engine drops the Harness block | manifest tripwire, `min_engine_version` | detect-only |
| R-8 | **Feature 009 H0 inconsistencies** (branch mismatch, stale `feature_directory`, FAILED sibling run, empty pending context, dirty tree, unverified commit state of Feature 009's T035–T038, its T039 unrevalidated) | excluded from fixture/pilot until separate review | open until separate authorisation |
| R-9 | Human actor not authenticated; human-only operations are *logically* separated only | channel separation + hash-chained audit + digest; stated in `status` | **a local agent (or any process) with the same OS user can call internal functions or edit files**; protection relies on host permissions (E3) |
| R-10 | Redaction misses a secret | caps, patterns, allowlisted env, quarantine path | best effort only |
| R-11 | Large/binary/symlink files in snapshots | `OPAQUE` entries and flags | reviewer cannot read opaque content |
| R-12 | Preset edges diverge from default-preset docs | docs + regression tests | maintenance cost |
| R-13 | Engine `resume` reconstruction (`suspended_from`) and `harness.cycle.step` could disagree | consistency check ⇒ `FAIL_CLOSED`; recovery tests | verified only at implementation time |
| R-14 | Existing human-answer revalidation (commit `cdd4d41`) interacts with Harness suspensions | free-text answers never change Harness state; typed ops only | interaction not exercised until Gate B |
| R-15 | Prohibited operations are denied by policy, not prevented | enforcement classes E1/E2/E3 in policy, status and docs (FR-079); `OPERATION_NOT_PERMITTED` only on visible evidence | network, git push, deploy, migrations, DB, secrets reads are unobserved unless the host reports them |
| R-16 | Credentials/secrets reachable by agent or validator processes | fixture hygiene + canary test (FR-081, SC-008); minimal env; `HOME` redirect | no sandbox: in real use the OS user's files and network remain reachable |
| R-17 | Dirty or ignored files influence validator output outside the reviewed diff | clean-tree default, chain of custody, dirty-baseline approval, ignored files hashed and surfaced (FR-082..084) | contents of ignored files are never shown to the reviewer; excluded paths (`ignoredExclusions`) are not examined |
| R-18 | Path matching ambiguity (case-insensitive FS, Unicode, symlinks, hard links) | closed dialect, validate-not-normalise, collision detection, symlink rules, 30 vectors | hard links and bind mounts undetected; Windows unsupported |
| R-19 | `STATE_INCOHERENT` after manual edits, old engines or faulty resume | projection table, fail closed, `reconcileCycle` | recovery is manual |
| R-20 | Structural `tasks.md` digest depends on parser fidelity | `parserVersion` pin, `PARSER_VERSION_CHANGED`, vectors | prose not following Spec Kit task format is invisible to the graph |
