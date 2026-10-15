# T049: Pre-Gate-B Technical Review (read-only)

**Status**: report for owner review. **T049 is NOT ticked** and **Gate B remains blocked.**
**Update 2026-10-15 (revision 3)**: the owner authorised updating the specification artifacts with C-01…C-13 and PT-01…PT-18. They are now incorporated in spec revision 3 (see `analysis.md` §2 for the C→artifact map); some were **refined** while doing so (notably C-04: one `Coordinator.commit` instead of several hooks, which also removed the need to add a field to `CoordinatorExecutionContext`/`CoordinatorOptions`; and the OD-14 scope boundary). Nothing was implemented, and this report stays the record of the evidence. The findings, line numbers and probes below are unchanged.
**Baseline (as of the review, evidence unchanged)**: branch `docs/harness-mvp-spec` at `069f7e2` (spec) over code at `main` `c1e4054` / `v0.5.0`. *(Later: revision 3 incorporating this report was published at commit `2576046`; this report itself is part of that commit.)* No source, checkpoint, Incito or Feature 009 file was modified.
**Date**: 2026-10-15

## 1. Method and limits

Direct reading of the code (not of the earlier reports), plus two throw-away probes run **outside the repository** (scratchpad, in-memory store, a temp git repo) against the built `dist/`:
- probe 1: which checkpoints one `submitProjectRunStep` writes, and whether an unknown top-level `harness` field survives;
- probe 2: what a human answer to a blocked stage does in the existing engine.

Read in full: `src/coordinator/coordinator.ts`, `src/runtime/host-dispatch-adapter.ts`, `src/host/project-run-step.ts`, `src/decision/human-intervention.ts`, `src/decision/human-answer-validation.ts`, `src/project/locked-turn.ts`, and in `project-run.ts` lines 160–870 (resume reconstruction, push run, entry points). Read in part: `src/project/state-store.ts` (types, `validatePersistedState`, `save`, lock helpers), `src/project/bootstrap.ts` (`inferProjectName`, `runProjectInit` up to the skill install), `src/project/doctor.ts` (types and the first check), `src/host/status.ts` (head), `src/decision/decision-engine.ts` (transition logic, from H0), `git show cdd4d41` (message and stat).
**Not read** (so no claim is made about them): `src/agents/agent-dispatcher.ts` beyond what the coordinator shows, `executeWithHostGuards` in `host-execution-contract.ts`, `src/host/project-run-host.ts` and `src/cli/project-run-cli.ts` beyond their call sites, the second half of `bootstrap.ts` and `doctor.ts`, the existing tests (except where cited). The existing suite was not re-run in this step (it passed 428/428 at the start of Phase 2 and no code has changed since).

## 2. Verdict per requested item

| Item | Result |
|---|---|
| `coordinator.ts` / `host-dispatch-adapter.ts`: construction, persistence, preservation | **Gaps found** (F-01…F-06). `HostDispatchAdapter` is push-only and irrelevant to the pull path; the Coordinator is where every constraint lives |
| `bootstrap.ts` / `doctor.ts`: policy discovery, validation, diagnostics | **Nothing exists** to build on (F-12); the planned `doctor` extension would change a public type |
| State reconstruction on resume (`HarnessStep`, `heldAction`, `pending_action`) | **Critical gap** (F-07, F-08): the existing resume path re-dispatches and resets engine counters with no hook for the Harness |
| Compatibility with the human-answer revalidation (`cdd4d41`) | **Incompatible as-is for Harness executions** (F-08); compatible if Harness executions are kept off that path (C-03) |
| Coherence of the state table | **Incomplete**: the engine writes at-rest states the table does not list (F-02, probe 1) |
| Carry-forward of the `harness` block | **Confirmed gap**: dropped by every checkpoint path (probe 1); at least 4 touch points (F-01) |
| `harness-controller.md` §2a | **Sound, with amendments** (C-02, C-04) |
| `harness-controller.md` §3a | **Needs amendment** (C-01) |
| `path-matching.md` | **Sound**; no conflict with the code; tests still required |
| `authorization-envelope.md` §0 | **Sound**; claims agree with the code; two wording notes (F-13) |
| X7, R-13, R-14 | **X7 partly closed, R-13 confirmed and refined, R-14 confirmed critical** (section 5) |

## 3. Findings with evidence

Severity: **C** critical (breaks an approved guarantee), **H** high (spec cannot be implemented as written), **M** medium.

### F-01 (H) The checkpoint is built from an explicit field list; unknown fields are dropped
`coordinator.ts:213–244` passes an object literal to `stateStore.save`; nothing is spread from the previous record. The file store itself *would* keep extra fields (`state-store.ts:420` spreads the state it is given), so the loss happens in the Coordinator. The same explicit-copy pattern repeats where contexts are rebuilt: `project-run-step.ts:537–558` (submit), `project-run.ts:757–788` (resume reconstruction). Only one path preserves unknown fields by luck: `project-run.ts:746` saves `{ ...persisted, human_answers }`.
**Probe 1**: a `harness` key injected into a stored checkpoint did **not** survive one `submitProjectRunStep` (`harness key survived: false`).
Required touch points: `PersistedExecutionState`, `CoordinatorExecutionContext`, `Coordinator.checkpoint()`, the submit context builder, `reconstructResumeContext`. Also `scrubSecrets` (`state-store.ts:422`) only touches `context`, so the block must stay **outside** `context` (names such as `authorizationId` or `authenticated` match its `auth` pattern and would become `"[REDACTED]"`).

### F-02 (H) One call writes several checkpoints; the state table omits real at-rest states
**Probe 1**, one `submit` of an IMPLEMENT result wrote three checkpoints:
```
IMPLEMENT           | IN_PROGRESS            | pending none        | last_result=PASS
INDEPENDENT_REVIEW  | IN_PROGRESS            | pending none        | (result cleared)
INDEPENDENT_REVIEW  | AWAITING_AGENT_ACTION  | pending INDEPENDENT_REVIEW
```
`coordinator.ts:499–508` checkpoints every `TRANSITION` as `IN_PROGRESS` before the next decision; `applyExternalResult` (`:352–375`) checkpoints the applied result before any transition. A crash between saves leaves `(INDEPENDENT_REVIEW|RE_REVIEW|REMEDIATION, IN_PROGRESS, none)`, which `contracts/harness-controller.md` §3a does **not** allow (it lists `REVIEW_PENDING` and `REMEDIATION_PENDING` only with `AWAITING_AGENT_ACTION`). With the table as written, SC-010 / AS-85 would flag legitimate crash windows as `STATE_INCOHERENT` and deadlock the run.

### F-03 (H) Atomic acceptance and write-ahead counting need Coordinator changes, not just a controller
`checkpoint()` is private. `prepareNextAction` saves the transition and the dispatch separately (`:499–508`, `:489`). The specified single-save acceptance (`TASK_ACCEPTED` + engine move to `IMPLEMENT`) and the single-save "counter + pending action" (FR-042) cannot be produced from outside the class. Required: new Coordinator extension points (a pre-dispatch hook that may mutate the Harness block before the dispatch checkpoint; an atomic accept-and-advance method; an override of `human_intervention.questions`, see F-09).

### F-04 (H) Push mode has no durable pending action, so write-ahead counting is impossible there
`Coordinator.step()` (`:297–313`) calls `dispatcher.dispatch(...)` in-process and only checkpoints after the result (`applyExternalResult`). Nothing durable exists while a push-mode dispatch runs. The push entry points are `executeProjectRun`/`executeProjectResume` (`project-run.ts:296, 793`) and `ProjectRunHost.start/resume` (`project-run-host.ts:257, 290`), none of which could consult the Harness. The spec's "push and pull identical" (FR-072, AS-42) is not achievable without redesigning push mode.

### F-05 (H) The decision engine used by the pull API is hard-wired; `preset` is only a label
`project-run-step.ts:602` always does `new CoordinatorDecisionEngine()` (default preset). The persisted `preset` field is `config.project.workflow_version ?? "spec-kit-v1"` (`:614`, `project-run.ts:476`); in a consumer it is a free label such as `"v1"`, not a preset id. A Harness execution therefore cannot be recognised by `preset`; it must be recognised by the `harness` block, and `buildStepCoordinator` must inject the Harness preset (the engine constructor already accepts `{ preset }`). `resolveTransition(context)` receives only the context, so the counters and verification outcome must be on the context (F-01).

### F-06 (M) Pull mode never forwards `executionOptions`
`NextProjectRunStepRequest.executionOptions` is declared (`step-types.ts:41`) but `project-run-step.ts` never reads it, and `reconstructResumeContext` is called without it. `AgentDispatchRequest.options.timeout_ms` therefore never reaches a pull-mode host today. FR-023 ("`options.timeout_ms` from the envelope") needs a new carrier, and even then the timeout is **host-enforced (E3)**: in pull mode the engine only has `dispatchTtlMs`.

### F-07 (C) The existing resume path re-dispatches and resets engine counters for any suspended execution
`reconstructResumeContext` (`project-run.ts:624–791`):
- `state` becomes `suspended_from` (`:700–703`);
- for `RE_REVIEW`/`CONVERGE` always, and for `SPECIFY…IMPLEMENT/INDEPENDENT_REVIEW/REMEDIATION` when the saved result is still blocking (`:537–559`, `:572–583`), the saved result is **cleared** (`:766`), so the responsible agent is **re-dispatched**;
- `remediation_iteration` is reset to 0 for every re-verified state except `REMEDIATION` (`:723–726`, the E-2 behaviour).
Reachable from `nextProjectRunStep` in two branches: `HUMAN_INTERVENTION_REQUIRED` with `humanAnswers` (`project-run-step.ts:289`) and the `IN_PROGRESS`/default branch (`:320`), and from the push `executeProjectResume`.

### F-08 (C) Probe 2: a human answer causes a new dispatch outside any Harness control
After a `BLOCKED` IMPLEMENT result, `nextProjectRunStep({humanAnswers})` returned `AGENT_ACTION_REQUIRED` for IMPLEMENT with a **new `step_id`**, `history` showed two IMPLEMENT dispatches against one applied step, `human_answers` was kept and `human_intervention` was dropped. For a Harness execution suspended from `REMEDIATION` (for example `VALIDATOR_ERROR` or `DISPATCH_TIMEOUT`) the same path would dispatch a remediation **without the write-ahead counter increment**, and, from `RE_REVIEW`, would reset the engine's counter and re-dispatch the reviewer without validators. That defeats FR-041…FR-046 and FR-045 ("a human answer never changes the budget"). This is the concrete form of R-14.

### F-09 (H) Suspension questions are derived inside `checkpoint()` from `reason` and `findings`
`coordinator.ts:201–210` builds `human_intervention` with `deriveHumanQuestions(reason, findings)` (`human-intervention.ts:111–130`). With no findings the host receives one generic question `intervention-required` whose text is the reason. `HarnessSuspension.options` cannot be expressed unless `questions` can be supplied. The existing validation (`human-answer-validation.ts`, `cdd4d41`) checks answers against exactly those questions; it is audit-trail hygiene and does not itself advance anything (its header says so), which is compatible with the Harness rule that free text never changes state.

### F-10 (M) A pending action is persisted verbatim, unscrubbed
`pending_action.request` (`coordinator.ts:482–488`) includes `context`, and `scrubSecrets` only covers `state.context`. A `ReviewRequest` that inlined diffs or log excerpts would put payloads (and possibly secrets) into the checkpoint, contradicting FR-054 and the "payload-free events" rule. `AgentResult` has only `evidence: unknown[]` and `metadata` (an index-signature record, `domain/types.ts:173`) as carriers; the engine validates only `execution_id` on submit (`project-run-step.ts:522`).

### F-11 (M) Pull-mode submit order constrains where Harness validation can sit
`submit` validates stale/identity first (`:496–529`), then `applyExternalResult` (`:566`, which checkpoints and **clears the pending action**), then `prepareNextAction` (`:569`). Harness-level rejection (FR-068), the envelope refusal (§2a) and the baseline/diff inspection must run **before** line 566; otherwise a rejected result is already applied. The unlocked read-only pass (`:189`) returns a pending action verbatim (`:256–275`) and would also need the envelope check; moving a pending action into `heldAction` is a write, so that pass must answer "needs lock" (`needsLock`, `:205`).

### F-12 (M) `bootstrap.ts` / `doctor.ts`: no policy discovery, and diagnostics are fs-only and publicly typed
- `runProjectInit` writes `.project-run/config.json` and `.agents/skills`; it does **not** touch `.gitignore`; `--force` overwrites `config.json` non-atomically (`fs.writeFileSync`), a protected path (E2 only).
- `loadProjectConfig` reads `config.json`/`workflow.json` only; the `SkillResolver` search paths are `.project-run/skills`, `.agents/skills`. `.project-run/harness/policy.json` collides with nothing (OD-5 location confirmed).
- `runProjectDoctor` is documented as non-spawning and read-only; its return type `ProjectDoctorReport` is public. A `git check-ignore` evidence-directory check (FR-058, AS-90) needs git, which only the `SnapshotProvider` port will have; adding a field to `ProjectDoctorReport` also changes a public type (see F-14).
- `context-discovery.ts` treats a lone `specs/<dir>` as the active feature; with `specs/harness-mvp/` present, running the engine **in this repository** without an explicit feature would pick it. Harmless, noted.

### F-13 (M) Smaller facts that the spec should state
- `created_at` is rewritten on every save (`coordinator.ts:244`); audit timestamps must come from Harness events, not from the checkpoint.
- `tests/phase5-history.test.ts:124` asserts every dispatch has exactly one applied agent step. A Harness-abandoned or timed-out action (`abandonPendingAction`) breaks that pairing for Harness executions.
- The lock is held for the whole turn (`runLockedTurn`), default wait 30 s (`state-store.ts` lock options). Validators run inside a submit turn, so a human `revokeEnvelope` during a long validator run returns the non-terminal `EXECUTION_LOCKED` until the validator ends or times out; and `SIGKILL` of the engine leaves the lock reclaimable (pid probe) while a spawned validator may still be running, so a recovery turn could start a second validator on the same workspace.
- The CLI `engine` transport forwards a JSON payload to `nextProjectRunStep`/`submitProjectRunStep` (`project-run-cli.ts:199–200`), so any new request field becomes reachable from the CLI.

### F-14 (H) Public surface: the plan promises no new public types, but two exported interfaces must change
`PersistedExecutionState` (project barrel) and `CoordinatorExecutionContext` (decision barrel) are exported and have no index signature. Carrying the block requires adding an optional field to both. That is source-compatible but is a public type change, which conflicts with FR-077 / SC-011 as worded ("no new public types", surface byte-identical). Similarly `ProjectRunHostResponse` (status) and `ProjectDoctorReport` (doctor) cannot carry Harness status/diagnostics without changing exported types.

## 4. Contract-by-contract review

### `harness-controller.md` §2a (pending action vs envelope validity)
- Correct: the engine **does** clear `pending_action` on any non-awaiting checkpoint (`coordinator.ts:237–242`), so holding it in `harness.cycle.heldAction` is necessary, not stylistic.
- Needs: the refusal and the move to `heldAction` happen before `applyExternalResult` (F-11); the read-only pass must return `needsLock` (F-11); restoring a held action needs a Coordinator hook to checkpoint `AWAITING_AGENT_ACTION` with a literal `PersistedPendingAction` (F-03); the Harness controller must be reached from **every** path in F-07/F-08, otherwise §2a is bypassable.
- Verdict: sound after C-02 and C-04.

### `harness-controller.md` §3a (projection table)
- Missing at-rest rows (F-02): `(INDEPENDENT_REVIEW|RE_REVIEW|REMEDIATION, IN_PROGRESS, none)` for steps `REVIEW_PENDING`/`REMEDIATION_PENDING` **before** dispatch, and `(IMPLEMENT, IN_PROGRESS, none)` for `IMPLEMENTATION_PENDING` before dispatch (distinguishable from `TASK_ELIGIBILITY_CHECK` only by the presence of `harness.cycle`).
- Correct as written: `VERIFICATION_PENDING` and `FINDINGS_EVALUATION` (the engine really does persist `(IMPLEMENT, IN_PROGRESS, none, last_result)` after an applied result); `SUSPENDED` with engine `HUMAN_INTERVENTION_REQUIRED`.
- Verdict: **amend** (C-01).

### `path-matching.md`
- 23 of the 30 vectors are pure matcher cases; a throw-away reference matcher (kept in the scratchpad, not in the repo) gave 0 mismatches on them plus the 4 invalid-pattern cases. Vectors 22, 23, 24, 26 need real files (symlinks, NFC bytes, case collisions) and stay untested until Gate B.
- No existing code conflicts: nothing in the repo implements a glob; `context-discovery` uses plain `fs`; `lstat`/`readlink` are in `node:fs`. Git-listing needs the process port.
- Verdict: sound; tests listed in section 7.

### `authorization-envelope.md` §0 (logical enforcement vs technical prevention)
- Verified consistent with the code: the agent-facing API is `AgentResult` only (`step-types.ts`); there is no authenticated identity anywhere; the engine has no spawn and no sandbox; `HostExecutionOptions.timeout_ms` is advisory to the host (F-06).
- Two wording notes: (1) the mandatory protected set includes `.project-run/config.json`, and `init --force` overwrites it (F-12), an E2 case worth listing; (2) `Actor.authenticated: false` and `authorizationId` must never be placed under `context` (F-01).
- Verdict: sound.

## 5. X7, R-13, R-14

- **X7** (unread files): partially closed. Read and now evidenced: the Coordinator, the pull API, resume reconstruction, the store save/validate path, `human-intervention`, `human-answer-validation`, `locked-turn`. Still unread: items under "Not read" in section 1. None of them is on the path of any finding above, but the claim "no other path writes checkpoints" rests on a grep (`src/coordinator/coordinator.ts:213` is the only `save(` besides `project-run.ts:746`), not on a full read.
- **R-13** (resume reconstruction vs `HarnessStep`): **confirmed and refined**. Reconstruction sets `state = suspended_from` and clears results by its own rules (F-07); the Harness cannot rely on it. The safe design is that Harness executions never pass through `reconstructResumeContext` (C-03).
- **R-14** (human-answer revalidation, `cdd4d41`): **confirmed, critical** (F-08). The revalidation is correct for the engine's own workflow but is exactly the mechanism that re-dispatches and resets counters; the validation half (`validateHumanAnswers`) is reusable as is.

## 6. Proposed corrections (not applied; need owner decision before any implementation)

| ID | Proposal | Amends | Resolves |
|---|---|---|---|
| **C-01** | Extend §3a with the pre-dispatch rows and state the rule "`IN_PROGRESS` + `harness.cycle` present ⇒ the step names what the controller does next"; add the probe-1 sequence as a normative example; SC-010/AS-85 enumerate it | `harness-controller.md` §3a, SC-010, AS-85, AS-86 | F-02 |
| **C-02** | List the **delegation points** explicitly: every branch of `nextProjectRunStepImpl`; `submitProjectRunStepUnlocked` before `applyExternalResult`; the unlocked read pass (returns `needsLock` when a move to `heldAction` is needed); and the human-only operations | controller §1/§2a, T032 | F-11 |
| **C-03** | **Harness executions are pull-only and never pass through `reconstructResumeContext`**: `executeProjectRun`/`executeProjectResume`/`ProjectRunHost`, the push CLI paths and `reconstructResumeContext` fail closed for an execution with a `harness` block (`HARNESS_REQUIRES_PULL_API`). Human answers on such an execution are validated with `validateHumanAnswers` and recorded (audit only), then the controller re-evaluates; they never trigger a dispatch or touch counters. Replace "push and pull identical" (FR-072, AS-41, AS-42) with "push entry points refuse Harness executions" | FR-072, AS-41, AS-42, controller §1, NG list (add "push mode for Harness executions") | F-04, F-07, F-08 |
| **C-04** | Add explicit **Coordinator extension points** as additive, behaviour-preserving changes with regression tests: `beforeDispatchCheckpoint(context, decision, stepId)`; an atomic accept-and-advance method; a `questions` override for suspensions; carrying `context.harness` in `checkpoint()`. Update plan §3 touch points and tasks (new task before T030) | plan §3, tasks T027–T030 | F-01, F-03, F-09 |
| **C-05** | Select the Harness preset in `buildStepCoordinator` from the `harness` block (not from `preset`); state that `preset` stays an unused label | D-10, plan §3 | F-05 |
| **C-06** | **Public surface decision (OD-10)**: permit exactly one optional field `harness?: unknown` on `PersistedExecutionState` and on `CoordinatorExecutionContext` (typed internally), nothing else; reword FR-077/SC-011/AS-49 to "no new exported **names**, no new exports/subpaths/bin; the only public type change is that optional field"; keep `ProjectRunHostResponse` and `ProjectDoctorReport` unchanged and put Harness status/diagnostics in internal functions; re-scope AS-90's `doctor` warning to an internal check using the `SnapshotProvider` (`git check-ignore`) | FR-077, SC-011, AS-49, AS-90, T033 | F-12, F-14 |
| **C-07** | State the **transport**: Harness payloads ride in `AgentResult.metadata.harness` / `evidence` and are validated by the controller; dispatch requests carry **references and digests only** (never diffs, logs, secrets) because `pending_action.request` is persisted unscrubbed; the host reads content from evidence files | review-contract, FR-054, FR-019 | F-10 |
| **C-08** | FR-023: the dispatch hook sets `request.options.timeout_ms`; classify the timeout as **host-enforced (E3)**; `dispatchTtlMs` is the only engine-side bound | FR-023, FR-067, envelope §0 | F-06 |
| **C-09** | Validator recovery: record the process-group id and run id under the evidence directory; before re-running after a crash the executor checks that no process of the previous run is alive (`STALE_VALIDATOR_PROCESS` suspension otherwise) | verification-pipeline §3, controller R8 | F-13 |
| **C-10** | Document that long validator runs hold the execution lock; human operations that need it wait or get `EXECUTION_LOCKED`; validator timeouts bound this; revocation during a run takes effect at the next boundary | controller §2, risk R-21 | F-13 |
| **C-11** | For Harness executions the dispatch↔`AGENT_STEP` pairing (`tests/phase5-history.test.ts:124`) may not hold after an abandoned or timed-out action; record these only as Harness events and document the exception; do not add a `step_log` kind (public union) | data-model, evidence-ledger | F-13 |
| **C-12** | State that checkpoint `created_at` is not stable and that the Harness never uses it; keep the block outside `context` | evidence-ledger §2 | F-01, F-13 |
| **C-13** | Add `.project-run/config.json` overwrite by `init --force` to the E2 examples; add a policy loader (`loadHarnessPolicy`) as new internal code, with explicit "no discovery exists today" | envelope §0/§1, plan | F-12 |

## 7. Tests required (proposed scenarios; ids are provisional and not yet in `acceptance-scenarios.md`)

| ID | Test | Covers |
|---|---|---|
| PT-01 | Carry-forward across **every** checkpoint path: start, next, submit, resume-with-answers, the answers-only save at `project-run.ts:746`, failure marker; a `harness` marker injected before each must survive | F-01 |
| PT-02 | Existing non-Harness checkpoints are byte-identical (modulo timestamps and ids) after the Coordinator extension points exist | C-04, SC-005 |
| PT-03 | Sequence test of one submit (the probe-1 sequence) for a Harness execution: every intermediate at-rest tuple is in the amended table; crash-injection after each save recovers | F-02, C-01 |
| PT-04 | Atomic accept-and-advance: a failed or conflicting save leaves no `TASK_ACCEPTED` and no state change | F-03 |
| PT-05 | Write-ahead: counter increment and pending action appear in the same revision; a failed dispatch checkpoint leaves the counter unchanged | F-03, FR-042 |
| PT-06 | A Harness execution passed to `executeProjectRun`, `executeProjectResume`, `ProjectRunHost.start/resume`, and `reconstructResumeContext` is refused with no write | F-04, F-07, C-03 |
| PT-07 | Probe-2 as a regression: a human answer on a Harness execution suspended from `REMEDIATION`/`RE_REVIEW`/`IMPLEMENT` records the answer, **dispatches nothing**, leaves counters and `remediation_iteration` unchanged | F-08 |
| PT-08 | Preset selection: a Harness execution gets the Harness preset regardless of `preset` label (`"v1"`, `"spec-kit-v1"`, missing) | F-05 |
| PT-09 | Read-only pass returns `needsLock` for an invalid envelope with a pending action; the locked pass moves it to `heldAction`; submit is refused before `applyExternalResult` | F-11 |
| PT-10 | Restoring `heldAction` produces an engine `pending_action` with the original `step_id`, and a result for it is accepted once | §2a |
| PT-11 | `pending_action.request.context` contains only references/digests (size bound, no diff text) in the fixture | F-10, C-07 |
| PT-12 | Suspension questions for each `SuspensionReason` reach the host and `validateHumanAnswers` accepts answers to them | F-09 |
| PT-13 | `request.options.timeout_ms` present in Harness dispatches; absent for non-Harness (unchanged) | F-06 |
| PT-14 | Orphan validator after `SIGKILL` of the engine ⇒ `STALE_VALIDATOR_PROCESS` | C-09 |
| PT-15 | Revoke during a running validator returns `EXECUTION_LOCKED` and succeeds after the timeout | C-10 |
| PT-16 | Package surface: `exports`/`bin`/`files` byte-identical; exported type diff limited to the one optional field | C-06 |
| PT-17 | `scrubSecrets` does not touch the Harness block; a test places Harness names under `context` and proves the redaction hazard is documented | F-01 |
| PT-18 | The 7 path-matching vectors needing real files (22, 23, 24, 26 and symlinked parents) on a temp repo | path-matching |

## 8. Decisions requested

- **OD-10** (C-06): allow one optional `harness?: unknown` field on the two exported interfaces, with the reworded FR-077/SC-011. Alternative: keep the block outside both interfaces, which would require a second persisted file and reopen D-09.
- **OD-11** (C-03): Harness executions are **pull-only**; push entry points refuse them.
- **OD-12** (C-04): accept additive Coordinator extension points (behaviour-preserving, regression-tested) as part of Gate B scope.
- **OD-13** (C-11): accept that the dispatch↔step pairing does not hold for Harness executions after abandonment/timeout.

None of these has been applied to the specification. They need your decision before the spec is corrected, and the corrected spec needs a re-run of the consistency analysis.

## 9. What this review does not establish

It does not prove the Harness is implementable beyond the points above; it does not review the unread files in section 1; it does not run the existing suite again; and it does not close T049. Probes 1 and 2 used an in-memory store and a throw-away repository, not the file store's lock or CAS paths, which the existing multi-process tests already cover.

## 10. Follow-up read-only inspection of the areas listed as "Not read" in §1 (revision 4)

Added 2026-10-15 under the owner's instruction to complete the review. Same method as §1 (source reading plus one more throw-away probe outside the repository). Sections 1–9 are unchanged. `src/`, `tests/` and `package.json` were verified unchanged against `HEAD` before and after. **T049 is not closed by this section.** Line numbers refer to the current files.

| ID | File and symbol | Observed behaviour (source) | Effect on revision 4 |
|---|---|---|---|
| F-15 | `src/agents/agent-dispatcher.ts` `prepareRequest` (57–132), `dispatch` (134–159) | Resolves role/runtime through the registry, **mutates the incoming request in place** (`capability`, `skill`, `skill_metadata`, `skills`, `required_skills`), validates required skills with `SkillValidator.validateRole` (throws `SkillValidationError`), returns the same object; `dispatch` additionally needs a runtime adapter | **Confirms** that requests can be prepared without an adapter (controller §6.1a). **Correction applied**: a fresh transient request per dispatch, never reused |
| F-16 | `src/runtime/host-execution-contract.ts` `executeWithHostGuards` (148–289) | Push-only wrapper (used by `HostDispatchAdapter`): `timeout_ms` by `Promise.race`, cancellation by `AbortSignal`, lifecycle callbacks; writes back **one merged object to both `metadata` and `execution_metadata`** (250–262) | **Confirms** FR-023 (pull mode never calls it, so timeouts are host-enforced). **Correction applied**: closed schema rules for `execution_metadata` (`result-validation.md` §4, FR-109, AS-135, E-20) |
| F-17 | `src/host/project-run-host.ts` `startProjectRun` (244–274), `resumeProjectRun` (285–305), `buildHostResponse` (130–233); `src/host/status.ts` | Thin wrappers over `executeProjectRun`/`executeProjectResume`. `startProjectRun` passes no `baseRevision`; push responses **recompute** `humanIntervention` with `deriveHumanQuestions` (151–166), whereas `statusProjectRun` returns the **persisted** `human_intervention` (recomputing only when absent) | **Confirms** E-14 and that the questions override reaches hosts through the public status. **Contradicts an implicit assumption**: the push entry guard cannot rely on a record already loaded (next row) |
| F-18 | probe 3 (scratchpad, in-memory store, `dist/`) + `project-run.ts:296–309`; **later found documented in `ARCHITECTURE.md` §4.17.2 and pinned by `tests/state-store-contract.test.ts:542–577`** (see §12) | `startProjectRun` with the id of an existing execution took the lock, then its first save had `expectedRevision = undefined`: the existing checkpoint was **overwritten** (state, pending action, `harness` key and history reset) | **Contradicts** the revision-4 wording "entry guards on loaded records" for `executeProjectRun`. **Correction applied**: guard loads the record under the lock before the first save (FR-097, E-19, AS-133, T051); risk R-30 added. Existing non-Harness behaviour is to be preserved, not fixed |
| F-19 | `src/cli/project-run-cli.ts` (`run`, `resume`, `engine start|resume|status` → push functions; `engine next-step|submit-step` → pull API, payload forwarded as `{...payload, projectRoot}` at ≈ 199–200) | The CLI adds no logic of its own; any new request field of the pull API becomes reachable from the CLI; `executionOptions` in a payload is ignored by the pull path | **Confirms** FR-095 and F-06 assumptions; no change |
| F-20 | `src/project/bootstrap.ts` ≈ 200–357 | Second half is skill installation from `templates/skills` into `.agents/skills`; `--force` overwrites skills and `config.json` (non-atomic `writeFileSync`); no `.gitignore` handling; no policy discovery | **Confirms** F-12. **New**: skill search paths (`project-config.ts:292`) are not in the mandatory protected set ⇒ **OD-18 proposed, not applied** |
| F-21 | `src/project/doctor.ts` 140–297 | Role/skill/runtime checks and report formatting only; no git, no process spawn, no ignore check | **Confirms** FR-058 (an internal `harnessDoctor` with the `SnapshotProvider` port is needed) |
| F-22 | `templates/host-integrations/claude-code/project-engine-run/SKILL.md` steps 4–6 (≈ 150–190) | Tells the host to present questions, resume with `next-step` + `humanAnswers`, expect `AGENT_ACTION_REQUIRED`, and ask the user to clarify further if the suspension persists | **Confirms** FR-095; **new risk** R-31: a Harness suspension returns the same suspension after answers, so a host following this text would loop. **Correction applied**: `HARNESS_SUSPENSION:` reason prefix (controller §4, AS-134) and T048 includes updating this text |
| F-23 | tests: `public-api-surface.test.ts`, `package-boundary.test.ts` (150–181), `phase5-history.test.ts` (108–135), `state-store.test.ts` (116–137), titles of `project-run-step-api.test.ts` | Runtime-export and consumer-type-fixture mechanisms exist; the boundary test allows only `node:fs`/`node:path`; the dispatch↔step pairing (with `step_id` link) is asserted; `scrubSecrets` is tested for `context` only; **no test found** that preserves unknown checkpoint fields or references `executeWithHostGuards`/`timeout_ms`/`HostTimeoutError` (the same-id push start **is** pinned by `state-store-contract.test.ts:542–577`, see §12) | **Confirms** the test mechanisms assumed for FR-105/AS-112 and the need for PT-01/AS-97; coverage of timeouts is **unknown** (no test found) |
| F-24 | re-read of `coordinator.ts`, `project-run-step.ts`, `project-run.ts`, `state-store.ts` lines cited in §3 (213–244, 227, 237–242, 367, 489; 189, 522, 566, 602, 614; 296–309, 723–726, 746, 766; 420–422) | Every cited line was re-opened and matches the description in §3 | **Confirms** F-01…F-11 against the current source |

**Still not read, or read only partially**: the test files other than the portions named above (titles and targeted lines only: no full read of `resume.test.ts`, `human-answers-*`, `host-api.test.ts`, `phase5-locking.test.ts`, `checkpoint-save-failures.test.ts`); `src/host/project-engine-run.ts` (read by grep of its dispatch only); `src/agents/agent-registry.ts`, `default-agent-registry.ts`, `src/skills/*`, `src/presets/*`, `src/project/context-discovery.ts` beyond lines already cited; the 0.4.x/0.5.0 documents (`ARCHITECTURE.md` §4.x) beyond the lines cited. No test, build or type-check was run in this follow-up.

## 11. Confrontation of the complete report with the remaining code and tests (revision 4, second follow-up)

Added 2026-10-15 at the owner's request ("confront the complete report with the code and the remaining tests; record divergences; present the evidence for an explicit closing decision"). Method: source reading, targeted test reading, three throw-away probes against `dist/` (scratchpad, in-memory store, never in the repository). `src/`, `tests/` and `package.json` verified unchanged against `HEAD` before and after. **No test, build or type-check was run.** This section does **not** close T049; the closing decision is the owner's.

### 11.1 Findings of §3 and §10 against code and tests

Verdicts: **C** confirmed by source; **C+T** also exercised by an existing test; **C−T** confirmed by source, no existing test found; **U** unproven; **D** divergence between a specification statement and the code (corrected in the artifacts).

| ID | Claim | Source evidence (re-opened this step) | Existing test evidence | Verdict |
|---|---|---|---|---|
| F-01 | Checkpoint built field by field; unknown fields dropped | `coordinator.ts:213–244`; `state-store.ts:420` spreads only what it is given | none found for unknown-field preservation; `human-answers-*` and `resume` tests only check known fields | C−T (probe 1) |
| F-02 | One submit writes three checkpoints; transitional `IN_PROGRESS` tuples exist | `coordinator.ts:352–375, 499–508, 489` | `checkpoint-save-failures.test.ts:170` ("failing ANY single save … always recoverable"), `:221` (failure after the result was applied; next-step recovers) | C+T (the engine recovers; mechanism reusable for AS-99) |
| F-03 | `checkpoint()` private; atomic accept needs a new method | `coordinator.ts:148` | n/a | C |
| F-04 | Push mode has no durable pending action | `coordinator.ts:297–313` | `human-answers-resume-push-mode.test.ts` shows push re-dispatch semantics only; the absence of a durable pending action is shown by source, not by a test | C |
| F-05 | Pull API hard-wires the default engine; `preset` is a label | `project-run-step.ts:602, 614`; `project-run.ts:476` | `workflow-presets.test.ts` injects a custom preset only into a push `Coordinator`, never through the pull path | C+T (confirms the injection mechanism, and its absence in pull) |
| F-06 | `executionOptions` declared but not forwarded in pull | `step-types.ts:41`; no use in `project-run-step.ts` | none found | C−T |
| F-07 | Resume clears results, resets `remediation_iteration`, re-dispatches | `project-run.ts:700–726, 766` | `human-answers-resume-stages.test.ts` (all ten stages; clean result cleared for `RE_REVIEW`/`CONVERGE`; remediation budget kept for a blocked `REMEDIATION`, lines 257–311), `resume.test.ts` (F-2 regression) | C+T (these tests are the **non-Harness control** for AS-103/AS-98) |
| F-08 | A human answer causes a new dispatch outside any Harness control | probe 2; same code | `human-answers-resume-stages.test.ts:145–186` asserts exactly this for the engine | C+T |
| F-09 | Suspension questions derived inside `checkpoint()` | `coordinator.ts:201–210`; `human-intervention.ts:111` | `host-status-and-restart.test.ts:119` ("exact persisted questions, not a recomputation that could drift"), `human-intervention-contract.test.ts` | C+T |
| F-10 | `pending_action.request` persisted unscrubbed; `scrubSecrets` covers `context` only | `coordinator.ts:482–488`; `state-store.ts:422` | `state-store.test.ts:116–137` covers `context` only | C+T (scope as stated) |
| F-11 | Submit applies the result before validation points; read pass answers from what it read | `project-run-step.ts:496–569, 189–205` | `phase5-locking.test.ts:1095` (matrix: pure-read states take no lock and write nothing), `:1124`, `:1143`, `:453–530` (submit races, `STALE_STEP`) | C+T |
| F-12 | No policy discovery; bootstrap/doctor limits | `bootstrap.ts` lines 80–200 read, 200–357 inspected by grep of file operations; `doctor.ts` lines 1–140 read, 140–297 inspected by grep (no git/spawn/ignore handling found) | `project-init.test.ts` exists (not read) | C (partial read) |
| F-13 | `created_at` rewritten; lock wait 30 s; validators under lock; CLI forwards payload | `coordinator.ts:244`; `state-store.ts:141, 528`; `project-run-cli.ts` ≈ 199–200 | `phase5-locking.test.ts:277` (`EXECUTION_LOCKED` timeout), `:295` (SIGKILL reclaim), `:621` (kill and recover) | C+T |
| F-14 | Exported interfaces must change to carry the block | `project/index.ts:8` (`export * from "./state-store.js"`), `decision/index.ts:3` | `public-api-surface.test.ts` and `tests/fixtures/consumer-types/*` give the mechanism | C+T (mechanism) |
| F-15…F-24 | see §10 | re-opened | see §10 | C / C−T as listed there |

### 11.2 Divergences between the specification and the code found in this step (all corrected in the artifacts)

| ID | Divergence | Evidence | Correction |
|---|---|---|---|
| X-1 | The Harness preset was said to inherit `getExpectedOutput`; `SpecKitV1Preset` defines only `getSkillsForRole` and `getStateSkillConfig` (no `getExpectedOutput`, `validStates`, `allowedTransitions`, `stateToRole`) | `spec-kit-preset.ts:357–365`; fallback `decision-engine.ts:343–345` | controller §3 and D-10 reworded |
| X-2 | FR-108 treated the dispatch↔step pairing as a test detail; it is a **documented contract** that allows only a *trailing* unmatched dispatch | `ARCHITECTURE.md` §4.17 (table row "Relationship"), `phase5-history.test.ts:124–134` | FR-108, E-17, AS-116 rewritten (pair by `step_id`); `ARCHITECTURE.md` §4.17 amendment added to T041 |
| X-3 | The push entry guard was assumed to rely on an already loaded record | `project-run.ts:296–309`; probe 3; documented in `ARCHITECTURE.md` §4.17.2; pinned by `state-store-contract.test.ts:542–577` | FR-097, E-19, AS-133, T051, R-30 (done earlier; the documentation and test evidence were added in §12) |
| X-4 | The closed schema left room for two diverging metadata copies | `host-execution-contract.ts:250–262` | `result-validation.md` §4, AS-135 (previous step) |

No divergence contradicts a conclusion of §3; each concerns a detail of how the specification described the code.

### 11.3 Reusable test techniques found (inputs for the Gate B test tasks, not implemented)

| Needed by | Existing technique (file) |
|---|---|
| AS-99/PT-03 crash windows | wrapper that fails the Nth save and asserts recoverability (`checkpoint-save-failures.test.ts:170`, `MemoryExecutionStateStore.failNextSave` in `tests/helpers/memory-store.ts`) |
| AS-37/R18/PT-14 process kill | real child processes with `SIGKILL` and stale-lock reclaim (`phase5-locking.test.ts:295, 621`) |
| PT-09 read pass writes nothing | the read/write matrix (`phase5-locking.test.ts:1095`) |
| AS-98/PT-02 non-Harness regression, AS-103 control | the whole existing suite, in particular `human-answers-resume-stages.test.ts` |
| AS-112/PT-16 type surface | `public-api-surface.test.ts` plus `tests/fixtures/consumer-types/*` |
| AS-133 same-id start | the **non-Harness control already exists**: `state-store-contract.test.ts:542–577` (restart/overwrite pinned); `phase5-locking.test.ts:980` covers "refused when the lock is held"; no test exists for a **Harness** record (new) |

### 11.4 What is still not read (the review is **not** exhaustive; updated by §12.1: `bootstrap.ts` and `doctor.ts` are now fully read, and several test ranges were added)

Bodies of: `resume.test.ts` (titles only), `checkpoint-save-failures.test.ts` (titles and the cited ranges only), `phase5-locking.test.ts` (titles only except cited ranges), `execution-record.test.ts`, `state-store-contract.test.ts`, `state-store.test.ts` (except 116–137), `human-answers-validation*.test.ts`, `human-answers-concurrency-processes.test.ts`, `human-intervention-contract.test.ts`, `blocked-status-semantics.test.ts`, `cli-*.test.ts`, `project-init.test.ts`, `host-api.test.ts` (titles), `skill-validator.test.ts`, `context-discovery.test.ts`, `runtime-default-resolution.test.ts`, `config-skill-requirement-precedence.test.ts`, the `*-safety-gate` tests; `src/skills/skill-validator.ts` and `skill-resolver.ts` (read by grep of their filesystem calls and `validateRole`), `src/presets/spec-kit-preset.ts` (grep and lines 357–365), `src/agents/default-agent-registry.ts` (grep), `src/project/context-discovery.ts` beyond lines already cited, `src/project/project-config.ts` beyond lines already cited, `ARCHITECTURE.md` except §4.4, §4.15, §4.17 (partly) and the lines cited; the other `docs/*.md` contracts (`state-machine.md`, `transition-contract.md`, …). Runtime behaviour was exercised only through three in-memory probes; the file store lock/CAS paths and any real host were not exercised by me.

### 11.5 Statement for the closing decision

On the evidence above every finding F-01…F-24 is confirmed by source (F-12 and F-20/F-21 were on a partial read of `bootstrap.ts`/`doctor.ts`; §12.1 completes it), nine of the fourteen rows of §11.1 are also exercised by an existing test, and four small divergences (X-1…X-4) were found and corrected in the specification. Items that remain unproven are listed in §11.4 and in `analysis.md`. Whether that is sufficient to close T049 is the owner's decision; **T049 stays open and unticked**.

## 12. Third pass: additional reading against the owner's closing criteria

Added 2026-10-15. The owner stated that T049 can be closed when the additional reading reveals no **material** contradictions, the known gaps are documented with their evidence, and the remaining risks are clearly delimited; a full audit of the code base is not required, but the reviewed scope must be sufficient to support the conclusion. This section applies those criteria. **T049 remains open and unticked.** `src/`, `tests/` and `package.json` were verified unchanged against `HEAD`; no test, build or type-check was run.

### 12.1 Read in this pass

| Area | Extent |
|---|---|
| `src/project/bootstrap.ts` 196–357 and `src/project/doctor.ts` 138–297 | **in full** (with the first halves read earlier, both files are now fully read) |
| `src/skills/skill-validator.ts`, `skill-resolver.ts` | targeted: `validateRole` and the filesystem calls (search paths, `SKILL.md` frontmatter) |
| `tests/state-store-contract.test.ts` | titles; lines 388–418 and 538–577 in full |
| `tests/execution-record.test.ts` | titles; lines 358–419 in full |
| `tests/checkpoint-save-failures.test.ts` | lines 100–250 in full (the fault-injection driver, the exhaustive single-save failure loop, the two submit-failure cases) |
| `tests/human-answers-validation-lifecycle.test.ts`, `project-init.test.ts`, `context-discovery.test.ts`, `cli-engine-step-transport.test.ts` | titles only |
| `tests/phase5-locking.test.ts` | the read/write matrix (1095 ff., by grep of its assertions) |
| `ARCHITECTURE.md` §4.17.2 (lines 982–998), `docs/transition-contract.md` (the section before "Transition Persistence") | cited passages |

### 12.2 Results

| ID | Result | Evidence | Effect |
|---|---|---|---|
| Z-1 | **Correction of an earlier statement of mine.** The same-id push start restart/overwrite (E-19) is **documented** (`ARCHITECTURE.md` §4.17.2: "What is *not* revision-protected: the initial push `start`") and **pinned by an existing test** (`state-store-contract.test.ts:542–577`). My statements in §10/§11 that no such test exists were wrong | `ARCHITECTURE.md` 984–996; the test body | §10 F-18, §11.2 X-3 and §11.3 corrected; E-19, AS-133 and R-30 cite the documentation and the test as the **non-Harness regression control**. The conclusion is unchanged: a Harness execution needs the load-under-lock guard |
| Z-2 | **Precision, X-5.** A late or duplicate submit is `STALE_STEP` only when a **different** action is pending; with no pending action it is `NO_PENDING_ACTION` (`project-run-step.ts:496–516`; `checkpoint-save-failures.test.ts:235–236`). Several specification statements said `STALE_STEP` for no-pending-action situations (abandoned, adoption-closed, recovery window) | source + test | FR-075, AS-43, AS-106, AS-118, AS-123, spec edge case, controller §11 and `result-validation.md` §3 corrected |
| Z-3 | **Reusable zero-write assertion.** `checkpoint-save-failures.test.ts:193–219` compares the durable record before and after a failed submit with deep equality ignoring only `updated_at`, and `FaultyStore.failOn(k)` fails the *k*-th save of a full lifecycle (170–191). `execution-record.test.ts:381–419` pins zero-effect rejections of stale/forged/no-pending/completed submissions, but asserts only `step_log` | test bodies | **Confirms** the class-A/OD-16 precedent and gives the technique for AS-99/AS-120. AS-120's whole-record and revision comparison is **stronger** than the existing precedent (documented as such) |
| Z-4 | `bootstrap.ts`/`doctor.ts` complete: `init` installs only missing skills; without `--force` a modified skill is a conflict and is never overwritten; with `--force` skills and `config.json` are overwritten; the doctor never touches git or processes | full read; `project-init.test.ts` titles | **Confirms** F-12/F-20/F-21 and OD-18 (applied) |
| Z-5 | Skill availability is evaluated from the search paths on **every** `prepareRequest` (`SkillValidator.validateRole` → `SkillResolver.resolveSkills`): a task diff that deletes or edits a required `SKILL.md` changes the next dispatch's validation and the agent's instructions | `skill-validator.ts`, `skill-resolver.ts` | **Supports** OD-18 (those paths are now protected, detection only) |
| Z-6 | `docs/transition-contract.md` requires rejecting any transition **from** `HUMAN_INTERVENTION_REQUIRED`; the engine's resume sets `state = suspended_from` outside the matrix (`project-run.ts:700–703`) | doc + source | Controller §8 wording: W12 is a *restoration*, mirroring the engine, not an exception to the matrix |
| Z-7 | No contradiction with a conclusion of §3, §10 or §11 was found; the only corrections concern my own wording (Z-1, Z-2) | — | — |

### 12.3 Assessment against the owner's criteria (an assessment, not a closure)

1. **No material contradictions.** None found in this pass. Two statements of mine were inaccurate (Z-1 test coverage, Z-2 error code) and are corrected; neither changes a design conclusion.
2. **Known gaps documented with evidence.** The claims with no existing test remain listed with their evidence: unknown-field preservation (probe 1), `executionOptions` not forwarded (source), `executeWithHostGuards` timeouts (no test found by grep), and the Harness-record variants of the same-id start. They rest on source reading and throw-away probes, and are covered by new scenarios (AS-97, AS-109, AS-133).
3. **Remaining risks delimited.** R-26, R-30 (hand-built `Coordinator`, legacy overwrite), R-31 (host skill), R-27 (provisional limits), R-28/R-29 (secret scan, class-A observability) and the unexercised nature of everything not yet implemented.
4. **Scope reviewed is a sample, not a census.** Still unread: the bodies of `resume.test.ts`, `phase5-locking.test.ts` (outside the cited ranges), `execution-record.test.ts` (outside 358–419), `state-store-contract.test.ts` (outside the cited ranges), `human-answers-validation*.test.ts`, `human-answers-concurrency-processes.test.ts`, `human-intervention-contract.test.ts`, `blocked-status-semantics.test.ts`, `cli-*.test.ts`, `skill-validator.test.ts`, `context-discovery.test.ts`, `runtime-default-resolution.test.ts`, `config-skill-requirement-precedence.test.ts`, the `*-safety-gate` tests; `src/presets/spec-kit-preset.ts` (grep and 357–365), `src/agents/default-agent-registry.ts` (grep), `src/project/context-discovery.ts`, `src/project/project-config.ts` beyond cited lines; `ARCHITECTURE.md` except §4.4, §4.15 and §4.17 (partly); the other `docs/*.md` contracts.
Whether that sample supports closing is the owner's decision.

## 13. Closing decision for T049

**Decision (owner, 2026-10-15):** T049 is closed on the basis of §10–§12. Recorded from the owner's instruction that T049 may be closed when the additional reading reveals no material contradictions, the known gaps are documented with their evidence and the remaining risks are clearly delimited, with a full audit of the code base explicitly **not** required, and that before marking the task complete the agent must record the decision and justification here, update the reference in `tasks.md`, preserve the limitations and the risks R-26…R-31, and confirm that only `specs/harness-mvp/` changed. Sections 1–12 are **unchanged evidence**; statements in them such as "T049 stays open" describe the state at the time they were written and are superseded for status purposes by this section only.

### 13.1 Justification (against the owner's criteria)
1. **No material contradiction.** Across §3, §10, §11 and §12 every finding F-01…F-24 was re-opened in the current source and matches; the divergences found (X-1…X-5, Z-1, Z-2) concerned how the specification *described* the code, not a design conclusion, and were corrected in the artifacts. The two inaccuracies in my own earlier wording (Z-1, Z-2) are recorded, not hidden.
2. **Known gaps documented with evidence.** Claims without an existing test: preservation of unknown checkpoint fields (probe 1), `executionOptions` not forwarded in pull mode (source), `executeWithHostGuards`/timeout behaviour (no test found by grep), and the behaviour of any *Harness* record. Each is covered by a specified, **not yet implemented** scenario (AS-97, AS-109, AS-133 and the PT-derived set).
3. **Remaining risks delimited.** R-26 (hand-built `Coordinator` can still rewrite a Harness record; detection only), R-27 (provisional result limits), R-28 (best-effort secret scan), R-29 (class A rejections leave no durable record), R-30 (legacy same-id push start overwrites a record; the guard is specified, not built), R-31 (host skill text must change before a host can drive a Harness execution).

### 13.2 Limitations preserved (what this closure does **not** claim)
- **Partial reading of tests and documentation.** The review is a sample, not a census. Unread or only partly read: most test bodies (`resume`, `phase5-locking`, `execution-record`, `state-store-contract`, `human-answers-validation*`, `human-answers-concurrency-processes`, `human-intervention-contract`, `blocked-status-semantics`, `cli-*`, `skill-validator`, `context-discovery`, `runtime-default-resolution`, `config-skill-requirement-precedence`, the `*-safety-gate` tests, outside the ranges cited in §11–§12), the `docs/*.md` contracts other than the cited passage of `transition-contract.md`, most of `ARCHITECTURE.md`, and parts of `src/presets`, `src/agents/default-agent-registry.ts`, `src/project/context-discovery.ts`, `src/project/project-config.ts` (§12.3 item 4 has the list).
- **Three in-memory probes only** (checkpoint sequence and unknown-field survival; human answer on a blocked stage; same-id push start), against `dist/` with an in-memory store and a temporary repository.
- **No real execution of the file store or of real hosts** by me: the file store's lock/CAS paths and hosts such as Claude Code were not exercised; the existing test suite was **not run** in this step (nor in any T049 step after the Phase 2 baseline of 428 passing tests).
- No claim that the engine is correct beyond the behaviours cited, and no claim that the Harness design works: nothing of it is implemented.

### 13.3 What stays pending (not affected by this closure)
- **All specified scenarios and tasks are pending implementation** (T003 and T050…T067 and the rest of Phase 2–9 tasks; AS-01…AS-135 are specification-level, none has been run).
- **T003 is not started; Gate B remains blocked**: it needs a new explicit owner authorisation (the Gate B request also re-confirms OD-10…OD-13). Closing T049 satisfies the prerequisite recorded for that request; it does not grant it.
- **Revision 4 remains uncommitted and unpushed**; committing needs its own authorisation.
- Risks R-26…R-31 and the open verification gaps of §12.3 item 4 remain in force as stated.

### 13.4 Addendum (status after this closure)
On 2026-10-15, after §13 was written, the owner authorised **Gate B** (isolated vertical slice only, with OD-10…OD-13 reconfirmed) and the **commit** of revision 4 as a documentation-only change. §13.3 describes the state at the moment of closure and is superseded for status purposes by this addendum. Gates C and D, push, PR, release and publication remain unauthorised.
