# Incito Agent Orchestration — V1 State Machine Test Matrix

## 1. Purpose

This document defines the minimum test scenarios required before connecting real specialized agents to the Coordinator.

The State Machine must be testable without LLMs.

---

# 2. Valid Transition Tests

| Current State | Condition | Expected State |
|---|---|---|
| `INTAKE` | valid execution context | `SPECIFY` |
| `SPECIFY` | specification gate passes | `CLARIFY` |
| `CLARIFY` | clarification complete | `PLAN` |
| `PLAN` | planning gate passes | `TASKS` |
| `TASKS` | tasks gate passes | `ANALYZE` |
| `ANALYZE` | no blocking findings | `IMPLEMENT` |
| `IMPLEMENT` | implementation gate passes | `INDEPENDENT_REVIEW` |
| `INDEPENDENT_REVIEW` | review PASS | `CONVERGE` |
| `INDEPENDENT_REVIEW` | actionable findings | `REMEDIATION` |
| `REMEDIATION` | remediation gate passes | `RE_REVIEW` |
| `RE_REVIEW` | review PASS | `CONVERGE` |
| `RE_REVIEW` | findings + iterations available | `REMEDIATION` |
| `CONVERGE` | convergence PASS | `READY_FOR_PR` |
| `CONVERGE` | actionable findings + iterations available | `REMEDIATION` |

---

# 3. Invalid Transition Tests

The following must be rejected:

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

---

# 4. Gate Failure Tests

Verify that:

```text
SPECIFICATION gate FAIL
```

does not allow:

```text
SPECIFY → CLARIFY
```

Verify that:

```text
PLANNING gate FAIL
```

does not allow:

```text
PLAN → TASKS
```

Verify that:

```text
ANALYZE has HIGH finding
```

does not allow:

```text
ANALYZE → IMPLEMENT
```

Verify that:

```text
IMPLEMENTATION gate FAIL
```

does not allow:

```text
IMPLEMENT → INDEPENDENT_REVIEW
```

---

# 5. Evidence Tests

Verify that an agent result:

```text
PASS
```

without required evidence does not pass the associated gate.

Verify that:

```text
required evidence = FAIL
```

cannot satisfy the gate.

---

# 6. Review Loop Tests

### PASS

```text
INDEPENDENT_REVIEW
    ↓ PASS
CONVERGE
```

### Findings

```text
INDEPENDENT_REVIEW
    ↓ FINDINGS
REMEDIATION
    ↓ PASS
RE_REVIEW
```

### Re-review PASS

```text
RE_REVIEW
    ↓ PASS
CONVERGE
```

### Re-review Findings

```text
RE_REVIEW
    ↓ FINDINGS
REMEDIATION
```

when the iteration limit has not been reached.

---

# 7. Remediation Limit Test

Given:

```text
remediation_iteration = 3
actionable findings > 0
```

expected:

```text
HUMAN_INTERVENTION_REQUIRED
```

The Coordinator must not start a fourth remediation cycle.

---

# 8. Terminal State Tests

Verify:

```text
READY_FOR_PR → any state
```

is rejected.

Verify:

```text
HUMAN_INTERVENTION_REQUIRED → any state
```

is rejected.

---

# 9. State Persistence Tests

After every accepted transition verify:

```text
state updated
transition history appended
evidence persisted
gate status persisted
iteration counters preserved
```

After a rejected transition verify:

```text
state unchanged
history unchanged
```

unless an explicit failure/audit record is defined by the runtime.

---

# 10. Determinism Tests

Given identical:

```text
state
artifacts
gates
findings
evidence
counters
```

the transition engine must produce the same result every time.

No LLM should be required for these tests.
