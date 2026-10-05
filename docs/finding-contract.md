# Incito Agent Orchestration — V1 Finding Contract

## 1. Purpose

This document defines the canonical structure and lifecycle of findings produced by analysis, independent review, remediation review, and convergence.

A finding represents an actionable problem that must remain traceable from detection through resolution.

---

# 2. Finding Schema

Conceptually:

```typescript
interface Finding {
  id: string;

  severity:
    | "CRITICAL"
    | "HIGH"
    | "MEDIUM"
    | "LOW";

  category:
    | "FUNCTIONAL"
    | "SECURITY"
    | "ARCHITECTURE"
    | "TEST"
    | "REGRESSION"
    | "CONTRACT"
    | "SPECIFICATION"
    | "OTHER";

  status:
    | "OPEN"
    | "IN_REMEDIATION"
    | "RESOLVED"
    | "WONT_FIX";

  location?: {
    file: string;
    line?: number;
  };

  evidence: string;
  expected: string;
  actual: string;
  required_remediation: string;
}
```

---

# 3. Finding Identity

The `id` is the stable identity of the finding.

Example:

```text
F-001
F-002
F-003
```

The identifier must remain unchanged through:

```text
OPEN
→
IN_REMEDIATION
→
RESOLVED
```

A remediation must not create a replacement finding merely because the finding was reviewed again.

---

# 4. Severity

V1 supports:

```text
CRITICAL
HIGH
MEDIUM
LOW
```

Severity determines the impact of a finding on gates according to the Gate Contract.

---

# 5. Categories

V1 supports:

```text
FUNCTIONAL
SECURITY
ARCHITECTURE
TEST
REGRESSION
CONTRACT
SPECIFICATION
OTHER
```

The category describes the primary dimension of the problem.

---

# 6. Lifecycle

```text
OPEN
  ↓
IN_REMEDIATION
  ↓
RESOLVED
```

A finding may alternatively become:

```text
OPEN
  ↓
WONT_FIX
```

only when the applicable feature policy explicitly allows that decision.

The Coordinator must not silently convert findings to `WONT_FIX`.

---

# 7. Required Evidence

Every finding must explain:

```text
Evidence
Expected
Actual
Required Remediation
```

Example:

```json
{
  "id": "F-001",
  "severity": "HIGH",
  "category": "SECURITY",
  "status": "OPEN",
  "location": {
    "file": "src/api/customer.ts",
    "line": 42
  },
  "evidence": "Endpoint reads customer data without tenant filter.",
  "expected": "Customer data must be isolated by tenant.",
  "actual": "Query does not apply tenant_id filtering.",
  "required_remediation": "Enforce tenant isolation in the query and add regression coverage."
}
```

---

# 8. Finding Resolution

A finding may be marked `RESOLVED` only after remediation evidence exists and the Independent Review Agent has verified the correction.

The Remediation Agent alone cannot authorize final resolution.

---

# 9. Finding Traceability

The Coordinator must preserve:

```text
Finding ID
Original evidence
Remediation evidence
Re-review result
Resolution status
```

This provides an audit trail for every actionable issue.

---

# 10. Finding Rules

The V1 Coordinator must enforce:

1. Findings cannot disappear without a recorded resolution.
2. Finding IDs are immutable.
3. Resolved findings remain in execution history.
4. Remediation must reference the findings it addresses.
5. Re-review must validate the original finding.
6. Actionable findings prevent convergence.
