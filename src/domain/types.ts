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

export type ExecutionLockFailureCode = "EXECUTION_LOCKED" | "EXECUTION_LOCK_UNAVAILABLE";

/**
 * The engine could not obtain the advisory lock for an execution, so it did NOT run the
 * operation (and never runs it unlocked). The execution and its checkpoint are untouched.
 * Raised only from lock acquisition — never for an error thrown by the locked operation
 * itself. Entry points convert it into a structured, non-terminal failure whose
 * `failureReason` starts with `code`; see `isExecutionLockFailure`.
 */
export class ExecutionLockError extends Error {
  constructor(
    readonly code: ExecutionLockFailureCode,
    readonly executionId: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionLockError";
    Object.setPrototypeOf(this, ExecutionLockError.prototype);
  }
}

/**
 * Another operation holds the advisory lock for this execution and did not release it
 * within the wait budget. The execution itself is fine — retry once that operation ends.
 */
export class ExecutionLockTimeoutError extends ExecutionLockError {
  constructor(executionId: string, message?: string) {
    super("EXECUTION_LOCKED", executionId, message ?? `EXECUTION_LOCKED: Execution '${executionId}' is being modified by another operation`);
    this.name = "ExecutionLockTimeoutError";
    Object.setPrototypeOf(this, ExecutionLockTimeoutError.prototype);
  }
}

/**
 * The lock could not be taken at all because the filesystem refused (the runs directory
 * is missing or not a directory, is not writable, the disk is full, ...). Retrying
 * without fixing the environment will not help.
 */
export class ExecutionLockUnavailableError extends ExecutionLockError {
  constructor(executionId: string, message?: string, readonly cause?: unknown) {
    super("EXECUTION_LOCK_UNAVAILABLE", executionId, message ?? `EXECUTION_LOCK_UNAVAILABLE: Could not lock execution '${executionId}'`);
    this.name = "ExecutionLockUnavailableError";
    Object.setPrototypeOf(this, ExecutionLockUnavailableError.prototype);
  }
}

/** True when a `failureReason` reports a lock failure (the call was rejected; the execution is intact and not terminal). */
export function isExecutionLockFailure(reason: string | undefined): boolean {
  return /^EXECUTION_LOCK(ED|_UNAVAILABLE):/.test(reason ?? "");
}

export type PersistenceFailureCode = "CHECKPOINT_WRITE_FAILED" | "CHECKPOINT_CONFLICT";

/** Every machine-readable failure code a response can carry in `failureCode`. */
export type ExecutionFailureCode = ExecutionLockFailureCode | PersistenceFailureCode;

/**
 * A checkpoint the engine needed to write could not be written (`ExecutionStateStore.save`
 * rejected). The engine never reports progress that is not durable, so the operation that
 * needed the write is abandoned and this error surfaces; entry points turn it into a
 * structured, non-terminal failure (`failureCode: "CHECKPOINT_WRITE_FAILED"`).
 *
 * The execution is left at its LAST DURABLE checkpoint (a save is all-or-nothing). Which
 * checkpoint that is depends on how far the abandoned turn got, but it is always a state
 * the engine can recover from — exactly like a crash at that point: `next-step` (pull) or
 * `resume`/`start` (push) with the same execution id continue from it. Raised only for a
 * write the engine required; never for a lock failure (see `ExecutionLockError`).
 */
export class CheckpointWriteError extends Error {
  readonly code: PersistenceFailureCode;
  constructor(
    readonly executionId: string,
    /** The lifecycle status the failed checkpoint would have recorded. */
    readonly lifecycleStatus: string,
    readonly cause?: unknown,
    /** For subclasses: a more specific code and message. */
    refinement?: { code: PersistenceFailureCode; message: string },
  ) {
    const detail = cause instanceof Error ? cause.message : cause === undefined ? "unknown error" : String(cause);
    super(
      refinement?.message ??
        `CHECKPOINT_WRITE_FAILED: The ${lifecycleStatus} checkpoint for execution '${executionId}' could not be written (${detail}). ` +
          `The engine does not report progress that is not durable, so this call did not take effect beyond the last durable checkpoint, ` +
          `and the execution is intact. Fix the storage problem (free disk space, permissions on '.project-run/runs'), then call next-step ` +
          `(pull mode) or resume/start (push mode) again with the same executionId — it continues from the last durable checkpoint.`,
    );
    this.code = refinement?.code ?? "CHECKPOINT_WRITE_FAILED";
    this.name = "CheckpointWriteError";
    Object.setPrototypeOf(this, CheckpointWriteError.prototype);
  }
}

/**
 * A store refused a checkpoint write because the execution was modified by someone else since
 * this operation read it (optimistic concurrency: the write named the `expectedRevision` it was
 * based on, and the stored revision differs). NOTHING was written; the other writer's checkpoint
 * stands. This is a `CheckpointWriteError` (so every entry point already reports it, as a
 * non-terminal failure) with its own code, because the right reaction differs: not "fix the
 * storage", but "re-read — the execution moved on": call next-step / status to get the current state.
 *
 * Under the per-execution lock this cannot happen between cooperating engine calls; it is the
 * safety net for when the lock did not hold (an operator deleted a live lock, a store without
 * mutual exclusion, an engine that does not use the lock): the loser is rejected instead of
 * silently overwriting the winner.
 */
export class CheckpointConflictError extends CheckpointWriteError {
  constructor(
    executionId: string,
    lifecycleStatus: string,
    readonly expectedRevision: number,
    /** The revision actually stored. */
    readonly actualRevision: number,
  ) {
    super(executionId, lifecycleStatus, undefined, {
      code: "CHECKPOINT_CONFLICT",
      message:
        `CHECKPOINT_CONFLICT: Execution '${executionId}' was changed by another operation while this call was in progress ` +
        `(this call was based on revision ${expectedRevision}; the stored revision is ${actualRevision}). ` +
        `This call's changes were discarded and the other operation's checkpoint stands — nothing was overwritten. ` +
        `Call next-step (pull mode) or status again to get the current state; do not retry a submission blindly.`,
    });
    this.name = "CheckpointConflictError";
    Object.setPrototypeOf(this, CheckpointConflictError.prototype);
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
