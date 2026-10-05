# Incito Agent Orchestration — V1 Context Policy

## 1. Purpose

This document defines deterministic rules for selecting the information included in an agent Execution Context.

The goal is to balance:

```text
sufficient context
+
low noise
+
traceability
+
bounded responsibility
```

---

# 2. Selection Priority

Context should be selected in this order:

```text
1. Current operation requirements
2. Authoritative artifacts
3. Relevant implementation context
4. Relevant findings
5. Required constraints
6. Required evidence context
7. Supporting repository context
```

---

# 3. Authoritative Sources

When multiple sources contain the same information, prefer:

```text
state-machine.md
state-contract
feature specification
approved plan
approved contracts
constitution
gate contract
finding records
persisted evidence
```

Agent conversation history is not authoritative.

---

# 4. Specification Context

The Specification Agent should receive:

```text
feature request
existing specification
constitution
relevant project conventions
known constraints
```

It should not receive unrelated implementation details unless they affect the specification.

---

# 5. Architecture Context

The Architecture Agent should receive:

```text
specification
constitution
existing architecture
technical constraints
relevant contracts
relevant repository structure
```

It should receive enough repository context to avoid designing against nonexistent structures.

---

# 6. Implementation Context

The Implementation Agent should receive:

```text
specification
approved plan
approved tasks
relevant contracts
relevant source files
relevant tests
required constraints
```

The implementation agent may inspect additional files when necessary.

The Coordinator does not need to enumerate every possible file in advance.

---

# 7. Review Context

The Independent Review Agent must receive enough information to independently compare:

```text
requirements
planned design
actual implementation
validation evidence
```

Minimum conceptual set:

```text
specification
plan
tasks
contracts
implementation diff
tests
validation results
```

---

# 8. Remediation Context

The Remediation Agent should receive:

```text
finding(s)
original requirement
affected implementation
relevant tests
review evidence
applicable contracts
```

It should not receive unrelated findings unless required to understand a dependency.

---

# 9. Convergence Context

The Convergence Agent requires the broadest feature-level context because it evaluates the complete result.

Minimum:

```text
specification
success criteria
acceptance criteria
plan
tasks
contracts
implementation status
findings
validation evidence
```

---

# 10. Sensitive Context

The Coordinator must not expose secrets as part of agent context unless explicitly required by the operation and supported by the execution environment.

Examples:

```text
API keys
access tokens
passwords
private credentials
```

Agent context should reference configured services rather than embedding credentials.

---

# 11. Context Size

The Coordinator should prefer references to large artifacts where the agent can retrieve them, rather than duplicating entire artifacts into the invocation payload.

For example:

```text
path = specs/003/spec.md
```

may be preferable to embedding the entire file when the execution environment supports repository access.

---

# 12. Relevance

A file is relevant when at least one of these applies:

```text
directly required by current operation
defines an applicable contract
contains implementation being changed
contains tests validating the change
contains an active finding
defines an applicable constraint
```

---

# 13. Context Reproducibility

The Coordinator should be able to reconstruct the context used for an invocation from persisted state and repository references.

This supports debugging and auditability.

---

# 14. Context Policy Rule

The agent may request additional information during execution when necessary.

However:

```text
agent request
    ↓
Coordinator evaluates request
    ↓
allowed / denied
```

The agent does not automatically gain authority to broaden its workflow scope.

