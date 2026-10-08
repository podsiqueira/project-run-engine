// packages/project-run-engine/src/host/project-run-step.ts
//
// The pull-based step API: `nextProjectRunStep()` and `submitProjectRunStep()`.
//
// This is NOT a second Coordinator or a second orchestration implementation. Every
// piece of logic here is reused, not reimplemented:
//   - context bootstrapping/reconstruction: `resolveConfig`, `buildEngineServices`,
//     `reconstructStartContext`, `reconstructResumeContext` from `../project/project-run.js`
//     (the exact same functions `executeProjectRun`/`executeProjectResume` use);
//   - decision-making and checkpointing: `Coordinator.prepareNextAction()` /
//     `Coordinator.applyExternalResult()` (new methods on the existing `Coordinator`,
//     not a parallel class — see `coordinator.ts`);
//   - skill enrichment/validation: `AgentDispatcher.prepareRequest()` (the same logic
//     `dispatch()` uses, minus the runtime-adapter lookup/invocation);
//   - terminal-state response shaping: `statusProjectRun()` (Phase 2), re-read from
//     the checkpoint `prepareNextAction()` just wrote, rather than re-derived here.
//
// The engine never spawns a provider process and never fabricates an AgentResult. The
// host performs the described role's work using its own tools/session and reports
// back the result; this module's only job is translating between that and the
// Coordinator/DecisionEngine's existing, unmodified machinery.

import type { AgentResult, CoordinatorState } from "../domain/types.js";
import type { CoordinatorExecutionContext, FindingInput } from "../decision/types.js";
import { Coordinator, type PreparedAction } from "../coordinator/coordinator.js";
import { CoordinatorDecisionEngine } from "../decision/decision-engine.js";
import { AgentDispatcher } from "../agents/agent-dispatcher.js";
import { SkillValidationError } from "../skills/skill-validation-error.js";
import type { ProjectWorkflowConfig } from "../project/project-config.js";
import {
  resolveConfig,
  resolveRuntime,
  buildEngineServices,
  reconstructStartContext,
  reconstructResumeContext,
} from "../project/project-run.js";
import {
  FileExecutionStateStore,
  type ExecutionStateStore,
  type PersistedExecutionState,
} from "../project/state-store.js";
import { statusProjectRun } from "./status.js";
import type { ProjectRunHostResponse } from "./types.js";
import type {
  NextProjectRunStepRequest,
  SubmitProjectRunStepRequest,
  ProjectRunStepResponse,
} from "./step-types.js";

function failed(
  executionId: string,
  state: CoordinatorState,
  failureReason: string,
  terminal = true,
): ProjectRunStepResponse {
  return { status: "FAILED", terminal, executionId, state, failureReason };
}

/** Translates an already-terminal/paused `ProjectRunHostResponse` into step-response shape. */
function fromHostResponse(hostResponse: ProjectRunHostResponse): ProjectRunStepResponse {
  switch (hostResponse.status) {
    case "COMPLETED":
      return { status: "COMPLETED", terminal: true, executionId: hostResponse.executionId, state: hostResponse.state, result: hostResponse };
    case "HUMAN_INTERVENTION_REQUIRED":
      return {
        status: "HUMAN_INTERVENTION_REQUIRED",
        terminal: false,
        executionId: hostResponse.executionId,
        state: hostResponse.state,
        humanIntervention: hostResponse.humanIntervention!,
      };
    case "BLOCKED_MISSING_SKILLS":
      return {
        status: "BLOCKED_MISSING_SKILLS",
        terminal: false,
        executionId: hostResponse.executionId,
        state: hostResponse.state,
        role: hostResponse.role,
        missingSkills: hostResponse.missingSkills,
        failureReason: hostResponse.failureReason,
      };
    case "RUNNING":
    case "FAILED":
    default:
      return failed(
        hostResponse.executionId,
        hostResponse.state,
        hostResponse.failureReason ?? `Unexpected status '${hostResponse.status}'`,
        hostResponse.status === "FAILED",
      );
  }
}

/** Translates the result of `Coordinator.prepareNextAction()` into a step response. */
async function fromPreparedAction(
  executionId: string,
  projectRoot: string,
  stateStore: ExecutionStateStore,
  prepared: PreparedAction,
): Promise<ProjectRunStepResponse> {
  if (prepared.kind === "DISPATCH_PENDING") {
    return {
      status: "AGENT_ACTION_REQUIRED",
      terminal: false,
      executionId,
      state: prepared.decision.state,
      stepId: prepared.stepId,
      request: prepared.request,
    };
  }

  // TERMINAL (COMPLETE or REQUIRE_HUMAN_INTERVENTION) — prepareNextAction() already
  // checkpointed it; re-read via statusProjectRun() rather than re-deriving the same
  // translation a second time.
  const hostResponse = await statusProjectRun({ executionId, projectRoot, stateStore });
  return fromHostResponse(hostResponse);
}

/**
 * Returns the next action a host must take for an execution, without ever invoking an
 * `AgentRuntimeAdapter`. Starts a brand new execution when `executionId` is omitted
 * (or doesn't correspond to a persisted execution yet); otherwise recovers or advances
 * an existing one — including one a *different* process/host instance started (see
 * `ARCHITECTURE.md` §4.4/§4.11).
 */
export async function nextProjectRunStep(
  request: NextProjectRunStepRequest,
): Promise<ProjectRunStepResponse> {
  const projectRoot = request.projectRoot ?? process.cwd();
  const stateStore = request.stateStore ?? new FileExecutionStateStore(projectRoot);

  if (request.executionId) {
    let persisted: PersistedExecutionState | null;
    try {
      persisted = await stateStore.load(request.executionId);
    } catch (err) {
      return failed(request.executionId, "HUMAN_INTERVENTION_REQUIRED", (err as Error).message);
    }

    if (persisted) {
      switch (persisted.lifecycle_status) {
        case "AWAITING_AGENT_ACTION": {
          if (!persisted.pending_action) {
            return failed(
              persisted.execution_id,
              persisted.state,
              "Persisted state is AWAITING_AGENT_ACTION but has no pending_action recorded — this indicates a corrupted checkpoint.",
            );
          }
          // Pure, non-mutating read: the pending action is returned verbatim
          // (same stepId) rather than re-decided, so a submission issued against an
          // earlier query of this same pending action still correlates correctly.
          return {
            status: "AGENT_ACTION_REQUIRED",
            terminal: false,
            executionId: persisted.execution_id,
            state: persisted.state,
            stepId: persisted.pending_action.step_id,
            request: persisted.pending_action.request,
          };
        }

        case "HUMAN_INTERVENTION_REQUIRED": {
          if (!request.humanAnswers || request.humanAnswers.length === 0) {
            // Pure, non-mutating read of the current suspension — no answers were
            // supplied, so there is nothing to resume.
            const hostResponse = await statusProjectRun({ executionId: persisted.execution_id, projectRoot, stateStore });
            return fromHostResponse(hostResponse);
          }
          // Answers were supplied: resume. reconstructResumeContext() persists them
          // durably, decides whether the suspended state needs fresh re-verification
          // (shouldReverifyOnResume — the exact Phase 0/2 safety mechanism, unchanged),
          // and reconstructs the context to advance from.
          const reconstructed = await reconstructResumeContext({
            executionId: persisted.execution_id,
            projectRoot,
            stateStore,
            config: request.config,
            configPath: request.configPath,
            humanAnswers: request.humanAnswers,
          });
          if (!reconstructed.ok) {
            return failed(persisted.execution_id, reconstructed.state, reconstructed.failureReason);
          }
          return runPrepare(reconstructed.context, reconstructed.config, projectRoot, stateStore, request.maxSteps);
        }

        case "COMPLETED":
        case "FAILED": {
          const hostResponse = await statusProjectRun({ executionId: persisted.execution_id, projectRoot, stateStore });
          return fromHostResponse(hostResponse);
        }

        case "IN_PROGRESS":
        default: {
          // Mid-sequence with no pending action recorded — a prior prepareNextAction()
          // call checkpointed a pure TRANSITION but the process disappeared before the
          // next decision. Recover via the same reconstruction logic resume() uses and
          // advance forward: this is safe because no agent work was ever lost (none
          // was in flight at this exact point) and reconstructResumeContext() already
          // preserves (rather than clears) a non-HITL last_result, so nothing is
          // silently discarded.
          const reconstructed = await reconstructResumeContext({
            executionId: persisted.execution_id,
            projectRoot,
            stateStore,
            config: request.config,
            configPath: request.configPath,
          });
          if (!reconstructed.ok) {
            return failed(persisted.execution_id, reconstructed.state, reconstructed.failureReason);
          }
          return runPrepare(reconstructed.context, reconstructed.config, projectRoot, stateStore, request.maxSteps);
        }
      }
    }
    // No persisted execution for this id yet — fall through to starting fresh with it.
  }

  // Fresh start.
  const resolvedConfig = await resolveConfig(projectRoot, request.config, request.configPath);
  if (!resolvedConfig.ok) {
    return failed(request.executionId ?? "unknown", "INTAKE", resolvedConfig.failureReason);
  }
  const config = resolvedConfig.config;

  // Resolve runtime once, here, before `runPrepare()` ever calls into the Coordinator's
  // decision loop — same precedence and same shared helper `executeProjectRun` uses, so
  // the pull-based fresh-start path honors `config.runtime.default_runtime` exactly like
  // push-mode does, rather than leaving `context.runtime` unset for the decision engine
  // to independently (and incorrectly) default elsewhere.
  const context: CoordinatorExecutionContext = {
    state: "INTAKE",
    runtime: resolveRuntime(request.runtime, undefined, config),
  };
  const started = reconstructStartContext({
    projectRoot,
    context,
    executionId: request.executionId,
    explicitFeature: request.feature,
    explicitBranch: request.branch,
    config,
  });
  if (!started.ok) {
    return failed(request.executionId ?? "unknown", "INTAKE", started.failureReason);
  }

  return runPrepare(context, config, projectRoot, stateStore, request.maxSteps);
}

/**
 * Submits the `AgentResult` for a previously issued `AGENT_ACTION_REQUIRED` step,
 * exactly as the engine owns it: validates the submission, applies the result through
 * `Coordinator.applyExternalResult()`, re-evaluates via `Coordinator.prepareNextAction()`,
 * and returns whatever comes next. The host never supplies — and cannot force — the
 * resulting transition; only the content of `result` (status/findings/evidence).
 */
export async function submitProjectRunStep(
  request: SubmitProjectRunStepRequest,
): Promise<ProjectRunStepResponse> {
  const projectRoot = request.projectRoot ?? process.cwd();
  const stateStore = request.stateStore ?? new FileExecutionStateStore(projectRoot);

  let persisted: PersistedExecutionState | null;
  try {
    persisted = await stateStore.load(request.executionId);
  } catch (err) {
    return failed(request.executionId, "HUMAN_INTERVENTION_REQUIRED", (err as Error).message);
  }

  if (!persisted) {
    return failed(
      request.executionId,
      "HUMAN_INTERVENTION_REQUIRED",
      `EXECUTION_NOT_FOUND: Execution '${request.executionId}' not found in state store`,
    );
  }

  // Reject: terminal executions cannot accept a submission.
  if (persisted.lifecycle_status === "COMPLETED") {
    return failed(
      request.executionId,
      persisted.state,
      `EXECUTION_NOT_RESUMABLE: Cannot submit a result for completed execution '${request.executionId}'.`,
    );
  }
  if (persisted.lifecycle_status === "FAILED") {
    return failed(
      request.executionId,
      persisted.state,
      `EXECUTION_NOT_RESUMABLE: Execution '${request.executionId}' has failed terminally: ${persisted.terminal_reason ?? "unknown error"}.`,
    );
  }

  // Reject: no agent action is currently pending (includes HUMAN_INTERVENTION_REQUIRED
  // and bare IN_PROGRESS — a submission is never valid unless the engine itself raised
  // AWAITING_AGENT_ACTION).
  if (persisted.lifecycle_status !== "AWAITING_AGENT_ACTION" || !persisted.pending_action) {
    return failed(
      request.executionId,
      persisted.state,
      `NO_PENDING_ACTION: Execution '${request.executionId}' has no outstanding agent action to submit a result for (current lifecycle status: ${persisted.lifecycle_status}).`,
      false,
    );
  }

  // Reject: duplicate or stale submission. The stepId must match the exact pending
  // action — this is what makes a second submission against an already-applied
  // action (or one issued for a now-superseded request) rejectable rather than
  // silently double-applied.
  if (persisted.pending_action.step_id !== request.stepId) {
    return failed(
      request.executionId,
      persisted.state,
      `STALE_STEP: submitted stepId '${request.stepId}' does not match the current pending action '${persisted.pending_action.step_id}'. This usually means a result was already submitted for this action, or it is no longer current.`,
      false,
    );
  }

  // Reject: a cheap forgery guard — the submitted result must identify the execution
  // it claims to belong to. (The decision engine itself derives the next state purely
  // from `result.status`/`result.findings`; there is no "desired next state" field on
  // AgentResult for a host to forge in the first place.)
  if (request.result.execution_id !== request.executionId) {
    return failed(
      request.executionId,
      persisted.state,
      `INVALID_RESULT: submitted AgentResult.execution_id ('${request.result.execution_id}') does not match executionId ('${request.executionId}').`,
      false,
    );
  }

  const resolvedConfig = await resolveConfig(projectRoot, request.config, request.configPath);
  if (!resolvedConfig.ok) {
    return failed(request.executionId, persisted.state, resolvedConfig.failureReason);
  }
  const config = resolvedConfig.config;

  const context: CoordinatorExecutionContext = {
    execution_id: persisted.execution_id,
    feature: persisted.feature,
    branch: persisted.branch,
    state: persisted.state,
    iteration: persisted.iteration,
    remediation_iteration: persisted.remediation_iteration,
    runtime: persisted.runtime,
    context: persisted.context,
    findings: persisted.findings as FindingInput[] | undefined,
    humanAnswers: persisted.human_answers,
    stepLog: persisted.step_log,
    execution: {
      execution_id: persisted.execution_id,
      feature: persisted.feature,
      branch: persisted.branch,
      state: persisted.state,
      iteration: persisted.iteration,
      remediation_iteration: persisted.remediation_iteration,
    },
  };

  const coordinator = buildStepCoordinator(persisted.execution_id, projectRoot, config, persisted, stateStore, request.maxSteps);

  // Apply the host's result exactly as a real dispatch would have — this is the one
  // place the engine ever "believes" what the host reports, and it does so by
  // handing the result to the SAME Coordinator method (applyExternalResult) and the
  // SAME CoordinatorDecisionEngine every push-mode dispatch uses. No new trust path.
  await coordinator.applyExternalResult(context, request.result as AgentResult, request.stepId);

  try {
    const prepared = await coordinator.prepareNextAction(context, request.maxSteps);
    return fromPreparedAction(persisted.execution_id, projectRoot, stateStore, prepared);
  } catch (err) {
    if (err instanceof SkillValidationError) {
      return {
        status: "BLOCKED_MISSING_SKILLS",
        terminal: false,
        executionId: persisted.execution_id,
        state: context.state ?? persisted.state,
        role: err.result.role,
        missingSkills: err.result.missingRequiredSkills,
        failureReason: err.result.failureReason,
      };
    }
    return failed(persisted.execution_id, context.state ?? persisted.state, (err as Error).message);
  }
}

function buildStepCoordinator(
  executionId: string,
  projectRoot: string,
  config: ProjectWorkflowConfig,
  persisted: { project: string; feature: string; branch: string; runtime: string; preset: string } | undefined,
  stateStore: ExecutionStateStore,
  maxSteps: number | undefined,
): Coordinator {
  const { validator, registry } = buildEngineServices(projectRoot, config, {});
  // No real AgentRuntimeAdapter is ever registered: prepareNextAction()/
  // applyExternalResult() never call AgentDispatcher.dispatch(), only
  // AgentDispatcher.prepareRequest() (enrichment + skill validation only).
  const dispatcher = new AgentDispatcher(registry, [], validator);
  const decisionEngine = new CoordinatorDecisionEngine();
  return new Coordinator({
    dispatcher,
    decisionEngine,
    stateStore,
    maxSteps,
    executionMetadata: {
      executionId,
      project: persisted?.project ?? config.project.name,
      feature: persisted?.feature ?? "",
      branch: persisted?.branch ?? "",
      runtime: (persisted?.runtime as never) ?? config.runtime.default_runtime,
      preset: persisted?.preset ?? config.project.workflow_version ?? "spec-kit-v1",
    },
  });
}

async function runPrepare(
  context: CoordinatorExecutionContext,
  config: ProjectWorkflowConfig,
  projectRoot: string,
  stateStore: ExecutionStateStore,
  maxSteps: number | undefined,
): Promise<ProjectRunStepResponse> {
  const executionId = context.execution_id ?? context.execution?.execution_id ?? "unknown";
  const coordinator = buildStepCoordinator(executionId, projectRoot, config, undefined, stateStore, maxSteps);

  try {
    const prepared = await coordinator.prepareNextAction(context, maxSteps);
    return fromPreparedAction(executionId, projectRoot, stateStore, prepared);
  } catch (err) {
    if (err instanceof SkillValidationError) {
      return {
        status: "BLOCKED_MISSING_SKILLS",
        terminal: false,
        executionId,
        state: context.state ?? "INTAKE",
        role: err.result.role,
        missingSkills: err.result.missingRequiredSkills,
        failureReason: err.result.failureReason,
      };
    }
    return failed(executionId, context.state ?? "INTAKE", (err as Error).message);
  }
}
