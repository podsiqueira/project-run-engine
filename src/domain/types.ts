// packages/project-run-engine/src/domain/types.ts

import type {
  HostExecutionOptions,
  HostExecutionMetadata,
} from "../runtime/host-execution-contract.js";

export type CoordinatorState =
  | "INTAKE"
  | "SPECIFY"
  | "CLARIFY"
  | "PLAN"
  | "TASKS"
  | "ANALYZE"
  | "IMPLEMENT"
  | "INDEPENDENT_REVIEW"
  | "REMEDIATION"
  | "RE_REVIEW"
  | "CONVERGE"
  | "READY_FOR_PR"
  | "HUMAN_INTERVENTION_REQUIRED";

export type AgentRole =
  | "SPECIFICATION"
  | "ARCHITECTURE"
  | "IMPLEMENTATION"
  | "INDEPENDENT_REVIEW"
  | "REMEDIATION"
  | "CONVERGENCE"
  | (string & {});

export type StandardAgentRuntime =
  | "ANTIGRAVITY"
  | "CLAUDE"
  | "CURSOR"
  | "MOCK";

export type AgentRuntime =
  | StandardAgentRuntime
  | (string & {});

export type AgentCapability =
  | "spec-kit/specify"
  | "spec-kit/clarify"
  | "spec-kit/plan"
  | "spec-kit/tasks"
  | "spec-kit/analyze"
  | "spec-kit/implement"
  | "spec-kit/independent-review"
  | "spec-kit/bug-assess"
  | "spec-kit/bugfix"
  | "spec-kit/bug-test"
  | "spec-kit/converge"
  | (string & {});

/**
 * Provider-neutral resolved skill requirement carried on AgentDispatchRequest.
 * Represents WHAT capability is required, where it is located, and its execution invariants,
 * completely independent of any physical host runtime or LLM provider.
 */
export interface AgentSkillRequirement {
  id: string;
  required: boolean;
  name?: string;
  description?: string;
  capability?: AgentCapability | string;
  execution_order?: number;
  workflow?: string;
  evidenceRequirements?: string[];
  source?: string;
  version?: string;
}

export interface AgentSkill extends AgentSkillRequirement {
  id: string;
  name: string;
  description: string;
  capability: AgentCapability | string;
  required: boolean;
  execution_order: number;
  workflow?: string;
  evidenceRequirements?: string[];
  source?: string;
  version?: string;
}

export interface RoleSkillMetadata {
  skill: string;
  workflow: string;
  capability?: AgentCapability | string;
  description: string;
  evidenceRequirements?: string[];
}

export interface RemediationEvidence {
  finding_id: string;
  root_cause: string;
  correction: string;
  validation_performed: string;
  remaining_risks?: string;
  files_changed?: string[];
  tests_added_or_updated?: string[];
}

export interface AgentDefinition {
  role: AgentRole;
  name: string;
  description: string;
  supportedRuntimes: AgentRuntime[];
  capability?: AgentCapability | string;
  capabilities?: (AgentCapability | string)[];
  skill?: string;
  skills?: (AgentSkill | AgentSkillRequirement)[];
  required_skills?: AgentSkillRequirement[];
  skillMetadata?: RoleSkillMetadata;
}

export interface AgentDispatchRequest {
  execution_id: string;
  feature: string;
  branch: string;
  state: string;
  role: AgentRole;
  iteration: number;
  remediation_iteration: number;
  context: unknown;
  expected_output: {
    status: string;
    evidence_required: boolean;
  };
  capability?: AgentCapability | string;
  skill?: string;
  skills?: AgentSkillRequirement[];
  required_skills?: AgentSkillRequirement[];
  skill_metadata?: RoleSkillMetadata;
  options?: HostExecutionOptions;
}

export type FindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "ADVISORY";

export type FindingStatus = "OPEN" | "RESOLVED" | "ACCEPTED";

export interface FindingLocation {
  file?: string;
  line?: number;
  column?: number;
}

export interface StructuredFinding {
  id: string;
  severity: FindingSeverity;
  category?: string;
  location?: FindingLocation;
  evidence?: string;
  expected?: string;
  actual?: string;
  required_remediation?: string;
  status: FindingStatus;
  advisory?: boolean;
  blocking?: boolean;
  [key: string]: unknown;
}

export type AgentExecutionOutcome = "PASS" | "FINDINGS" | "FAIL" | "BLOCKED";

export interface AgentResult {
  execution_id: string;
  agent: AgentRole;
  state: string;
  status: AgentExecutionOutcome | string;
  evidence: unknown[];
  findings: (StructuredFinding | unknown)[];
  metadata?: HostExecutionMetadata;
  execution_metadata?: HostExecutionMetadata;
}

/**
 * One entry in an execution's durable, append-only step log (ENG-002).
 *
 * The log is the engine's persisted answer to "what actually happened in this run":
 * every agent result the engine applied (`AGENT_STEP`) and every time it suspended for
 * a human (`HUMAN_INTERVENTION`), in order, across restarts and resumes. It is
 * deliberately NOT the decision engine's input — gates still read the latest result's
 * findings (`CoordinatorExecutionContext.findings`), so a clean re-run still clears a
 * blocking gate. The log keeps what that replacement would otherwise erase.
 *
 * - `findings` is a snapshot of exactly what that result reported, never merged or
 *   de-duplicated: a finding raised at step 3 and absent from step 8's (clean) result
 *   is still visible at step 3.
 * - Per-step evidence payloads are not retained (only `evidence_count`); the most
 *   recent result's full evidence remains on `PersistedExecutionState.last_result`.
 */
export type ExecutionStepKind = "AGENT_STEP" | "HUMAN_INTERVENTION";

export interface ExecutionStepRecord {
  /** 1-based position in the log; continues across resumes and restarts. */
  seq: number;
  kind: ExecutionStepKind;
  /** The state the step ran in (`AGENT_STEP`) or the state suspended from (`HUMAN_INTERVENTION`). */
  state: CoordinatorState;
  /** `AGENT_STEP` only: the role whose result was applied. */
  role?: AgentRole;
  /** `AGENT_STEP` only: the `AgentResult.status` the engine acted on. */
  status?: string;
  /** `AGENT_STEP` only, pull-mode only: the correlation id of the submitted step. */
  step_id?: string;
  /** `AGENT_STEP` only: the findings that result reported (possibly empty). */
  findings?: (StructuredFinding | unknown)[];
  /** `AGENT_STEP` only: how many evidence items that result carried. */
  evidence_count?: number;
  /** `HUMAN_INTERVENTION` only: why the engine suspended. */
  reason?: string;
  recorded_at: string;
}

/** Number of agent steps (applied agent results) in a step log — the meaning of `stepsCount`. */
export function countAgentSteps(stepLog: readonly ExecutionStepRecord[] | undefined): number {
  return (stepLog ?? []).filter((r) => r.kind === "AGENT_STEP").length;
}

export class ProjectNotGitRepositoryError extends Error {
  readonly code = "PROJECT_NOT_GIT_REPOSITORY";
  constructor(message = "Target directory is not a git repository") {
    super(message);
    this.name = "ProjectNotGitRepositoryError";
    Object.setPrototypeOf(this, ProjectNotGitRepositoryError.prototype);
  }
}

export class FeatureNotDiscoveredError extends Error {
  readonly code = "FEATURE_NOT_DISCOVERED";
  constructor(message = "Active feature specification could not be discovered") {
    super(message);
    this.name = "FeatureNotDiscoveredError";
    Object.setPrototypeOf(this, FeatureNotDiscoveredError.prototype);
  }
}

export class ExecutionNotFoundError extends Error {
  readonly code = "EXECUTION_NOT_FOUND";
  constructor(readonly executionId: string, message?: string) {
    super(message ?? `Execution '${executionId}' was not found`);
    this.name = "ExecutionNotFoundError";
    Object.setPrototypeOf(this, ExecutionNotFoundError.prototype);
  }
}

export class ExecutionNotResumableError extends Error {
  readonly code = "EXECUTION_NOT_RESUMABLE";
  constructor(readonly executionId: string, message?: string) {
    super(message ?? `Execution '${executionId}' is not in a resumable state`);
    this.name = "ExecutionNotResumableError";
    Object.setPrototypeOf(this, ExecutionNotResumableError.prototype);
  }
}

/**
 * Another operation holds the advisory lock for this execution and did not release it
 * within the wait budget. The execution itself is fine — retry the call.
 */
export class ExecutionLockTimeoutError extends Error {
  readonly code = "EXECUTION_LOCKED";
  constructor(readonly executionId: string, message?: string) {
    super(message ?? `EXECUTION_LOCKED: Execution '${executionId}' is being modified by another operation`);
    this.name = "ExecutionLockTimeoutError";
    Object.setPrototypeOf(this, ExecutionLockTimeoutError.prototype);
  }
}

export class InvalidPersistedStateError extends Error {
  readonly code = "INVALID_PERSISTED_STATE";
  constructor(readonly executionId: string, message?: string) {
    super(message ?? `Persisted state for execution '${executionId}' is malformed or invalid`);
    this.name = "InvalidPersistedStateError";
    Object.setPrototypeOf(this, InvalidPersistedStateError.prototype);
  }
}

export class StateVersionUnsupportedError extends Error {
  readonly code = "STATE_VERSION_UNSUPPORTED";
  constructor(readonly version: unknown, message?: string) {
    super(message ?? `Unsupported execution state schema version: ${version}`);
    this.name = "StateVersionUnsupportedError";
    Object.setPrototypeOf(this, StateVersionUnsupportedError.prototype);
  }
}

export type {
  HostExecutionLifecycleStatus,
  HostExecutionRecord,
  HostExecutionMetadata,
  HostExecutionOptions,
} from "../runtime/host-execution-contract.js";

export {
  HostExecutionError,
  HostTimeoutError,
  HostCancellationError,
} from "../runtime/host-execution-contract.js";

export interface SkillRequirement {
  id: string;
  required: boolean;
  role?: AgentRole;
  capability?: string;
  description?: string;
}

export interface SkillDescriptor {
  id: string;
  name: string;
  description?: string;
  compatibility?: string;
  available: boolean;
  source?: string;
  version?: string;
  metadata?: Record<string, unknown>;
}

export interface SkillValidationResult {
  valid: boolean;
  role: AgentRole;
  missingRequiredSkills: string[];
  missingOptionalSkills: string[];
  availableSkills: SkillDescriptor[];
  failureReason?: string;
}

export type WorkflowAction = "FEATURE" | "RUN" | "REVIEW";

export interface OrchestrationExecutionRequest {
  execution_id: string;
  feature: string;
  branch: string;
  requested_action: WorkflowAction;
  runtime: AgentRuntime;
  context?: unknown;
  human_approved?: boolean;
}

export function validateOrchestrationExecutionRequest(request: OrchestrationExecutionRequest): {
  valid: boolean;
  error?: string;
} {
  if (!request.execution_id?.trim()) {
    return { valid: false, error: "execution_id is required" };
  }
  if (!request.feature?.trim()) {
    return { valid: false, error: "feature is required" };
  }
  if (!request.branch?.trim()) {
    return { valid: false, error: "branch is required" };
  }
  if (!request.requested_action) {
    return { valid: false, error: "requested_action is required (FEATURE | RUN | REVIEW)" };
  }
  if (!request.runtime || !request.runtime.trim()) {
    return { valid: false, error: "runtime is required" };
  }
  if (request.requested_action === "RUN" && !request.human_approved) {
    return {
      valid: false,
      error: "Human approval is required before initiating autonomous RUN workflow",
    };
  }
  return { valid: true };
}
