# T049: Pre-Gate-B Technical Review (read-only)

**Status**: report for owner review. **T049 is NOT ticked** and **Gate B remains blocked.**
**Update 2026-10-15 (revision 3)**: the owner authorised updating the specification artifacts with C-01…C-13 and PT-01…PT-18. They are now incorporated in spec revision 3 (see `analysis.md` §2 for the C→artifact map); some were **refined** while doing so (notably C-04: one `Coordinator.commit` instead of several hooks, which also removed the need to add a field to `CoordinatorExecutionContext`/`CoordinatorOptions`; and the OD-14 scope boundary). Nothing was implemented, and this report stays the record of the evidence. The findings, line numbers and probes below are unchanged.
**Baseline**: branch `docs/harness-mvp-spec` at `069f7e2` (spec) over code at `main` `c1e4054` / `v0.5.0`. No source, checkpoint, Incito or Feature 009 file was modified.
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
