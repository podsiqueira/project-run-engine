# Architecture: project-run-engine

## 1. System Overview

`project-run-engine` provides a reusable, deterministic multi-agent orchestration architecture for software delivery. It establishes strict separation between:

1. **Orchestration Logic**: What role executes, what state transition occurs, and how findings/evidence are evaluated.
2. **Project Configuration**: How a consuming repository names its project, configures its feature paths, and assigns skills to roles.
3. **Host Runtime Execution**: How and where an agent physically runs (Antigravity, Claude, Cursor, CI worker, etc.).

```
┌─────────────────────────────────────────────────────────────┐
│                       Consuming Project                     │
│  (.project-run/config.json, skills/, consumer host bridge)  │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    project-run-engine                       │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │               Coordinator Execution Loop            │   │
│   └───────────────▲─────────────────────┬───────────────┘   │
│                   │                     │                   │
│   ┌───────────────┴──────────────┐ ┌────▼───────────────┐   │
│   │  CoordinatorDecisionEngine   │ │   AgentDispatcher  │   │
│   │    (Pure State Machine)      │ │(Skills Validation) │   │
│   └──────────────────────────────┘ └────┬───────────────┘   │
│                                         │                   │
│   ┌─────────────────────────────────────▼───────────────┐   │
│   │             Host Execution Contract                 │   │
│   │      (HostDispatchAdapter, executeWithHostGuards)   │   │
│   └─────────────────────────────────────┬───────────────┘   │
└─────────────────────────────────────────┼───────────────────┘
                                          │
                        ┌─────────────────┴─────────────────┐
                        │ Consumer-Injected Runtime Adapter │
                        │  (Antigravity / Claude / Custom)  │
                        └───────────────────────────────────┘
```

---

## 2. Core Invariants

1. **Zero LLM / Provider SDK Dependencies**:
   The engine does not import or call OpenRouter, OpenAI, Anthropic, Vercel AI SDK, or any model provider. Dispatches are runtime-agnostic data structures (`AgentDispatchRequest`).

2. **Runtime Extensibility**:
   Runtimes are not hardcoded inside the Coordinator or Decision Engine. While standard runtime constants (`ANTIGRAVITY`, `CLAUDE`, `CURSOR`, `MOCK`) are provided, consumers may register any custom runtime identifier (`CI_AGENT`, `K8S_RUNNER`, etc.) without modifying engine source code.

3. **Skill Safety Guard**:
   Agent roles require specific skills (e.g. Spec-Kit capabilities). The engine inspects local workspace paths and validates that all mandatory skills exist before dispatching any agent. If a mandatory skill is missing, execution is halted immediately (`BLOCKED_MISSING_SKILLS`). Skills are never automatically fetched from remote networks.

4. **Single User Command**:
   The entire lifecycle (`INTAKE -> SPECIFY -> CLARIFY -> PLAN -> TASKS -> ANALYZE -> IMPLEMENT -> INDEPENDENT_REVIEW -> REMEDIATION -> RE_REVIEW -> CONVERGE -> READY_FOR_PR`) is driven automatically by the Coordinator loop without requiring separate commands for review or remediation.

---

## 3. Module Responsibilities

### `src/domain/`
Defines provider-neutral types, execution records, dispatch requests, agent definitions, and validation contracts.

### `src/coordinator/`
Implements the continuous execution loop (`Coordinator`). The loop requests a decision from the decision engine, dispatches agents via the dispatcher, receives structured results, updates execution state, and repeats until a terminal state (`READY_FOR_PR` or `HUMAN_INTERVENTION_REQUIRED`) is reached.

### `src/decision/`
Contains the pure, deterministic `CoordinatorDecisionEngine`. It implements the formal state machine transition matrix and decides whether to dispatch an agent, transition to a new state, require human intervention, or complete the workflow. It performs zero I/O and zero network operations.

### `src/agents/`
Maintains the `AgentRegistry` and `AgentDispatcher`. The dispatcher verifies required skills, enriches requests with resolved skill metadata, and delegates execution to registered runtime adapters.

### `src/runtime/`
Defines the `AgentRuntimeAdapter` interface and the `HostDispatchAdapter`. The `HostDispatchAdapter` wraps consumer-provided host execution logic with standard host guards (`executeWithHostGuards`), enforcing timeouts, cancellation signals, and lifecycle status tracking.

### `src/skills/`
Provides `SkillResolver` (discovers skills from `.project-run/skills`, `.agents/skills`, or custom paths and parses frontmatter metadata) and `SkillValidator` (checks presence of required and optional skills per role).

### `src/presets/`
Encapsulates workflow presets such as the Spec-Kit skill contract (`spec-kit-preset.ts`) and role-to-skill mappings.

### `src/project/`
Provides project-level integration:
- `project-config.ts`: Loads and validates `.project-run/config.json`.
- `project-run.ts`: Bootstraps and executes `/project-run` workflows.
- `doctor.ts`: Performs non-destructive health checks across config, skills, and runtimes.

### `src/host/`
Provides the provider-agnostic Host Skill Contract (`ProjectRunHost`) a host agent
invokes instead of parsing CLI output or reimplementing the state machine. See
Section 4 below.

---

## 4. Host-Agent Orchestration Model

> **Project Run is an agent-orchestrated workflow capability, not fundamentally a CLI
> application.** The CLI (`project-run-cli.ts`) is a compatibility/debugging/local
> development interface built on top of the same `ProjectRunHost` contract an AI
> coding-agent host uses — it is one consumer of the capability, not the capability
> itself. See §4.5.

`project-run-engine` is designed to be invoked interactively from an AI coding-agent
environment — Claude Code, Cursor, Antigravity, Codex, or any other host capable of
running a slash command / tool / skill and executing role-specific work. The intended
end-user experience is conceptually:

```text
/project-engine-run "004-campaigns-and-lead-attribution"
```

**`/project-engine-run` is a host-level invocation convention; `project-engine-run`
(no slash) is the provider-neutral semantic capability this package exposes.** The two
are not the same thing. The engine API never encodes a `/`, never assumes a
conversational command syntax, and never assumes English-language argument parsing —
it exposes exactly one machine-readable capability (`projectEngineRun()`, §4.2) that a
host's own slash command, native tool, or skill definition calls into after doing
whatever host-specific parsing turned `/project-engine-run "<feature>"` (or a tool
call, or a skill invocation) into a structured `{ action, ... }` payload.

**The slash command itself is a host responsibility.** This package does not, and will
not, implement `/project-engine-run` as a Claude/Cursor/Antigravity/Codex-specific
artifact (no `.claude/commands/...`, no Cursor rule file, no MCP server is bundled
here). What this package provides instead is the clean, machine-readable,
provider-neutral interface a host's own slash-command implementation calls into.

### 4.1 The split

```text
┌─────────────────────────────────────────────────────┐
│                     HOST AGENT                       │
│                                                       │
│   Claude Code  /  Cursor  /  Antigravity  /  Codex   │
│                                                       │
│   - the conversational interface                     │
│   - the actual /project-engine-run command/tool/skill│
│   - presenting HumanQuestion[] to the human           │
│   - collecting the human's answers                    │
│   - invoking start()/resume()/status() below          │
│   - the runtime-specific AgentRuntimeAdapter(s)       │
└───────────────────────────┬───────────────────────────┘
                            │ ProjectRunHost (src/host/)
                            │ .start() / .resume() / .status()
                            ▼
┌─────────────────────────────────────────────────────┐
│               PROJECT RUN ENGINE (this package)       │
│                                                       │
│   - workflow state & the 13-state state machine       │
│   - CoordinatorDecisionEngine (transitions, gates)    │
│   - checkpoints / persistence / resume                │
│   - clarification & analysis blocking gates           │
│   - the Human-in-the-Loop contract (HumanQuestion[])  │
│   - role dispatch contracts (AgentDispatchRequest)     │
│   - workflow sequencing & convergence rules            │
└───────────────────────────┬───────────────────────────┘
                            │ AgentDispatchRequest
                            ▼
┌─────────────────────────────────────────────────────┐
│              HOST AGENT RUNTIME (host-supplied)       │
│                                                       │
│   Executes the dispatched role's work using whichever │
│   host it is, and returns a structured AgentResult.   │
└─────────────────────────────────────────────────────┘
```

The engine never needs to know whether the host is Claude, Cursor, Antigravity, or
Codex — it only ever sees an `AgentRuntimeAdapter[]`, exactly as it always has. The
host never needs to reimplement the state machine, gate evaluation, or persistence —
it only ever calls `start()`/`resume()` and renders whatever comes back.

### 4.2 The Host Skill Contract (`src/host/`)

```typescript
interface ProjectRunHost {
  start(request: ProjectRunHostRequest): Promise<ProjectRunHostResponse>;
  resume(request: ProjectRunResumeRequest): Promise<ProjectRunHostResponse>;
  status(request: ProjectRunStatusRequest): Promise<ProjectRunHostResponse>;
}
```

`status()` is read-only: it loads the persisted checkpoint and translates it into the
exact same `ProjectRunHostResponse` shape `start()`/`resume()` return, without ever
touching the Coordinator, the decision engine, or any `AgentRuntimeAdapter`. It is what
makes the restart/multi-host scenario in §4.6 possible, and it is safe to call as often
as a host likes — it never mutates state.

For hosts that prefer a single action-discriminated entry point (the natural shape for
most tool-calling conventions — one tool, one input schema, dispatch on a field) over
three separate methods, `src/host/project-engine-run.ts` exposes the same three
operations as one function, purely as routing with no duplicated orchestration logic:

```typescript
function projectEngineRun(input:
  | { action: "start";  /* ...ProjectRunHostRequest */ }
  | { action: "resume"; /* ...ProjectRunResumeRequest */ }
  | { action: "status"; /* ...ProjectRunStatusRequest */ }
): Promise<ProjectRunHostResponse>;
```

This is the literal shape of the `project-engine-run` capability named in §4's opening
note — `ProjectRunHost` and `projectEngineRun()` are two equivalent entry points onto
identical behavior; a host integration can use whichever fits its own calling
convention better.

`ProjectRunHostResponse.status` is one of `RUNNING | COMPLETED |
HUMAN_INTERVENTION_REQUIRED | BLOCKED_MISSING_SKILLS | FAILED` — never a string a host
must parse human-readable prose out of. `response.terminal` is explicit about which of
these a host can still act on: `true` for `COMPLETED`/`FAILED` (nothing further to do),
`false` for everything else (including `BLOCKED_MISSING_SKILLS` — retriable once the
host installs the missing skill). `RUNNING` is only ever observed via `status()`;
`start()`/`resume()` always run to a terminal or paused point before returning, so
neither itself produces it. When `status === "HUMAN_INTERVENTION_REQUIRED"`, the
response carries a structured `humanIntervention: HumanInterventionRequired` with a
`HumanQuestion[]` the host renders directly:

```text
Project Run needs your input before continuing.

Question:
[CRITICAL] Which authentication model should this feature use?

Why this matters:
Evidence: Spec does not define auth model for campaign attribution endpoints
```

The host collects the answer and calls `resume()` with `humanAnswers: [{ questionId,
answer }]`. The engine persists the answer durably (for audit: what was asked, what
was answered, when) but never mutates the original finding directly — the agent
responsible for the suspended state is always re-dispatched to independently verify
the fix, consistent with the Finding Contract's principle that a finding is resolved
only once independently re-verified, not merely because someone says it is fixed.

### 4.3 Progress events

A host supplies an optional `onEvent` callback to both `start()` and `resume()` to
render live progress without polling the state store or scraping logs:

```text
RUN_STARTED · RESUME_STARTED · STATE_CHANGED ·
AGENT_DISPATCH_STARTED · AGENT_DISPATCH_COMPLETED ·
HUMAN_INTERVENTION_REQUIRED · RUN_COMPLETED · RUN_FAILED
```

```text
Project Run
✓ Specification
✓ Clarification
→ Architecture
⏸ Waiting for your input
```

### 4.4 Restart and multi-host recovery

The engine, not any in-memory host object, is the source of truth for an execution's
state. This is what makes the following scenario work without any new persistence
system beyond the existing `FileExecutionStateStore`:

```text
Host A                              Host B
  │                                   │
  │ start({ feature })                │
  │ → executionId = X                 │
  │ → HUMAN_INTERVENTION_REQUIRED     │
  │                                   │
  ✕ (process exits / crashes /        │
     is simply a different host       │
     invocation entirely)             │
                                       │ status({ executionId: X })
                                       │ → HUMAN_INTERVENTION_REQUIRED,
                                       │   same questions Host A saw
                                       │
                                       │ resume({ executionId: X, humanAnswers })
                                       │ → COMPLETED
```

Host B never needs anything from Host A beyond the `executionId` and the shared
`projectRoot` — both execution identity and progress are entirely recoverable from
`.project-run/runs/<executionId>.json`. This is also exactly how a single host
recovers from its own crash: there is no in-memory-only state anywhere in this
architecture that isn't also checkpointed.

**What is durable, and what is not.** The checkpoint carries an append-only `step_log`
(`ExecutionStepRecord[]`): one `AGENT_STEP` entry per agent result the engine applied
(role, state, result status, the findings *that result reported*, evidence count, and
the pull `step_id` when applicable) and one `HUMAN_INTERVENTION` entry per suspension,
in order, continuing across resumes and restarts. Human answers keep their own
append-only trail (`human_answers`). An entry is created only when the engine actually
applies an agent result or suspends for a human — never for a pure transition, a
rejected submission (`STALE_STEP`, `INVALID_RESULT`, …), or a dispatch that failed
before producing a result. It is an execution record, not the decision engine's input
and not an event stream.

`stepLog` and `stepsCount` are present on `status()`, `start()` and `resume()`
responses. In pull mode, the terminal `COMPLETED` step response embeds the full host
response (`result.stepLog`, `result.stepsCount`); the non-terminal variants
(`AGENT_ACTION_REQUIRED`, `HUMAN_INTERVENTION_REQUIRED`, `BLOCKED_MISSING_SKILLS`,
`FAILED`) are signals and deliberately do not carry them — a pull host reads the record
of a running or suspended execution through `status()` (`project-run engine status`).
Four fields are deliberately distinct:

| Field | Meaning |
|---|---|
| `findings` | The findings of the **most recent** agent result — the decision engine's gate input. A later clean result replaces it with `[]`; that replacement is what lets a re-run clear a blocking gate, so it is intentionally unchanged. |
| `stepLog[].findings` | What each step **reported**, never merged or replaced. A finding raised at step 5 is still there after a clean re-run at step 8. Whether it was resolved is read from later entries, not inferred by the engine. |
| `stepsCount` | The number of `AGENT_STEP` entries in the whole execution. Pure state transitions and human suspensions are not steps; the count includes steps before a resume. |
| `history` | What the engine **decided** — transitions, dispatches, completion, suspensions — as a durable, compact, execution-wide record. Not an alias of `stepLog`; see §4.17 (before Phase 5 it was always `[]`). |

**Known limitations**: per-step evidence payloads are not retained (only `evidence_count`);
the latest result's full evidence remains on `last_result`. A checkpoint written before
`step_log` existed reports `stepsCount: 0` / `stepLog: []` until new steps are recorded
(earlier steps are not reconstructed); likewise a checkpoint written before Phase 5 has
no `history` (§4.17).

**Two counters share the name `stepsCount`; they are not the same thing.**
`ProjectRunHostResponse.stepsCount` (and the `RUN_COMPLETED` event) is the agent-step
count above. `CoordinatorRunResult.stepsCount` / `ProjectRunExecutionResult.stepsCount`
are the Coordinator loop's iteration count for that one call — they include pure
transitions, reset on every resume, and are what `maxSteps` bounds. The workflow
`iteration` field is a third, unrelated value and is no longer reported as a step count.

### 4.5 Host adapter responsibilities

A provider-specific host integration (built outside this repository, in each host's
own configuration) is responsible for:

1. Exposing `project-engine-run` as that host's native invocation mechanism (slash
   command, tool, skill — see §4.6).
2. Translating the host's own invocation payload into a `ProjectEngineRunInput` (or
   the equivalent `ProjectRunHost` call).
3. Supplying an `AgentRuntimeAdapter[]` — the actual mechanism by which that host
   executes a dispatched role's work and returns a structured `AgentResult`. This is
   necessarily host-specific code, since "how Claude Code executes a role's work" and
   "how Cursor executes a role's work" are different by construction; the engine only
   ever sees the resulting `AgentResult`, never how it was produced.
4. Rendering `ProjectRunHostResponse.humanIntervention.questions` to the user and
   collecting their answers.
5. Retaining `executionId` across turns/sessions so it can call `resume()`/`status()`
   later — including, per §4.4, from a different process entirely.
6. Rendering `onEvent` callbacks as live progress, if the host's UX supports it.

What a host adapter must **not** do: it must not import from `src/coordinator/`,
`src/decision/decision-engine.js`, or `src/project/state-store.js`, must not attempt to
compute a state transition itself, and must not mutate a persisted checkpoint directly
— every one of those remains strictly engine-owned. `tests/host-isolation.test.ts`
proves a complete host adapter is implementable using only `src/host/` plus the
dispatch-contract types (`AgentRuntimeAdapter`, `AgentDispatchRequest`, `AgentResult`).

### 4.6 Provider-neutral skill/tool schema

`src/host/project-engine-run.ts` exports `PROJECT_ENGINE_RUN_TOOL_SCHEMA` — a single,
plain-JSON-Schema tool/skill description for the `project_engine_run` capability. JSON
Schema is the one input format Claude's `tool_use`, OpenAI/Codex function calling, and
MCP tool definitions all already consume, so this one artifact can back a Claude Code
Skill, a Cursor tool, an MCP server, or an Antigravity tool definition without being
specific to any of them — which is why this repository does **not** ship four
provider-specific files (no `.claude/commands/project-engine-run.md`, no Cursor rule,
no MCP server, no Antigravity tool definition). A provider-neutral artifact genuinely
represents the capability; building four parallel, hand-maintained copies of the same
tool description would not add anything this shared schema doesn't already provide.

The schema is deliberately scoped to the JSON-serializable subset of the input
(`action`, `executionId`, `feature`, `humanAnswers`, ...) — `adapters` (live functions)
can never cross a tool-calling wire, so whatever process receives a `project_engine_run`
tool call and holds the real `AgentRuntimeAdapter` implementation calls
`projectEngineRun()` directly, in-process, supplying its own adapters alongside the
JSON-decoded fields from the tool call. That in-process call site is the host adapter
described in §4.5 — it is genuinely unavoidable, and is the one piece of integration
work every host still needs, regardless of transport.

### 4.7 Provider analysis (informational — no implementation here)

Based on each platform's publicly known, general tool/skill-calling model (not this
repository's internals): Claude Code, Cursor, and Codex all support registering custom
tools/skills backed by local process execution and consuming structured (JSON) tool
output — which is exactly what `project_engine_run`'s schema (§4.6) assumes. Antigravity
exposes its own subagent/tool definition mechanism with a comparable shape. All four
can, in principle, represent `HumanQuestion[]` as a conversational prompt back to the
user, and all four can retain an opaque string (`executionId`) across turns for later
`resume()`/`status()` calls — exactly the properties the Host Skill Contract depends on
and nothing more exotic. MCP is a relevant, commonly supported transport across Cursor
and Codex in particular, and could carry `PROJECT_ENGINE_RUN_TOOL_SCHEMA` as one MCP
tool definition; it is not required by the contract itself, since a host capable of
local process execution and JSON tool output needs nothing beyond that. Exact,
version-specific API details for each platform should be verified against that
platform's current documentation before building its adapter — this analysis is
necessarily general, not a substitute for that verification, and intentionally stops
short of it since no provider-specific integration is implemented in this phase.

All four fall into the **interactive agent host** category defined in §4.10, not the
programmatic-import category: none of them extend themselves primarily by importing an
npm package into a running Node process on the user's behalf. All four therefore reach
this capability via `project-run engine` (§4.10) or an equivalent local-process/MCP
transport carrying the same JSON contract — never via direct `import
{ projectRunHost }`.

### 4.8 Conceptual host integrations (not implemented in this package)

| Host | Conceptual integration |
|---|---|
| **Claude Code** | An Agent Skill whose `/project-engine-run "<feature>"` body calls `ProjectRunHost.start()`/`.resume()`, renders `humanIntervention.questions`, and supplies the host's own `AgentRuntimeAdapter`. |
| **Cursor** | A custom tool/rule wired to the same contract, likely via an MCP server that exposes `start`/`resume` as tools. |
| **Antigravity** | A subagent/skill definition invoking the same contract, using Antigravity's own agent execution mechanism as the `AgentRuntimeAdapter`. |
| **Codex** | An MCP tool (or native tool-calling integration) over the same contract. |

None of the above are implemented in this repository. Only the engine-side contract —
`src/host/` — is. Provider-specific slash commands, MCP servers, and IDE integrations
belong to each host's own integration work, built on top of this contract.

### 4.9 CLI role

The CLI (`project-run-cli.ts`) is a compatibility/debugging/local development
interface, not a second orchestration implementation: `project-run` / `project-run
resume` / `project-run status` call `startProjectRun` / `resumeProjectRun` /
`statusProjectRun` (`src/host/`) — the exact same functions `ProjectRunHost` and
`projectEngineRun()` call — rather than touching `Coordinator` internals or
`executeProjectRun`/`executeProjectResume` directly. There is one orchestration path;
the CLI, `ProjectRunHost`, and `projectEngineRun()` are three equally-thin ways to
reach it. A **programmatic** host integration (one that can `import` this package)
should call `ProjectRunHost`/`projectEngineRun` directly rather than shelling out to
the CLI and parsing output. An **interactive agent** host (a Claude Code Skill, a
Cursor tool, or similar — see §4.10) structurally cannot `import` anything; for that
category, `project-run engine` (§4.10) *is* the intended way to drive it, not merely a
debugging fallback.

### 4.10 Two categories of host, and the `project-run engine` CLI transport

§4.2–§4.9 describe the contract assuming a host that can `import` TypeScript/JS and
hold a live `AgentRuntimeAdapter` function in memory. That assumption holds for a
**programmatic host** — a Node service, a custom orchestration backend — but not for
an **interactive agent host** (Claude Code, Cursor, Codex, Antigravity): these extend
themselves through Skills/tools that are instructions for the agent to follow using its
*own* general-purpose tools (running commands, reading/writing files), not a place to
import and call a TypeScript function. For this category, `project-run engine
<start|resume|status>` is the transport:

```bash
project-run engine start --json '{"feature":"004-campaigns-and-lead-attribution"}' --dir <repo>
# -> prints exactly one JSON line: a ProjectRunHostResponse
```

- Exactly one JSON line per invocation, to stdout.
- Exit code reflects only whether the *CLI invocation itself* was well-formed (bad/
  missing `--json` → exit 1); the workflow's actual outcome (`COMPLETED` /
  `HUMAN_INTERVENTION_REQUIRED` / `BLOCKED_MISSING_SKILLS` / `FAILED`) is always in the
  printed JSON's `status` field, never encoded as a differentiated exit code — a host
  parses JSON, not exit codes, to decide what to do next.
- `adapters` cannot be passed through `--json` (a live function cannot be serialized
  across a command-line boundary). See `templates/host-integrations/claude-code/
  project-engine-run/SKILL.md` for the one reference artifact this repository ships,
  and its explicit, honest documentation of what remains unsolved by this transport
  alone: *how the dispatched role's actual work gets done* is still a host-specific
  decision (§4.5), not something `project-run engine` resolves for you. The reference
  skill's `--mock-scenario` flag exists solely to demonstrate the control-flow contract
  (start → response → human intervention → resume → continue) and is documented in
  `--help` as demo/test-only — it must never be used outside of trying the skill out.

The design question raised when this section was first written — how an interactive
agent host performs dispatched work *inline, in the same session*, without spawning a
nested agent process per dispatch — is resolved by the pull-based step API. See §4.11.

### 4.11 The pull-based step API: same-session execution without nested spawning

> **The engine does not execute the provider's agent. The host executes the agent and
> submits the resulting `AgentResult` back to the engine.**

`start()`/`resume()` (§4.1–§4.2) run the Coordinator loop to completion internally,
which needs a real `AgentRuntimeAdapter` for every dispatch — something a single,
synchronous host-tool invocation (one Bash call from an interactive session) cannot
supply, because that call cannot pause mid-loop and have the *calling* session itself
reason about something and hand the answer back. The only way to make push-mode work
for a live session is to have its adapter spawn a *separate* nested agent process per
dispatch — exactly the fresh-session-per-dispatch, no-durable-conversation,
no-cost-tracking anti-pattern this whole engine evolution exists to move away from.

The pull-based step API avoids this entirely by changing the unit of control from "run
the whole workflow" to "tell me one thing to do":

```typescript
interface ProjectRunStepResponse {
  // discriminated on `status`:
  //   "AGENT_ACTION_REQUIRED"      — request: AgentDispatchRequest; stepId: string
  //   "HUMAN_INTERVENTION_REQUIRED" — humanIntervention: HumanInterventionRequired
  //   "BLOCKED_MISSING_SKILLS"     — role, missingSkills
  //   "COMPLETED"                  — result: ProjectRunHostResponse
  //   "FAILED"                     — failureReason; terminal: boolean
}

function nextProjectRunStep(request: {
  executionId?: string;       // omit to start fresh; provide to recover/advance/resume
  feature?: string; branch?: string; runtime?: AgentRuntime;
  humanAnswers?: HumanAnswer[]; // supplying these against a suspended execution resumes it
  /* …projectRoot, config, maxSteps, etc. */
}): Promise<ProjectRunStepResponse>;

function submitProjectRunStep(request: {
  executionId: string;
  stepId: string;             // must match the pending action's stepId
  result: AgentResult;        // the host's own work, reported honestly
}): Promise<ProjectRunStepResponse>;
```

```text
host calls next-step
        ↓
AGENT_ACTION_REQUIRED { request }
        ↓
host performs `request`'s role using ITS OWN tools, in this same session
        ↓
host calls submit-step({ stepId, result })
        ↓
engine applies result → re-evaluates via the SAME CoordinatorDecisionEngine
        ↓
AGENT_ACTION_REQUIRED (next role) | HUMAN_INTERVENTION_REQUIRED | COMPLETED | FAILED
```

**This is not a second Coordinator or a second orchestration implementation.** Every
piece of this is reused, not reimplemented:

| Reused from | For |
|---|---|
| `Coordinator.prepareNextAction()` (new method, same class) | Evaluating decisions, auto-advancing pure `TRANSITION`s, checkpointing — identical to `step()`/`run()`, except a `DISPATCH_AGENT` decision is returned to the caller instead of acted on. |
| `Coordinator.applyExternalResult()` (new method, same class) | Applying a host-submitted result — `step()` itself now calls this too, so push-mode and pull-mode apply a result through one code path, not two. |
| `AgentDispatcher.prepareRequest()` (extracted from `dispatch()`) | The exact same capability/skill enrichment and skill-requirement validation a real dispatch would perform — a pull-mode host sees an identical, validated request, and a missing required skill is still caught before the host is asked to do undefined work. |
| `resolveConfig`, `buildEngineServices`, `reconstructStartContext`, `reconstructResumeContext` (extracted from `executeProjectRun`/`executeProjectResume`) | Identical config loading, context discovery, execution identity, and — critically — the exact Phase 0–2 resume safety logic (`shouldReverifyOnResume`, durable human-answer persistence) when a step-mode host resumes a suspended execution. |
| `statusProjectRun()` (Phase 2) | Translating a just-checkpointed terminal/HITL state into a response, rather than re-deriving that translation a second time. |

**Persistence**: a pending action is persisted literally (`PersistedExecutionState.
pending_action: { step_id, role, runtime, request, requested_at }`), not re-derived, so
a host that restarted after `next-step` but before `submit-step` recovers the exact
same `stepId`/`request` from disk — proven by a dedicated restart test spawning two
independent "host" calls with zero shared JS object references.

**Safety** (all re-verified against the Phase 0–2 test suite, unmodified):

- A submission is rejected (`FAILED`, `terminal: false`) when: the execution has no
  pending action (`NO_PENDING_ACTION`), the `stepId` doesn't match the current pending
  one (`STALE_STEP` — rejects duplicate/replayed submissions), or the result's
  `execution_id` doesn't match (`INVALID_RESULT`).
- A submission against an already-completed or already-failed execution is rejected
  (`EXECUTION_NOT_RESUMABLE`, `terminal: true`).
- There is no "desired next state" field on `AgentResult` for a host to forge — the
  decision engine derives the transition purely from `status`/`findings`, exactly as
  it always has.
- Human answers resume through `reconstructResumeContext()` unchanged: they are
  persisted for audit, never mutate a finding directly, and the responsible role is
  always re-dispatched (returned as a fresh `AGENT_ACTION_REQUIRED`) to independently
  verify — the human's answer informs what the host does differently, it does not
  substitute for redoing the work.

**CLI transport**: `project-run engine next-step`/`submit-step` expose this over the
same JSON transport `start`/`resume`/`status` use (§4.10) — this is how the reference
Claude Code skill (`templates/host-integrations/claude-code/project-engine-run/
SKILL.md`) drives the workflow: no `--mock-scenario`, no adapter of any kind, because
in pull-mode the skill itself — the live, already-running session — *is* the agent
runtime.

### 4.12 Phase 4: real Claude Code validation

§4.11 described the pull-based step API's design. Phase 4's objective was narrower and
stricter: prove — with a real Claude Code session, real tool calls, and a real human,
not unit tests or synthetic harnesses — that the design in §4.11 actually works
end-to-end, with no Claude/Anthropic SDK import, `claude -p` invocation, or nested
agent session anywhere in the engine.

**What was genuinely demonstrated**, against a disposable fixture repository (not this
package's own repo or history):

- A full `SPECIFY → CLARIFY → PLAN → TASKS → ANALYZE → IMPLEMENT → INDEPENDENT_REVIEW →
  CONVERGE → COMPLETED` lifecycle, driven entirely through `project-run engine
  next-step`/`submit-step` subprocess calls against the compiled CLI, with the live
  Claude Code session performing every role's work using its own Read/Edit/Bash tools —
  real spec/plan/tasks/implementation files, real git commits, real `node --test`
  execution with genuine pass/fail output.
- A real `HUMAN_INTERVENTION_REQUIRED` suspension, presented to the actual user via the
  host's own question-asking mechanism (not fabricated), with the real answer persisted
  durably and independently verified on disk (`human_answers` in the checkpoint file).
  The engine then forced a fresh re-dispatch rather than trusting the answer directly —
  exactly the Finding Contract guarantee §4.2 describes.
- A genuine `FINDINGS` result (a real, specific documentation-consistency observation
  found during honest independent review) that correctly routed as non-blocking per
  `isFindingBlocking()`'s LOW-severity rule, rather than forcing an unnecessary
  remediation cycle — live confirmation that the severity-based gate logic (§2, Phase 1)
  governs pull-mode exactly as it governs push-mode.
- **Restart/recovery**: a pending `AGENT_ACTION_REQUIRED` action was generated by one
  process, and **a second, independent, context-free invocation** — sharing no
  in-memory state, told nothing about the pending `stepId`/`request` in advance —
  recovered the exact persisted action from disk via `next-step`, completed it
  honestly, and the engine advanced correctly. This is the accurate description of what
  was shown: **not** two separate Claude Code terminal sessions (that was not what was
  run), but a second, genuinely independent process reading only `executionId` and the
  shared `projectRoot` — which is precisely the property §4.4's restart scenario
  depends on, and is what was actually exercised.

**Provider neutrality held throughout**: no SDK import, no `claude -p`, no nested agent
process, no conditional branching on provider identity anywhere in `src/` — confirmed
by direct inspection and `tests/package-boundary.test.ts`, both before and after Phase
4's changes.

### 4.13 Host-agnostic architecture, and what Phase 4 did not test

The engine remains, by construction, ignorant of which host is driving it — Phase 4
validated one concrete host (Claude Code) without adding a single line of Claude-specific
code to `src/`. The architecture is intended to support multiple interactive hosts on
the same contract:

```text
                 ┌──────────────────────┐
                 │  project-run-engine  │
                 │   (provider-neutral) │
                 └───────────┬──────────┘
                              │
              pull-based step API / CLI JSON transport
                              │
             ┌────────────────┴────────────────┐
             │                                  │
        Claude Code                        Antigravity
   (validated — Phase 4)              (supported target;
                                      not yet live-validated)
             │
             └── backlog: Cursor / Codex / MCP transport
                 (see `docs/backlog.md` — not implemented here)
```

- **Claude Code**: the only host genuinely live-validated so far (this section).
- **Antigravity**: a long-standing supported runtime identifier and conceptual
  integration target (§4.8) — not live-validated by Phase 4, and no Antigravity-specific
  code exists in this package; the same pull-based contract is expected to work for it
  without engine changes, but that expectation is untested until an actual Antigravity
  host integration exercises it.
- **Cursor, Codex, an MCP transport**: deliberately out of scope for every phase so far,
  including this one. They remain conceptual (§4.7–§4.8) and are tracked as backlog
  (`docs/backlog.md`), not implemented, so the engine never grows a dependency on any of
  their SDKs or calling conventions.

### 4.14 Runtime resolution

`AgentRuntime` for a given execution is resolved **once**, by `resolveRuntime()`
(`src/project/project-run.ts`), before the Coordinator's decision loop ever runs — not
independently re-derived at each decision. The precedence is:

```text
an explicit per-call `runtime` argument
    ?? a runtime already present on the context/persisted record
    ?? the project's configured `runtime.default_runtime` (.project-run/config.json)
    ?? "ANTIGRAVITY" (historical last-resort fallback)
```

Every host-facing entry point resolves runtime this way and writes the result onto
`context.runtime` before dispatch can occur: `executeProjectRun` (push), the fresh-start
path of `nextProjectRunStep` (pull), and `reconstructResumeContext` (both paths' resume).
`CoordinatorDecisionEngine.decide()` and `Coordinator.checkpoint()` retain their own
`context.runtime ?? "ANTIGRAVITY"` fallback purely as a defensive last resort for a
caller that constructs a `CoordinatorExecutionContext` directly without going through
one of these entry points — it is not expected to fire for any supported host
integration, and a consuming project's `runtime.default_runtime` is a fully functional
part of the configuration contract: a host may omit `runtime` on every call once it is
set, exactly as `CONSUMER-GUIDE.md` §9.2 now documents.

### 4.15 Trust boundary: result truthfulness

```text
Project Run Engine
    ↓  orchestrates state transitions; validates result shape/status
Host / agent
    ↓  responsible for truthful execution reporting
```

The engine decides the next state purely from the `status` and `findings` of the
`AgentResult` a host submits, and rejects malformed, stale, forged-identity, or
post-terminal submissions (§4.11). It does **not** re-run tests, re-inspect files, or
otherwise verify that the agent really did what it claims; a host that reports `PASS`
for work it did not do is trusted. The reference Claude Code skill states this
obligation to the agent explicitly (`SKILL.md`, "Truthfulness"). Building an
independent verifier is out of scope; see `docs/backlog.md`.

### 4.16 Feature bootstrap and identity boundaries

Three distinct identities travel through an execution, and the engine never conflates
them: the **feature** (which unit of work, e.g. `007-lifecycle-smoke-test`), the
**execution id** (this run of the workflow, e.g. `exec-1791412982780-58use`), and the
**git branch** (what the working tree has checked out, e.g.
`tmp/project-run-lifecycle-smoke`). Each is its own field on the execution context, the
dispatch request, and the checkpoint. Feature and branch names are not required to match;
branch→feature matching in `discoverFeature()` is only a convenience for locating an
*existing* `specs/<name>/` directory when no feature is given explicitly.

**Who creates a new feature's workspace: the host/consumer, not the engine.** The engine
discovers features; at run time it writes only under `.project-run/` and never creates a
feature directory. A call naming a feature whose directory does not exist returns
`FEATURE_NOT_DISCOVERED` (with an actionable reason) before any execution record is
written. The reasons this is not the engine's job:

- The workspace layout and naming belong to the workflow preset and its tooling. The
  bundled `speckit-specify` skill itself allocates the directory name (numbering by
  scanning existing `specs/` entries), runs `mkdir -p`, and records the path in
  `.specify/feature.json`; an engine-created directory would be a second, unsynchronised
  owner of that decision.
- Creating workspace files from inside the engine would break the engine's
  "provider-neutral orchestration, no workspace mutation" boundary.

Required host behaviour for a brand-new feature: create the feature workspace (by
default `specs/<feature>/`, any seed file is fine) and then call `next-step`/`start`
with that `feature`. If the feature name is only known after the specify step allocates
it, the host must establish it first — the engine cannot dispatch `SPECIFY` for a
feature it cannot locate. Whether to later offer an *opt-in*, preset-aware bootstrap
helper is a possible enhancement, not a decision; see `docs/backlog.md` (ENG-001).

Prerequisite scripts that print a `BRANCH:` value (`.specify/scripts/bash/*.sh`) live in
the consuming project, not in this package; their reporting of a feature name under
`BRANCH` is outside the engine (`docs/backlog.md`, ENG-003).

### 4.17 Phase 5: durable decision history, atomic checkpoints, and per-execution locking

Phase 5 hardens persistence for the case this architecture now routinely produces:
independent host turns (separate processes, separate sessions) touching the same
`execution_id`. Three changes, all additive to the `0.2.0` contract except where noted.

**1. `history` — the engine's durable decision record.** Each `Coordinator` decision is
appended to `context.history` *before* the checkpoint that follows it, and persisted as
`PersistedExecutionState.history` (`DecisionRecord[]`; an optional field that already
existed in the type but was never written). It records, in order and across resumes:

| Decision | Recorded fields |
|---|---|
| `TRANSITION` | `from`, `to`, `reason`, `remediation_iteration` — this is where the remediation/retry loop is visible |
| `DISPATCH_AGENT` | `role`, `runtime`, `state`, `iteration`, `remediation_iteration`, and (pull mode) the `step_id` that links it to `stepLog` |
| `COMPLETE` / `REQUIRE_HUMAN_INTERVENTION` | `reason` (and `from` for a suspension) |

Each entry is `{ step, state, decision, timestamp }`, `step` being the 1-based position in
the whole execution (it does **not** restart after a resume). Entries are deliberately
compact: **no dispatch request, result, evidence or findings** are stored. (A live
`StepRecord` for an 8-step run was ~44 KB against a ~2 KB checkpoint, almost all of it
payloads that `pending_action`, `last_result` and `stepLog` already cover; persisting it
verbatim would have grown every checkpoint ~20× and rewritten it on every save.)

`history` and `stepLog` answer different questions and are not aliases:

| | `history` | `stepLog` |
|---|---|---|
| Question | what did the engine decide, and why? | what actually happened? |
| Contains | transitions, dispatches, completion, suspensions | agent results (status, reported findings, evidence count), suspensions |
| Pure transitions (e.g. remediation loop) | yes | no |
| Findings | no | yes, per step |
| Relationship | each `DISPATCH_AGENT` is followed, once its result is applied, by exactly one `AGENT_STEP`, in the same order, linked by `step_id` in pull mode. A trailing dispatch with no matching step is either still pending (pull) or was never completed (the dispatch failed or the process died) | |

Surfaces: `ProjectRunHostResponse.history` (type `DecisionRecord[]`) on `status()`,
`start()`, `resume()` and the terminal pull `COMPLETED` response, plus
`PersistedExecutionState.history`. **Contract change:** through `0.2.0` this field was the
live per-call `StepRecord[]` for push-mode and always `[]` from `status()`; it is now the
durable `DecisionRecord[]` everywhere. The rich live records are still available to
programmatic callers (`onEvent`, `onStep`, `ProjectRunExecutionResult.history`,
`coordinatorResult.history`), whose shape is unchanged.

**2. Atomic checkpoint writes.** `FileExecutionStateStore.save()` writes a temp file,
fsyncs it, then renames it over the checkpoint. A reader — or a process that dies mid-save
— now only ever sees the previous complete checkpoint or the new complete one. (Previously
a plain `writeFileSync` truncated first, so a concurrent `load()` could fail with an
invalid-JSON error; this was reproduced and is covered by a cross-process test.)

**3. Advisory per-execution lock.** `FileExecutionStateStore.withLock(executionId, fn)`
(and the store-agnostic `withExecutionLock(store, id, fn)`, which simply runs `fn` for a
store that has no `withLock`) provides mutual exclusion for one execution's
read-modify-write turn.

- *What is locked* (one hold per turn, from the first read to the last checkpoint):
  `submitProjectRunStep`; `nextProjectRunStep` when it can mutate (a new or `IN_PROGRESS`
  execution, or a suspended one given `humanAnswers`); `executeProjectResume` /
  `resumeProjectRun`; `executeProjectRun` / `startProjectRun` when an execution id is
  supplied. *What is not locked:* `status()`, and every pure-read `nextProjectRunStep`
  path (returning the pending action, reporting a suspension or a terminal state), so
  observers never wait behind a writer; and a call with no `executionId`, whose freshly
  minted id nobody else can know yet.
- *Scope:* one lock file per execution (`<runsDir>/<id>.lock`), so different executions
  never contend. The engine takes it only at the outermost entry points and runs the
  inner steps unlocked; it is **not re-entrant** (an adapter that calls back into the
  engine for the same execution from inside a push-mode turn will wait out the timeout).
- *Lifecycle:* acquired by exclusive file creation, polled with jittered backoff up to a
  timeout (default 30 s; `new FileExecutionStateStore(root, undefined, { timeoutMs })`),
  released in `finally` on success, throw or rejection. Release only removes a lock that
  is still the caller's own.
- *Failure behaviour:* a timeout raises `ExecutionLockTimeoutError` (`EXECUTION_LOCKED`),
  surfaced as a **non-terminal** `FAILED` response (pull) or failed result (push) —
  the execution and its checkpoint are untouched and the call can simply be retried. A
  holder whose process has died is detected by probing its pid and reclaimed (reclamation
  is itself serialised through a guard file); a live holder is never displaced, however
  long it holds. A push-mode turn holds the lock for the whole run, so a competing
  mutation waits (or times out) rather than interleaving.
- *Idempotency (unchanged, now race-proof):* the second of two simultaneous submits of one
  step loses to the first and is rejected `STALE_STEP`, exactly as a sequential duplicate
  already was; simultaneous identical `humanAnswers` are recorded once and produce one
  re-dispatch.

**Guarantees and limits.** The lock gives mutual exclusion among cooperating callers using
this store on one machine and a local filesystem. It does *not* protect against: code that
bypasses it (direct `save()` calls, a `0.2.0` or older engine continuing the same
execution — which also drops `history` when it rewrites the checkpoint, so don't mix
versions on one execution); pid reuse after a crash; other machines or filesystems
without atomic exclusive create (some network mounts) — the engine is limited to
`node:fs`/`node:path` and cannot identify other hosts; or a hung-but-alive holder (waiters
time out instead). `Coordinator` itself performs no locking, so a library caller driving it
directly must hold the lock itself.

**Persisted-format compatibility.** `history` is an optional field and `version` stays `1`:
no migration. A checkpoint written before Phase 5 loads with an empty `history`; decisions
that were never recorded are never reconstructed, and recording simply resumes from the
next decision (step numbering restarts at 1 for such an execution).

**Out of scope, and not decided:** optimistic-concurrency/versioned writes, a
database-backed store, cross-machine coordination, a heartbeat for long-lived holders,
persisting per-decision payloads or an event stream, and any change to `stepLog` or
`stepsCount`. See `docs/backlog.md`.
