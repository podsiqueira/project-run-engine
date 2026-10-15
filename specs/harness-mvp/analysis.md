# Specification Analysis Report: Harness MVP, revision 3 (T049 corrections)

**Method**: the procedure of `templates/skills/speckit-analyze/SKILL.md`, applied manually (no `.specify/` scripts and no `constitution.md` in this repository; `ARCHITECTURE.md` §2 and the package-boundary test stand in for the constitution). Traceability numbers come from a script (regex over FR/AS/SC/T/D/OD/R ids, dependency graph, file references); findings and the adequacy review are a manual read. **Deviation**: the skill says "no file writes"; this report is saved for review. Running it modified nothing else. The revision-2 report is preserved in git history (`069f7e2`).
**Scope**: specification only. No code, checkpoint, runtime behaviour, Incito or Feature 009 content was touched; nothing was committed or pushed in this step. **T049 is not ticked, T003 is not started, Gate B is blocked.**
**Caveat on evidence**: the T049 findings rest on my reading of the code and on two throw-away probes (scratchpad, in-memory store, temp repo); the owner has not yet inspected `t049-technical-review.md` or these revision-3 files directly.

## 1. Where each requested priority was addressed

| # | Priority | Specification change |
|---|---|---|
| 1 | Recovery and human answers | Harness executions never use `reconstructResumeContext` or any legacy resume/push path (FR-097); human answers are **audit-only**: no dispatch, no change to counters, `remediation_iteration` or `last_result` (FR-098, SC-012, invariant I9); resumption only by typed operations or `resumeSuspension`, which restores a recorded pre-suspension row (`restoreRow`) and re-enters authorisation, pins, baseline, budget and the row's recovery (controller §7a). AS-42, AS-97, AS-102, AS-103, AS-106 |
| 2 | Persistence and logical atomicity | One additive `@internal Coordinator.commit` built from the **persisted record** (FR-099): preserves unknown fields, appends logs, `questions` override, literal pending action, one CAS save per boundary (write-ahead counter + pending action in one `commit`; accept-and-advance in one `commit`). Harness validation completes **before** any `commit` and `applyExternalResult` is never called (FR-100); the read-only pass returns "needs lock" when a write is needed (controller §1, §2a, §8). AS-45, AS-100, AS-101, AS-105 |
| 3 | State table | Rows **T0–T9** and write sequences **W0–W13**, a recovery action per row; every crash window between commits is a row; `STATE_INCOHERENT` only for tuples that are *not rows* (FR-087, FR-101; controller §3a/§3b; recovery rows R19–R27). Completeness by enumerating the W-sequences and injecting a crash before and after each commit (SC-010, SC-013; AS-85, AS-99, AS-115) |
| 4 | Pull mode and preset | Identification **only** by a validated `harness` block (FR-096, E-15); the Harness preset validates and labels the Harness' own writes and is **never** used for the engine's `decide`/`resolveTransition`; the engine's remediation loop is never executed for Harness executions (FR-050). AS-104 |
| 5 | Evidence and security | References and digests only in requests, pending actions and events, with 8 KiB / 4 KiB limits; host payloads in `AgentResult.metadata.harness`; the engine does **not** sanitise `pending_action` (stated as a fact), so the guarantee is by construction and test; the block stays outside `context` (FR-102, FR-103, FR-104, SC-014; AS-107, AS-113) |
| 6 | Compatibility | Non-Harness contracts preserved byte-for-byte (FR-105, AS-98). The **complete** exported delta is `PersistedExecutionState.harness?: unknown` and one `@internal Coordinator.commit`; nothing changes in `CoordinatorExecutionContext`, `CoordinatorOptions`, `ProjectRunHostResponse`, `ProjectDoctorReport`, `ExecutionStepKind`, `ExecutionFailureCode`; Harness status/diagnostics are internal functions; the dispatch↔step pairing exception is documented (FR-108). AS-112, AS-116 |

## 2. C-01…C-13 and PT-01…PT-18 → artifacts

| Proposal | Where it landed | Note |
|---|---|---|
| C-01 table | controller §3a/§3b; FR-087, FR-101; SC-013; AS-85, AS-99, AS-115 | rows T0–T9 |
| C-02 delegation points | controller §1, §2a; FR-100; AS-105 | explicit table of code locations |
| C-03 pull-only / answers | FR-097, FR-098; controller §7a; SC-012; AS-42, AS-102, AS-103 | **refined**: legacy `Coordinator.step/run/prepareNextAction/applyExternalResult` cannot see the persisted record, so they are not guarded; entry guards plus tripwire (R-26) |
| C-04 Coordinator hooks | FR-099; controller §8; T050 | **refined**: a single `commit` replaces four hooks and removes any change to `CoordinatorExecutionContext`/`CoordinatorOptions` |
| C-05 preset selection | FR-096; D-10, D-32; AS-104; T056 | preset never identifies an execution |
| C-06 public surface | FR-077, FR-105; SC-011; D-15; AS-49, AS-112; T057 | delta of two items |
| C-07 transport / references | FR-102, FR-103; review §1a; AS-107; T054 | |
| C-08 timeout | FR-023; AS-109; T058; R-23 | host-enforced (E3) |
| C-09 orphan validators | FR-106; verification §3a; controller R20; AS-110; T055 | |
| C-10 lock semantics | FR-107; controller §9; AS-111; R-21 | |
| C-11 history pairing | FR-108; AS-116; OD-13 | |
| C-12 timestamps / scrub | FR-102, FR-108; evidence-ledger §2; AS-113 | |
| C-13 `init --force`, policy loader | envelope §0/§1; FR-090; AS-90 | |
| PT-01…PT-18 | AS-97…AS-114 (PT id quoted in each), plus AS-115…AS-118 | PT-18 → AS-114 |

## 3. Mechanical results

| Measure | Revision 2 | **Revision 3** |
|---|---|---|
| Functional requirements | 95 | **108** (FR-096…FR-108 new; FR-023, 050, 054, 058, 060, 065, 066, 072, 075, 077, 087, 095, 097 reworded) |
| FRs with ≥ 1 task / ≥ 1 scenario | 95 / 95 | **108 / 108** |
| Acceptance scenarios | 96 | **118** (AS-97…AS-118 new; AS-42, 45, 49, 65, 85, 86, 90 rewritten); no gaps, no duplicates, all referenced by a task |
| Success criteria | 11 | **14** (SC-012…SC-014), all referenced |
| Tasks | 49 (T001–T049) | **59** (T050–T059 new); no duplicates, unknown dependencies or cycles |
| State rows / write sequences | 6 / 0 | **T0–T9 / W0–W13** |
| Decisions D-xx | 29 | **36** |
| Owner decisions | OD-1…OD-9 approved | + **OD-10…OD-13 approved for specification**, **OD-14 open** |
| Risks R-xx | 20 | **26** |
| Undefined FR / D / OD / R references; placeholders | 0 | 0 |
| Ticked | H0–H7, T001, T002, T045 | unchanged; **T049, T003 and every other task unticked** |

Pass 1 of this revision (before its own fixes) found **FR-108 without a task** and **FR-103 without a scenario**; both fixed (T057, AS-107). Traceability means an id is cited, not that the scenario is adequate; adequacy is in §5.

## 4. Defects found by this revision's own analysis and fixed

| ID | Defect | Fix |
|---|---|---|
| N1 | "Guard in the Coordinator methods" was not implementable: they never see the persisted record | Entry guards on every function that loads the record + manifest tripwire; limitation recorded (FR-097, R-26, AS-42, AS-97) |
| N2 | The engine matrix gives `HUMAN_INTERVENTION_REQUIRED` no outgoing edges, so `commit` validation would reject every resume | Explicit exception for `resumeSuspension` (W12) and adoption (W0) |
| N3 | Adoption only from an idle state was unusable: the common state is `(IMPLEMENT, AWAITING, engine-created pending IMPLEMENT)` | Three quiescent source tuples; engine-created pending action closed with a digest-only event; W0; AS-118 (FR-075) |
| N4 | Recomputing the whole-tree `treeDigest` on every `next` would make polling expensive | Controller §2 step 6 split: cheap pins on every call; baseline chain only at dispatch, submission and acceptance |
| N5 | W12 ("restore the pre-suspension row") was ambiguous | `restoreRow` recorded in the suspension |
| N6 | `harnessDoctor` needs `git check-ignore`, which no port offered | `SnapshotProvider.isIgnored` added |
| N7 | `TASK_ELIGIBILITY_CHECK` was listed as a resting step although row T0 has no cycle | Removed from the at-rest `HarnessStep`; the active suspension is stored in `harness.suspension` also when no cycle exists |
| N8 | A `CONVERGE` edge would hand the run to the engine's own remediation loop outside the Harness budget | No edge to `CONVERGE`; the execution stays suspended at `PHASE_END`; **OD-14 open** |
| N9 | Building requests with `resolveDispatch` needs the Spec Kit skill configuration | The Harness preset extends the Spec Kit preset |
| N10 | Four extension hooks plus a context field would have widened the public surface | One `commit` method; delta of two items |

## 5. Adequacy review (judgement, not coverage)

| Area | Scenarios | Adequate? | Weakness that remains |
|---|---|---|---|
| Answers never dispatch | AS-103 (three suspension origins plus a non-Harness control) | Yes | asserts "zero new dispatch events", so a future new trigger is still caught |
| State-table completeness | AS-85, AS-99, AS-115 | **Partly** | completeness is proved relative to the *enumerated* W-sequences; if the enumeration is hand-written, a missed write in the implementation is a silent gap. T053 should derive the list from the `commit` call sites |
| Crash windows | AS-99 with fault injection | Yes if the injector can fail *between* saves | the in-memory store supports `failNextSave`; real process kills belong to T036; a crash *inside* the atomic rename is covered by the existing store tests only |
| Write-ahead counter | AS-101 | Yes | multi-process proof is T037 |
| Adoption | AS-118 | Yes for the three sources | adopting a run whose agent is mid-work discards that step (late result ⇒ `STALE_STEP`); a human decision, documented |
| References-only requests | AS-107 | Yes for fixtures | **not** a proof for arbitrary agent content (next row) |
| Host-supplied results | none | **Gap** | the engine persists the full `last_result` (`evidence: unknown[]`, findings text) and findings in `step_log`; FR-102 constrains Harness-built requests and events, not host-supplied results. Either accept it (results are persisted like this today, E-6) or add a size/content check on submitted results. **Owner decision requested (OD-15, below)** |
| Exported-type delta | AS-112 | Yes in intent | the mechanism (`.d.ts` diff of the built package) is left to T057 |
| Path matching | AS-94, AS-114, SC-009 | Yes | hard links and bind mounts undetected (R-18) |
| Timeouts | AS-109 | Only that the option is set | host-enforced in pull mode (R-23) |
| Hand-off after `PHASE_END` | AS-117 | Behaviour defined for the MVP | product decision OD-14 still open |

## 6. Decisions and risks

- **Approved earlier**: OD-1…OD-9 (2026-10-15).
- **Approved for specification** by the authorisation to update the artifacts (to be re-confirmed in the Gate B request): OD-10 exported delta, OD-11 pull-only, OD-12 additive `commit`, OD-13 pairing exception.
- **Open**: **OD-14** hand-off after `PHASE_END` (default: stay suspended); **OD-15** (new, from §5) whether host-supplied results (`evidence`, findings text) need a size/content check, or the existing behaviour is accepted.
- **Open verification gaps**: the "Not read" list in `t049-technical-review.md` §1 (agent dispatcher, `executeWithHostGuards`, project-run-host and CLI beyond call sites, second halves of `bootstrap.ts`/`doctor.ts`); non-Harness engine paths were not re-read beyond T049; the host skill text that resumes by `humanAnswers` was not reviewed.
- **Risks added**: R-21 lock held by validators, R-22 orphan validators, R-23 timeouts host-enforced, R-24 exported delta, R-25 suspension at `PHASE_END`, R-26 hand-built Coordinator. R-13 and R-14 are *closed by design*, but the design is unproven until Gate B.

## 7. Status

- Revision 3 is a documentation change in the working tree on `docs/harness-mvp-spec`; **not committed, not pushed**.
- **T049 remains open**: a report exists and its findings are incorporated, but the owner has not reviewed it; it is not ticked.
- **T003 not started; Gate B blocked.** Feature 009 and Incito untouched.
- Re-run this analysis after any further edit. Suggested next owner actions: read `contracts/harness-controller.md` (§3a, §3b, §7a, §8), decide OD-14 and OD-15, then decide whether to close T049.
