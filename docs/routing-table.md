# Incito Agent Orchestration — V1 Routing Table

## 1. Purpose

This document maps Coordinator states to the specialized agent responsible for executing the work associated with that state.

Routing is deterministic.

The Coordinator selects an agent from the current state and the allowed transition, not from free-form agent reasoning.

---

# 2. Agent Types

| Agent | Responsibility |
|---|---|
| `SPECIFICATION` | Specification and clarification |
| `ARCHITECTURE` | Planning, tasks, analysis |
| `IMPLEMENTATION` | Application implementation |
| `INDEPENDENT_REVIEW` | Independent review and re-review |
| `REMEDIATION` | Finding remediation |
| `CONVERGENCE` | Final convergence |

---

# 3. State Routing

| Current State | Primary Agent | Operation |
|---|---|---|
| `INTAKE` | — | Initialize execution |
| `SPECIFY` | `SPECIFICATION` | Create/update specification |
| `CLARIFY` | `SPECIFICATION` | Resolve ambiguities |
| `PLAN` | `ARCHITECTURE` | Create implementation plan |
| `TASKS` | `ARCHITECTURE` | Generate implementation tasks |
| `ANALYZE` | `ARCHITECTURE` | Analyze specification/plan/tasks |
| `IMPLEMENT` | `IMPLEMENTATION` | Execute implementation |
| `INDEPENDENT_REVIEW` | `INDEPENDENT_REVIEW` | Review implementation |
| `REMEDIATION` | `REMEDIATION` | Resolve findings |
| `RE_REVIEW` | `INDEPENDENT_REVIEW` | Validate remediation |
| `CONVERGE` | `CONVERGENCE` | Validate final convergence |
| `READY_FOR_PR` | — | Terminal |
| `HUMAN_INTERVENTION_REQUIRED` | — | Terminal |

---

# 4. Routing Rules

## Rule 1

One execution state maps to one primary agent in V1.

---

## Rule 2

The Coordinator must not select an agent dynamically based on an LLM response.

---

## Rule 3

If no agent is mapped to a state, the state must be either:

```text
INTAKE
READY_FOR_PR
HUMAN_INTERVENTION_REQUIRED
```

---

## Rule 4

The Coordinator must verify that the selected agent is allowed to operate on the current state before invocation.

---

## Rule 5

An agent may not invoke another specialized agent through the Coordinator contract.

Agent orchestration remains the responsibility of the Coordinator.

---

# 5. Agent Operation Mapping

## Specification Agent

```text
SPECIFY
CLARIFY
```

---

## Architecture Agent

```text
PLAN
TASKS
ANALYZE
```

---

## Implementation Agent

```text
IMPLEMENT
```

---

## Independent Review Agent

```text
INDEPENDENT_REVIEW
RE_REVIEW
```

---

## Remediation Agent

```text
REMEDIATION
```

---

## Convergence Agent

```text
CONVERGE
```

---

# 6. Routing Failure

If a state requires an agent but no valid agent mapping exists:

```text
→ HUMAN_INTERVENTION_REQUIRED
```

The Coordinator must not attempt to execute the state itself.

---

# 7. Context Selection

The Coordinator must provide only the context relevant to the selected operation.

Examples:

### Implementation

```text
spec.md
plan.md
tasks.md
data-model.md
contracts/
constitution.md
relevant findings
```

### Review

```text
spec.md
plan.md
tasks.md
implementation diff
tests
contracts/
constitution.md
previous findings
```

### Remediation

```text
finding(s)
relevant implementation files
relevant tests
original requirements
review evidence
```

Context selection is part of orchestration, but the agent remains responsible for executing the operation.

---

# 8. Role, Capability, and Runtime Architecture

## 8.1 The Core Distinction: Agent Role != Skill != Runtime != Host

The architecture enforces a strict four-way separation of concerns:

```text
Human / Command
       │
       ▼
Execution Request (IncitoExecutionRequest)
       │
       ▼
Coordinator (State Machine / Decision Engine)
       ├─► Agent Role (WHAT responsibility)
       ├─► Required Skills (WHICH ordered procedures)
       └─► Runtime (WHERE to execute)
       │
       ▼
AgentDispatcher
       │
       ▼
RuntimeAdapter (HostDispatchAdapter)
       ├─► Antigravity
       ├─► Claude
       ├─► Cursor (future)
       └─► Mock
```

| Dimension | Concept | Definition | Example |
|---|---|---|---|
| **Agent Role** | WHAT responsibility | Functional persona in the feature lifecycle | `SPECIFICATION`, `REMEDIATION` |
| **Skill** | WHICH procedure | Abstract, provider-neutral capability/workflow | `speckit-bug-assess`, `speckit-bug-fix` |
| **Runtime** | WHERE boundary | Abstract runtime identifier passed to dispatcher | `ANTIGRAVITY`, `CLAUDE`, `CURSOR`, `MOCK` |
| **Host** | HOW executed | Physical engine/environment executing the agent | Local subagent, Anthropic CLI, Cursor runner |

### Architectural Invariant
1. The **Coordinator** decides WHAT role needs to execute and WHAT state transition is valid. It never executes skills directly.
2. The **Agent Role** declares its required Spec Kit skills in deterministic sequential order.
3. The **Skill Contract** (`AgentSkill`) is completely provider-neutral: no model names, API keys, CLI commands, or prompt templates.
4. The **Runtime Adapter** decides HOW/WHERE that role and its skills are executed.
5. The **Human Approval Boundary** ensures autonomous execution cannot begin without human consent.

---

## 8.2 Provider-Agnostic Role & Skill Contract

Each agent role maps to an ordered sequence of Spec Kit skills:

| Agent Role | Execution Order | Skill ID | Required | Capability | Workflow | Evidence Requirements |
|---|---|---|---|---|---|---|
| `SPECIFICATION` | 1 | `speckit-specify` | Yes | `spec-kit/specify` | `spec-kit/specify` | — |
| `SPECIFICATION` | 2 | `speckit-clarify` | No (when needed) | `spec-kit/clarify` | `spec-kit/clarify` | — |
| `ARCHITECTURE` | 1 | `speckit-plan` | Yes | `spec-kit/plan` | `spec-kit/plan` | — |
| `ARCHITECTURE` | 2 | `speckit-tasks` | Yes | `spec-kit/tasks` | `spec-kit/tasks` | — |
| `ARCHITECTURE` | 3 | `speckit-analyze` | Yes | `spec-kit/analyze` | `spec-kit/analyze` | — |
| `IMPLEMENTATION` | 1 | `speckit-implement` | Yes | `spec-kit/implement` | `spec-kit/implement` | — |
| `INDEPENDENT_REVIEW` | 1 | `speckit-analyze` | Yes | `spec-kit/independent-review` | `spec-kit/independent-review` | Finding reports, contract conformance |
| `REMEDIATION` | 1 | `speckit-bug-assess` | Yes | `spec-kit/bug-assess` | `spec-kit/bug-assess` | `assessment.md` |
| `REMEDIATION` | 2 | `speckit-bug-fix` | Yes | `spec-kit/bugfix` | `spec-kit/bugfix` | `finding`, `root_cause`, `correction`, `validation_performed`, `remaining_risks` |
| `REMEDIATION` | 3 | `speckit-bug-test` | Yes | `spec-kit/bug-test` | `spec-kit/bug-test` | `test.md` (re-verification) |
| `CONVERGENCE` | 1 | `speckit-converge` | Yes | `spec-kit/converge` | `spec-kit/converge` | Convergence report |

---

## 8.3 Remediation Bugfix Workflow Contract

Remediation must not merely edit code until tests pass.

The `REMEDIATION` role must execute the Spec Kit bugfix methodology (`speckit-bug-assess` → `speckit-bug-fix` → `speckit-bug-test`), producing evidence that captures:

1. **Finding**: Original finding identifier and problem statement.
2. **Root Cause**: Underlying cause of the defect.
3. **Correction**: Concrete code modifications applied.
4. **Validation Performed**: Automated tests run and results verified.
5. **Remaining Risks**: Known edge cases, caveats, or downstream considerations.

---

## 8.4 Interchangeable Host Runtimes

The orchestration domain preserves complete runtime independence. The same agent role and semantic Spec Kit capability requirement can be dispatched to any registered host runtime capability:

- `ANTIGRAVITY`
- `CLAUDE`
- `CURSOR`
- `MOCK`

The Coordinator and Dispatcher do not know provider-specific APIs, model parameters, or prompt formats. Skill and capability metadata are passed as abstract semantic requirements on `AgentDispatchRequest`.

---

# 9. Human Approval Boundary & Future Command Interface

## 9.1 Human vs. Coordinator vs. Runtime Boundaries

To prevent unwanted autonomy and maintain rigorous governance, responsibilities are partitioned as follows:

| Owner | Responsibilities | Invariants |
|---|---|---|
| **Human** | 1. Feature discovery & domain requirements<br>2. Initial clarification & business decisions<br>3. Review & approval of the specification<br>4. Final PR merge | Autonomous implementation cannot begin without explicit human approval. |
| **Coordinator** | 1. State machine transitions & enforcement<br>2. Agent selection & skill contract provision<br>3. Runtime selection & adapter resolution<br>4. Gate evaluations & evidence validation<br>5. Remediation loop & convergence limits | Never writes code, never invents evidence, never bypasses failed gates. |
| **Runtime** | 1. Physical dispatch of the agent role to the host<br>2. Execution of required Spec Kit skills<br>3. Gathering artifacts and returning `AgentResult` | Cannot alter Coordinator state transitions or redefine workflow decisions. |

## 9.2 Command Flow & `/project-run` Entrypoint

The primary portable workflow command is `/project-run`.

```text
/project-run (or /project-run doctor)
       │
       ▼
Project Run Bootstrap
       ├─► Load & Validate Project Config (.project-run/config.json)
       ├─► Discover Skills (SkillResolver)
       └─► Validate Skills (SkillValidator)
               │
               ├─► Missing required skills? ──► FAIL SAFELY (No agent executed)
               │
               ▼ All required skills present
Coordinator Engine (State Machine Loop)
       │
       ▼
Coordinator Decision Engine (Transitions & Gate Evaluations)
       │
       ▼
Agent Dispatcher (Enriched with role skills & validated)
       │
       ▼
Agent Runtime Adapter (HostDispatchAdapter)
       ├─► Antigravity
       ├─► Claude
       ├─► Cursor
       └─► Mock
```

### Invariants:
1. **Single Command Complete Workflow**: A single invocation of `/project-run` drives the feature through its full lifecycle: `IMPLEMENT` → `INDEPENDENT_REVIEW` → `REMEDIATION` → `RE_REVIEW` → `CONVERGE` → `READY_FOR_PR`. The human does NOT need to manually trigger intermediate review, remediation, or converge commands.
2. **Pre-Execution Skill Guard**: Before any agent is dispatched, the `SkillValidator` checks that every required skill for that role is available. If any required skill is missing, execution is halted immediately with a structured error, ensuring **no agent execution or LLM call occurs**.
3. **Mandatory Independent Review Guard**: The `INDEPENDENT_REVIEW` role strictly requires `speckit-analyze` (capability `spec-kit/independent-review`). It is mandatory and cannot be treated as optional; if unavailable, `/project-run` safely blocks execution and `/project-run doctor` flags the missing requirement.
4. **Diagnostic Doctor (`/project-run doctor`)**: Provides non-destructive environment verification (configuration validity, role requirements, skill discovery, runtime adapter readiness) without executing agents or modifying project files.
5. **Portability Across Projects**: Any repository can adopt this workflow by providing `.project-run/config.json` and a skills directory (e.g. `.project-run/skills` or `.agents/skills`). The core engine remains 100% project-agnostic.
6. **No Automatic Skill Installation**: The engine never silently downloads, executes, or installs arbitrary code. Missing skills result in deterministic failure, preserving human control over project dependencies.

## 9.3 Explicit Skill Injection into Agent Dispatch

```text
Project Configuration (.project-run/config.json)
       │
       ▼
SkillResolver (Discovers SKILL.md paths & metadata)
       │
       ▼
SkillValidator (Validates availability)
       │
       ├─► Missing mandatory skill? ──► HALT (No runtime/LLM invoked)
       │
       ▼ All mandatory skills available
Enrich AgentDispatchRequest (skills / required_skills: AgentSkillRequirement[])
       │
       ▼
AgentDispatcher (Passes exact request reference)
       │
       ▼
AgentRuntimeAdapter (HostDispatchAdapter / MockRuntimeAdapter)
       ├─► ANTIGRAVITY (Host subprocess/dispatch)
       ├─► CLAUDE (Host CLI dispatch)
       ├─► CURSOR (Future host runner)
       └─► MOCK (Deterministic testing)
```

1. **Skill Requirements Belong to Role Configuration**:
   Each agent role defines its required and optional skills declaratively in project configuration (`.project-run/config.json`) and agent definitions (`AgentDefinition.skills`).
2. **Resolution & Validation Before Runtime Invocation**:
   Before an agent is dispatched, `SkillResolver` discovers the skill descriptors (locating the `SKILL.md` path and version metadata) and `SkillValidator` verifies that all mandatory skills exist. Missing mandatory skills immediately abort the workflow before invoking any runtime adapter or LLM.
3. **Skill Injection into `AgentDispatchRequest`**:
   The validated, resolved skills are injected into the dispatch request (`request.skills` and `request.required_skills` as `AgentSkillRequirement[]`). Each requirement includes `id`, `required`, `capability`, `execution_order`, `source` (file location), `workflow`, and `evidenceRequirements`.
4. **Exact Pass-Through to Generic Runtime Adapters**:
   `AgentDispatcher` delivers the exact request object to the registered `AgentRuntimeAdapter` without altering or reinterpreting the domain payload.
5. **Runtime Independence**:
   Runtime adapters (`HostDispatchAdapter`, `MockRuntimeAdapter`, and future adapters) consume the generic `AgentDispatchRequest`. Concrete host execution (Antigravity subprocess, Claude Code CLI, Cursor runner) resides entirely behind the adapter boundary; the Coordinator and Dispatcher remain 100% LLM- and provider-neutral.
6. **Unified Workflow Command**:
   `/project-run` remains the sole user-facing entry point. The entire lifecycle (`IMPLEMENT` → `INDEPENDENT_REVIEW` → `REMEDIATION` → `RE_REVIEW` → `CONVERGE` → `READY_FOR_PR`) executes automatically without separate user review or remediation commands.




