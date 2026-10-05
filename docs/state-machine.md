# Incito Agent Orchestration — V1 State Machine

## 1. Purpose

This document defines the formal state machine for the Incito V1 Coordinator.

The Coordinator is responsible for controlling the feature-development workflow through explicit states, gates, transitions, invariants, and terminal conditions.

The Coordinator does not implement code, review code, fix findings, or make architectural decisions on behalf of specialized agents.

> **The Coordinator coordinates; specialized agents execute.**

The state machine must be deterministic and must never advance a feature without the evidence required by the corresponding gate.

---

# 2. V1 State Model

The V1 Coordinator uses the following states:

```text
INTAKE
  ↓
SPECIFY
  ↓
CLARIFY
  ↓
PLAN
  ↓
TASKS
  ↓
ANALYZE
  ↓
IMPLEMENT
  ↓
INDEPENDENT_REVIEW
  ↓
REMEDIATION
  ↓
RE_REVIEW
  ↓
CONVERGE
  ↓
READY_FOR_PR
```

The following additional state is used when automation must stop:

```text
HUMAN_INTERVENTION_REQUIRED
```

## 2.1 State Categories

### Execution states

These states represent active workflow stages:

- `INTAKE`
- `SPECIFY`
- `CLARIFY`
- `PLAN`
- `TASKS`
- `ANALYZE`
- `IMPLEMENT`
- `INDEPENDENT_REVIEW`
- `REMEDIATION`
- `RE_REVIEW`
- `CONVERGE`

### Terminal states

These states stop Coordinator execution:

- `READY_FOR_PR`
- `HUMAN_INTERVENTION_REQUIRED`

No automated transition leaves a terminal state.

---

# 3. State Definitions

## 3.1 INTAKE

### Purpose

Establish the initial execution context for a feature.

### Required context

- Feature identifier
- Feature description or source request
- Repository
- Dedicated feature branch
- Execution identifier

### Responsible agent

No specialized agent is required.

### Exit condition

The execution context is valid and the feature can enter specification.

### Transition

```text
INTAKE → SPECIFY
```

---

## 3.2 SPECIFY

### Purpose

Create or update the feature specification.

### Responsible agent

`Specification Agent`

### Expected artifacts

```text
spec.md
```

Additional specification checklists may be produced when required.

### Gate

The Specification Gate must pass.

Required conditions:

- `spec.md` exists.
- Requirements are defined.
- Required acceptance criteria are defined.
- No blocking ambiguity remains.
- Specification quality checklist passes.
- Evidence of the specification work exists.

### Transition

```text
SPECIFY → CLARIFY
```

---

## 3.3 CLARIFY

### Purpose

Resolve ambiguities before architectural planning.

### Responsible agent

`Specification Agent`

### Gate

Clarification is complete when:

- Required clarification questions have been resolved.
- No blocking ambiguity remains.
- `spec.md` reflects the resolved decisions.
- Evidence of the clarification exists.

### Transition

```text
CLARIFY → PLAN
```

If clarification cannot be resolved automatically:

```text
CLARIFY → HUMAN_INTERVENTION_REQUIRED
```

---

## 3.4 PLAN

### Purpose

Create the implementation architecture and plan based on the real repository.

### Responsible agent

`Architecture Agent`

### Expected artifacts

As applicable:

```text
plan.md
research.md
data-model.md
quickstart.md
contracts/
```

### Gate

The Planning Gate must pass.

Required conditions:

- `plan.md` exists.
- Architectural decisions are documented.
- Required research is complete.
- Data model is defined when applicable.
- Contracts are defined when applicable.
- Plan is based on the existing codebase.
- Evidence exists for the planning decisions.

### Transition

```text
PLAN → TASKS
```

---

## 3.5 TASKS

### Purpose

Transform the approved plan into implementation tasks.

### Responsible agent

`Architecture Agent`

### Expected artifact

```text
tasks.md
```

### Gate

The Tasks Gate must pass.

Required conditions:

- `tasks.md` exists.
- Tasks follow the expected format.
- Requirements have task coverage.
- Dependencies are defined.
- Tasks have a clear purpose.
- Tasks are traceable to the plan and requirements.

### Transition

```text
TASKS → ANALYZE
```

---

## 3.6 ANALYZE

### Purpose

Validate consistency before implementation.

### Responsible agent

`Architecture Agent`

### Validation scope

At minimum:

- Specification
- Plan
- Tasks
- Existing repository structure
- Contracts
- Data model
- Architectural decisions

### Gate

The Analyze Gate passes only when:

```text
CRITICAL findings = 0
HIGH findings     = 0
MEDIUM findings   = 0
```

Low findings may be handled according to feature policy, but cannot be silently ignored.

### Transitions

Successful analysis:

```text
ANALYZE → IMPLEMENT
```

Blocking analysis findings:

```text
ANALYZE → HUMAN_INTERVENTION_REQUIRED
```

The Coordinator must not allow implementation while the Analyze Gate is failing.

---

## 3.7 IMPLEMENT

### Purpose

Implement the approved tasks.

### Responsible agent

`Implementation Agent`

### Expected activities

- Execute implementation tasks.
- Modify application code.
- Create or update tests.
- Execute technical verification.
- Mark tasks complete only when actually implemented.

### Gate

The Implementation Gate must pass before independent review.

Required conditions:

- Relevant tasks are complete.
- Tests pass.
- Typecheck passes.
- Lint passes.
- Build passes when applicable.
- Git branch is known.
- Working tree state is known.
- Evidence exists for the verification results.

### Transition

```text
IMPLEMENT → INDEPENDENT_REVIEW
```

The Implementation Agent cannot transition directly to `CONVERGE`.

---

# 4. INDEPENDENT_REVIEW

## Purpose

Perform an independent review of the implementation.

The agent that implemented the feature cannot be the authority that approves its own implementation.

### Responsible agent

`Independent Review Agent`

### Review scope

At minimum:

- Functional requirements
- Acceptance criteria
- Architecture
- Security
- Multi-tenancy
- RLS
- Tests
- Regressions
- Contracts
- Specification adherence
- Plan adherence
- Task adherence

### Result contract

The Review Agent must return exactly one of:

```text
PASS
```

or:

```text
FINDINGS
```

There is no implicit or subjective intermediate success state.

### Transitions

If review passes:

```text
INDEPENDENT_REVIEW → CONVERGE
```

If findings exist:

```text
INDEPENDENT_REVIEW → REMEDIATION
```

---

# 5. REMEDIATION

## Purpose

Resolve findings produced by the Independent Review Agent.

### Responsible agent

`Remediation Agent`

### Required behavior

The Remediation Agent must:

- Receive structured findings.
- Correct the identified problems.
- Add or update tests where necessary.
- Execute technical verification.
- Preserve the original finding identifiers.
- Produce evidence of the remediation.

The original finding must not be overwritten or deleted.

### Gate

Remediation passes when:

- Required corrections have been implemented.
- Relevant tests pass.
- Technical verification passes.
- Evidence exists for the correction.
- No known regression was introduced by the remediation.

### Mandatory transition

```text
REMEDIATION → RE_REVIEW
```

Remediation can never transition directly to:

```text
CONVERGE
READY_FOR_PR
```

---

# 6. RE_REVIEW

## Purpose

Independently validate the remediation.

### Responsible agent

`Independent Review Agent`

### Rule

The corrected implementation must be reviewed again.

A remediation is not considered valid merely because the Remediation Agent reports that it was fixed.

### Transitions

If review passes:

```text
RE_REVIEW → CONVERGE
```

If findings remain and remediation iterations remain available:

```text
RE_REVIEW → REMEDIATION
```

If the maximum remediation iteration limit has been reached:

```text
RE_REVIEW → HUMAN_INTERVENTION_REQUIRED
```

---

# 7. CONVERGE

## Purpose

Perform the final convergence check across all feature artifacts and requirements.

### Responsible agent

`Convergence Agent`

### Validation scope

The Convergence Agent must verify:

- All requirements are satisfied.
- Success criteria are satisfied.
- User stories and acceptance scenarios are satisfied.
- Architectural decisions are respected.
- Constitution principles are respected.
- All required tasks are complete.
- Previous findings are resolved.
- No actionable gaps remain.

The following gap categories are considered actionable:

```text
missing
partial
contradicts
unrequested
```

### Gate

The Convergence Gate passes only when:

```text
Convergence = PASS
```

and:

```text
Actionable Findings = 0
```

### Transitions

If convergence passes:

```text
CONVERGE → READY_FOR_PR
```

If convergence fails:

```text
CONVERGE → REMEDIATION
```

The findings produced by convergence must be structured and traceable.

---

# 8. Terminal States

## 8.1 READY_FOR_PR

This state means the automated V1 workflow has completed successfully.

Required conditions:

```text
Specification Gate       = PASS
Planning Gate            = PASS
Tasks Gate               = PASS
Analyze Gate              = PASS
Implementation Gate      = PASS
Independent Review       = PASS
Convergence              = PASS
Actionable Findings      = 0
```

The Coordinator performs no further automated implementation work.

---

## 8.2 HUMAN_INTERVENTION_REQUIRED

This state means the Coordinator cannot safely continue automatically.

Possible causes include:

- Blocking ambiguity.
- Analyze gate failure requiring a decision.
- Maximum remediation iterations reached.
- Repeated findings that cannot be resolved.
- Required human decision.
- Invalid or inconsistent execution state.
- Missing required evidence that cannot be generated automatically.

This is a terminal state for V1.

The Coordinator must stop rather than invent a decision or bypass a gate.

---

# 9. Allowed Transitions

The Coordinator must use an explicit transition table.

| From | To | Trigger | Required condition |
|---|---|---|---|
| `INTAKE` | `SPECIFY` | system | Intake valid |
| `SPECIFY` | `CLARIFY` | agent result | Specification Gate PASS |
| `CLARIFY` | `PLAN` | agent result | Clarification complete |
| `CLARIFY` | `HUMAN_INTERVENTION_REQUIRED` | gate | Blocking ambiguity |
| `PLAN` | `TASKS` | agent result | Planning Gate PASS |
| `TASKS` | `ANALYZE` | agent result | Tasks Gate PASS |
| `ANALYZE` | `IMPLEMENT` | gate | Analyze Gate PASS |
| `ANALYZE` | `HUMAN_INTERVENTION_REQUIRED` | gate | Blocking findings |
| `IMPLEMENT` | `INDEPENDENT_REVIEW` | gate | Implementation Gate PASS |
| `INDEPENDENT_REVIEW` | `CONVERGE` | agent result | Review PASS |
| `INDEPENDENT_REVIEW` | `REMEDIATION` | agent result | Findings exist |
| `REMEDIATION` | `RE_REVIEW` | gate | Remediation Gate PASS |
| `RE_REVIEW` | `CONVERGE` | agent result | Review PASS |
| `RE_REVIEW` | `REMEDIATION` | agent result | Findings + iterations available |
| `RE_REVIEW` | `HUMAN_INTERVENTION_REQUIRED` | gate | Maximum iterations reached |
| `CONVERGE` | `READY_FOR_PR` | gate | Convergence PASS |
| `CONVERGE` | `REMEDIATION` | agent result | Convergence findings |
| `READY_FOR_PR` | — | terminal | — |
| `HUMAN_INTERVENTION_REQUIRED` | — | terminal | — |

Any transition not explicitly listed above is invalid in V1.

---

# 10. State Machine Invariants

The following invariants must always hold.

## Invariant 1 — No arbitrary state jumps

A state may transition only through an explicitly allowed transition.

For example:

```text
SPECIFY → IMPLEMENT
```

is invalid.

---

## Invariant 2 — Gates control transitions

The existence of an agent result is not sufficient to advance the state.

The required gate must pass.

---

## Invariant 3 — Evidence-first

A gate cannot be considered `PASS` without the evidence required by that gate.

The Coordinator must not rely on subjective statements such as:

```text
"Implementation looks good."
```

---

## Invariant 4 — Independent review

The implementation must be independently reviewed.

```text
IMPLEMENT
    ↓
INDEPENDENT_REVIEW
```

is mandatory.

---

## Invariant 5 — Remediation requires re-review

```text
REMEDIATION
    ↓
RE_REVIEW
```

is mandatory.

Remediation cannot bypass independent review.

---

## Invariant 6 — Findings remain traceable

A finding retains its original identifier throughout remediation and re-review.

Example:

```text
F-001
  ↓
IN_REMEDIATION
  ↓
RESOLVED
```

---

## Invariant 7 — Maximum remediation cycles

V1 uses:

```text
MAX_REMEDIATION_ITERATIONS = 3
```

When the limit is reached while actionable findings remain:

```text
→ HUMAN_INTERVENTION_REQUIRED
```

---

## Invariant 8 — Terminal states are immutable

No automated transition leaves:

```text
READY_FOR_PR
```

or:

```text
HUMAN_INTERVENTION_REQUIRED
```

---

## Invariant 9 — Coordinator does not implement

The Coordinator must never:

- write application code;
- fix findings;
- modify implementation;
- create the specification;
- perform independent review;
- make architectural decisions that belong to specialized agents.

---

# 11. State Transition Evaluation

Every Coordinator cycle follows this sequence:

```text
1. Load persisted state
        ↓
2. Validate State Contract
        ↓
3. Read current state
        ↓
4. Determine allowed transitions
        ↓
5. Evaluate required gate
        ↓
6. If gate fails:
       STOP or HUMAN_INTERVENTION_REQUIRED
        ↓
7. If gate passes:
       select responsible agent
        ↓
8. Execute agent
        ↓
9. Validate Agent Result
        ↓
10. Collect evidence
        ↓
11. Evaluate resulting gate
        ↓
12. Persist new state
        ↓
13. Transition to next allowed state
```

The Coordinator must never determine a transition solely from natural-language agent output.

---

# 12. State Persistence

The state machine requires persistent execution state.

Minimum information:

```json
{
  "execution": {
    "id": "exec_001",
    "feature": "003-example-feature",
    "branch": "feat/003-example-feature",
    "state": "IMPLEMENT",
    "iteration": 1,
    "remediation_iteration": 0
  },

  "gates": {
    "specification": "PASS",
    "planning": "PASS",
    "tasks": "PASS",
    "analyze": "PASS",
    "implementation": "PENDING",
    "review": "PENDING",
    "convergence": "PENDING"
  },

  "findings": [],

  "evidence": [],

  "git": {
    "branch": "feat/003-example-feature",
    "commit": "abc123",
    "working_tree": "KNOWN"
  }
}
```

The exact persistent schema is defined separately by the V1 State Contract.

---

# 13. V1 Scope

The state machine intentionally does not cover:

- Production deployment.
- Automatic production release.
- Automatic merge without explicit policy.
- Multiple repositories.
- Infrastructure management.
- Production monitoring.
- Dynamic agent creation.
- Agent self-modification.
- Code generation by the Coordinator.

The state machine exists only to control the validated feature-development workflow.

---

# 14. V1 Test Requirements

Before connecting real agents, the State Machine must be tested independently.

At minimum, tests must verify:

### Valid transitions

```text
INTAKE → SPECIFY
SPECIFY → CLARIFY
CLARIFY → PLAN
PLAN → TASKS
TASKS → ANALYZE
ANALYZE → IMPLEMENT
IMPLEMENT → INDEPENDENT_REVIEW
INDEPENDENT_REVIEW → CONVERGE
INDEPENDENT_REVIEW → REMEDIATION
REMEDIATION → RE_REVIEW
RE_REVIEW → CONVERGE
RE_REVIEW → REMEDIATION
CONVERGE → READY_FOR_PR
CONVERGE → REMEDIATION
```

### Invalid transitions

Examples:

```text
SPECIFY → IMPLEMENT
PLAN → IMPLEMENT
IMPLEMENT → CONVERGE
REMEDIATION → CONVERGE
REMEDIATION → READY_FOR_PR
```

must all be rejected.

### Terminal state tests

Verify that:

```text
READY_FOR_PR → anything
```

and:

```text
HUMAN_INTERVENTION_REQUIRED → anything
```

are rejected.

### Remediation limit

Verify:

```text
remediation_iteration < 3
```

allows another remediation cycle, while:

```text
remediation_iteration >= 3
```

with actionable findings produces:

```text
HUMAN_INTERVENTION_REQUIRED
```

---

# 15. Relationship to Other V1 Contracts

This document defines only the **state machine**.

The following contracts should be defined separately:

```text
state-machine.md
state-contract.schema.json
agent-contract.md
finding-contract.schema.json
evidence-contract.schema.json
gate-contract.md
```

The Coordinator implementation should depend on these contracts rather than embedding their definitions directly into agent prompts.

---

# 16. Design Principle

The V1 Coordinator should remain intentionally simple.

> **The Coordinator does not need to be intelligent. It needs to be predictable.**

The intelligence belongs to the specialized agents.

The Coordinator is responsible for:

```text
STATE
RULES
EVIDENCE
TRANSITIONS
GATES
PROCESS CONTROL
```

That separation is the foundation of the V1 architecture.
