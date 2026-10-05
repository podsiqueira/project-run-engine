# Incito Agent Orchestration — V1 Coordinator Contract

## 1. Purpose

This document defines the behavioral contract of the V1 Coordinator.

The Coordinator is a deterministic workflow controller.

It does not implement application code and does not perform the work assigned to specialized agents.

---

# 2. Core Responsibility

The Coordinator must:

1. Load persisted execution state.
2. Validate the State Contract.
3. Identify the current state.
4. Determine allowed transitions.
5. Evaluate required gates.
6. Select the responsible agent.
7. Build the agent execution context.
8. Execute the agent.
9. Validate the Agent Result.
10. Validate returned evidence.
11. Evaluate the resulting gate.
12. Persist the new state.
13. Record the transition.
14. Continue or stop according to the State Machine.

---

# 3. Coordinator Must Not

The Coordinator must not:

- implement application code;
- modify application files as remediation;
- write the feature specification;
- perform independent review;
- resolve findings itself;
- invent missing evidence;
- bypass a failed gate;
- create an unapproved transition;
- decide architecture on behalf of the Architecture Agent;
- use subjective judgment to declare a feature complete.

---

# 4. Execution Cycle

Every Coordinator cycle follows:

```text
LOAD
 ↓
VALIDATE STATE
 ↓
EVALUATE CURRENT STATE
 ↓
RESOLVE TRANSITION
 ↓
ROUTE AGENT
 ↓
EXECUTE AGENT
 ↓
VALIDATE RESULT
 ↓
VALIDATE EVIDENCE
 ↓
EVALUATE GATE
 ↓
PERSIST
 ↓
TRANSITION
```

---

# 5. Determinism

The Coordinator must use deterministic rules for:

```text
state validation
transition validation
routing
gate evaluation
iteration limits
terminal-state detection
```

LLMs may be used by specialized agents, but V1 state control must not depend on an LLM deciding whether a transition is allowed.

---

# 6. State Authority

The persisted State Contract is the authoritative execution state.

The Coordinator must not infer a different state from conversational output.

If persisted state and agent output conflict:

```text
persisted state wins
```

and the conflict must be recorded as an execution problem.

---

# 7. Evidence Authority

Evidence is the basis for gate decisions.

The Coordinator must not transform:

```text
agent says PASS
```

into:

```text
gate = PASS
```

without validating the required evidence.

---

# 8. Failure Policy

When the Coordinator encounters:

```text
invalid state
invalid transition
missing required evidence
invalid agent result
missing required agent
blocking gate failure
```

it must stop the affected workflow rather than bypassing the condition.

Where the State Machine defines a human-intervention transition, it must use:

```text
HUMAN_INTERVENTION_REQUIRED
```

---

# 9. Iteration Policy

V1 must track:

```text
iteration
remediation_iteration
```

The maximum remediation limit is:

```text
MAX_REMEDIATION_ITERATIONS = 3
```

The limit applies to remediation loops and prevents indefinite automated execution.

---

# 10. Persistence

After every accepted state transition, the Coordinator must persist:

```text
current state
gate results
findings
evidence
Git state
iteration counters
transition history
```

A failed transition must not mutate the current state.

---

# 11. Auditability

The Coordinator must be able to answer:

```text
What state are we in?
Why are we in this state?
Which agent executed last?
What evidence was produced?
Which gate passed or failed?
Which findings remain?
How many remediation cycles occurred?
What caused the last transition?
```

The State Contract and transition history must provide these answers.

---

# 12. Terminal Behavior

When:

```text
READY_FOR_PR
```

is reached:

```text
STOP
```

When:

```text
HUMAN_INTERVENTION_REQUIRED
```

is reached:

```text
STOP
```

No automatic work continues after either terminal state.

---

# 13. Coordinator Mental Model

The Coordinator should be implemented conceptually as:

```text
State
  +
Rules
  +
Evidence
  +
Agent Result
  ↓
Deterministic Transition
```

Not as:

```text
LLM
  ↓
"figure out what to do next"
```

---

# 14. V1 Success Criterion

The Coordinator is successful when it can reliably execute the State Machine without needing to understand or implement the application itself.

Its intelligence is intentionally limited.

Its reliability comes from:

```text
explicit states
explicit contracts
explicit gates
explicit transitions
explicit evidence
explicit limits
```

---

# 15. Human Approval Boundary & Skill Delegation

## 15.1 Human Approval Boundary

The feature workflow is never fully autonomous by default.

1. **Human Ownership**: The human operator owns:
   - Initial feature intent and business goals (`/incito feature`)
   - Domain clarification and tradeoff decisions
   - Formal sign-off on `spec.md`, `plan.md`, and `tasks.md` before execution begins
2. **Autonomous Execution Gate**: Autonomous transition into implementation (`/incito run`) requires explicit human approval (`human_approved: true` on `IncitoExecutionRequest`).
3. **Rejection of Unapproved Autonomous Runs**: If an execution request attempts `RUN` without verified human approval, the Coordinator refuses dispatch and requires human intervention.

## 15.2 Coordinator Skill Non-Execution Rule

The Coordinator:
- **Decides WHAT** agent role must execute.
- **Specifies WHICH** ordered Spec Kit skills (`AgentSkill[]`) are required.
- **Passes WHERE** the work is to be executed (`AgentRuntime`).
- **NEVER executes skills itself**. Skill execution is delegated strictly through `AgentDispatcher` to the registered `RuntimeAdapter` and host runtime.

