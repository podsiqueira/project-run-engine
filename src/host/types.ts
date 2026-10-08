// packages/project-run-engine/src/host/types.ts
//
// Provider-agnostic Host Skill Contract.
//
// This is the public interface a host agent (Claude Code, Cursor, Antigravity, Codex,
// or any other interactive coding-agent environment) uses to invoke Project Run
// without parsing CLI stdout and without reimplementing the coordinator/state-machine.
//
// The engine owns: workflow state, coordinator decisions, state transitions,
// checkpoints/persistence, clarification gates, human-in-the-loop suspension/resume,
// role dispatch contracts, workflow sequencing, and convergence rules.
//
// The host owns: the conversational interface, the actual slash command/tool/skill
// registration (e.g. `/project-engine-run "<feature>"`), presenting questions to the
// human, collecting human answers, invoking/resuming the engine, and providing the
// runtime-specific agent execution mechanism (an `AgentRuntimeAdapter[]`, exactly as
// the pre-existing programmatic API already requires).

import type {
  AgentRole,
  AgentRuntime,
  AgentSkillRequirement,
  CoordinatorState,
  ExecutionStepRecord,
  HostExecutionOptions,
  StructuredFinding,
} from "../domain/types.js";
import type { AgentRuntimeAdapter } from "../runtime/runtime-adapter.js";
import type { StepRecord } from "../coordinator/coordinator.js";
import type { ProjectWorkflowConfig } from "../project/project-config.js";
import type { HumanAnswer, HumanInterventionRequired } from "../decision/human-intervention.js";
import type { ProjectRunEvent } from "./events.js";

export interface ProjectRunHostRequest {
  /** Workspace root. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Feature identifier. Auto-discovered from the git branch/specs/ when omitted. */
  feature?: string;
  /** Git branch. Auto-discovered when omitted. */
  branch?: string;
  /** Execution identifier. A new one is generated when omitted. */
  executionId?: string;
  runtime?: AgentRuntime;
  /**
   * The host's runtime-specific agent execution mechanism — exactly the same
   * `AgentRuntimeAdapter[]` the pre-existing `executeProjectRun` already accepts.
   * This is how the host provides "how Claude/Cursor/Antigravity/Codex executes a
   * role's work," without the engine ever needing to know which one it is.
   */
  adapters: AgentRuntimeAdapter[];
  config?: ProjectWorkflowConfig;
  configPath?: string;
  executionOptions?: HostExecutionOptions;
  maxSteps?: number;
  /** Optional progress/event sink — see `ProjectRunEvent` in `./events.js`. */
  onEvent?: (event: ProjectRunEvent) => void | Promise<void>;
}

export interface ProjectRunResumeRequest {
  executionId: string;
  projectRoot?: string;
  adapters: AgentRuntimeAdapter[];
  runtime?: AgentRuntime;
  config?: ProjectWorkflowConfig;
  configPath?: string;
  executionOptions?: HostExecutionOptions;
  maxSteps?: number;
  /**
   * Structured answers to the questions returned on the prior
   * HUMAN_INTERVENTION_REQUIRED suspension. See `ProjectRunHostResponse.humanIntervention`.
   */
  humanAnswers?: HumanAnswer[];
  onEvent?: (event: ProjectRunEvent) => void | Promise<void>;
}

export interface ProjectRunStatusRequest {
  executionId: string;
  projectRoot?: string;
}

/**
 * - `RUNNING`: a persisted execution mid-sequence, observable only via `status()` —
 *   `start()`/`resume()` always run the coordinator loop to a terminal or paused point
 *   before returning, so neither ever itself returns `RUNNING`; `status()` can, if the
 *   process driving a previous `start()`/`resume()` call exited (crashed, was killed,
 *   or simply disappeared) between two checkpoints.
 * - `HUMAN_INTERVENTION_REQUIRED` / `BLOCKED_MISSING_SKILLS`: non-terminal, actionable —
 *   see `ProjectRunHostResponse.terminal`.
 * - `COMPLETED` / `FAILED`: terminal — no further `resume()` call will progress them.
 */
export type ProjectRunHostStatus =
  | "RUNNING"
  | "COMPLETED"
  | "HUMAN_INTERVENTION_REQUIRED"
  | "BLOCKED_MISSING_SKILLS"
  | "FAILED";

export interface ProjectRunHostResponse {
  status: ProjectRunHostStatus;
  /**
   * `true` for `COMPLETED`/`FAILED` (no further `resume()` call can progress this
   * execution); `false` for every other status, including `BLOCKED_MISSING_SKILLS`
   * (resuming again after the host installs the missing skill is expected to work,
   * since the underlying suspended checkpoint — if any — was never touched by the
   * failed attempt).
   */
  terminal: boolean;
  executionId: string;
  state: CoordinatorState;
  /**
   * The number of agent steps (applied agent results) in the whole execution so far,
   * counted from the durable `stepLog` — so it includes steps performed before a
   * resume or restart, and excludes pure state transitions and human suspensions.
   * (Before ENG-002 this was a per-call loop counter in push-mode and the constant
   * workflow `iteration` in `status()`.)
   */
  stepsCount: number;
  /**
   * Live, in-memory only: the Coordinator's step records for the `start()`/`resume()`
   * call that produced this response. Always `[]` from `status()` and pull-mode
   * responses. Use `stepLog` for the durable record.
   */
  history: StepRecord[];
  /**
   * The findings reported by the MOST RECENT agent result — the same findings the
   * decision engine gates on. A later clean result legitimately replaces this with
   * `[]`; earlier findings remain visible in `stepLog`.
   */
  findings: StructuredFinding[];
  /**
   * The durable, append-only record of every agent step and human suspension in this
   * execution, in order, including what each step reported (ENG-002). See
   * `ExecutionStepRecord`. Empty for checkpoints written before the log existed
   * (earlier steps are not reconstructed). Pull-mode step responses other than the
   * terminal `COMPLETED` one do not carry this; read it with `status()`.
   */
  stepLog: ExecutionStepRecord[];
  /** Present if and only if `status === "HUMAN_INTERVENTION_REQUIRED"`. */
  humanIntervention?: HumanInterventionRequired;
  /** Present if and only if `status === "BLOCKED_MISSING_SKILLS"`. */
  role?: AgentRole;
  missingSkills?: AgentSkillRequirement["id"][];
  /** Present if and only if `status === "FAILED"` (or "BLOCKED_MISSING_SKILLS"). */
  failureReason?: string;
}

/**
 * The provider-agnostic Host Skill Contract itself. A host agent's slash command /
 * tool / skill implementation calls `start()` once per new execution, `resume()`
 * whenever the human has answered a `HUMAN_INTERVENTION_REQUIRED` request (or simply
 * wants to retry a previously interrupted run), and `status()` to read back a
 * persisted execution's current state without attempting to advance it — the
 * mechanism that lets a different process/host instance recover an execution it did
 * not itself start (see `ARCHITECTURE.md` §4.4, "Restart and multi-host recovery").
 */
export interface ProjectRunHost {
  start(request: ProjectRunHostRequest): Promise<ProjectRunHostResponse>;
  resume(request: ProjectRunResumeRequest): Promise<ProjectRunHostResponse>;
  status(request: ProjectRunStatusRequest): Promise<ProjectRunHostResponse>;
}
