# project-run-engine

A provider-agnostic, runtime-neutral agent orchestration engine for portable workflow execution.

`project-run-engine` automates multi-agent software engineering lifecycles (Specification, Architecture, Implementation, Independent Review, Remediation, and Convergence) without coupling to any specific LLM provider, SDK, or host runtime.

**Status**: Phases 0–4, Phase 4 Closure and the ENG-001/002/003 remediation are complete (current release `0.2.0`). Phase 5 (persistence hardening: durable decision `history`, atomic checkpoints, per-execution locking) is implemented in source and unreleased. See [`docs/phase-reports.md`](docs/phase-reports.md) for phase history and [`docs/backlog.md`](docs/backlog.md) for deferred work and known limitations. **Upgrading from 0.2.x?** `ProjectRunHostResponse.history` changes type in 0.3 — see [`CONSUMER-GUIDE.md` §10](CONSUMER-GUIDE.md#10-upgrading-from-02x-to-03x).

---

## Key Principles

- **Zero Provider SDKs**: Contains no dependencies on OpenRouter, OpenAI, Anthropic, Vercel AI SDK, or model-specific APIs.
- **Runtime Neutral & Extensible**: Executes across standard host runtimes (`ANTIGRAVITY`, `CLAUDE`, `CURSOR`, `MOCK`) as well as consumer-provided custom runtimes (e.g. `CI_AGENT`, cluster workers) through the `HostDispatchAdapter` / `AgentRuntimeAdapter` boundary.
- **Pure Deterministic State Machine**: The `CoordinatorDecisionEngine` governs state transitions, iterations, and control flow without side effects.
- **Skill Contracts, Not Downloads**: Enforces declarative skill requirements per agent role (such as Spec-Kit workflows). The engine verifies skill presence locally before dispatch; it never downloads external code automatically.
- **Single User Entry Point**: Coordinates the entire workflow through `/project-run`. Review, remediation, re-review, and convergence are fully automated.
- **Execution Continuity & Checkpointing**: Persists execution state at key milestones and supports resuming runs blocked on human intervention without restarting completed agents.
- **Structured Finding Contracts**: Formal typed model for findings, evidence, and actionable severity routing.

---

## Installation

```bash
npm install @incito-labs/project-run-engine
```

*(Or from a local workspace path during development:* `"@incito-labs/project-run-engine": "file:../path/to/packages/project-run-engine"`*)*

---

## CLI Usage

`project-run-engine` provides a built-in CLI for deterministic project scaffolding, diagnostics, execution, and execution resumption:

```bash
# 1. Bootstrap project configuration and canonical Spec-Kit skills
npx project-run init

# 2. Verify workspace configuration and skill availability
npx project-run doctor

# 3. Execute the workflow (auto-discovers git branch and feature)
npx project-run

# 4. Resume an execution after human intervention
npx project-run resume --execution-id <execution_id>
```

### CLI Command Options

- `project-run init [--project <name>] [--force]`
  - Scaffolds `.project-run/config.json` and canonical offline Spec-Kit skills into `.agents/skills/`.
  - Idempotent: does not overwrite existing files unless `--force` is specified.
- `project-run doctor [--project-root <path>]`
  - Validates configuration, required agent roles, skill search paths, and skill presence on disk.
- `project-run [run] [--feature <name>] [--branch <branch>] [--runtime <runtime>]`
  - Runs the orchestration workflow.
  - Automatically discovers git branch from `.git/HEAD` (or git worktree pointers).
  - Automatically discovers feature from active branch name (`feat/<feature>`, `feature/<feature>`), `.project-run/config.json`, or specs directories.
- `project-run resume --execution-id <execution_id>`
  - Resumes an execution that paused in `HUMAN_INTERVENTION_REQUIRED`.
  - Restores the exact checkpointed state and continues without re-executing completed agents.

---

## Context Auto-Discovery (G-1)

When running without explicit flags, `project-run-engine` deterministically discovers the workspace context without guessing or inventing synthetic values:

1. **Git Branch Discovery**:
   - Inspects `.git/HEAD` directly on disk (supporting standard git repositories as well as worktrees and submodules with `gitdir:` pointers).
   - If not in a git repository or HEAD is detached without a branch, fails explicitly with `ProjectNotGitRepositoryError`.
2. **Feature Discovery**:
   - Priority 1: Git branch naming convention (e.g. `feat/004-user-auth` -> `004-user-auth`).
   - Priority 2: Configured `feature_directory` in `.project-run/config.json`.
   - Priority 3: Single feature directory found in `.specs/` or `specs/`.
   - If the feature cannot be determined unambiguously, fails explicitly with `FeatureNotDiscoveredError`.

Zero LLM calls or synthetic fabrications are made.

---

## Execution State Persistence (G-2)

The engine introduces an `ExecutionStateStore` abstraction with a default `FileExecutionStateStore`:

```typescript
export interface ExecutionStateStore {
  save(state: PersistedExecutionState): Promise<void>;
  load(executionId: string): Promise<PersistedExecutionState | null>;
  exists(executionId: string): Promise<boolean>;
}
```

Persisted runs are saved to `.project-run/runs/<execution_id>.json`.

### Persisted State Schema

- `schema_version`: Current state schema version (currently `1`).
- `execution_id`: Unique identifier for the run.
- `project`: Project identity and workflow preset version.
- `feature`: Target feature name.
- `branch`: Active Git branch.
- `current_state`: Active `CoordinatorState`.
- `iteration`: Current overall iteration count.
- `remediation_iteration`: Remediation loop iteration counter.
- `last_result`: Last recorded `AgentResult`.
- `findings`: Array of `StructuredFinding` records.
- `context`: Snapshot of `CoordinatorExecutionContext`.
- `timestamps`: `started_at` and `updated_at` ISO-8601 strings.

### Secret Scrubbing & Privacy

All persisted contexts pass through automated secret scrubbing. Sensitive environment variables, auth tokens, passwords, and API keys are replaced with `[REDACTED]` prior to disk writes.

### Checkpoint Milestones

The `Coordinator` persists state automatically at 6 deterministic lifecycle milestones:
1. **Execution Start**: Immediately upon run initialization.
2. **After Agent Result**: After every host agent dispatch completes.
3. **State Transition**: After every state machine transition evaluated by the `CoordinatorDecisionEngine`.
4. **Human Intervention**: Before pausing execution in `HUMAN_INTERVENTION_REQUIRED`.
5. **Terminal Success**: When execution successfully reaches `READY_FOR_PR`.
6. **Terminal Failure**: When execution terminates due to fatal errors or maximum remediation limits.

---

## Structured Finding Contract (G-4)

The engine formalizes findings into a strong, deterministic contract:

```typescript
export type FindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "ADVISORY";
export type FindingStatus = "OPEN" | "RESOLVED" | "ACCEPTED";

export interface FindingLocation {
  file?: string;
  line?: number;
  column?: number;
}

export interface StructuredFinding {
  id: string;
  severity: FindingSeverity;
  category: string;
  location?: FindingLocation;
  evidence: string;
  expected: string;
  actual: string;
  required_remediation: string;
  status: FindingStatus;
  advisory?: boolean;
  blocking?: boolean;
}
```

### Actionability & Decision Engine Routing

The `CoordinatorDecisionEngine` evaluates findings through a deterministic 3-tier model (`severity` → `actionability` → `blocking status`):
- **Actionability**: Open findings with `status: "OPEN"` (excluding `ADVISORY` or `advisory: true`) are actionable—they are preserved in context, evidence, and run summaries for full observability. Findings with `status: "RESOLVED"` or `"ACCEPTED"` are non-actionable.
- **Blocking Status**: Only blocking findings trigger the `REMEDIATION` state:
  - `CRITICAL`, `HIGH`, and `MEDIUM` severities default to blocking (`blocking: true`).
  - `LOW` severity findings default to non-blocking (`blocking: false`). They do not trigger `REMEDIATION` or halt the workflow unless explicitly marked `blocking: true`.
  - Explicit `blocking` flags (`true` / `false`) take precedence over severity defaults.
- Iteration counters and maximum remediation limits are strictly enforced for blocking finding remediation cycles.

---

## Human Intervention Resume Protocol (G-5)

When an execution pauses in `HUMAN_INTERVENTION_REQUIRED` (e.g. maximum remediation limit reached, blocked dependency, or manual approval gate), the operator addresses the issue and resumes execution:

```bash
npx project-run resume --execution-id <execution_id>
```

### Resume Semantics

1. Loads persisted state from `.project-run/runs/<execution_id>.json`.
2. Verifies execution existence (`ExecutionNotFoundError` if absent).
3. Verifies resumability (`ExecutionNotResumableError` if already terminal such as `READY_FOR_PR`).
4. Reconstructs `Coordinator` execution context, iterations, findings, and completed step history.
5. Continues execution from the preserved state without re-dispatching already completed agents.
6. Subsequent milestones continue to checkpoint state normally.

---

## Provider & Host Agnosticism

`project-run-engine` strictly defines the boundaries between orchestration and host execution:

| Responsibility | Handled By `project-run-engine` | Handled By Consumer / Host |
|---|---|---|
| Workflow state machine & transitions | Yes | No |
| Skill requirement declarations & validation | Yes | No |
| Checkpoint persistence & resumption | Yes | No |
| Workspace context discovery | Yes | No |
| Finding structure & actionability rules | Yes | No |
| Physical LLM API calls | **No** (Forbidden) | Yes |
| Host tool execution (file editing, shells) | **No** (Forbidden) | Yes |
| Provider-specific prompts or agent subagents | **No** (Forbidden) | Yes |
| Concrete host bridges (Antigravity, Claude, Cursor) | **No** (Interface only) | Yes |

Consumers implement the `HostAgentDispatcher` interface for their chosen runtime and pass it to the engine.

---

## Programmatic API Example

```typescript
import {
  executeProjectRun,
  executeProjectResume,
  HostDispatchAdapter,
  FileExecutionStateStore,
  type HostAgentDispatcher,
  type AgentDispatchRequest,
  type AgentResult,
} from "@incito-labs/project-run-engine";

// 1. Consumer provides runtime dispatcher
const customDispatcher: HostAgentDispatcher = {
  async dispatch(request: AgentDispatchRequest): Promise<AgentResult> {
    return {
      execution_id: request.execution_id,
      agent: request.role,
      state: request.state,
      status: "PASS",
      evidence: ["Completed verification checks"],
      findings: [],
    };
  },
};

const adapter = new HostDispatchAdapter("CI_AGENT", customDispatcher);

// 2. Start a new workflow run
const runResult = await executeProjectRun({
  projectRoot: process.cwd(),
  runtime: "CI_AGENT",
  adapters: [adapter],
});

// 3. Or resume an interrupted run
const resumeResult = await executeProjectResume({
  projectRoot: process.cwd(),
  executionId: "exec-12345",
  adapters: [adapter],
});
```

---

## Public API Export Map

| Module | Exports |
|---|---|
| `@incito-labs/project-run-engine` | Main barrel export exposing all public API components |
| `@incito-labs/project-run-engine/domain` | `CoordinatorState`, `AgentRole`, `AgentRuntime`, `StructuredFinding`, `AgentResult`, `AgentSkillRequirement`, `ExecutionStepRecord`, `countAgentSteps`, domain error classes (including `ExecutionLockError`, `ExecutionLockTimeoutError`, `ExecutionLockUnavailableError`, `isExecutionLockFailure`) |
| `@incito-labs/project-run-engine/coordinator` | `Coordinator`, `CoordinatorOptions`, `CoordinatorRunResult`, `StepRecord` (the live, per-call record — not the durable `history`) |
| *(no `/decision` subpath)* | The decision layer — `CoordinatorDecisionEngine`, `CoordinatorDecision`, `CoordinatorExecutionContext`, `isFindingActionable`, and the durable-history types `DecisionRecord`, `RecordedDecision`, `DispatchDecisionSummary` — is exported from the **root** barrel only |
| `@incito-labs/project-run-engine/runtime` | `HostDispatchAdapter`, `HostAgentDispatcher`, `MockRuntimeAdapter`, `executeWithHostGuards` |
| `@incito-labs/project-run-engine/skills` | `SkillResolver`, `SkillValidator`, `SkillValidationError` |
| `@incito-labs/project-run-engine/presets` | Spec-Kit preset definitions (`ROLE_SKILLS_MAP`, `getSkillsForRole`, etc.) |
| `@incito-labs/project-run-engine/project` | `executeProjectRun`, `executeProjectResume`, `discoverProjectContext`, `FileExecutionStateStore` (including `withLock` and its lock-default options), `ExecutionStateStore` (optional `withLock`), `ExecutionLockOptions`, `withExecutionLock`, `PersistedExecutionState`, `runProjectDoctor`, `loadProjectConfig` |
| `@incito-labs/project-run-engine/host` | `startProjectRun`, `resumeProjectRun`, `statusProjectRun`, `nextProjectRunStep`, `submitProjectRunStep`, `projectEngineRun`, and the `ProjectRunHostResponse` / `ProjectRunStepResponse` types |

---

## License

Apache-2.0

