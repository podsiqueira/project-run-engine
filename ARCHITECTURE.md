# Architecture: project-run-engine

## 1. System Overview

`project-run-engine` provides a reusable, deterministic multi-agent orchestration architecture for software delivery. It establishes strict separation between:

1. **Orchestration Logic**: What role executes, what state transition occurs, and how findings/evidence are evaluated.
2. **Project Configuration**: How a consuming repository names its project, configures its feature paths, and assigns skills to roles.
3. **Host Runtime Execution**: How and where an agent physically runs (Antigravity, Claude, Cursor, CI worker, etc.).

```
┌─────────────────────────────────────────────────────────────┐
│                       Consuming Project                     │
│  (.project-run/config.json, skills/, consumer host bridge)  │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    project-run-engine                       │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │               Coordinator Execution Loop            │   │
│   └───────────────▲─────────────────────┬───────────────┘   │
│                   │                     │                   │
│   ┌───────────────┴──────────────┐ ┌────▼───────────────┐   │
│   │  CoordinatorDecisionEngine   │ │   AgentDispatcher  │   │
│   │    (Pure State Machine)      │ │(Skills Validation) │   │
│   └──────────────────────────────┘ └────┬───────────────┘   │
│                                         │                   │
│   ┌─────────────────────────────────────▼───────────────┐   │
│   │             Host Execution Contract                 │   │
│   │      (HostDispatchAdapter, executeWithHostGuards)   │   │
│   └─────────────────────────────────────┬───────────────┘   │
└─────────────────────────────────────────┼───────────────────┘
                                          │
                        ┌─────────────────┴─────────────────┐
                        │ Consumer-Injected Runtime Adapter │
                        │  (Antigravity / Claude / Custom)  │
                        └───────────────────────────────────┘
```

---

## 2. Core Invariants

1. **Zero LLM / Provider SDK Dependencies**:
   The engine does not import or call OpenRouter, OpenAI, Anthropic, Vercel AI SDK, or any model provider. Dispatches are runtime-agnostic data structures (`AgentDispatchRequest`).

2. **Runtime Extensibility**:
   Runtimes are not hardcoded inside the Coordinator or Decision Engine. While standard runtime constants (`ANTIGRAVITY`, `CLAUDE`, `CURSOR`, `MOCK`) are provided, consumers may register any custom runtime identifier (`CI_AGENT`, `K8S_RUNNER`, etc.) without modifying engine source code.

3. **Skill Safety Guard**:
   Agent roles require specific skills (e.g. Spec-Kit capabilities). The engine inspects local workspace paths and validates that all mandatory skills exist before dispatching any agent. If a mandatory skill is missing, execution is halted immediately (`BLOCKED_MISSING_SKILLS`). Skills are never automatically fetched from remote networks.

4. **Single User Command**:
   The entire lifecycle (`INTAKE -> SPECIFY -> CLARIFY -> PLAN -> TASKS -> ANALYZE -> IMPLEMENT -> INDEPENDENT_REVIEW -> REMEDIATION -> RE_REVIEW -> CONVERGE -> READY_FOR_PR`) is driven automatically by the Coordinator loop without requiring separate commands for review or remediation.

---

## 3. Module Responsibilities

### `src/domain/`
Defines provider-neutral types, execution records, dispatch requests, agent definitions, and validation contracts.

### `src/coordinator/`
Implements the continuous execution loop (`Coordinator`). The loop requests a decision from the decision engine, dispatches agents via the dispatcher, receives structured results, updates execution state, and repeats until a terminal state (`READY_FOR_PR` or `HUMAN_INTERVENTION_REQUIRED`) is reached.

### `src/decision/`
Contains the pure, deterministic `CoordinatorDecisionEngine`. It implements the formal state machine transition matrix and decides whether to dispatch an agent, transition to a new state, require human intervention, or complete the workflow. It performs zero I/O and zero network operations.

### `src/agents/`
Maintains the `AgentRegistry` and `AgentDispatcher`. The dispatcher verifies required skills, enriches requests with resolved skill metadata, and delegates execution to registered runtime adapters.

### `src/runtime/`
Defines the `AgentRuntimeAdapter` interface and the `HostDispatchAdapter`. The `HostDispatchAdapter` wraps consumer-provided host execution logic with standard host guards (`executeWithHostGuards`), enforcing timeouts, cancellation signals, and lifecycle status tracking.

### `src/skills/`
Provides `SkillResolver` (discovers skills from `.project-run/skills`, `.agents/skills`, or custom paths and parses frontmatter metadata) and `SkillValidator` (checks presence of required and optional skills per role).

### `src/presets/`
Encapsulates workflow presets such as the Spec-Kit skill contract (`spec-kit-preset.ts`) and role-to-skill mappings.

### `src/project/`
Provides project-level integration:
- `project-config.ts`: Loads and validates `.project-run/config.json`.
- `project-run.ts`: Bootstraps and executes `/project-run` workflows.
- `doctor.ts`: Performs non-destructive health checks across config, skills, and runtimes.

### `src/host/`
Provides the provider-agnostic Host Skill Contract (`ProjectRunHost`) a host agent
invokes instead of parsing CLI output or reimplementing the state machine. See
Section 4 below.

---

## 4. Host-Agent Orchestration Model

`project-run-engine` is designed to be invoked interactively from an AI coding-agent
environment — Claude Code, Cursor, Antigravity, Codex, or any other host capable of
running a slash command / tool / skill and executing role-specific work. The intended
end-user experience is conceptually:

```text
/project-engine-run "004-campaigns-and-lead-attribution"
```

**The slash command itself is a host responsibility.** This package does not, and will
not, implement `/project-engine-run` as a Claude/Cursor/Antigravity/Codex-specific
artifact (no `.claude/commands/...`, no Cursor rule file, no MCP server is bundled
here). What this package provides instead is the clean, machine-readable,
provider-neutral interface a host's own slash-command implementation calls into.

### 4.1 The split

```text
┌─────────────────────────────────────────────────────┐
│                     HOST AGENT                       │
│                                                       │
│   Claude Code  /  Cursor  /  Antigravity  /  Codex   │
│                                                       │
│   - the conversational interface                     │
│   - the actual /project-engine-run command/tool/skill│
│   - presenting HumanQuestion[] to the human           │
│   - collecting the human's answers                    │
│   - invoking start()/resume() below                   │
│   - the runtime-specific AgentRuntimeAdapter(s)       │
└───────────────────────────┬───────────────────────────┘
                            │ ProjectRunHost (src/host/)
                            │ .start() / .resume()
                            ▼
┌─────────────────────────────────────────────────────┐
│               PROJECT RUN ENGINE (this package)       │
│                                                       │
│   - workflow state & the 13-state state machine       │
│   - CoordinatorDecisionEngine (transitions, gates)    │
│   - checkpoints / persistence / resume                │
│   - clarification & analysis blocking gates           │
│   - the Human-in-the-Loop contract (HumanQuestion[])  │
│   - role dispatch contracts (AgentDispatchRequest)     │
│   - workflow sequencing & convergence rules            │
└───────────────────────────┬───────────────────────────┘
                            │ AgentDispatchRequest
                            ▼
┌─────────────────────────────────────────────────────┐
│              HOST AGENT RUNTIME (host-supplied)       │
│                                                       │
│   Executes the dispatched role's work using whichever │
│   host it is, and returns a structured AgentResult.   │
└─────────────────────────────────────────────────────┘
```

The engine never needs to know whether the host is Claude, Cursor, Antigravity, or
Codex — it only ever sees an `AgentRuntimeAdapter[]`, exactly as it always has. The
host never needs to reimplement the state machine, gate evaluation, or persistence —
it only ever calls `start()`/`resume()` and renders whatever comes back.

### 4.2 The Host Skill Contract (`src/host/`)

```typescript
interface ProjectRunHost {
  start(request: ProjectRunHostRequest): Promise<ProjectRunHostResponse>;
  resume(request: ProjectRunResumeRequest): Promise<ProjectRunHostResponse>;
}
```

`ProjectRunHostResponse.status` is one of `COMPLETED | HUMAN_INTERVENTION_REQUIRED |
BLOCKED_MISSING_SKILLS | FAILED` — never a string a host must parse human-readable
prose out of. When `status === "HUMAN_INTERVENTION_REQUIRED"`, the response carries a
structured `humanIntervention: HumanInterventionRequired` with a `HumanQuestion[]` the
host renders directly:

```text
Project Run needs your input before continuing.

Question:
[CRITICAL] Which authentication model should this feature use?

Why this matters:
Evidence: Spec does not define auth model for campaign attribution endpoints
```

The host collects the answer and calls `resume()` with `humanAnswers: [{ questionId,
answer }]`. The engine persists the answer durably (for audit: what was asked, what
was answered, when) but never mutates the original finding directly — the agent
responsible for the suspended state is always re-dispatched to independently verify
the fix, consistent with the Finding Contract's principle that a finding is resolved
only once independently re-verified, not merely because someone says it is fixed.

### 4.3 Progress events

A host supplies an optional `onEvent` callback to both `start()` and `resume()` to
render live progress without polling the state store or scraping logs:

```text
RUN_STARTED · RESUME_STARTED · STATE_CHANGED ·
AGENT_DISPATCH_STARTED · AGENT_DISPATCH_COMPLETED ·
HUMAN_INTERVENTION_REQUIRED · RUN_COMPLETED · RUN_FAILED
```

```text
Project Run
✓ Specification
✓ Clarification
→ Architecture
⏸ Waiting for your input
```

### 4.4 Conceptual host integrations (not implemented in this package)

| Host | Conceptual integration |
|---|---|
| **Claude Code** | An Agent Skill whose `/project-engine-run "<feature>"` body calls `ProjectRunHost.start()`/`.resume()`, renders `humanIntervention.questions`, and supplies the host's own `AgentRuntimeAdapter`. |
| **Cursor** | A custom tool/rule wired to the same contract, likely via an MCP server that exposes `start`/`resume` as tools. |
| **Antigravity** | A subagent/skill definition invoking the same contract, using Antigravity's own agent execution mechanism as the `AgentRuntimeAdapter`. |
| **Codex** | An MCP tool (or native tool-calling integration) over the same contract. |

None of the above are implemented in this repository. Only the engine-side contract —
`src/host/` — is. Provider-specific slash commands, MCP servers, and IDE integrations
belong to each host's own integration work, built on top of this contract.

### 4.5 CLI role

The CLI (`project-run-cli.ts`) is one possible consumer of this same orchestration
API, not the core interface: `project-run`/`project-run resume` call
`startProjectRun`/`resumeProjectRun` (`src/host/project-run-host.ts`) rather than
touching `Coordinator` internals directly. It remains useful for local development,
debugging, and CI/batch execution, but a host agent integration should call the
`ProjectRunHost` contract directly rather than shelling out to the CLI and parsing its
output.
