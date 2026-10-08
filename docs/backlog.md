# Backlog: Future Host Integrations & Hardening

This tracks work deliberately **not** implemented yet, to keep `project-run-engine`'s
core provider-neutral and avoid speculative scope creep. See `ARCHITECTURE.md` §4.13
for how these fit the overall architecture, and `docs/phase-reports.md` for phase
history. None of these are scheduled; they are recorded so the engine's
provider-neutral boundary stays a deliberate choice, not an accidental gap.

**Host split**: *current* — Claude Code (live-validated in Phase 4) and Antigravity
(supported target; not yet live-validated). *Backlog* — Cursor, Codex, MCP.

## Host Integration — Antigravity

**Purpose**: Validate that the same provider-neutral pull contract
(`nextProjectRunStep`/`submitProjectRunStep`, or the push-based `ProjectRunHost`) can be
driven by an Antigravity host without changing any engine internals — the same proof
Phase 4 performed for Claude Code, but for the other long-standing supported runtime
identifier (`AgentRuntime` already includes `"ANTIGRAVITY"`).

**Not done**: No Antigravity-specific code, skill, or adapter exists in this repository.

## Host Integration — Cursor

**Purpose**: Validate the provider-neutral pull contract with Cursor, when Cursor is
available for testing. Conceptual integration notes already exist (`ARCHITECTURE.md`
§4.7–§4.8); no implementation.

## Host Integration — Codex

**Purpose**: Validate the provider-neutral pull contract with Codex, when Codex is
available for testing. Conceptual integration notes already exist (`ARCHITECTURE.md`
§4.7–§4.8); no implementation.

## MCP Transport

**Purpose**: Evaluate MCP as an optional transport/integration mechanism for hosts that
benefit from it (Cursor and Codex both commonly support it per `ARCHITECTURE.md` §4.7).
MCP must remain an **integration/transport concern** carrying the existing
`PROJECT_ENGINE_RUN_TOOL_SCHEMA`, never an engine architectural dependency — the engine
itself must never import an MCP SDK.

## Execution persistence under concurrent submission — ADDRESSED in Phase 5 (cross-machine / optimistic concurrency still DEFERRED)

**Original observation (kept for history)**: `FileExecutionStateStore` persisted with plain
file read/modify/write — no locking, no atomic replace, no optimistic-concurrency check.
Two near-simultaneous `submitProjectRunStep()` calls for the same pending action could
both pass validation (`STALE_STEP` etc.) before either wrote, and simultaneous writes from
independent hosts could race. It was deferred because only one host at a time had been
validated.

**Phase 5 outcome** (`ARCHITECTURE.md` §4.17; `tests/phase5-locking.test.ts`):
- Checkpoint writes are atomic (temp file + fsync + rename). Reproduced beforehand: a reader
  racing a writer in another process got "Unexpected end of JSON input" from `load()`.
- A per-execution advisory lock (`FileExecutionStateStore.withLock` / `withExecutionLock`)
  now serialises every mutating turn — `submitProjectRunStep`, mutating
  `nextProjectRunStep`, `resume`, and `start`/`executeProjectRun` with an id. Reads stay
  unlocked. Dead holders are reclaimed by pid probe; contention surfaces as a non-terminal
  `EXECUTION_LOCKED` failure, and an unusable runs directory as a non-terminal
  `EXECUTION_LOCK_UNAVAILABLE` (the engine fails closed rather than run unlocked). Verified
  with real OS processes, including SIGKILL.
- Duplicate-submission idempotency is preserved and is now race-proof.

**Still deferred (not decided, not scheduled)**:
- *Cross-machine / network-filesystem coordination.* The engine is limited to
  `node:fs`/`node:path`, so the lock is scoped to one machine and a local filesystem.
- *Optimistic concurrency / versioned writes or a database-backed store.* Revisit only if
  the advisory lock proves insufficient (e.g. hosts on different machines sharing a store).
- *Lock heartbeat for very long push-mode turns.* A live holder is never displaced; waiters
  time out (default 30 s, configurable) instead. Mixed-engine-version use of one execution
  (older engines don't lock and drop `history`) is unsupported.

## Decision-level `history` — RESOLVED in Phase 5

**Original limitation (kept for history)**: the persisted checkpoint did not retain the
Coordinator's live `StepRecord[]` (which embeds full decision objects), so
`statusProjectRun()` always returned `history: []`. ENG-002 (below) added `stepLog` as the
durable record of *what happened* and deliberately left this open.

**Phase 5 outcome**: `history` is now the durable, execution-wide, compact record of what
the engine *decided* (`DecisionRecord[]`; `PersistedExecutionState.history`), recoverable by
any host after a restart and returned by `status()`, `start()`, `resume()` and the terminal
pull `COMPLETED` response. It is not an alias of `stepLog` (`ARCHITECTURE.md` §4.17;
`tests/phase5-history.test.ts`). **Contract change:** the response `history` type is now
`DecisionRecord[]` (was `StepRecord[]`), and push-mode `history` is no longer the rich
per-call records — those remain available through `onEvent`/`onStep`/`coordinatorResult`.

**Still deferred**: persisting dispatch payloads, result evidence, or an event stream; any
event-sourcing redesign. Pre-Phase-5 checkpoints report `history: []` and are not
back-filled.

## Trust boundary — result truthfulness

The engine validates the *shape and status* of a submitted `AgentResult` (`stepId`,
`execution_id`, no pending/terminal misuse; transitions derive only from
`status`/`findings`) but does **not** independently verify that the host/agent actually
performed the work it reports. Truthful execution reporting is the host's
responsibility. See `ARCHITECTURE.md` §4.15. No independent verifier is planned or
implied.

## Follow-ups from the Claude cloud lifecycle smoke test

Source: a full pull-mode run (`@incito-labs/project-run-engine` 0.1.1, consumed by the
Incito repo, Claude Code cloud session; feature `007-lifecycle-smoke-test`, execution
`exec-1791412982780-58use`) that reached `COMPLETED` / `READY_FOR_PR` through a real
human-intervention gate. The run's temporary branch, feature files and checkpoint were
deleted afterward, so this section is the retained evidence. Each entry below keeps its
original registered observation and now also records its disposition. Severities are
provisional — this repository has no formal severity taxonomy.

### ENG-001 — Feature-directory bootstrap — CLOSED (host-owned; engine contract documented)

- **Status**: CLOSED. **Severity**: MEDIUM (provisional, unchanged).
- **Registered observation**: `discoverFeature()` (`src/project/context-discovery.ts`)
  requires an explicit feature to already exist as a directory (`<root>/<feature>` or
  `<root>/specs/<feature>`), otherwise returns `FEATURE_NOT_DISCOVERED`. For a brand-new
  feature the specify step normally creates that directory, but the engine refuses to
  start — and so never dispatches `SPECIFY` — until it exists. In the smoke test the host
  seeded the directory by hand and retried with an explicit `feature`. Branch matching
  only recognizes a folder named after the branch (after stripping `feat/`, `fix/`, …
  prefixes), so a branch like `tmp/...` does not auto-discover.
- **Confirmed root cause**: not a defect — an unstated contract. The engine only ever
  writes under `.project-run/` at run time; the bundled `speckit-specify` skill owns
  allocating the feature directory name (numbering by scanning `specs/`), `mkdir -p`,
  and `.specify/feature.json`. The circularity arose because nothing said who seeds the
  workspace when the feature is named up front.
- **Ownership / decision**: the **host/consumer** creates a new feature's workspace; the
  engine discovers it. The engine does not create feature directories (it would become a
  second, unsynchronised owner of preset-specific layout and numbering).
- **Implemented**: no behavior change except the failure reason, which now states the
  contract and the default location to create (`context-discovery.ts`). Contract
  documented in `ARCHITECTURE.md` §4.16, `CONSUMER-GUIDE.md` §9.2 and the reference
  skill (`templates/host-integrations/claude-code/project-engine-run/SKILL.md`).
  Regression coverage: `tests/feature-bootstrap-boundary.test.ts` (nothing is created
  on failure; no execution record is written; after the host seeds the directory the
  same call dispatches `SPECIFY`; non-feature-shaped branches do not auto-discover).
- **Remaining follow-up (not decided, not scheduled)**: an *opt-in*, preset-aware
  bootstrap helper is a possible enhancement only if a second host shows the same
  friction; it would need to defer to the preset's own naming/numbering rather than
  invent one. Consumers: your host must seed `specs/<feature>/` (see the contract above).

### ENG-002 — Final execution state loses findings and history — CLOSED (history persistence of decisions DEFERRED)

- **Status**: CLOSED for the audit-record gap; decision-level `history` was DEFERRED here
  and has since been resolved by Phase 5 (see above). **Severity**: HIGH (provisional, unchanged) — highest of
  the three.
- **Registered observation**: a nine-step run with four findings, a human-intervention
  gate, three human answers, remediation and an `ANALYZE` re-run returned a final
  `COMPLETED` response with `findings: []`, `history: []`, `stepsCount: 1`. Only
  `human_answers` survived in the checkpoint.
- **Confirmed root causes (three independent)**:
  - **A. No durable step record** — nothing persisted which steps ran or which human
    suspensions occurred (`PersistedExecutionState.history` was declared but never
    written).
  - **B. Findings replaced** — `Coordinator.applyExternalResult()` replaces
    `context.findings` with each result's findings. This replacement is *required* for
    gating (the decision engine and resume logic read it; a clean re-run must clear a
    blocking gate), so it was **not** changed — the bug was that it was also the only
    record.
  - **C. `stepsCount` ≠ steps** — pull-mode `status()` reported the persisted workflow
    `iteration`, which is never incremented (always 1); push-mode reported a per-call
    loop counter (including pure transitions, restarting at 0 on every resume).
- **Ownership**: engine.
- **Implemented** (`ARCHITECTURE.md` §4.4 is the contract):
  - **A**: new append-only `step_log` on the checkpoint (`ExecutionStepRecord`: one
    `AGENT_STEP` per applied result with role/state/status/reported findings/evidence
    count/`step_id`; one `HUMAN_INTERVENTION` per suspension), carried on the context
    like `human_answers` and exposed as `stepLog` on `status()`, `start()`, `resume()` and
    the terminal `COMPLETED` pull response (non-terminal pull responses are signals and
    omit it; read `status()`).
  - **B**: gate semantics untouched; the earlier findings are preserved in
    `stepLog[].findings` (snapshot per step, never merged or de-duplicated; the engine
    does not infer "resolved" — read later entries).
  - **C**: host-level `stepsCount` = number of `AGENT_STEP` entries across the whole
    execution (excludes transitions and suspensions; includes pre-resume steps). The
    Coordinator-level `stepsCount` stays the per-call loop counter (it bounds `maxSteps`)
    and is now documented as such.
  - Tests: `tests/execution-record.test.ts` (8) — the exact observed sequence (ANALYZE
    findings → human gate → clean ANALYZE re-run → COMPLETED) in pull and push mode,
    multiple dispatched steps, resume, human intervention, completed execution, `status()`
    from a second host, and a pre-`step_log` checkpoint. 7 of the 8 fail against the
    pre-change code.
- **Deferred (explicit)**: persisting decision-level `history` (`StepRecord[]`) — *since
  resolved by Phase 5, see above* — or an event stream; retaining per-step evidence payloads (only `evidence_count`; the latest
  result keeps full evidence on `last_result`); engine-inferred "resolved" status for
  findings; back-filling `step_log` for checkpoints written before this change (they
  report `stepsCount: 0`).
- **Side effect to note**: `ProjectRunHostResponse` gains a required `stepLog` field
  (additive on the wire; a consumer that *constructs* this type must add it) and
  `stepsCount` changes meaning as above — a contract change, versioned **`0.2.0`**
  (minor, pre-1.0: keeps existing `^0.1.x` ranges from picking it up unannounced).
  Release status: `0.2.0` is published to npm (`latest`) and was verified from a fresh
  registry install, including continuing a real checkpoint written by `0.1.1`.
- **Review follow-ups folded in before release**: rejected or pre-flight-blocked push
  responses (e.g. resuming a completed execution) now report the persisted record rather
  than `stepsCount: 0`; docs corrected to state that only `status()`, `start()`,
  `resume()` and the terminal `COMPLETED` pull response carry `stepLog` (other pull
  responses are signals); the two same-named `stepsCount` counters are documented as
  different things (`ARCHITECTURE.md` §4.4). Tests: 15 in `tests/execution-record.test.ts`.

### ENG-003 — Feature vs. execution vs. branch identity in prerequisite tooling — OPEN (EXTERNAL / CONSUMER OWNED; no engine action)

- **Status**: OPEN — consumer-owned. **Severity**: LOW–MEDIUM (provisional, unchanged).
- **Registered observation**: Spec-Kit prerequisite scripts
  (`.specify/scripts/bash/check-prerequisites.sh`, `setup-plan.sh`) printed
  `BRANCH: 007-lifecycle-smoke-test`, sourced from `.specify/feature.json`, while the
  actual Git branch was `tmp/project-run-lifecycle-smoke`. Feature, execution
  (`exec-…`) and Git branch were conflated in reporting.
- **Verification (in this repo)**: the engine does not contain, call, parse or emit
  `BRANCH:` / `feature.json` / the prerequisite scripts (grep of `src/`). It records
  `feature`, `execution_id` and `branch` as separate fields from the real `.git/HEAD`;
  `tests/feature-bootstrap-boundary.test.ts` pins that, including a feature name that
  differs from the branch. The only in-repo trace is the bundled `speckit-plan` template
  text that tells the plan agent to read a `BRANCH` key from `setup-plan.sh` output; the
  bundled `speckit-specify` template already states the branch name "does **not**
  dictate the spec directory name". The mislabelling originates in the consumer's
  `.specify/scripts/` (the template is upstream-derived and was not changed here).
- **Ownership**: Spec-Kit scripts in the consuming repository (Incito).
- **Engine action**: none, deliberately — no speculative change. Terminology and the
  per-identity source of truth are written down in `ARCHITECTURE.md` §4.16.
- **Remaining consumer follow-up**: in the consuming repo, make the prerequisite scripts
  report the Git branch from git (not from `.specify/feature.json`) — or relabel the
  feature value as `FEATURE` — and do not force feature and branch names to match.
  Stays OPEN here until the consumer confirms; close it when they do.

## Checkpoint save failures are swallowed — OPEN (pre-existing; documented, not fixed in 0.3.0)

`Coordinator.checkpoint()` catches and ignores every `stateStore.save()` error. It predates Phase 5
(present since the Coordinator's first checkpointing commit) and Phase 5 did not introduce or
change it. Atomic writes and the execution lock keep the checkpoint file structurally consistent
(no torn JSON), but they do not make a failed write visible: after the lock is taken and the first
checkpoint exists, a failing `save()` (disk full, I/O error) can leave the durable checkpoint at
the previous step while the call returns the next action or a push-mode result. A later submission
for that action is then rejected `STALE_STEP`, and a restarted process resumes from the older
checkpoint. Not data corruption; a failure-observability gap. Mitigated only for the first
checkpoint of a pull-mode execution (`EXECUTION_LOCK_UNAVAILABLE`). Behaviour is described in
`ARCHITECTURE.md` §4.17 ("Known limitation").

**Future work (not scheduled):** propagate checkpoint save failures from the Coordinator as a
structured, non-terminal failure (so the caller sees it before acting on an unpersisted step) for
both pull and push paths. This changes error-propagation semantics and needs its own review.

## Phase 5

Complete and released as `0.3.0`: persistence hardening (decision `history`, atomic
checkpoints, per-execution advisory lock). See `docs/phase-reports.md` for the baseline,
evidence, and the release impact (a minor bump, `0.3.0`).
Host integrations (Antigravity, Cursor, Codex, MCP) are **not** part of Phase 5; they remain
the backlog items above.
