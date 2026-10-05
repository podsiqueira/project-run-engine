# Incito Agent Orchestration — V1 Coordinator Runtime Architecture

## 1. Purpose

This document defines the physical architecture of the V1 Coordinator Runtime.

The runtime is the implementation of the contracts already defined under:

```text
docs/agent-orchestration/v1/
```

It must implement those contracts rather than redefine them.

The Coordinator is a deterministic workflow controller responsible for orchestrating specialized agents.

It is not an application-code implementation agent and it is not a general-purpose autonomous manager.

---

# 2. Architectural Principle

The V1 runtime follows:

```text
                ┌─────────────────────┐
                │  Execution Request  │
                └──────────┬──────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │   State Store       │
                └──────────┬──────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │ State Machine       │
                └──────────┬──────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │ Transition Engine   │
                └──────────┬──────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │ Gate Evaluator      │
                └──────────┬──────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │ Agent Router        │
                └──────────┬──────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │ Context Builder     │
                └──────────┬──────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │ Agent Executor      │
                └──────────┬──────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │ Result Validator    │
                └──────────┬──────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │ Evidence Collector  │
                └──────────┬──────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │ State Persistence   │
                └─────────────────────┘
```

---

# 3. Runtime Components

## 3.1 Coordinator

The Coordinator is the orchestration entry point.

Responsibilities:

```text
load execution
validate execution state
resolve work
invoke agent
validate result
evaluate gate
persist result
continue or stop
```

The Coordinator should coordinate components rather than contain their implementation details.

Conceptually:

```typescript
class Coordinator {
  run(executionId: string): Promise<ExecutionResult>;
}
```

---

# 4. State Store

## Responsibility

The State Store provides access to the persisted State Contract.

It must support:

```text
load
create
update
append transition history
```

Conceptually:

```typescript
interface StateStore {
  get(executionId: string): Promise<ExecutionState>;
  create(state: ExecutionState): Promise<void>;
  save(state: ExecutionState): Promise<void>;
  appendTransition(
    executionId: string,
    transition: TransitionRecord
  ): Promise<void>;
}
```

The State Store is the authority for persisted workflow state.

---

# 5. State Machine

## Responsibility

The State Machine contains the definition of:

```text
states
allowed transitions
terminal states
```

It must not execute agents.

It must not modify application code.

It must not evaluate natural-language reasoning.

Conceptually:

```typescript
interface StateMachine {
  getAllowedTransitions(
    state: CoordinatorState
  ): Transition[];
}
```

The State Machine should be deterministic and independently testable.

---

# 6. Transition Engine

## Responsibility

The Transition Engine determines whether a proposed transition is structurally valid.

It uses:

```text
current state
transition contract
gate results
evidence
preconditions
iteration counters
```

Conceptually:

```typescript
interface TransitionEngine {
  validate(
    state: ExecutionState,
    transition: TransitionRequest
  ): TransitionDecision;
}
```

The result should be explicit:

```text
VALID
INVALID
BLOCKED
```

The Transition Engine must never invent a transition.

---

# 7. Gate Evaluator

## Responsibility

The Gate Evaluator determines whether a gate passes according to the Gate Contract.

Inputs:

```text
gate definition
agent result
findings
evidence
artifacts
```

Output:

```typescript
interface GateResult {
  gate: GateName;
  status: "PASS" | "FAIL" | "BLOCKED";
  evidenceIds: string[];
  findings: string[];
}
```

The evaluator must use deterministic rules wherever possible.

An LLM must not be required to decide whether a structural gate condition such as:

```text
tests passed
HIGH findings = 0
required artifact exists
```

is satisfied.

---

# 8. Agent Router

## Responsibility

The Agent Router maps:

```text
current state
    ↓
agent
```

according to `routing-table.md`.

Conceptually:

```typescript
interface AgentRouter {
  resolve(
    state: CoordinatorState
  ): AgentType | null;
}
```

The router must not use an LLM.

If no agent is mapped to a state, the Coordinator must follow the State Machine behavior for that state.

---

# 9. Context Builder

## Responsibility

The Context Builder creates the Execution Context defined by:

```text
execution-context.md
context-policy.md
```

Inputs:

```text
execution state
agent type
current operation
artifacts
findings
constraints
gate
evidence requirements
repository context
```

Output:

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

The Context Builder should be deterministic.

---

# 10. Agent Executor

## Responsibility

The Agent Executor provides the runtime boundary to specialized agents.

Conceptually:

```typescript
interface AgentExecutor {
  execute(
    agent: AgentType,
    context: ExecutionContext
  ): Promise<AgentResult>;
}
```

The Coordinator does not need to know whether the underlying agent is:

```text
Antigravity
Claude
OpenAI
local process
mock agent
future provider
```

The executor is the abstraction boundary.

---

# 11. Mock Agent Executor

V1 must support a mock implementation of `AgentExecutor`.

Purpose:

```text
test Coordinator
without real LLMs
```

Example:

```typescript
class MockAgentExecutor implements AgentExecutor {
  execute(
    agent: AgentType,
    context: ExecutionContext
  ): Promise<AgentResult> {
    // deterministic test result
  }
}
```

This allows the State Machine, routing, gate evaluation, persistence, and transition behavior to be validated independently.

---

# 12. Result Validator

## Responsibility

The Result Validator validates that the agent response conforms to the Agent Contract.

It must verify:

```text
execution identity
agent identity
operation
status
findings structure
evidence references
required output structure
```

Conceptually:

```typescript
interface ResultValidator {
  validate(
    context: ExecutionContext,
    result: AgentResult
  ): ValidationResult;
}
```

An invalid result must not be converted into a successful gate.

---

# 13. Evidence Collector

## Responsibility

The Evidence Collector normalizes and persists evidence returned or produced during the operation.

Conceptually:

```typescript
interface EvidenceCollector {
  collect(
    executionId: string,
    result: AgentResult
  ): Promise<Evidence[]>;
}
```

Evidence must be traceable to:

```text
execution
agent
operation
artifact or command
timestamp
result
```

---

# 14. Finding Manager

## Responsibility

The Finding Manager maintains findings according to `finding-contract.md`.

It must support:

```text
create
update
resolve
reopen
list active
```

Finding identity must remain stable through remediation.

Example:

```text
F-001
  ↓
OPEN
  ↓
IN_REMEDIATION
  ↓
RESOLVED
```

A remediation cycle must not create a new finding merely because the finding was reviewed again.

---

# 15. Repository Adapter

The Coordinator requires repository operations but should not directly depend on shell commands or Git implementation details.

Conceptually:

```typescript
interface RepositoryAdapter {
  getStatus(): Promise<GitStatus>;
  getDiff(): Promise<GitDiff>;
  getBranch(): Promise<string>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}
```

Additional operations may be introduced as implementation requires.

The Repository Adapter is an infrastructure boundary.

---

# 16. Runtime Flow

The main execution loop is:

```text
1. Load execution
2. Validate State Contract
3. Check terminal state
4. Resolve allowed work
5. Resolve agent
6. Build Execution Context
7. Invoke Agent Executor
8. Validate Agent Result
9. Collect Evidence
10. Update Findings
11. Evaluate Gate
12. Resolve Transition
13. Persist state + history
14. Repeat
```

---

# 17. Terminal Handling

If:

```text
state = READY_FOR_PR
```

the Coordinator stops successfully.

If:

```text
state = HUMAN_INTERVENTION_REQUIRED
```

the Coordinator stops with an intervention-required result.

No agent invocation occurs after a terminal state is reached.

---

# 18. Error Handling

Runtime failures must be distinguished from agent findings.

Examples:

```text
AGENT_FAILURE
INVALID_AGENT_RESULT
STATE_VALIDATION_FAILURE
TRANSITION_FAILURE
GATE_EVALUATION_FAILURE
PERSISTENCE_FAILURE
REPOSITORY_FAILURE
```

These are operational failures.

They must not automatically be represented as application findings.

---

# 19. Atomicity

State mutation must follow:

```text
validate
  ↓
prepare changes
  ↓
persist evidence/findings
  ↓
persist state transition
  ↓
commit
```

A rejected transition must not move the current state.

Where the underlying persistence mechanism supports transactions, state and transition history should be committed atomically.

---

# 20. Idempotency

The Coordinator should protect against accidental duplicate execution.

Every agent invocation should have a unique execution step identifier:

```typescript
interface ExecutionStep {
  step_id: string;
  execution_id: string;
  state: CoordinatorState;
  agent: AgentType;
}
```

If the same step is retried, the runtime should avoid duplicating:

```text
transition history
evidence
finding creation
state mutation
```

---

# 21. Concurrency

V1 should assume one active Coordinator execution per feature execution.

The runtime should prevent two Coordinator processes from simultaneously advancing the same execution.

The exact locking mechanism is an implementation decision.

The invariant is:

```text
one execution
    →
one authoritative state transition at a time
```

---

# 22. Runtime Configuration

The following values should be configuration rather than hard-coded throughout the runtime:

```text
MAX_REMEDIATION_ITERATIONS
agent provider
agent model
repository root
execution storage
timeouts
retry policy
```

The default V1 remediation limit remains:

```text
3
```

as defined by the Coordinator Contract.

---

# 23. Dependency Direction

The runtime should follow:

```text
Coordinator
    ↓
Application Services
    ↓
Contracts / Domain Rules
    ↓
Infrastructure Adapters
```

Infrastructure should not redefine domain rules.

For example:

```text
Agent Executor
```

must not decide:

```text
next state
gate status
remediation limit
```

Those decisions belong to the Coordinator/domain layer.

---

# 24. Suggested Module Structure

The initial implementation may use:

```text
coordinator/
├── coordinator.ts
├── state-machine.ts
├── transition-engine.ts
├── gate-evaluator.ts
├── agent-router.ts
├── context-builder.ts
├── result-validator.ts
├── evidence-collector.ts
├── finding-manager.ts
├── repository-adapter.ts
├── agent-executor.ts
│
├── domain/
│   ├── types.ts
│   └── constants.ts
│
├── adapters/
│   ├── mock-agent-executor.ts
│   └── ...
│
└── tests/
    ├── state-machine.test.ts
    ├── transition-engine.test.ts
    ├── gate-evaluator.test.ts
    ├── agent-router.test.ts
    └── coordinator.test.ts
```

This is a suggested implementation structure, not a mandatory repository layout.

---

# 25. What Must Remain Outside the Coordinator

The Coordinator must not contain:

```text
feature-specific business logic
application implementation logic
specialized coding prompts
review heuristics specific to one technology
LLM provider-specific reasoning
```

Those belong behind the appropriate agent or infrastructure boundary.

---

# 26. First Implementation Target

The first executable slice should not invoke a real LLM.

Implement:

```text
State Machine
    ↓
Transition Engine
    ↓
Gate Evaluator
    ↓
Agent Router
    ↓
Mock Agent Executor
    ↓
Result Validator
    ↓
State Persistence
```

with deterministic tests.

The first success criterion is:

```text
A complete synthetic execution can move through the State Machine
using mock agent results and stop correctly at a terminal state.
```

---

# 27. Real Agent Integration

Only after the deterministic runtime passes its tests should the real agent adapter be introduced.

The sequence should be:

```text
Mock Agent
    ↓
Coordinator Runtime Validation
    ↓
Real Agent Executor
    ↓
One Specialized Agent
    ↓
Full V1 Agent Set
```

This keeps failures attributable to either:

```text
orchestration
```

or:

```text
agent behavior
```

instead of mixing both during initial development.

---

# 28. V1 Runtime Invariants

The implementation must preserve these invariants:

1. Agents do not own workflow state.
2. Agents do not authorize transitions.
3. The Coordinator does not implement application code.
4. Gates require evidence.
5. Findings have stable identity.
6. Terminal states stop execution.
7. Remediation is bounded.
8. Routing is deterministic.
9. State transitions are auditable.
10. The same input state produces the same structural routing decision.
11. Mock agents can exercise the complete State Machine.
12. Infrastructure adapters cannot redefine domain rules.

---

# 29. Architecture Boundary

The resulting architecture is:

```text
                    COORDINATOR
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
 State Machine     Gate Evaluator    Agent Router
        │                │                │
        └────────────────┼────────────────┘
                         │
                         ▼
                  Context Builder
                         │
                         ▼
                  Agent Executor
                         │
              ┌──────────┴──────────┐
              │                     │
         Mock Agent            Real Agent
              │                     │
              └──────────┬──────────┘
                         ▼
                  Result Validator
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
        Evidence                 Findings
             │                       │
             └───────────┬───────────┘
                         ▼
                    State Store
```

The important architectural rule is:

```text
Agents produce work and evidence.

Coordinator evaluates, persists, and transitions.
```

---

# 30. Next Implementation Step

After this document is accepted, the next artifact should be:

```text
coordinator-interfaces.md
```

It should define the concrete TypeScript interfaces and domain types shared by:

```text
State Machine
Transition Engine
Gate Evaluator
Agent Router
Context Builder
Agent Executor
Result Validator
Evidence Collector
Finding Manager
State Store
```

Only after those interfaces are stable should implementation files be generated.
