# Consumer Guide: Integrating `project-run-engine`

This guide explains how to integrate `project-run-engine` into any TypeScript codebase.

---

## 1. Add Dependency

Add `@incito-labs/project-run-engine` to your repository's `package.json`:

```json
{
  "dependencies": {
    "@incito-labs/project-run-engine": "^0.1.0"
  }
}
```

During local multi-repo or monorepo development, you can use a relative file reference:

```json
{
  "dependencies": {
    "@incito-labs/project-run-engine": "file:../../packages/project-run-engine"
  }
}
```

---

## 2. Initialize Project Workflow (`project-run init`)

The fastest and safest way to set up `project-run-engine` in a repository is using the CLI:

```bash
npx project-run init
```

This single command:
1. Creates `.project-run/config.json` with a valid Spec-Kit workflow configuration.
2. Infers the project name from `package.json` (or directory name).
3. Copies canonical Spec-Kit skills (`speckit-specify`, `speckit-plan`, `speckit-implement`, `speckit-bug-assess`, `speckit-bug-fix`, `speckit-bug-test`, `speckit-converge`, etc.) into `.agents/skills/`.
4. Runs completely offline without external network calls.
5. Is **idempotent**: safe to run multiple times without duplicating or overwriting custom skills.

To overwrite conflicting or modified skills explicitly:
```bash
npx project-run init --force
```

---

## 3. Manual Project Configuration (Alternative)

If preferred, you can manually create `.project-run/config.json` at your repository root:

```json
{
  "project": {
    "name": "my-service",
    "workflow_version": "v1",
    "feature_directory": "specs/current-feature"
  },
  "runtime": {
    "default_runtime": "ANTIGRAVITY",
    "supported_runtimes": ["ANTIGRAVITY", "CLAUDE", "CURSOR", "MOCK", "CI_AGENT"]
  },
  "agents": {
    "SPECIFICATION": {
      "name": "Specification Agent",
      "required_skills": [
        { "id": "speckit-specify", "required": true },
        { "id": "speckit-clarify", "required": false }
      ]
    },
    "ARCHITECTURE": {
      "name": "Architecture Agent",
      "required_skills": [
        { "id": "speckit-plan", "required": true },
        { "id": "speckit-tasks", "required": true },
        { "id": "speckit-analyze", "required": true }
      ]
    },
    "IMPLEMENTATION": {
      "name": "Implementation Agent",
      "required_skills": [
        { "id": "speckit-implement", "required": true }
      ]
    },
    "INDEPENDENT_REVIEW": {
      "name": "Independent Review Agent",
      "required_skills": [
        { "id": "speckit-analyze", "required": true }
      ]
    },
    "REMEDIATION": {
      "name": "Remediation Agent",
      "required_skills": [
        { "id": "speckit-bug-assess", "required": true },
        { "id": "speckit-bug-fix", "required": true },
        { "id": "speckit-bug-test", "required": true }
      ]
    },
    "CONVERGENCE": {
      "name": "Convergence Agent",
      "required_skills": [
        { "id": "speckit-converge", "required": true }
      ]
    }
  },
  "skills": {
    "search_paths": [".agents/skills", ".project-run/skills", "skills"]
  }
}
```

---

## 3. Supply Required Skills

The engine verifies that each skill declared in your config exists on disk with a valid `SKILL.md` frontmatter. Place them in any directory listed in `skills.search_paths`:

```
.agents/skills/
├── speckit-specify/
│   └── SKILL.md
├── speckit-plan/
│   └── SKILL.md
├── speckit-tasks/
│   └── SKILL.md
├── speckit-analyze/
│   └── SKILL.md
├── speckit-implement/
│   └── SKILL.md
├── speckit-bug-fix/
│   └── SKILL.md
└── speckit-converge/
    └── SKILL.md
```

Each `SKILL.md` must include YAML frontmatter:

```markdown
---
name: speckit-implement
description: Executes implementation tasks defined in tasks.md
version: "1.0.0"
---
# Implementation Skill Instructions
...
```

---

## 4. Provide a Host Runtime Adapter

`project-run-engine` provides the execution loop, but your repository or host environment connects to the physical agent runner (Antigravity subagent, Claude tool invocation, Cursor terminal, or CI execution).

Implement the `HostAgentDispatcher` interface and pass it to `HostDispatchAdapter`:

```typescript
import {
  HostDispatchAdapter,
  type HostAgentDispatcher,
  type AgentDispatchRequest,
  type AgentResult,
  type HostExecutionOptions,
} from "@incito-labs/project-run-engine";

class MyHostDispatcher implements HostAgentDispatcher {
  async dispatch(
    request: AgentDispatchRequest,
    options?: HostExecutionOptions,
  ): Promise<AgentResult> {
    // 1. Inspect request.role, request.skills, request.context
    // 2. Invoke host subagent or CLI command
    // 3. Return structured AgentResult with formal StructuredFinding records
    return {
      execution_id: request.execution_id,
      agent: request.role,
      state: request.state,
      status: "PASS",
      evidence: ["Completed task successfully"],
      findings: [],
    };
  }
}

export const myAdapter = new HostDispatchAdapter("ANTIGRAVITY", new MyHostDispatcher());
```

### Structured Findings Example

Review and remediation agents return `StructuredFinding` items in their `AgentResult`:

```typescript
import type { StructuredFinding } from "@incito-labs/project-run-engine";

const finding: StructuredFinding = {
  id: "FINDING-001",
  severity: "HIGH",
  category: "data-consistency",
  location: {
    file: "src/services/billing.ts",
    line: 42,
    column: 10,
  },
  evidence: "Null check missing before accessing accountId",
  expected: "Account must be verified or null handled safely",
  actual: "Throws TypeError when account is unverified",
  required_remediation: "Add early return or conditional check before accessing accountId",
  status: "OPEN",
};
```

---

## 5. Execute Workflows

Call `executeProjectRun`. The engine automatically discovers your Git branch and active feature, persists execution checkpoints, and manages state transitions:

```typescript
import { executeProjectRun } from "@incito-labs/project-run-engine";
import { myAdapter } from "./my-adapter.js";

// Context (feature, branch, execution_id) is auto-discovered if omitted
const result = await executeProjectRun({
  projectRoot: process.cwd(),
  runtime: "ANTIGRAVITY",
  adapters: [myAdapter],
});

if (result.status === "COMPLETED") {
  console.log("Workflow completed! Ready for PR.");
} else if (result.status === "BLOCKED_MISSING_SKILLS") {
  console.error("Missing required skills:", result.missingSkills);
} else if (result.state === "HUMAN_INTERVENTION_REQUIRED") {
  console.warn("Workflow requires human intervention. Execution ID:", result.context.execution_id);
} else {
  console.error("Execution stopped:", result.status, result.failureReason);
}
```

---

## 6. Execution Persistence & Resuming Runs

Execution state is checkpointed to:

```text
.project-run/runs/<execution_id>.json
```

If an execution stops at `HUMAN_INTERVENTION_REQUIRED` (e.g. max remediation cycles reached), you can address the issue and resume without re-running completed agents:

### Via CLI:

```bash
npx project-run resume --execution-id <execution_id>
```

### Via Programmatic API:

```typescript
import { executeProjectResume } from "@incito-labs/project-run-engine";
import { myAdapter } from "./my-adapter.js";

const resumed = await executeProjectResume({
  projectRoot: process.cwd(),
  executionId: "exec-12345",
  adapters: [myAdapter],
});
```

---

## 7. Run Diagnostic Doctor

Run `runProjectDoctor` to verify setup before running workflows:

```typescript
import { runProjectDoctor, formatDoctorReport } from "@incito-labs/project-run-engine";

const report = await runProjectDoctor({
  projectRoot: process.cwd(),
  registeredAdapters: ["ANTIGRAVITY"],
});

console.log(formatDoctorReport(report));
```

---

## 8. Reference Consumer Implementations

- **Incito (`Consumer #1`)**: Full application consumer under repository root. Consumes `@incito-labs/project-run-engine` as a package dependency via `"@incito-labs/project-run-engine": "file:packages/project-run-engine"`. Provides consumer-specific CLI wrapper in `src/core/agent-orchestration/cli/project-run-cli.ts` without internal engine duplication.
- **demo-service (`Consumer #2`)**: Standalone consumer example in `examples/project-run-consumer/`. Demonstrates zero-dependency integration, custom runtime registration (`CI_AGENT`), and offline skill discovery.

