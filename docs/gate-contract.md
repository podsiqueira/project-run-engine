# Incito Agent Orchestration — V1 Gate Contract

## 1. Purpose

This document defines the validation gates used by the V1 Coordinator to authorize state transitions.

A gate is a deterministic evaluation over the execution state, artifacts, findings, evidence, and repository state.

A gate is not a free-form agent opinion.

---

# 2. Gate Status

All V1 gates use:

```text
PENDING
PASS
FAIL
BLOCKED
```

---

# 3. Specification Gate

## Required conditions

```text
spec.md exists
requirements defined
acceptance criteria defined
required clarifications resolved
quality checklist passes
required evidence exists
```

## Pass

All required conditions are satisfied.

## Fail

One or more required conditions are not satisfied.

---

# 4. Planning Gate

## Required conditions

```text
plan.md exists
architectural decisions documented
required research completed
required contracts defined
required data model defined
evidence exists
```

The plan must reflect the real repository.

---

# 5. Tasks Gate

## Required conditions

```text
tasks.md exists
tasks follow expected structure
requirements have coverage
dependencies are defined
tasks have purpose
tasks are traceable
```

---

# 6. Analyze Gate

The Analyze Gate passes only when:

```text
CRITICAL findings = 0
HIGH findings     = 0
MEDIUM findings   = 0
```

Low findings may remain only when the feature policy explicitly permits them and they are not silently ignored.

If blocking findings remain:

```text
ANALYZE → HUMAN_INTERVENTION_REQUIRED
```

---

# 7. Implementation Gate

Required conditions:

```text
relevant tasks complete
tests pass
typecheck passes
lint passes
build passes when applicable
branch known
working tree known
evidence exists
```

The exact build requirement may depend on the repository and feature.

---

# 8. Review Gate

The Independent Review Agent must return exactly:

```text
PASS
```

or:

```text
FINDINGS
```

A review gate cannot pass while actionable findings remain.

---

# 9. Remediation Gate

The Remediation Gate requires:

```text
required remediation implemented
relevant tests pass
technical verification passes
remediation evidence exists
```

Passing remediation does not authorize convergence.

The mandatory next state is:

```text
REMEDIATION → RE_REVIEW
```

---

# 10. Convergence Gate

The Convergence Gate passes only when:

```text
requirements satisfied
success criteria satisfied
acceptance scenarios satisfied
architectural decisions respected
constitution principles respected
tasks complete
previous findings resolved
actionable gaps = 0
```

Actionable gap categories include:

```text
missing
partial
contradicts
unrequested
```

---

# 11. Gate Evaluation Rule

The Coordinator should evaluate gates from persisted state.

Conceptually:

```text
Gate(
    artifacts,
    findings,
    evidence,
    git,
    agentResult
)
    ↓
PASS | FAIL | BLOCKED
```

The gate evaluator must be deterministic.

---

# 12. Gate vs Agent Result

An agent result is input to gate evaluation.

It is not the gate itself.

```text
AgentResult
    ↓
Evidence validation
    ↓
Artifact validation
    ↓
Finding validation
    ↓
Gate evaluation
    ↓
Gate Status
```

This prevents an agent from advancing the workflow simply by returning `PASS`.

---

# 13. Gate Rules

1. No gate may pass without required evidence.
2. A failed required condition means the gate cannot pass.
3. A gate failure blocks the associated transition.
4. Gate status must be persisted.
5. Gate evaluations must be reproducible from persisted state.
6. The Coordinator owns transition decisions; agents do not.
