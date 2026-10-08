# Consumer Guide: Integrating `project-run-engine`

This guide explains how to integrate `project-run-engine` into any TypeScript codebase.

---

## 1. Add Dependency

Add `@incito-labs/project-run-engine` to your repository's `package.json`:

```json
{
  "dependencies": {
    "@incito-labs/project-run-engine": "^0.3.0"
  }
}
```

During local multi-repo or monorepo development, you can use a relative file reference:

```json
{
  "dependencies": {
    "@incito-labs/project-run-engine": "file:../../packages/project-run-engine"
  }
}
```

---

## 2. Initialize Project Workflow (`project-run init`)

The fastest and safest way to set up `project-run-engine` in a repository is using the CLI:

```bash
npx project-run init
```

This single command:
1. Creates `.project-run/config.json` with a valid Spec-Kit workflow configuration.
2. Infers the project name from `package.json` (or directory name).
3. Copies canonical Spec-Kit skills (`speckit-specify`, `speckit-plan`, `speckit-implement`, `speckit-bug-assess`, `speckit-bug-fix`, `speckit-bug-test`, `speckit-converge`, etc.) into `.agents/skills/`.
4. Runs completely offline without external network calls.
5. Is **idempotent**: safe to run multiple times without duplicating or overwriting custom skills.

To overwrite conflicting or modified skills explicitly:
```bash
npx project-run init --force
```

---

## 3. Manual Project Configuration (Alternative)

If preferred, you can manually create `.project-run/config.json` at your repository root:

```json
{
  "project": {
    "name": "my-service",
    "workflow_version": "v1",
    "feature_directory": "specs/current-feature"
  },
  "runtime": {
    "default_runtime": "ANTIGRAVITY",
    "supported_runtimes": ["ANTIGRAVITY", "CLAUDE", "CURSOR", "MOCK", "CI_AGENT"]
  },
  "agents": {
    "SPECIFICATION": {
      "name": "Specification Agent",
      "required_skills": [
        { "id": "speckit-specify", "required": true },
        { "id": "speckit-clarify", "required": false }
      ]
    },
    "ARCHITECTURE": {
      "name": "Architecture Agent",
      "required_skills": [
        { "id": "speckit-plan", "required": true },
        { "id": "speckit-tasks", "required": true },
        { "id": "speckit-analyze", "required": true }
      ]
    },
    "IMPLEMENTATION": {
      "name": "Implementation Agent",
      "required_skills": [
        { "id": "speckit-implement", "required": true }
      ]
    },
    "INDEPENDENT_REVIEW": {
      "name": "Independent Review Agent",
      "required_skills": [
        { "id": "speckit-analyze", "required": true }
      ]
    },
    "REMEDIATION": {
      "name": "Remediation Agent",
      "required_skills": [
        { "id": "speckit-bug-assess", "required": true },
        { "id": "speckit-bug-fix", "required": true },
        { "id": "speckit-bug-test", "required": true }
      ]
    },
    "CONVERGENCE": {
      "name": "Convergence Agent",
      "required_skills": [
        { "id": "speckit-converge", "required": true }
      ]
    }
  },
  "skills": {
    "search_paths": [".agents/skills", ".project-run/skills", "skills"]
  }
}
```

---

## 3. Supply Required Skills

The engine verifies that each skill declared in your config exists on disk with a valid `SKILL.md` frontmatter. Place them in any directory listed in `skills.search_paths`:

```
.agents/skills/
├── speckit-specify/
│   └── SKILL.md
├── speckit-plan/
│   └── SKILL.md
├── speckit-tasks/
│   └── SKILL.md
├── speckit-analyze/
│   └── SKILL.md
├── speckit-implement/
│   └── SKILL.md
├── speckit-bug-fix/
│   └── SKILL.md
└── speckit-converge/
    └── SKILL.md
```

Each `SKILL.md` must include YAML frontmatter:

```markdown
---
name: speckit-implement
description: Executes implementation tasks defined in tasks.md
version: "1.0.0"
---
# Implementation Skill Instructions
...
```

---

## 4. Provide a Host Runtime Adapter

`project-run-engine` provides the execution loop, but your repository or host environment connects to the physical agent runner (Antigravity subagent, Claude tool invocation, Cursor terminal, or CI execution).

Implement the `HostAgentDispatcher` interface and pass it to `HostDispatchAdapter`:

```typescript
import {
  HostDispatchAdapter,
  type HostAgentDispatcher,
  type AgentDispatchRequest,
  type AgentResult,
  type HostExecutionOptions,
} from "@incito-labs/project-run-engine";

class MyHostDispatcher implements HostAgentDispatcher {
  async dispatch(
    request: AgentDispatchRequest,
    options?: HostExecutionOptions,
  ): Promise<AgentResult> {
    // 1. Inspect request.role, request.skills, request.context
    // 2. Invoke host subagent or CLI command
    // 3. Return structured AgentResult with formal StructuredFinding records
    return {
      execution_id: request.execution_id,
      agent: request.role,
      state: request.state,
      status: "PASS",
      evidence: ["Completed task successfully"],
      findings: [],
    };
  }
}

export const myAdapter = new HostDispatchAdapter("ANTIGRAVITY", new MyHostDispatcher());
```

### Structured Findings Example

Review and remediation agents return `StructuredFinding` items in their `AgentResult`:

```typescript
import type { StructuredFinding } from "@incito-labs/project-run-engine";

const finding: StructuredFinding = {
  id: "FINDING-001",
  severity: "HIGH",
  category: "data-consistency",
  location: {
    file: "src/services/billing.ts",
    line: 42,
    column: 10,
  },
  evidence: "Null check missing before accessing accountId",
  expected: "Account must be verified or null handled safely",
  actual: "Throws TypeError when account is unverified",
  required_remediation: "Add early return or conditional check before accessing accountId",
  status: "OPEN",
};
```

---

## 5. Execute Workflows

Call `executeProjectRun`. The engine automatically discovers your Git branch and active feature, persists execution checkpoints, and manages state transitions:

```typescript
import { executeProjectRun } from "@incito-labs/project-run-engine";
import { myAdapter } from "./my-adapter.js";

// Context (feature, branch, execution_id) is auto-discovered if omitted
const result = await executeProjectRun({
  projectRoot: process.cwd(),
  runtime: "ANTIGRAVITY",
  adapters: [myAdapter],
});

if (result.status === "COMPLETED") {
  console.log("Workflow completed! Ready for PR.");
} else if (result.status === "BLOCKED_MISSING_SKILLS") {
  console.error("Missing required skills:", result.missingSkills);
} else if (result.state === "HUMAN_INTERVENTION_REQUIRED") {
  console.warn("Workflow requires human intervention. Execution ID:", result.context.execution_id);
} else {
  console.error("Execution stopped:", result.status, result.failureReason);
}
```

---

## 6. Execution Persistence & Resuming Runs

Execution state is checkpointed to:

```text
.project-run/runs/<execution_id>.json
```

If an execution stops at `HUMAN_INTERVENTION_REQUIRED` (e.g. max remediation cycles reached), you can address the issue and resume without re-running completed agents:

### Via CLI:

```bash
npx project-run resume --execution-id <execution_id>
```

### Via Programmatic API:

```typescript
import { executeProjectResume } from "@incito-labs/project-run-engine";
import { myAdapter } from "./my-adapter.js";

const resumed = await executeProjectResume({
  projectRoot: process.cwd(),
  executionId: "exec-12345",
  adapters: [myAdapter],
});
```

### Concurrent hosts and the execution lock

Several hosts (separate processes or sessions) may drive the same `executionId`. Every call that
can **change** an execution — `submitProjectRunStep`, `nextProjectRunStep` when it starts,
recovers or resumes an execution, `executeProjectResume`/`resumeProjectRun`, and
`executeProjectRun`/`startProjectRun` with an `executionId` — runs inside a per-execution
advisory lock (one machine, local filesystem). Reads (`statusProjectRun`, and a
`nextProjectRunStep` that only returns an already-pending action or reports a suspension or
terminal state) never take it, so observers never wait behind a writer. Checkpoints are written
atomically, so a reader never sees a half-written file.

If the lock cannot be had, the call returns a **non-terminal** `FAILED` (it never throws, and the
CLI still prints exactly one JSON line); the execution is untouched:

| `failureReason` starts with | Meaning | What to do |
|---|---|---|
| `EXECUTION_LOCKED:` | Another live operation held the lock for the whole wait (default 30 s). | Repeat the **same** call after a moment. |
| `EXECUTION_LOCK_UNAVAILABLE:` | The filesystem refused the lock itself: `.project-run/runs` is missing, not a directory, not writable, or the disk is full. A first `next-step` **without** an `executionId` reports the same code (no lock is involved; the first checkpoint could not be written, so no action is issued). | Fix the environment, then retry. Retrying alone will not help. |

A lock error raised *inside* an operation (for example by an adapter that tries to lock the
same execution from within a push-mode run) is **not** one of these: the turn fails as an ordinary
terminal `FAILED`, its `failureReason` does not begin with a lock code, and the execution is not resumable.

**Checkpoint write failures and conflicts** *(unreleased; next release `0.4.0` — `ARCHITECTURE.md` §4.17.1–§4.17.2)*. The engine never reports progress that is not durable. If a checkpoint it
needs cannot be written, or the execution was changed by someone else while the call was in
progress, the call returns a non-terminal `FAILED` with `terminal: false` and a machine-readable
`failureCode` (the same field now also carries the two lock codes):

| `failureCode` | Meaning | What to do |
|---|---|---|
| `CHECKPOINT_WRITE_FAILED` | The store rejected a `save()` (disk full, I/O error, permissions). The execution is at its last durable checkpoint; `state`/`stepLog`/`history` in the response are that checkpoint's. | Fix the storage problem, then call `next-step` again with the same `executionId` (pull) or `resume` / `start` again (push). Submitting the same result again is safe — it is applied at most once. |
| `CHECKPOINT_CONFLICT` | The execution was modified by another operation after this call read it (optimistic concurrency); nothing of this call was written and the other operation's checkpoint stands. Normally prevented by the lock, so it means the lock did not hold. | Do **not** retry blindly: call `next-step` (or `status`) to get the current state. |

**Writing your own store.** `ExecutionStateStore` (exported) is all the engine knows about storage —
`save` / `load` / `exists`, plus optional `list` and `withLock`. A `save` must resolve only once the
checkpoint is durable and reject otherwise. To get compare-and-swap, assign a per-execution `revision`
(1, 2, 3, ...), return it from `load()`, accept `save(state, { expectedRevision })`, throw
`CheckpointConflictError` (nothing written) when it does not match the stored revision (`0` = none yet),
and return `{ revision }` from `save`. A store written against the `0.3.0` contract (`save(state): Promise<void>`)
keeps working without it. `startProjectRun` / `resumeProjectRun` / `statusProjectRun` and the pull
functions all take a `stateStore`. The bundled file store is local-filesystem, single-machine only — it
is **not** safe across machines or network filesystems; for that you need a store whose conditional write
is atomic across machines.

**Clearing a stale lock by hand.** The lock file is `.project-run/runs/<executionId>.lock`
(named in the `EXECUTION_LOCKED` message). A lock left by a crashed process is reclaimed
automatically. The engine will *not* remove a lock whose recorded pid is still alive — it cannot
tell a busy holder from an unrelated process that was assigned a dead holder's pid (after a crash,
or a container restart that re-uses pids). So if `EXECUTION_LOCKED` persists and you are **certain
no engine process is running for that execution**, delete that one file. The checkpoint
(`<executionId>.json`) is never affected. Add `.project-run/runs/` to `.gitignore` so lock files
are never committed.

Programmatic use:

```typescript
import {
  FileExecutionStateStore,
  withExecutionLock,
  ExecutionLockError,           // base class; `.code` is "EXECUTION_LOCKED" | "EXECUTION_LOCK_UNAVAILABLE"
  isExecutionLockFailure,       // true for a failureReason that reports a lock failure
} from "@incito-labs/project-run-engine";

// Optional: a longer wait for hosts whose push-mode turns run long.
const store = new FileExecutionStateStore(projectRoot, undefined, { timeoutMs: 120_000, pollMs: 50 });

// Serialise your own read-modify-write of an execution with the engine's turns.
// Not re-entrant: never call the engine for the SAME execution from inside `fn`.
await withExecutionLock(store, executionId, async () => { /* ... */ });
```

A custom `ExecutionStateStore` may implement the optional
`withLock<T>(executionId, fn, options?)` to get the same protection; without it the engine runs
unlocked, exactly as in `0.2.0`. Throw an `ExecutionLockError` subclass from it to have the engine
return the structured failure; any other error propagates unchanged.

---

## 7. Run Diagnostic Doctor

Run `runProjectDoctor` to verify setup before running workflows:

```typescript
import { runProjectDoctor, formatDoctorReport } from "@incito-labs/project-run-engine";

const report = await runProjectDoctor({
  projectRoot: process.cwd(),
  registeredAdapters: ["ANTIGRAVITY"],
});

console.log(formatDoctorReport(report));
```

---

## 8. Reference Consumer Implementations

- **Incito (`Consumer #1`)**: Full application consumer under repository root. Consumes `@incito-labs/project-run-engine` as a package dependency via `"@incito-labs/project-run-engine": "file:packages/project-run-engine"`. Provides consumer-specific CLI wrapper in `src/core/agent-orchestration/cli/project-run-cli.ts` without internal engine duplication.
- **demo-service (`Consumer #2`)**: Standalone consumer example in `examples/project-run-consumer/`. Demonstrates zero-dependency integration, custom runtime registration (`CI_AGENT`), and offline skill discovery.

---

## 9. Integrating an AI Coding-Agent Host (Claude Code, Cursor, Antigravity, Codex)

Sections 1–8 above describe the `HostAgentDispatcher`/`HostDispatchAdapter` pattern and
the CLI — both still fully supported. Which one applies to you depends on whether your
integration can `import` this package (see `ARCHITECTURE.md` §4.10 for the full
distinction):

### 9.1 Programmatic host (can `import` this package)

A custom Node orchestration service, a backend that drives agent calls itself, etc.
Start from the provider-agnostic Host Skill Contract instead of `executeProjectRun`
directly:

```typescript
import { projectRunHost } from "@incito-labs/project-run-engine/host";
// or the single action-discriminated entry point:
import { projectEngineRun } from "@incito-labs/project-run-engine/host";

const response = await projectRunHost.start({
  feature: "004-campaigns-and-lead-attribution",
  adapters: [myAdapter], // same HostAgentDispatcher/AgentRuntimeAdapter from §4
});

if (response.status === "HUMAN_INTERVENTION_REQUIRED") {
  // Present response.humanIntervention.questions to the user, collect their answers,
  // then: await projectRunHost.resume({ executionId: response.executionId, adapters, humanAnswers });
}
```

### 9.2 Interactive agent host (Claude Code, Cursor, Antigravity, Codex)

These extend themselves through Skills/tools — instructions for the agent to follow
using its own general-purpose tools (running commands, reading files), not a place to
`import` a TypeScript function. Use the JSON transport instead — and prefer the
**pull-based step API** (`next-step`/`submit-step`) over push-mode (`start`/`resume`)
whenever the host itself is the live session that should perform each role's work:

```bash
# Pull-mode (recommended for a same-session interactive host): the host performs each
# role's work itself and reports the result back — no adapter needed or accepted.
project-run engine next-step --json '{"feature":"004-campaigns-and-lead-attribution"}' --dir <repo>
project-run engine submit-step --json '{"executionId":"...","stepId":"...","result":{...}}' --dir <repo>

# Push-mode: runs the whole workflow in one call; requires a real AgentRuntimeAdapter
# (a separate process/session — see §9.1), or is useful for CI/batch automation.
project-run engine start --json '{"feature":"004-campaigns-and-lead-attribution"}' --dir <repo>
```

Note that every example above omits `"runtime"` from the JSON payload entirely — this
is intentional, not an oversight. The engine resolves the runtime to use from
`.project-run/config.json`'s `runtime.default_runtime` whenever a call doesn't specify
one explicitly:

```text
explicit "runtime" in this call's JSON payload
    ?? a runtime already recorded on the execution (e.g. resuming one)
    ?? this project's configured runtime.default_runtime
    ?? the engine's historical fallback
```

So a project whose `.project-run/config.json` sets
`"runtime": { "default_runtime": "CLAUDE_CODE" }` never needs `"runtime":"CLAUDE_CODE"`
repeated on every `next-step`/`submit-step`/`start` call — set it once, in config, and
omit it from every call thereafter. Pass `"runtime"` explicitly only when a single call
needs to override the project's configured default (see `ARCHITECTURE.md` §4.14 for the
full precedence and where it's resolved).

**Starting a brand-new feature.** The engine locates features; it does not create them.
If `next-step`/`start` returns `FAILED` with `FEATURE_NOT_DISCOVERED` for a feature you
just named, create the feature workspace first (by default `specs/<feature>/`) and
retry. Feature name, execution id, and git branch are separate things and need not
match (`ARCHITECTURE.md` §4.16).

**Reporting.** `status()`, `start()`, `resume()` and the terminal `COMPLETED` pull
response (under `result`) carry `stepLog` (the durable, ordered record of agent steps and
human suspensions, including every finding each step reported) and `stepsCount` (the
number of agent steps in the whole execution, including before a resume). The other pull
responses are signals and omit them — call `project-run engine status` to read the record
of a running or suspended execution. `findings` is only the latest result's findings, so
a clean final result reports `findings: []`; read `stepLog` for the full record
(`ARCHITECTURE.md` §4.4). `history` is the engine's durable, compact record of what it
*decided* (transitions, dispatches, suspensions) — not an alias of `stepLog`
(`ARCHITECTURE.md` §4.17).

**Concurrent hosts.** Mutating calls on the same `executionId` are serialised by a
per-execution advisory lock (one machine, local filesystem), and reads never wait. If the lock
cannot be had you get a non-terminal `FAILED` whose `failureReason` starts with
`EXECUTION_LOCKED:` (another operation is running: repeat the same call) or
`EXECUTION_LOCK_UNAVAILABLE:` (the runs directory is unusable: fix the environment). The
execution is intact in both cases. See section 6, which also covers clearing a stale lock, and
section 10 if you are upgrading from `0.2.x`.

See `templates/host-integrations/claude-code/project-engine-run/SKILL.md` for a
complete reference skill built on the pull-based step API — it drives the full
workflow, including the Human-in-the-Loop round trip, entirely within the same Claude
Code session, with no nested agent process ever spawned. See `ARCHITECTURE.md` §4.11
for the full step contract and why pull-mode is what makes this possible.

The engine never knows which host is calling it: the host is solely responsible for
performing the requested role's work (using whatever tools it has) and returning an
honest `AgentResult`. This holds identically whether the host is Claude Code (the only
one genuinely validated so far — see `ARCHITECTURE.md` §4.12–§4.13), Antigravity (a
supported runtime identifier and integration target, not yet live-validated), or a
future Cursor/Codex/MCP integration (tracked as backlog in `docs/backlog.md`, not
implemented in this package).

---

## 10. Upgrading from 0.2.x to 0.3.x

`0.3.0` makes the decision history durable and hardens concurrent use. Almost everything is
additive; **one typed contract changes**.

**What changed**

| | `0.2.x` | `0.3.x` |
|---|---|---|
| `ProjectRunHostResponse.history` | `StepRecord[]`: live per-call records for `start()`/`resume()` (with `decision.request`, `result`, ...); always `[]` from `status()` and pull mode | `DecisionRecord[]`: the engine's **durable, execution-wide** record of what it decided (transitions, dispatches, completion, suspensions), on `status()`, `start()`, `resume()` and the terminal pull `COMPLETED` response. Compact: no request, result, evidence or findings |
| Dispatch payload / agent results | in `history[i].decision.request` / `history[i].result` | **gone from `history`.** Use `stepLog` (below) for results and findings; the dispatch request is the `AGENT_ACTION_REQUIRED` response itself |
| Concurrent calls on one execution | unprotected (could lose updates) | serialised by the execution lock; `EXECUTION_LOCKED` / `EXECUTION_LOCK_UNAVAILABLE` failures (see section 6) |
| Checkpoint writes | plain write (a concurrent reader could fail to parse) | atomic write-and-rename |
| Unusable `.project-run/runs` | engine ran best-effort without persisting | refuses with `EXECUTION_LOCK_UNAVAILABLE` |

**Unchanged:** `stepLog` (append-only record of agent results, their findings and human
suspensions), `stepsCount` (agent steps in the whole execution), `findings` (the latest result's
findings, which the gates use), the pull API, and the persisted `version` (`1`). The live per-call
`StepRecord`s are still available from `onEvent`, `executeProjectRun`'s `onStep`, and
`coordinatorResult.history`.

**Migrating code that read `history`**

```typescript
// 0.2.x
const requests = response.history.map((r) => r.decision.request);   // dispatch payloads
const results  = response.history.map((r) => r.result);             // agent results

// 0.3.x
const results  = response.stepLog.filter((r) => r.kind === "AGENT_STEP");   // status, findings, evidence_count per step
const decisions = response.history;   // { step, state, decision: { action: "TRANSITION"|"DISPATCH_AGENT"|"COMPLETE"|"REQUIRE_HUMAN_INTERVENTION", ... }, timestamp }
```

Over the CLI JSON transport the same applies: `history[i].result` and `history[i].decision.request`
are no longer present.

**Upgrade every host together.** All hosts that share a checkout (and so its
`.project-run/runs/`) should move to `0.3.x` at the same time. A `0.2.x` engine does not know the
new fields: when it continues an execution it silently **drops `history`** from the checkpoint
(`stepLog` is kept), and it does not take the lock, so it gives no mutual exclusion against `0.3.x`
hosts. Do not run mixed versions against one execution.

**Existing executions.** A checkpoint written by `0.2.x` loads unchanged: `history` starts empty
(earlier decisions are never invented) and fills from the next decision on, numbering from `1`;
`stepLog` and `stepsCount` carry on across the upgrade.

**New failures to handle.** Treat `failureReason` values beginning `EXECUTION_LOCKED:` (repeat the
same call) and `EXECUTION_LOCK_UNAVAILABLE:` (fix the environment; do not retry blindly) as
non-terminal; both arrive as `FAILED` with `terminal: false`. Details and manual recovery are in
section 6.

---

## 11. Upgrading from 0.3.x to 0.4.x (unreleased)

The next release after `0.3.0` is recommended as `0.4.0` (minor, pre-1.0): the public surface only grows,
the persisted `version` stays `1`, and `0.3.x` checkpoints and `void`-returning stores keep working. **One
behaviour changes:** a failed checkpoint write used to be silently ignored and is now reported.

| | `0.3.x` | `0.4.x` |
|---|---|---|
| A checkpoint `save()` fails | ignored; the call could still return an action / result / completion that was not saved (later `STALE_STEP`) | non-terminal `FAILED`, `failureCode: "CHECKPOINT_WRITE_FAILED"`, last durable state; recover with `next-step` / `resume` |
| Human answers that cannot be recorded | the run went on | the call fails the same way and nothing is acted on |
| Failure codes | `failureReason` prefix only | also `failureCode` (`EXECUTION_LOCKED`, `EXECUTION_LOCK_UNAVAILABLE`, `CHECKPOINT_WRITE_FAILED`, `CHECKPOINT_CONFLICT`) on `FAILED` responses; push results: `lockFailure` / `persistenceFailure` |
| Lost updates when the lock did not hold | possible | `PersistedExecutionState.revision` + compare-and-swap writes; the loser gets `CHECKPOINT_CONFLICT` |
| `start()` / `resume()` / `status()` storage | file store only | accept a `stateStore` |
| A checkpoint left `IN_PROGRESS` at `READY_FOR_PR` (crash) | `resume` / `next-step` refused it as completed | recovers and completes |

**What to do:** handle `failureCode` (or the `failureReason` prefix) `CHECKPOINT_WRITE_FAILED` and
`CHECKPOINT_CONFLICT` as non-terminal like the lock failures (section 6). If you implement
`ExecutionStateStore` or subclass `FileExecutionStateStore`: `save` may now return `{ revision }` and
receives an optional second argument; a TypeScript subclass that overrides `save()` returning
`Promise<void>` must return the base's receipt. Keep `.project-run/runs/` in `.gitignore` — the file store
now also creates a short-lived `<executionId>.cas` write guard. Mixed `0.3.x` / `0.4.x` use of one
execution is not supported (a `0.3.x` engine does not maintain `revision` or take the write guard).

---

See `ARCHITECTURE.md` §4 for the full contract (`start`/`resume`/`status`, progress
events, the Human-in-the-Loop flow, and what a host adapter is and isn't responsible
for), §4.8 for conceptual integration notes per host, and §4.10 for the programmatic
vs. interactive-agent distinction and the `project-run engine` CLI transport. This
package does not ship `.claude/commands/...`, a Cursor rule, an MCP server, or an
Antigravity tool definition — those are built in each host's own configuration using
the contract described there.

