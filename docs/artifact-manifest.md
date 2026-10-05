# Incito Agent Orchestration — V1 Artifact Manifest

## Purpose

This manifest records the intended V1 orchestration artifacts and their responsibilities.

## Core State

| Artifact | Responsibility |
|---|---|
| `state-machine.md` | Defines states and lifecycle |
| `state-contract.schema.json` | Defines persisted execution state |

## Contracts

| Artifact | Responsibility |
|---|---|
| `agent-contract.md` | Agent input/output boundary |
| `finding-contract.md` | Finding lifecycle and structure |
| `evidence-contract.md` | Evidence structure and validation |
| `gate-contract.md` | Gate evaluation rules |
| `transition-contract.md` | State transition authorization |
| `coordinator-contract.md` | Coordinator behavior |
| `execution-context.md` | Agent execution context |
| `context-policy.md` | Context selection rules |

## Routing and Validation

| Artifact | Responsibility |
|---|---|
| `routing-table.md` | State → Agent routing |
| `state-machine-test-matrix.md` | State-machine validation scenarios |

## Architectural Boundary

The V1 artifacts intentionally separate:

```text
WHAT THE SYSTEM ALLOWS
    ↓
State Machine + Contracts

WHO EXECUTES THE WORK
    ↓
Routing + Specialized Agents

HOW THE WORK IS DELIVERED
    ↓
Execution Context

HOW THE SYSTEM IS IMPLEMENTED
    ↓
Coordinator Runtime
```

The runtime implementation should not redefine these rules implicitly.
