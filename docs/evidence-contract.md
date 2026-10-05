# Incito Agent Orchestration — V1 Evidence Contract

## 1. Purpose

This document defines the evidence required for the Coordinator to make deterministic gate and transition decisions.

The Coordinator must make decisions from evidence rather than subjective agent statements.

---

# 2. Evidence Schema

Conceptually:

```typescript
interface Evidence {
  id: string;

  type:
    | "FILE"
    | "COMMAND"
    | "TEST"
    | "BUILD"
    | "LINT"
    | "TYPECHECK"
    | "ARTIFACT"
    | "GIT";

  description: string;

  reference?: string;

  status: "PASS" | "FAIL";

  timestamp: string;
}
```

---

# 3. Evidence Types

## FILE

Evidence that a file exists or contains the required content.

Example:

```text
specs/003/spec.md
```

---

## COMMAND

Evidence from an executed command.

Example:

```text
npm run validate
```

---

## TEST

Evidence from automated tests.

Example:

```text
npm test
```

---

## BUILD

Evidence that the applicable build succeeds.

---

## LINT

Evidence that linting succeeds.

---

## TYPECHECK

Evidence that static type checking succeeds.

---

## ARTIFACT

Evidence that a required project artifact was produced and validated.

---

## GIT

Evidence about repository state.

Examples:

```text
branch
commit
working tree
```

---

# 4. Evidence Status

Evidence is either:

```text
PASS
```

or:

```text
FAIL
```

A failed evidence item cannot satisfy a gate requiring successful verification.

---

# 5. Evidence Identity

Evidence IDs should remain unique within an execution.

Example:

```text
EV-001
EV-002
EV-003
```

---

# 6. Evidence and Gates

A gate must define which evidence types are required.

The Coordinator must not infer that a gate passed merely because an agent returned `PASS`.

Example:

```text
Implementation Gate
    ↓
requires:
    TEST = PASS
    TYPECHECK = PASS
    LINT = PASS
    GIT = PASS
```

---

# 7. Evidence-First Rule

The following is not sufficient:

```text
"Tests passed."
```

The agent must provide evidence such as:

```json
{
  "id": "EV-031",
  "type": "TEST",
  "description": "Unit test suite passed",
  "reference": "npm test",
  "status": "PASS",
  "timestamp": "2026-10-04T18:00:00Z"
}
```

---

# 8. Evidence Immutability

Evidence represents what was observed at a point in execution.

The Coordinator should append new evidence rather than rewriting historical evidence.

This allows the execution history to remain auditable.

---

# 9. Evidence Rules

1. Gates must be evidence-backed.
2. Failed evidence cannot satisfy a passing gate.
3. Evidence must identify what was verified.
4. Evidence should provide a reference whenever one exists.
5. Historical evidence must remain traceable.
