# Incito Agent Orchestration — V1 Transition Contract

## 1. Purpose

This document defines the formal contract used by the Coordinator to validate state transitions.

The State Machine defines which transitions exist. This contract defines the information required to authorize each transition.

A transition is valid only when:

```text
Current State
    +
Allowed Transition
    +
Required Gate
    +
Gate Result
    +
Required Evidence
    +
Transition Preconditions
    ↓
VALID TRANSITION
```

The Coordinator must reject any transition that does not satisfy this contract.

---

# 2. Transition Model

Conceptually:

```typescript
interface Transition {
  from: CoordinatorState;
  to: CoordinatorState;

  trigger:
    | "SYSTEM"
    | "AGENT_RESULT"
    | "GATE"
    | "HUMAN";

  agent?: AgentType;

  requiredGate?: GateName;

  preconditions: string[];

  requiredEvidence: EvidenceRequirement[];

  terminal?: boolean;
}
```

---

# 3. Transition Rules

## Rule 1 — Current State

The transition must originate from the persisted current state.

```text
transition.from === state.execution.state
```

If this is false, the transition must be rejected.

---

## Rule 2 — Explicit Transition

The `(from, to)` pair must exist in the V1 State Machine.

Unknown transitions are invalid.

---

## Rule 3 — Gate Requirement

If a transition requires a gate:

```text
gate.status === PASS
```

must be true.

A missing, pending, failed, or blocked gate cannot authorize a transition.

---

## Rule 4 — Evidence Requirement

All evidence required by the transition must exist and have:

```text
status = PASS
```

---

## Rule 5 — Agent Result

When a transition is triggered by an agent:

- The result must belong to the current execution.
- The result must identify the responsible agent.
- The result must conform to the Agent Contract.
- Required evidence must be present.
- Findings must be structurally valid.

---

## Rule 6 — No Agent-Owned Transitions

An agent may report:

```text
PASS
FINDINGS
FAIL
BLOCKED
```

but cannot authorize its own state transition.

The Coordinator evaluates the result.

---

# 4. V1 Transition Contracts

## INTAKE → SPECIFY

Trigger:

```text
SYSTEM
```

Preconditions:

```text
execution context exists
feature identifier exists
feature branch exists
```

Agent:

```text
SPECIFICATION
```

---

## SPECIFY → CLARIFY

Required gate:

```text
SPECIFICATION
```

Required conditions:

```text
spec.md exists
requirements defined
acceptance criteria defined
specification evidence exists
```

Agent:

```text
SPECIFICATION
```

---

## CLARIFY → PLAN

Required gate:

```text
SPECIFICATION
```

Preconditions:

```text
blocking ambiguities = 0
clarification evidence exists
```

Agent:

```text
ARCHITECTURE
```

---

## CLARIFY → HUMAN_INTERVENTION_REQUIRED

Trigger:

```text
GATE
```

Precondition:

```text
blocking ambiguity cannot be resolved automatically
```

No agent is selected.

---

## PLAN → TASKS

Required gate:

```text
PLANNING
```

Required conditions:

```text
plan.md exists
required architecture decisions documented
required artifacts available
planning evidence exists
```

Agent:

```text
ARCHITECTURE
```

---

## TASKS → ANALYZE

Required gate:

```text
TASKS
```

Required conditions:

```text
tasks.md exists
requirements have coverage
dependencies defined
task evidence exists
```

Agent:

```text
ARCHITECTURE
```

---

## ANALYZE → IMPLEMENT

Required gate:

```text
ANALYZE
```

Required condition:

```text
CRITICAL = 0
HIGH = 0
MEDIUM = 0
```

Agent:

```text
IMPLEMENTATION
```

---

## ANALYZE → HUMAN_INTERVENTION_REQUIRED

Trigger:

```text
GATE
```

Condition:

```text
blocking analysis findings remain
```

No agent is selected.

---

## IMPLEMENT → INDEPENDENT_REVIEW

Required gate:

```text
IMPLEMENTATION
```

Required evidence:

```text
tests
typecheck
lint
build when applicable
git state
```

Agent:

```text
INDEPENDENT_REVIEW
```

---

## INDEPENDENT_REVIEW → CONVERGE

Required gate:

```text
REVIEW
```

Condition:

```text
review status = PASS
actionable findings = 0
```

Agent:

```text
CONVERGENCE
```

---

## INDEPENDENT_REVIEW → REMEDIATION

Condition:

```text
review status = FINDINGS
actionable findings > 0
```

Agent:

```text
REMEDIATION
```

---

## REMEDIATION → RE_REVIEW

Required gate:

```text
REMEDIATION
```

Required:

```text
remediation evidence exists
technical verification passes
```

Agent:

```text
INDEPENDENT_REVIEW
```

---

## RE_REVIEW → CONVERGE

Condition:

```text
review status = PASS
actionable findings = 0
```

Agent:

```text
CONVERGENCE
```

---

## RE_REVIEW → REMEDIATION

Condition:

```text
review status = FINDINGS
actionable findings > 0
remediation_iteration < MAX_REMEDIATION_ITERATIONS
```

Agent:

```text
REMEDIATION
```

---

## RE_REVIEW → HUMAN_INTERVENTION_REQUIRED

Condition:

```text
actionable findings > 0
remediation_iteration >= MAX_REMEDIATION_ITERATIONS
```

No agent is selected.

---

## CONVERGE → READY_FOR_PR

Required gate:

```text
CONVERGENCE
```

Conditions:

```text
convergence = PASS
actionable findings = 0
```

Terminal:

```text
true
```

---

## CONVERGE → REMEDIATION

Condition:

```text
convergence = FAIL
actionable findings > 0
remediation_iteration < MAX_REMEDIATION_ITERATIONS
```

Agent:

```text
REMEDIATION
```

---

# 5. Invalid Transitions

The Coordinator must reject, at minimum:

```text
SPECIFY → IMPLEMENT
PLAN → IMPLEMENT
TASKS → IMPLEMENT
ANALYZE → CONVERGE
IMPLEMENT → CONVERGE
IMPLEMENT → READY_FOR_PR
REMEDIATION → CONVERGE
REMEDIATION → READY_FOR_PR
INDEPENDENT_REVIEW → READY_FOR_PR
```

The Coordinator must also reject any transition from:

```text
READY_FOR_PR
HUMAN_INTERVENTION_REQUIRED
```

---

# 6. Transition Persistence

Every accepted transition must append a history record.

Conceptually:

```json
{
  "from": "IMPLEMENT",
  "to": "INDEPENDENT_REVIEW",
  "triggeredBy": "GATE",
  "agent": "INDEPENDENT_REVIEW",
  "evidenceIds": [
    "EV-101",
    "EV-102"
  ],
  "timestamp": "..."
}
```

The history is append-only.

---

# 7. Transition Atomicity

A transition must be persisted atomically with the resulting state.

The Coordinator must not produce:

```text
state = INDEPENDENT_REVIEW
```

without recording the transition that caused it.

Likewise, a transition history entry must not exist without the corresponding state update.

---

# 8. Transition Determinism

Given the same:

```text
current state
persisted artifacts
gate results
findings
evidence
execution counters
```

the Coordinator must produce the same valid transition.

The V1 transition engine must not use an LLM to decide whether a transition is structurally allowed.
