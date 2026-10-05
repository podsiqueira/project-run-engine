# Incito Agent Orchestration — V1 Agent Contract

## 1. Purpose

This document defines the common contract between the V1 Coordinator and specialized agents.

The Coordinator owns workflow state, transitions, gates, persistence, and process control.

Specialized agents own execution within their assigned responsibility.

The Coordinator must never depend on free-form natural-language output as the authoritative result of an agent execution.

---

# 2. Agent Types

V1 defines the following specialized agent roles:

```text
SPECIFICATION
ARCHITECTURE
IMPLEMENTATION
INDEPENDENT_REVIEW
REMEDIATION
CONVERGENCE
```

The Coordinator itself is not an implementation agent.

---

# 3. Agent Invocation Contract

The Coordinator provides an agent with:

```text
- execution context
- current state
- relevant artifacts
- relevant findings
- applicable instructions
- required objective
- applicable gate criteria
```

The agent must operate only within its assigned responsibility.

The agent must return a structured result.

---

# 4. Agent Result

Every agent must return a result conforming conceptually to:

```typescript
interface AgentResult {
  execution_id: string;
  agent: AgentType;

  status:
    | "PASS"
    | "FAIL"
    | "FINDINGS"
    | "BLOCKED";

  summary: string;

  artifacts: ArtifactResult[];

  evidence: Evidence[];

  findings: Finding[];
}
```

The exact runtime representation may be implemented in TypeScript, JSON, or another validated format, but the semantic contract must remain equivalent.

---

# 5. Result Status

## PASS

The agent completed its assigned activity and produced the evidence required for the corresponding gate.

Expected:

```text
status = PASS
findings = []
```

---

## FAIL

The agent could not complete the assigned activity or the required validation failed.

The result must include evidence explaining the failure.

---

## FINDINGS

The agent completed its review/analysis but identified actionable problems.

The result must include structured findings.

This status is primarily expected from:

- Independent Review Agent
- Convergence Agent
- Architecture Agent during Analyze

---

## BLOCKED

The agent cannot safely continue because required information, access, or a human decision is missing.

The result must explain the blocking condition and provide evidence.

---

# 6. Agent Does Not Control State

An agent may report the outcome of its work, but it does not own the Coordinator state machine.

The agent must not be authoritative for:

```text
next state
gate transition
retry policy
remediation iteration limit
human intervention decision
```

The Coordinator evaluates the result against the State Machine and Gate Contract.

---

# 7. Evidence Requirement

Every successful agent result must contain evidence.

Examples:

```json
{
  "type": "FILE",
  "description": "Specification artifact created",
  "reference": "specs/003/spec.md",
  "status": "PASS"
}
```

```json
{
  "type": "TEST",
  "description": "Unit tests passed",
  "reference": "npm test",
  "status": "PASS"
}
```

The Coordinator must reject a result as sufficient for a gate when the required evidence is absent.

---

# 8. Artifact Result

An agent may create or update artifacts.

Conceptually:

```typescript
interface ArtifactResult {
  path: string;
  action: "CREATED" | "UPDATED" | "VERIFIED" | "UNCHANGED";
  status: "PASS" | "FAIL";
}
```

An artifact result describes what the agent did.

It does not by itself make a gate pass.

---

# 9. Finding Contract

When an agent produces findings, every finding must contain:

```text
id
severity
category
status
location when applicable
evidence
expected
actual
required_remediation
```

Finding identifiers must remain stable across remediation and re-review.

---

# 10. Agent Responsibilities

## Specification Agent

Responsible for:

```text
SPECIFY
CLARIFY
```

Must not implement application code.

---

## Architecture Agent

Responsible for:

```text
PLAN
TASKS
ANALYZE
```

Must not implement the feature merely to resolve an analysis problem.

---

## Implementation Agent

Responsible for:

```text
IMPLEMENT
```

May modify application code.

Must not perform the authoritative independent review.

---

## Independent Review Agent

Responsible for:

```text
INDEPENDENT_REVIEW
RE_REVIEW
```

Must independently inspect the implementation and return:

```text
PASS
```

or:

```text
FINDINGS
```

---

## Remediation Agent

Responsible for:

```text
REMEDIATION
```

Must resolve findings without deleting or rewriting the original finding identity.

---

## Convergence Agent

Responsible for:

```text
CONVERGE
```

Must determine whether the complete feature converges against requirements, artifacts, architectural decisions, tasks, and previous findings.

---

# 11. Failure Handling

An agent must never hide a failure to satisfy a gate.

If an operation fails:

```text
status = FAIL
```

If the agent cannot safely proceed:

```text
status = BLOCKED
```

If the agent discovers actionable problems:

```text
status = FINDINGS
```

The Coordinator decides what happens next.

---

# 12. No Free-Form Success

The following is insufficient:

```text
"Everything looks good."
```

A successful result must contain:

```text
PASS
+
evidence
+
artifact results when applicable
```

---

# 13. Contract Boundary

The boundary is:

```text
Coordinator
    │
    │ AgentRequest
    ▼
Specialized Agent
    │
    │ AgentResult
    ▼
Coordinator
    │
    ├── validate result
    ├── validate evidence
    ├── evaluate gate
    ├── update state
    └── determine transition
```

The Coordinator remains the sole authority over workflow state.

