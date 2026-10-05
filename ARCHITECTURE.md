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
