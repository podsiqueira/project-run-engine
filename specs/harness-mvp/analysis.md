# Specification Analysis Report: Harness MVP

**Method**: the procedure of `templates/skills/speckit-analyze/SKILL.md`, applied manually. The `.specify/` scripts and
`constitution.md` do not exist in this repository, so the scripts could not run and the constitution check used
`ARCHITECTURE.md` §2 plus the package-boundary test instead. Coverage numbers come from a script (regex over FR/AS/SC/T ids);
the findings table is a manual read of spec, plan, contracts, scenarios and tasks. **Deviation**: the skill says "no file writes";
this report is saved so Gate A reviewers can read it. No other artifact is modified by it.
**Run**: 2026-10-15, two passes (the first pass found gaps, which were fixed and re-measured; both are reported).

## 1. Pass 1 (before fixes): mechanical coverage

| Measure | Result |
|---|---|
| FRs defined | 78 (FR-001…FR-078, no gaps after adding FR-059/060) |
| FRs with no task | **4**: FR-001, FR-009, FR-019, FR-023 |
| FRs with no acceptance scenario | **20**: FR-001, 002, 003, 008, 009, 013, 019, 022, 023, 026, 033, 034, 036, 051, 054, 056, 058, 059, 065, 068 |
| Tasks without any FR/AS/SC reference | only owner-gate and Phase-0 rows (by design) |

## 2. Pass 2 (after fixes): mechanical coverage

| Measure | Result |
|---|---|
| FRs defined / with ≥1 task / with ≥1 scenario | 78 / 78 / 78 (**100 %**) |
| Scenarios (AS) / referenced by a task | 68 / 68 |
| Success criteria SC-001…007 referenced by a task or scenario | 7 / 7 |
| Tasks / duplicate ids / dependencies on a later or unknown id / cycles | 44 / 0 / 0 / 0 |
| Fixes applied | new task T021 (dispatch builder); scenarios AS-56…AS-68; FR refs added to T009, T027, T032 |

Coverage is a *traceability* measure (an id is mentioned), **not** proof that a scenario is adequate. See §3 for adequacy.

## 3. Findings

| ID | Category | Severity | Location | Summary | Status |
|---|---|---|---|---|---|
| C1 | Coverage | HIGH | spec FR-001/009/019/023 | requirements with no task | **Fixed** (T009, T021, T027, T032) |
| C2 | Coverage | HIGH | spec vs scenarios | 20 requirements with no acceptance scenario | **Fixed** (AS-10, 14, 16, 56–68) |
| I1 | Inconsistency | HIGH | spec FR-048 vs remediation §4 | "CRITICAL consumes no attempt" is ambiguous when the CRITICAL finding arrives after an already-counted attempt | **Fixed**: reworded (new dispatch is prevented; counted attempts stay counted); AS-26 aligned |
| I2 | Inconsistency | MEDIUM | spec US2.2 vs remediation §4 | `VALIDATOR_ERROR` after a remediation: "no attempt consumed" contradicts the already-counted attempt | **Fixed**: wording "no *additional* attempt" |
| I3 | Inconsistency | MEDIUM | spec FR-031 vs review contract | `VERIFIER_TAMPERING_RISK` vs `verifierTampering` (terminology drift) | **Fixed** |
| I4 | Inconsistency | MEDIUM | spec edge cases | `PRE_EXISTING` flag had no field | **Fixed**: `preExisting?` on `HarnessFinding` |
| I5 | Inconsistency | MEDIUM | controller §4 | `LIMIT_REACHED` used by the authorisation check but absent from `SuspensionReason` | **Fixed** |
| U1 | Underspecification | HIGH | controller / D-22 | no operation to clear causes fixed outside the Harness (e.g. validator env), and the interplay with existing `humanAnswers` was unspecified | **Fixed**: `resumeSuspension`, §7a, AS-68; interplay left as risk R-14 |
| U2 | Underspecification | MEDIUM | task-graph §6 / data-model | does a `SUSPENDED` task keep the single cycle slot? | **Fixed**: yes; only amendment/`EXCLUDED` frees it |
| U3 | Underspecification | MEDIUM | tasks | docs for the preset edges (`state-machine.md`, `transition-contract.md`) not in the task list | **Fixed** (T041) |
| A1 | Ambiguity | MEDIUM | FR-049, D-13 | "strict reduction" of fingerprint sets and fingerprint normalisation rules are heuristic | **Open**: parameterised at Gate B; OD-3 |
| A2 | Ambiguity | MEDIUM | FR-029/FR-031 | glob dialect for `allowedPaths`/`protectedPaths` (gitignore-style vs minimatch) not fixed; no glob library may be added (zero runtime deps) | **Open**: decide at Gate B (implement a small anchored-glob subset, specify it first) |
| A3 | Ambiguity | LOW | FR-009 | `maxTaskElapsedMs` is checked only at boundaries, not preemptive | Accepted (documented in D-16) |
| X1 | Constitution/boundary | CRITICAL-if-unresolved | plan §2, D-11 | the package-boundary test forbids `node:crypto` and `node:child_process` in `src/`; the design needs both | **Open, blocks Gate B**: OD-1 |
| X2 | Compatibility | HIGH | D-10, T028 | the Harness preset adds four transition edges; consumers with exhaustive state switches are unaffected (no new states) but preset docs must change | **Open (OD-2)**; regression tests specified |
| X3 | Compatibility | HIGH | evidence-ledger §7 | old engines drop the `harness` block; mitigation is detect-only | **Open risk R-7** |
| X4 | Security honesty | HIGH | FR-003, D-01 | human actors are host-asserted, not authenticated; a local agent with shell access could call human-only CLI operations | **Open risk R-9** (stated in spec, contract and status) |
| X5 | Feasibility | MEDIUM | D-04 | snapshotting large trees by hashing every changed file may be slow; size cap and `OPAQUE` rule exist but no performance budget | **Open**: add budget to the Gate B fixture |
| X6 | Scope | MEDIUM | Feature 009 | its H0 findings are unresolved; consumer's `tasks.md` uses prose `DEPENDS ON`, which is what the parser targets (no real-file validation done by design) | **Open (R-8)**: excluded until separate authorisation |
| X7 | Verification gap | MEDIUM | research §A | `coordinator.ts`, `host-dispatch-adapter.ts`, `bootstrap.ts`, `doctor.ts` and Feature 009's `execution-protocol.md` were not read line by line in H0; the claims about carry-forward and resume reconstruction rest on code comments and tests | **Open**: first task of Gate B should re-verify (R-13) |

No duplication findings. No placeholders (`TODO`, `TKTK`, `???`) remain in the artifacts (checked by script).

## 4. Adequacy review of the highest-risk acceptance criteria

| Requirement | Scenario | Adequate? | Gap |
|---|---|---|---|
| Exactly 3 attempts (FR-041..046) | AS-27..33, AS-54 | Yes: one test per counting-table row, property test over resume points | needs a real multi-process restart (T036/T037) |
| Counter survives host change (FR-043) | AS-29 | Partly | "host change" is simulated by a second client with the same store; a different *runtime* is not exercised until Gate C |
| Reviewer independence (FR-037..039) | AS-21..24 | Contract-level only | by design cannot prove isolation (NG-6) |
| No fabricated success after crash (FR-070) | AS-37 | Yes, 18 rows | R12 (acceptance CAS conflict) needs a deterministic fault injector in the fixture |
| Legacy checkpoints (FR-074) | AS-44 | Yes | golden files for v0.4.0 must be produced from the tagged release, not hand-written |
| Secrets in logs (FR-055/056) | AS-17, AS-64 | Partly | best-effort; only known patterns and allowlisted env values are verifiable |
| Feature 009 exclusion (SC-006) | AS-55 | Yes (lint) | does not stop a human from pointing the Harness at 009; process control only |

## 5. Metrics

Requirements 78 · Success criteria 7 · Scenarios 68 · Tasks 44 (T001–T044, all future) plus 8 specification rows (H0–H7) · Traceability coverage
100 % (pass 2; 94.9 % FR→task and 74.4 % FR→scenario in pass 1) · Ambiguity items 3 (1 open, 1 open, 1 accepted) ·
Duplication 0 · Critical issues **1 open (X1, owner decision OD-1)**.

## 6. Next actions

1. Owner resolves OD-1 (blocks Gate B), and decides OD-2…OD-5.
2. Re-run this analysis after any owner-requested edit to the spec.
3. Do not start `T001+` until Gate A and Gate B are granted in writing.
