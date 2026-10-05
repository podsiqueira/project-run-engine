# Incito Agent Orchestration — V1 Execution Context Contract

## 1. Purpose

This document defines the context package that the Coordinator provides to a specialized agent for one execution step.

The Execution Context is the boundary between:

```text
Coordinator
    ↓
Execution Context
    ↓
Specialized Agent
```

The purpose is to give the agent enough information to perform its assigned operation without transferring ownership of workflow state or transition decisions.

---

# 2. Core Principle

The Coordinator should provide:

```text
relevant context
+
explicit objective
+
applicable constraints
+
required outputs
+
evidence requirements
```

It should not provide an unrestricted instruction such as:

```text
"Work on the repository and decide what should happen next."
```

The agent performs the assigned operation.

The Coordinator remains responsible for deciding what happens after the operation.

---

# 3. Execution Context Model

Conceptually:

```typescript
interface ExecutionContext {
  execution: ExecutionContextIdentity;

  state: StateContext;

  objective: ObjectiveContext;

  artifacts: ArtifactContext[];

  findings: FindingContext[];

  constraints: ConstraintContext[];

  gate: GateContext;

  evidenceRequirements: EvidenceRequirement[];

  repository: RepositoryContext;
}
```

The runtime representation may evolve during implementation, but the semantic boundaries defined here are part of the V1 contract.

---

# 4. Execution Identity

```typescript
interface ExecutionContextIdentity {
  execution_id: string;
  feature: string;
  branch: string;
}
```

The agent must receive enough information to associate its work with the correct execution.

The agent must not create a new execution identity.

---

# 5. State Context

```typescript
interface StateContext {
  current_state: CoordinatorState;
  iteration: number;
  remediation_iteration: number;
}
```

The current state is informational context for the agent.

The agent must not modify it directly.

The agent must not select the next state.

---

# 6. Objective Context

The Coordinator must provide an explicit objective for the current operation.

Conceptually:

```typescript
interface ObjectiveContext {
  operation: string;
  goal: string;
  success_criteria: string[];
}
```

Example:

```json
{
  "operation": "IMPLEMENT",
  "goal": "Implement the tasks defined in tasks.md.",
  "success_criteria": [
    "All applicable implementation tasks are addressed.",
    "Required tests are added or updated.",
    "The implementation follows the approved plan and contracts."
  ]
}
```

The objective must be scoped to the current state.

---

# 7. Artifact Context

The Coordinator should provide only artifacts relevant to the operation.

Conceptually:

```typescript
interface ArtifactContext {
  path: string;
  role: string;
  status: string;
}
```

Examples:

```text
spec.md
plan.md
tasks.md
data-model.md
contracts/
```

The context should distinguish between:

```text
required
reference
generated
previously validated
```

artifacts when that distinction matters.

---

# 8. Finding Context

Findings must be included when they are relevant to the current operation.

For remediation:

```text
finding ID
severity
category
location
evidence
expected
actual
required remediation
```

For re-review:

```text
original finding
remediation evidence
changed files
relevant tests
```

For unrelated operations, irrelevant findings should not be included merely for completeness.

---

# 9. Constraint Context

Constraints describe rules that the agent must respect.

Examples:

```text
approved architecture
technical contracts
constitution principles
security requirements
tenant isolation requirements
technology constraints
scope boundaries
```

Conceptually:

```typescript
interface ConstraintContext {
  source: string;
  rule: string;
}
```

The Coordinator should prefer authoritative project artifacts over duplicated instructions.

---

# 10. Gate Context

The agent must know what gate its work contributes to.

Conceptually:

```typescript
interface GateContext {
  name: string;
  purpose: string;
  required_conditions: string[];
}
```

Example:

```json
{
  "name": "IMPLEMENTATION",
  "purpose": "Validate implementation completeness and technical verification.",
  "required_conditions": [
    "Relevant tasks complete",
    "Tests pass",
    "Typecheck passes",
    "Lint passes"
  ]
}
```

The agent provides the work and evidence.

The Coordinator evaluates whether the gate actually passes.

---

# 11. Evidence Requirements

The Coordinator must explicitly tell the agent what evidence is expected.

Conceptually:

```typescript
interface EvidenceRequirement {
  type: string;
  description: string;
  required: boolean;
}
```

Example:

```text
TEST       required
TYPECHECK  required
LINT       required
BUILD      required when applicable
GIT        required
```

The agent must not invent a different evidence policy.

---

# 12. Repository Context

The agent may need repository information to perform its operation.

Conceptually:

```typescript
interface RepositoryContext {
  root: string;
  working_tree: string;
  relevant_paths: string[];
}
```

The Coordinator should provide relevant paths where practical.

The agent may inspect additional repository files when necessary to complete its assigned operation.

However, repository access does not transfer workflow ownership to the agent.

---

# 13. Context by Agent

## Specification Agent

Primary context:

```text
feature request
specification guidance
constitution
existing specification artifacts
relevant project context
```

Expected operation:

```text
create/update specification
resolve specification ambiguity
```

---

## Architecture Agent

Primary context:

```text
spec.md
constitution
existing architecture
technical constraints
relevant repository structure
contracts
```

Expected operation:

```text
plan
tasks
analysis
```

---

## Implementation Agent

Primary context:

```text
spec.md
plan.md
tasks.md
data-model.md
contracts
constitution
relevant source files
relevant tests
resolved findings when applicable
```

Expected operation:

```text
implement assigned work
```

---

## Independent Review Agent

Primary context:

```text
spec.md
plan.md
tasks.md
contracts
constitution
implementation diff
relevant source files
tests
build/typecheck/lint evidence
previous findings
```

Expected operation:

```text
independently evaluate implementation
```

The review agent must not assume that implementation-agent claims are correct.

---

## Remediation Agent

Primary context:

```text
open findings
original requirements
relevant implementation files
relevant tests
review evidence
contracts
```

Expected operation:

```text
resolve assigned findings
```

The remediation agent must preserve finding identity.

---

## Convergence Agent

Primary context:

```text
spec.md
plan.md
tasks.md
acceptance criteria
success criteria
contracts
constitution
implementation state
resolved findings
remaining findings
validation evidence
```

Expected operation:

```text
determine whether the feature converges against its authoritative requirements
```

---

# 14. Context Exclusions

The Coordinator should not automatically pass:

```text
all previous agent messages
all repository files
all execution history
all unrelated findings
all unrelated feature artifacts
```

unless required by the current operation.

This reduces noise, context size, and the probability of irrelevant reasoning.

---

# 15. State and Transition Boundary

The agent receives:

```text
current state
```

but does not receive authority to change it.

The agent may return:

```text
PASS
FAIL
FINDINGS
BLOCKED
```

The Coordinator converts that result into a state transition according to:

```text
state-machine.md
transition-contract.md
gate-contract.md
routing-table.md
```

---

# 16. Context Integrity

The Coordinator must ensure that the context belongs to the current execution.

At minimum:

```text
execution_id matches
feature matches
branch matches
current state matches
```

An agent result associated with another execution must be rejected.

---

# 17. Context Versioning

The Coordinator should record which execution context was sent to the agent.

Conceptually:

```typescript
interface ContextMetadata {
  context_version: string;
  generated_at: string;
}
```

This allows later investigation of:

```text
What did the agent actually receive?
```

without making the agent responsible for workflow history.

---

# 18. Minimum Context Rule

Every agent invocation must contain enough information to answer:

```text
What am I responsible for?
What state am I operating in?
What artifacts should I use?
What constraints must I respect?
What evidence must I produce?
What does success for this operation look like?
```

If these questions cannot be answered from the execution context, the Coordinator must not invoke the agent.

---

# 19. Context Construction

The Coordinator should construct context using deterministic rules.

Conceptually:

```text
Current State
      ↓
Routing Table
      ↓
Agent
      ↓
Context Policy
      ↓
Relevant Artifacts
      +
Relevant Findings
      +
Constraints
      +
Gate Requirements
      +
Evidence Requirements
      ↓
Execution Context
```

The LLM should not decide what context it is entitled to receive.

---

# 20. Context Is Not Authority

Execution Context is an input package.

It is not permission to:

```text
change workflow state
skip gates
close findings
change requirements
override architecture decisions
declare convergence
```

Those responsibilities remain with the Coordinator and the authoritative contracts.
