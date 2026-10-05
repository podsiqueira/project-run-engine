# Distribution & Productization Architecture: `project-run-engine`

**Document Version:** 1.0.0  
**Status:** Approved Architecture Specification  
**Date:** October 5, 2026  
**Subject:** Package Distribution, Productization, Bootstrap Contracts, and Host Integration  
**Scope:** `packages/project-run-engine`, consuming projects (Incito and third-party repositories)

---

## 1. Executive Summary

`project-run-engine` is a provider-agnostic, zero-dependency workflow runtime designed to execute structured engineering delivery loops across diverse codebases. Extracted from Incito's core agent orchestration foundation, the engine implements a deterministic 13-state execution lifecycle (`INTAKE` through `READY_FOR_PR`) governed by declarative workflow presets, mandatory skill validation, and injectable host runtime boundaries.

While the standalone package has been built, typed, and validated against both automated boundary tests and an external consumer (`examples/project-run-consumer`), its distribution and adoption mechanisms must be formalized before general release.

### Core Strategic Decisions

1. **Zero External Runtime Dependencies:** The package maintains `dependencies: {}`, relying strictly on Node.js standard libraries (`node:fs`, `node:path`).
2. **LLM & Provider Agnosticism:** The engine contains zero knowledge of OpenAI, Anthropic, OpenRouter, Vercel AI SDK, Antigravity SDK, Claude SDK, or Cursor SDK. Physical agent dispatch is completely decoupled via the `HostDispatchAdapter` contract.
3. **Skills as First-Class Project Assets (Model D):** Methodology skills (such as Spec-Kit) are owned and versioned by the consuming project, residing on disk as human-readable markdown. The engine remains strictly **validation-only** at runtime (never silently downloading or mutating files), while an explicit bootstrap command (`project-run init` / `project-run skills install`) facilitates initial scaffolding.
4. **Command Surface (`/project-run`):** Delivered as a standard CLI binary (`bin/project-run.js`), executable directly via shell (`npx project-run`), package scripts (`npm run project-run`), and IDE agent slash commands (`/project-run`).
5. **Distribution Strategy:** Dual-tier distribution:
   - **Phase 1 (Monorepo / Local):** Consumed via local workspace / `file:` dependency (`file:packages/project-run-engine`).
   - **Phase 2 (Multi-Repo Distribution):** Published to an npm registry (`project-run-engine`) with an accompanying bootstrap runner (`npx project-run init`).

---

## 2. Current Architecture Assessment

### 2.1 Public API Boundary

The package exposes a clear barrel export (`src/index.ts`) alongside modular subpath exports configured in `package.json`:

```
project-run-engine
├── . (Root Barrel)             -> All public symbols across subdomains
├── ./domain                    -> Types, state schemas, error classes, request validation
├── ./coordinator               -> Coordinator execution loop, step/run results
├── ./decision                  -> CoordinatorDecisionEngine, state transitions, context
├── ./agents                    -> AgentRegistry, AgentDispatcher, default role definitions
├── ./runtime                   -> HostDispatchAdapter, MockRuntimeAdapter, host guard contracts
├── ./skills                    -> SkillResolver, SkillValidator, SkillValidationError
├── ./presets                   -> WorkflowPreset, SpecKitV1Preset, Spec-Kit skill catalog
└── ./project                   -> loadProjectConfig, validateProjectConfig, doctor, executeProjectRun
```

### 2.2 Internal Implementation Details

The following are strictly internal and not part of the consumer surface:
- Frontmatter parsing regex and file system traversal routines in `SkillResolver`.
- State transition evaluation and loop increment logic in `CoordinatorDecisionEngine`.
- Symmetrical timeout and cancellation handlers in `executeWithHostGuards`.
- Concrete diagnostic formatting helpers in `formatDoctorReport`.

### 2.3 Boundary Audit: Provider & Framework Couplings

An exhaustive audit of the `packages/project-run-engine` codebase confirms:

| Potential Coupling | Status | Evidence / Analysis |
|---|---|---|
| **Next.js** | **Zero Coupling** | 0 imports; no Next.js routing, headers, or server action dependencies. |
| **React** | **Zero Coupling** | 0 imports; no JSX, hooks, or React rendering code. |
| **Supabase / Postgres** | **Zero Coupling** | 0 imports; no database clients, SQL queries, or schema assumptions. |
| **Vercel AI SDK / OpenRouter** | **Zero Coupling** | 0 imports; no `ai`, `@ai-sdk`, or `@openrouter` references. |
| **OpenAI / Anthropic** | **Zero Coupling** | 0 imports; no proprietary LLM SDKs. |
| **Antigravity / Claude / Cursor SDKs** | **Zero Coupling** | 0 imports; runtimes are modeled solely as neutral string identifiers in `AgentRuntime`. |
| **Incito Domain Assumptions** | **Zero Coupling** | No references to Incito, CRM, WhatsApp, telecom billing, campaigns, or attribution. |

Automated package boundary verification (`packages/project-run-engine/tests/package-boundary.test.ts`) runs on every test invocation to assert that `package.json` has empty `dependencies: {}` and that no prohibited external modules are imported.

---

## 3. Distribution Options Evaluation

| Option | Installation Experience | Versioning & Upgrades | CI/CD Suitability | Skill Handling | Multi-Project Reuse | Overall Assessment |
|---|---|---|---|---|---|---|
| **1. Local Workspace (`file:`)** | Excellent for monorepos; zero network latency. | Immediate sync with source; no semver release overhead. | Requires source package checked into same repo or submodules. | Skills reside in local workspace path. | Poor across disconnected git repositories. | **Optimal for Phase 1** (Incito + Examples). |
| **2. Git Dependency (`git+https://`)** | Simple: `npm i git+https://...`; no npm account needed. | Pinned by commit hash or git tags; upgrade requires git tag bumps. | Moderate: requires git credentials / deploy keys in private CI. | Skills must be cloned or downloaded separately. | Good, but slow npm install times (git checkout & build). | **Not recommended** due to build-on-install friction. |
| **3. Published npm Package (`project-run-engine`)** | Best in class: `npm i project-run-engine`. | Standard SemVer (`^1.0.0`); automated Renovate/Dependabot upgrades. | Excellent: fast cached tarball downloads in CI/CD pipelines. | Skills validated on disk; package does not bundle project files. | Ideal across all internal and public repositories. | **Recommended target for Phase 2**. |
| **4. Dedicated CLI Package (`@project-run/cli`)** | Isolated global or npx execution (`npx @project-run/cli`). | Independent CLI versioning separate from engine core. | Requires managing two published artifacts. | Can bundle scaffolding templates. | Overkill for initial distribution. | **Deferred to Phase 3**. |
| **5. Core npm Package + Integrated CLI Binary** | Seamless: Single dependency provides programmatic API + CLI (`npx project-run`). | Unified versioning between engine runtime and CLI commands. | Superb: single install in CI enables both automated runs and doctor checks. | Engine validates skills; CLI exposes explicit `init` and `skills install` commands. | Exceptional: consistent developer experience across all repos. | **Recommended Long-Term Architecture**. |

---

## 4. Recommended Distribution Model

We recommend **Option 5 (Core npm Package with Integrated CLI Binary)** rolled out in two controlled phases:

```text
┌────────────────────────────────────────────────────────┐
│                      Distribution                      │
│                                                        │
│  Phase 1 (Immediate / Monorepo):                       │
│    "project-run-engine": "file:packages/project-run-engine" │
│                                                        │
│  Phase 2 (Multi-Repo Productization):                  │
│    "project-run-engine": "^0.1.0"                      │
│    npx project-run <command>                           │
└────────────────────────────────────────────────────────┘
```

### Key Architectural Tenets of the Distribution Model
1. **Single Artifact:** `project-run-engine` provides both the TypeScript programmatic API (for custom scripts and deep host integrations) and the pre-compiled executable CLI (`dist/cli/project-run-cli.js`).
2. **Zero Peer Dependencies:** Consuming projects do not need to install Vitest, TypeScript, or any specific framework to run the compiled engine.
3. **Reproducible Pre-compiled Assets:** The published package includes `dist/` containing standard ES modules and TypeScript declarations (`.d.ts`), eliminating consumer build-time compilation overhead.

---

## 5. Skill Installation and Bootstrap Model

### The Core Dilemma
> *"I install `project-run-engine` into a completely new repository. How do the required skills get there?"*

### Evaluation of Bootstrap Models

- **Model A (Validation-only, manual install):** Engine only validates; consumer must manually create `.agents/skills/*`.  
  *Verdict:* High developer friction; error-prone; unacceptable onboarding experience.
- **Model B (Automatic silent download):** Engine downloads missing skills over the network during pre-flight.  
  *Verdict:* Violates security boundaries, produces unpredictable side effects, breaks offline/air-gapped CI, and mutates codebases without explicit user consent.
- **Model C (Separate bootstrap CLI only):** Scaffolding tool copies skills once; engine has zero skill awareness.  
  *Verdict:* Disconnects the engine's validation rules from the skill authoring templates.
- **Model D (Explicit Bootstrap via CLI + Strict Runtime Validation):** The engine core remains strictly validation-only. A dedicated command (`project-run init` / `project-run skills install`) explicitly scaffolds project config and installs canonical methodology skills upon direct user invocation.  
  *Verdict:* **Selected & Recommended**.

### Recommended Architecture: Model D

```text
[ Developer or CI ]
       │
       │ Explicit Command: `npx project-run init --preset spec-kit-v1`
       ▼
┌───────────────────────────────────────────────────────┐
│              CLI Scaffolding Phase                    │
│  1. Creates `.project-run/config.json`                 │
│  2. Creates `.agents/skills/`                          │
│  3. Copies canonical Spec-Kit skills from package      │
│     templates to local disk                           │
└───────────────────────────────────────────────────────┘
       │
       │ Git Commit: Developer reviews & commits skills to git
       ▼
┌───────────────────────────────────────────────────────┐
│              Runtime Execution Phase                  │
│             `npx project-run`                         │
│  1. SkillResolver discovers `.agents/skills/` on disk │
│  2. SkillValidator verifies mandatory frontmatter      │
│  3. Blocks with BLOCKED_MISSING_SKILLS if absent      │
│  4. Zero network downloads, zero silent mutations     │
└───────────────────────────────────────────────────────┘
```

#### Why Skills Must Live in the Consuming Project's Git Tree:
1. **Human Auditability:** Agents follow instructions written in plain Markdown (`SKILL.md`). Developers must be able to inspect, customize, and PR modifications to agent instructions.
2. **Version Pinning:** A project must be able to pin its skill definitions to a specific git commit so that historical builds and CI runs remain 100% deterministic.
3. **IDE Discovery:** Local IDE tools (Antigravity, Claude Code, Cursor) require skills to exist in workspace paths (`.agents/skills/` or `.project-run/skills/`) to display them in autocomplete slash menus.

---

## 6. The `/project-run` Command Model

### 6.1 Invocation Taxonomy

The command `/project-run` is designed to be invoked symmetrically across three environments:

```text
1. Terminal / Shell:
   $ npx project-run [--runtime <RUNTIME>] [doctor]

2. Project Script:
   $ npm run project-run [-- --runtime <RUNTIME>]

3. IDE Agent Slash Command:
   /project-run
   /project-run doctor
```

### 6.2 Command Lifecycle & Decision Table

| Invocation Scenario | Condition | Engine Action | Exit Code | User / Agent Feedback |
|---|---|---|---|---|
| **Uninitialized Repository** | `.project-run/config.json` not found | Abort before dispatch | `1` | `Error: Configuration not found. Run "npx project-run init" to initialize.` |
| **Invalid Configuration** | Schema validation fails | Abort before dispatch | `1` | `Error: Invalid configuration in .project-run/config.json: [list of schema errors]` |
| **Missing Mandatory Skills** | Required skills missing for initial role | Pre-flight guard triggers | `2` | `BLOCKED_MISSING_SKILLS: Missing required skill "speckit-specify" for role SPECIFICATION.` |
| **Diagnostic Request** | Argument `doctor` passed | Run read-only audit | `0` (Healthy) / `1` (Issues) | Formatted ASCII report detailing config, skills, roles, and runtimes. |
| **Unsupported Runtime** | `--runtime XYZ` not in `supported_runtimes` | Abort before dispatch | `1` | `Error: Runtime "XYZ" is not in supported_runtimes: [ANTIGRAVITY, CLAUDE, CURSOR, MOCK]` |
| **Standard Workflow** | All pre-flights pass | Advance state machine | `0` (Success) / `1` (Failure) | Logs state transitions from `INTAKE` through `READY_FOR_PR`. |

### 6.3 Project & Preset Discovery

- **Project Root Discovery:** The command resolves the workspace root by traversing upwards from `process.cwd()` until it finds `.project-run/config.json` or `.git`.
- **Project Identity:** Extracted from `project.name` in `.project-run/config.json`.
- **Workflow Preset Discovery:** The engine reads `project.workflow_version` (e.g. `"v1"`), maps it to `SpecKitV1Preset`, and enforces the corresponding role-to-skill matrix.

---

## 7. Project Bootstrap Contract

When a consumer initializes a repository via `npx project-run init`, the following canonical layout is created:

```text
my-repository/
├── .project-run/
│   └── config.json              # Project workflow configuration
├── .agents/
│   └── skills/                  # Installed Spec-Kit methodology skills
│       ├── speckit-specify/
│       │   └── SKILL.md
│       ├── speckit-clarify/
│       │   └── SKILL.md
│       ├── speckit-plan/
│       │   └── SKILL.md
│       ├── speckit-tasks/
│       │   └── SKILL.md
│       ├── speckit-analyze/
│       │   └── SKILL.md
│       ├── speckit-implement/
│       │   └── SKILL.md
│       ├── speckit-bug-assess/
│       │   └── SKILL.md
│       ├── speckit-bug-fix/
│       │   └── SKILL.md
│       ├── speckit-bug-test/
│       │   └── SKILL.md
│       └── speckit-converge/
│           └── SKILL.md
└── specs/                       # Feature specifications
```

### Minimum Configuration Schema (`.project-run/config.json`)

```json
{
  "project": {
    "name": "my-service",
    "workflow_version": "v1",
    "feature_directory": "specs"
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
    "search_paths": [".agents/skills", ".project-run/skills"]
  }
}
```

---

## 8. Runtime & Host Integration Model

### 8.1 Inversion of Control: The Host Boundary

The engine does not execute LLMs. It defines the formal execution contract and inverts control to the host environment:

```text
               ┌─────────────────────────────────────┐
               │         project-run-engine          │
               │                                     │
               │  - State Machine Transitions        │
               │  - Remediation Loop Bounds (Max 3)  │
               │  - Mandatory Re-review Invariants   │
               │  - Timeout & Cancellation Guards   │
               │  - Skill Enrichment into Request    │
               └──────────────────┬──────────────────┘
                                  │
                                  ▼
               ┌─────────────────────────────────────┐
               │         HostDispatchAdapter         │
               │                                     │
               │  Calls injected HostAgentDispatcher │
               └──────────────────┬──────────────────┘
                                  │
      ┌───────────────────────────┼───────────────────────────┐
      ▼                           ▼                           ▼
┌──────────────┐           ┌──────────────┐           ┌──────────────┐
│ Antigravity  │           │    Claude    │           │   CI / Mock  │
│  Host Bridge │           │  Host Bridge │           │  Host Bridge │
└──────────────┘           └──────────────┘           └──────────────┘
```

### 8.2 Boundary Allocation

| Component | Belongs In Engine | Belongs In Host / Consumer | Responsibility |
|---|---|---|---|
| `AgentDispatchRequest` | **Yes** | No | Neutral payload with role, state, context, and injected skill metadata. |
| `AgentResult` | **Yes** | No | Normalized response containing status (`PASS`/`FINDINGS`), evidence, findings. |
| `executeWithHostGuards` | **Yes** | No | Enforces timeouts, AbortSignal cancellations, duration timing, and lifecycle tagging. |
| `HostDispatchAdapter` | **Yes** | No | Adapter wrapping a consumer-supplied `HostAgentDispatcher`. |
| `HostAgentDispatcher` | **Interface only** | **Implementation** | The physical bridge that invokes subagents, API endpoints, or terminal sessions. |
| Custom Runtimes | Supported dynamically | Defined by consumer | Consumer can pass `"CI_AGENT"`, `"LOCAL_DEV"`, etc., without engine changes. |

---

## 9. Versioning and Compatibility Strategy

To ensure seamless long-term maintenance across disparate repositories, compatibility is governed across four version vectors:

```text
┌───────────────────────────┐       governs       ┌───────────────────────────┐
│    Engine SemVer (v1.x)   │ ──────────────────> │ Workflow Preset (v1)      │
└───────────────────────────┘                     └─────────────┬─────────────┘
                                                                │ requires
                                                                ▼
┌───────────────────────────┐     compatible with ┌───────────────────────────┐
│ Project Config (schema v1)│ <────────────────── │ Skill Specifications (v1) │
└───────────────────────────┘                     └───────────────────────────┘
```

### 9.1 Compatibility Matrix
1. **Engine SemVer:** Follows strict Semantic Versioning (`MAJOR.MINOR.PATCH`).
   - Breaking changes to `AgentDispatchRequest`, `CoordinatorState`, or `AgentResult` require a `MAJOR` bump.
   - Adding new optional configuration fields or new preset capabilities is a `MINOR` bump.
2. **Preset Compatibility:** Each preset declares its `schema_version`. If a project config declares `workflow_version: "v2"` but the engine only supports `"v1"`, pre-flight fails gracefully.
3. **Skill Specification Versioning:** Every `SKILL.md` frontmatter includes `version: "1.0.0"`. `SkillValidator` checks that installed skills meet the minimum capability version declared in the preset.

### 9.2 Preventive Diagnostics via `project-run doctor`

`project-run doctor` serves as the primary compatibility gateway:
- Validates that `.project-run/config.json` conforms to the engine schema.
- Verifies that all 11 required Spec-Kit skills exist on disk.
- Asserts that skill frontmatter parses cleanly (YAML valid, name matches directory).
- Verifies that configured runtimes are recognized.
- Returns non-zero exit code on drift, enabling automated gating in pre-commit hooks and CI pipelines.

---

## 10. Consumer Installation Flow

The end-to-end developer experience for introducing `project-run-engine` into a fresh project:

```bash
# 1. Enter the target repository
$ cd my-new-service

# 2. Add the engine dependency
$ npm install --save-dev project-run-engine

# 3. Initialize project workflow and scaffold canonical Spec-Kit skills
$ npx project-run init --preset spec-kit-v1
# Output:
#   ✓ Created .project-run/config.json
#   ✓ Created .agents/skills/ (10 canonical Spec-Kit skills installed)
#   ✓ Added "project-run" script to package.json

# 4. Verify workspace health and skill presence
$ npm run project-run doctor
# Output:
#   ==================================================
#             PROJECT WORKFLOW DOCTOR REPORT          
#   ==================================================
#   Overall Status: ✓ HEALTHY
#   [1] Project Configuration: VALID
#   [2] Agent Roles & Skill Requirements: 6/6 HEALTHY
#   [3] Discovered Workspace Skills: 10 AVAILABLE
#   [4] Runtime Configuration: ANTIGRAVITY (Configured)

# 5. Execute feature delivery loop
$ npm run project-run
```

---

## 11. Incito Migration Boundary

When Incito transitions to consume the standalone package, the exact separation of responsibilities is established as follows:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   Incito Host Boundary (Consumer)                      │
│                                                                        │
│  - Application code: src/app, src/lib, src/components                  │
│  - Supabase database schema, migrations, and seeds                     │
│  - CRM, campaigns, WhatsApp telecom billing business logic            │
│  - Repository skills: .agents/skills/                                  │
│  - Repository workflow config: .project-run/config.json                │
│  - Host CLI entry point: src/core/agent-orchestration/cli/             │
│    (thin launcher calling executeProjectRun with process.cwd())        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ imports "project-run-engine"
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   project-run-engine (Standalone)                      │
│                                                                        │
│  - Deterministic 13-state execution loop (Coordinator)                 │
│  - Pure decision evaluation logic (CoordinatorDecisionEngine)          │
│  - Agent dispatch routing & skill validation (AgentDispatcher)         │
│  - Spec-Kit preset definition & role-to-skill maps (SpecKitV1Preset)   │
│  - Host execution contract guards (executeWithHostGuards)              │
│  - Workspace diagnostic audit (runProjectDoctor)                       │
│  - 0 application domain code, 0 provider SDKs, 0 database code         │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 12. Security and Safety Considerations

1. **Non-Destructive Doctor:** `runProjectDoctor` performs strictly read-only filesystem inspections. It never writes files, executes external binaries, or calls network endpoints.
2. **Explicit Skill Scaffolding:** Skill bootstrap only occurs on explicit user execution of `project-run init`. The engine runtime never downloads or mutates skills automatically.
3. **Execution Guardrails:**
   - **Remediation Iteration Cap:** Hard limit of 3 iterations on `RE_REVIEW` failures before forcing `HUMAN_INTERVENTION_REQUIRED`.
   - **Timeout Enforcement:** All agent dispatches enforce strict timeouts via `HostTimeoutError`.
   - **Cancellation Support:** Host dispatch respects standard `AbortSignal` for immediate graceful abort.
4. **Skill Content Isolation:** Skills are ingested as text strings (markdown) and passed into dispatch requests as documentation; they are never executed as dynamic code in the engine process.

---

## 13. Open Decisions

Before final general distribution, the following decisions should be aligned:

1. **Package Scope & Registry:** Should the standalone package be published publicly as `project-run-engine` or under an organizational scope (e.g. `@incito/project-run-engine` or `@project-run/engine`)?
   - *Recommendation:* Publish as `project-run-engine` or `@project-run/engine`.
2. **Skill Scaffolding Bundling:** Should canonical Spec-Kit skills be bundled inside the npm package under `templates/skills/` or cloned from a dedicated GitHub repository (`github.com/project-run/spec-kit-skills`)?
   - *Recommendation:* Bundle canonical skills directly inside `packages/project-run-engine/templates/skills/` so `project-run init` works completely offline without network dependencies.
3. **CLI Binary Entry in package.json:** Should `packages/project-run-engine/package.json` expose `"bin": { "project-run": "dist/cli/project-run-cli.js" }` directly?
   - *Recommendation:* Yes, adding `"bin"` allows `npx project-run` to execute out of the box.

---

## 14. Recommended Next Implementation Step

**Expose CLI Binary & Implement `init` Command in `project-run-engine`:**
1. Add `"bin": { "project-run": "./dist/cli/project-run-cli.js" }` to `packages/project-run-engine/package.json`.
2. Bundle the canonical Spec-Kit Markdown files into `packages/project-run-engine/templates/skills/`.
3. Add `project-run init` command to `project-run-cli.ts` to scaffold `.project-run/config.json` and copy canonical skills into `.agents/skills/`.
4. Validate end-to-end via an automated test in `tests/consumer/`.
