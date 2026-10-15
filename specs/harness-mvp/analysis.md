# Specification Analysis Report: Harness MVP, revision 4 (OD-17/OD-18 approved; T049 confrontation for the closing decision)

**What kinds of checking are reported, kept separate:**
- **Source and test review (manual, read-only)**: detail and line references in `t049-technical-review.md` §10 and §11. It is reading plus three throw-away probes of `dist/` (scratchpad, in-memory store, never in the repository). It is neither a test run nor a full audit.
- **Automated traceability checks** (§4): an ad-hoc Python script kept outside the repository (`scratchpad/check.py`). It proves **referential consistency and coverage by citation only**.
- **Manual consistency review** (§5) of the specification documents against each other.
No repository script exists for this analysis. **No test suite, build or type-check was run**; `src/`, `tests/` and `package.json` were verified unchanged against `HEAD` (`git diff --quiet HEAD -- src tests package.json`). Earlier reports are in git history (`069f7e2`, `2576046`). **Deviation**: the Spec Kit analyze skill says "no file writes"; this report is saved for review.

## 1. Baseline and status

| Item | Verified |
|---|---|
| Branch / HEAD / tracking | `docs/harness-mvp-spec` / `25760467592edfc98872e55fb7f0e9604bc7839e` (published revision 3) / `0 0` against `origin` after `git fetch` |
| Working tree | 15 modified files plus 1 new file (`contracts/result-validation.md`), **all under `specs/harness-mvp/`** (`contracts/path-matching.md` is newly modified in this step); 0 files outside; revision 4 is **uncommitted and unpushed** |
| **OD-17** | **APPROVED 2026-10-15** (specification decision): continuation after `PHASE_END` requires an explicit action by an authorised human actor (`Actor.kind = HUMAN`) through the existing authorisation path; the software `Coordinator` may validate and enforce it but never substitutes for it; no automatic or authorised transition to `CONVERGE`, `READY_FOR_PR` or any legacy remediation path |
| **OD-18** | **APPROVED 2026-10-15** (specification decision) and **applied**: `.agents/skills/**` and `.project-run/skills/**` join the mandatory protected set (detection only, E2) in FR-090, `contracts/authorization-envelope.md` §1 and `contracts/path-matching.md` (vectors 31–32) |
| OD-14, OD-15, OD-16 | approved earlier as specification decisions (OD-15 limits remain **provisional initial specification limits**); OD-10…OD-13 approved for specification purposes, re-confirmed in the Gate B request |
| **T049** | **CLOSED 2026-10-15 by owner decision** (`t049-technical-review.md` §13; ticked in `tasks.md`). Evidence in §6; limitations and risks R-26…R-31 preserved |
| T003 / Gate B | T003 not started; **Gate B AUTHORISED 2026-10-15** (isolated vertical slice only; OD-10…OD-13 reconfirmed); Gates C and D blocked; no push, PR, release or publication authorised. The approvals above were specification approvals; the Gate B authorisation is the separate implementation authorisation |

## 2. Changes made in this step (documentation only)

| Change | Files |
|---|---|
| OD-17, OD-18 recorded as approved; wording reconciled (no remaining "proposed/awaiting" for either) | `plan.md` (OD-17, OD-18, R-25, OD-14 line), `spec.md` (§9, NG-11), `contracts/harness-controller.md` §10.5, `contracts/task-graph.md` §7, `acceptance-scenarios.md` AS-117, `research.md`, `tasks.md` header |
| OD-18 applied to the contracts; vector count 30 → 32 | `spec.md` FR-090, `contracts/authorization-envelope.md` §1, `contracts/path-matching.md`, `acceptance-scenarios.md` AS-94, `plan.md`, `research.md`, `tasks.md` T046 |
| Divergence X-1 (Harness preset does not inherit `getExpectedOutput`) | `contracts/harness-controller.md` §3, `research.md` D-10 |
| Divergence X-2 (pairing is a documented contract; only trailing unmatched dispatches allowed): pair by `step_id` for Harness executions; amend `ARCHITECTURE.md` §4.17 at Gate B | `spec.md` FR-108 and E-17, `acceptance-scenarios.md` AS-116, `tasks.md` T041 |
| T049 review extended | `t049-technical-review.md` §11 (findings × code × tests, divergences, reusable test techniques, what is still unread, closing-decision statement) and §12 (third pass against the owner's closing criteria) |
| Correction of my own earlier statement (Z-1): the same-id push start restart is documented (`ARCHITECTURE.md` §4.17.2) and pinned by `state-store-contract.test.ts:542–577` | `spec.md` E-19, `acceptance-scenarios.md` AS-133, `plan.md` R-30, `t049-technical-review.md` §10/§11/§12 |
| Precision X-5 / Z-2: `NO_PENDING_ACTION` vs `STALE_STEP` | `spec.md` (FR-075, edge case), `acceptance-scenarios.md` (AS-43, AS-106, AS-118, AS-123), `contracts/harness-controller.md` §11, `contracts/result-validation.md` §3 |
| Controller §8 wording: HUMAN_INTERVENTION_REQUIRED restoration mirrors the engine's resume (Z-6) | `contracts/harness-controller.md` §8 |
Items X-3 (same-id push start overwrites a checkpoint) and X-4 (`execution_metadata` merge) were corrected in the previous step; they are part of §11.2.

## 3. T049: what was confronted in this step

Re-read or newly read (details with line references in `t049-technical-review.md`): the whole of `human-answers-resume-stages.test.ts` (non-Harness control for the resume/re-dispatch behaviour and the preserved remediation budget); titles of `resume`, `checkpoint-save-failures`, `phase5-locking`, `host-status-and-restart`, `workflow-presets`, `custom-runtime`, `human-answers-resume-push-mode` and `host-api`, plus the cited ranges; `src/host/project-engine-run.ts` (dispatch switch and schema failure codes); `agent-registry`, `default-agent-registry`, `spec-kit-preset` and `skill-resolver`/`skill-validator` (targeted); `ARCHITECTURE.md` §4.4, §4.15 and §4.17 (partly). Result: F-01…F-24 confirmed by source; nine of the fourteen §11.1 rows also exercised by an existing test; four small divergences found and corrected (X-1…X-4); reusable test techniques identified for the Gate B tests (§11.3). **Third pass (`t049-technical-review.md` §12)**: `bootstrap.ts` and `doctor.ts` now read in full; skill validator/resolver; the same-id start test and ARCHITECTURE §4.17.2; the fault-injection driver and exhaustive save-failure loop in `checkpoint-save-failures.test.ts`; rejected-submission integrity in `execution-record.test.ts`. Two corrections of my own wording (Z-1, Z-2), no contradiction of a design conclusion. **Still unread** (§11.4/§12.3): the bodies of the other test files listed there, `docs/*.md` other than `transition-contract.md`'s cited passage, most of `ARCHITECTURE.md`. Runtime behaviour was exercised only by three in-memory probes.

## 4. Automated traceability checks (script; coverage by citation only)

| Measure | Revision 3 (published) | **Revision 4, measured now** |
|---|---|---|
| Functional requirements | 108 | **115** (no gaps, no duplicate definitions) |
| FRs with ≥ 1 task / ≥ 1 acceptance scenario | 108 / 108 | **115 / 115** |
| Acceptance scenarios | 118 | **135** (no gaps or duplicates; each cited by ≥ 1 task) |
| Success criteria | 14 | **16** (each cited by a task or scenario) |
| Tasks | 59 | **67**; no duplicate ids, unknown dependencies, self-dependencies or cycles |
| Contracts | 8 | **9** (every `contracts/*.md` reference resolves) |
| D-xx / OD / R-xx defined | 36 / 14 / 26 | **38 / 18 / 31**; 0 undefined references in any family; 0 undefined FR references |
| Path-matching vectors | 30 | **32** |
| Placeholders | 0 | **0** |
| Ticked tasks | H0–H7, T001, T002, T045 | + **T049** (closed by owner decision); **T003 unticked** |
Status-wording search: no artifact other than historical sections of this report and of the T049 review calls OD-17 or OD-18 "proposed/open"; none says revision 4 is published. These checks cannot show that a scenario tests what it cites or that contracts agree beyond ids and references.

## 5. Manual consistency review (not tests)

| Check | Result |
|---|---|
| OD-14 + OD-17 | One wording everywhere: `PHASE_END` mandatory; `CLOSE_PHASE`/`CONTINUE` by a human actor plus a new/amended ACTIVE envelope; no per-task approval; no hand-off authorised |
| OD-15/OD-16 (class A vs class B) | Unchanged and consistent; limits still labelled provisional and scoped separately from the 8 KiB, 4 KiB, per-file and aggregate-evidence limits |
| OD-18 | Present in FR-090, the envelope contract, the path-matching contract and the vectors; absent nowhere it should appear (mandatory set listed in three places, all updated) |
| FR-108 vs documented pairing contract | Reconciled with `ARCHITECTURE.md` §4.17 and the test; the amendment of that document is scheduled (T041), not performed here (outside `specs/harness-mvp/`) |
| Residual uncertainties | numeric limits unmeasured (R-27); hand-built `Coordinator` (R-26, R-30); skill text for hosts (R-31, T048); real-process behaviour of the Harness is entirely unexercised (nothing is implemented) |

## 6. Evidence for the owner's decision on closing T049 (decision taken: closed, `t049-technical-review.md` §13)

- **For closing**: every finding of the report was re-opened in the current source and matches; the legacy resume/re-dispatch and fault-recovery behaviours the design depends on are covered by existing tests that act as the non-Harness control; the four divergences found were small and are corrected; no finding contradicts a conclusion of the review.
- **Against closing yet / residual risk**: the review is a sample, not a census (§3, `t049-technical-review.md` §12.3); several claims (unknown-field preservation, `executionOptions` not forwarded, host-guard timeouts, and any behaviour of a *Harness* record) have **no existing test** and rest on source reading and probes (the same-id overwrite is covered for non-Harness records by an existing test, Z-1).
- **Against the owner's criteria (assessment; the owner then decided to close)**: (1) no material contradiction found in the third pass; (2) known gaps documented with evidence (§12.3 item 2); (3) remaining risks delimited (§12.3 item 3); (4) the reviewed scope is a sample (§12.3 item 4). **Decision (2026-10-15)**: the owner closed T049 on this evidence.

## 7. Remaining blockers and decisions

1. ~~Owner decision on closing T049~~ — taken 2026-10-15 (closed).
2. Gate B was **authorised 2026-10-15** (isolated vertical slice; OD-10…OD-13 reconfirmed); T003 not started; Gates C and D blocked.
3. Committing revision 4 was authorised 2026-10-15 (documentation only); **pushing it was not**. The `ARCHITECTURE.md` §4.17 amendment is a Gate B documentation task (T041).

## 8. Confirmations

No source code, test, build, type-check, package metadata, lockfile, checkpoint, `.project-run/`, Incito or Feature 009 was changed or run; no formatter or generator was run; no push, PR, branch change or publication occurred, and no Gate B implementation had started when this report was written (the commit of revision 4 followed the owner's authorisation of 2026-10-15).
