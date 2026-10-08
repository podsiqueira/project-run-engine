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

import {
  CheckpointWriteError,
  ExecutionLockUnavailableError,
  type AgentResult,
  type CoordinatorState,
  type ExecutionFailureCode,
} from "../domain/types.js";
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
import { runLockedTurn } from "../project/locked-turn.js";
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
  failureCode?: ExecutionFailureCode,
): ProjectRunStepResponse {
  return { status: "FAILED", terminal, executionId, state, failureReason, ...(failureCode !== undefined ? { failureCode } : {}) };
}

/**
 * The response for a call that was abandoned because a checkpoint could not be written. The
 * execution is at its last durable checkpoint, so `state` is re-read from the store (best
 * effort) rather than taken from the abandoned in-memory turn — the response must never claim
 * progress the checkpoint does not contain. Non-terminal: `nextProjectRunStep()` with the same
 * `executionId` returns the authoritative state once the storage problem is fixed.
 */
async function checkpointWriteFailed(
  err: CheckpointWriteError,
  stateStore: ExecutionStateStore,
  fallbackState: CoordinatorState,
): Promise<ProjectRunStepResponse> {
  let state = fallbackState;
  try {
    state = (await stateStore.load(err.executionId))?.state ?? fallbackState;
  } catch {
    // the store that failed to write may also fail to read
  }
  return failed(err.executionId, state, err.message, false, err.code);
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
  try {
    return await nextProjectRunStepGuarded(request, projectRoot, stateStore);
  } catch (err) {
    // A checkpoint the call needed could not be written: nothing is reported as progress.
    if (err instanceof CheckpointWriteError) return checkpointWriteFailed(err, stateStore, "INTAKE");
    throw err;
  }
}

async function nextProjectRunStepGuarded(
  request: NextProjectRunStepRequest,
  projectRoot: string,
  stateStore: ExecutionStateStore,
): Promise<ProjectRunStepResponse> {
  const executionId = request.executionId;

  // No id: a fresh, unguessable one is minted below — nothing else can contend for it.
  if (!executionId) return settle(await nextProjectRunStepImpl(request, projectRoot, stateStore, "write"));

  // Pass 1 — UNLOCKED and strictly read-only. It reads the checkpoint once; if the call can be
  // answered without changing anything (return the pending action, report a suspension or a
  // terminal state, or report a read failure) it is answered right here and never waits behind
  // a writer. The store it sees cannot write, so it is incapable of mutating.
  //
  // If that read shows the call must MUTATE (no checkpoint yet, an in-progress recovery, or
  // answers for a suspension) — or shows a state this code does not recognise — pass 1 does
  // nothing and says so. There is deliberately no separate "peek": classifying from one read
  // and then acting on a second, later read is a check-then-act race (the checkpoint can change
  // in between, e.g. another host's submit passing through IN_PROGRESS).
  const first = await nextProjectRunStepImpl(request, projectRoot, readOnlyView(stateStore), "read");
  if (!isNeedsLock(first)) return first;

  // Pass 2 — LOCKED. Re-evaluates from the checkpoint as it is once the lock is held; whatever
  // another host did in the meantime is respected (the answer may now be a plain read).
  const turn = await runLockedTurn(stateStore, executionId, () => nextProjectRunStepImpl(request, projectRoot, stateStore, "write"));
  if (!turn.acquired) return failed(executionId, first.state, turn.error.message, false, turn.error.code);
  return settle(turn.value);
}

/** Signal from the read-only pass: "answering this call requires modifying the execution". */
interface NeedsLock {
  needsLock: true;
  state: CoordinatorState;
}

function needsLock(state: CoordinatorState): NeedsLock {
  return { needsLock: true, state };
}

function isNeedsLock(value: ProjectRunStepResponse | NeedsLock): value is NeedsLock {
  return (value as NeedsLock).needsLock === true;
}

/** The write pass and the no-id path never ask for a lock (they either hold it or need none). */
function settle(value: ProjectRunStepResponse | NeedsLock): ProjectRunStepResponse {
  if (isNeedsLock(value)) throw new Error("INTERNAL: nextProjectRunStep asked for the lock while already allowed to write");
  return value;
}

/**
 * A view of the store that can read but not write. Pass 1 runs against this, so even a future
 * code path that forgot to ask for the lock fails loudly instead of corrupting a checkpoint.
 */
function readOnlyView(store: ExecutionStateStore): ExecutionStateStore {
  return {
    load: (id) => store.load(id),
    exists: (id) => store.exists(id),
    list: store.list ? () => store.list!() : undefined,
    save: async () => {
      throw new Error("INTERNAL: attempted to write a checkpoint from the unlocked read-only pass of nextProjectRunStep");
    },
  };
}

/**
 * `mode: "read"` is the unlocked pass (see above): it must not write, and returns `NeedsLock`
 * instead of taking any mutating branch. `mode: "write"` runs with the lock held (or with a
 * freshly minted id nobody else knows) and may do anything.
 */
async function nextProjectRunStepImpl(
  request: NextProjectRunStepRequest,
  projectRoot: string,
  stateStore: ExecutionStateStore,
  mode: "read" | "write",
): Promise<ProjectRunStepResponse | NeedsLock> {

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
          if (mode === "read") return needsLock(persisted.state);
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
          return runPrepare(reconstructed.context, reconstructed.config, projectRoot, stateStore, request.maxSteps, reconstructed.baseRevision);
        }

        case "COMPLETED":
        case "FAILED": {
          const hostResponse = await statusProjectRun({ executionId: persisted.execution_id, projectRoot, stateStore });
          return fromHostResponse(hostResponse);
        }

        case "IN_PROGRESS":
        default: {
          if (mode === "read") return needsLock(persisted.state);
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
          return runPrepare(reconstructed.context, reconstructed.config, projectRoot, stateStore, request.maxSteps, reconstructed.baseRevision);
        }
      }
    }
    // No persisted execution for this id yet — fall through to starting fresh with it.
    if (mode === "read") return needsLock("INTAKE");
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

  try {
    return await confirmFirstCheckpoint(await runPrepare(context, config, projectRoot, stateStore, request.maxSteps, 0), stateStore);
  } catch (err) {
    // Nothing durable exists yet: the very first checkpoint could not be written. Report it as
    // the documented "runs directory unusable" failure (same as the unwritable-dir case that
    // confirmFirstCheckpoint detects when a store drops the write silently). A failure AFTER
    // the first checkpoint exists is a CHECKPOINT_WRITE_FAILED and propagates to the entry point.
    if (err instanceof CheckpointWriteError && !(await stateStore.exists(err.executionId).catch(() => false))) {
      return firstCheckpointUnwritable(err.executionId);
    }
    throw err;
  }
}

/**
 * A fresh start hands the host an action that it will perform and later submit. Checkpoint
 * writes are best-effort inside the Coordinator, so if the store is unusable the action would
 * be issued although nothing was persisted — the host would do the work and only then learn,
 * at submit, that there is no execution to submit to. Confirm the first checkpoint exists
 * before issuing the action; otherwise report it now, in the same (non-terminal) way as any
 * other failure to use the runs directory.
 */
async function confirmFirstCheckpoint(
  response: ProjectRunStepResponse,
  stateStore: ExecutionStateStore,
): Promise<ProjectRunStepResponse> {
  if (response.status !== "AGENT_ACTION_REQUIRED") return response;
  let persisted = false;
  try {
    persisted = await stateStore.exists(response.executionId);
  } catch {
    persisted = false;
  }
  if (persisted) return response;
  return firstCheckpointUnwritable(response.executionId);
}

function firstCheckpointUnwritable(executionId: string): ProjectRunStepResponse {
  const err = new ExecutionLockUnavailableError(
    executionId,
    `EXECUTION_LOCK_UNAVAILABLE: The first checkpoint for execution '${executionId}' could not be written, so no action was issued ` +
      `(nothing could ever be submitted against it). Check that '.project-run/runs' exists as a writable directory and that the disk is not full, then retry.`,
  );
  return failed(executionId, "INTAKE", err.message, false, err.code);
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
  try {
    return await submitProjectRunStepGuarded(request, projectRoot, stateStore);
  } catch (err) {
    // A checkpoint the call needed could not be written: the response must not claim that the
    // result was applied beyond what the last durable checkpoint contains.
    if (err instanceof CheckpointWriteError) return checkpointWriteFailed(err, stateStore, "INTAKE");
    throw err;
  }
}

async function submitProjectRunStepGuarded(
  request: SubmitProjectRunStepRequest,
  projectRoot: string,
  stateStore: ExecutionStateStore,
): Promise<ProjectRunStepResponse> {
  // A submission is validate-then-apply on the pending action: two near-simultaneous
  // submits for the same step would both pass validation against the same checkpoint
  // and double-apply. Holding the lock across the whole turn makes the loser see the
  // winner's checkpoint and be rejected as STALE_STEP, exactly as a sequential
  // duplicate already is.
  const turn = await runLockedTurn(stateStore, request.executionId, () => submitProjectRunStepUnlocked(request, projectRoot, stateStore));
  if (turn.acquired) return turn.value;
  let state: CoordinatorState = "INTAKE";
  try {
    state = (await stateStore.load(request.executionId))?.state ?? state;
  } catch {
    // best-effort state for the error response only
  }
  return failed(request.executionId, state, turn.error.message, false, turn.error.code);
}

async function submitProjectRunStepUnlocked(
  request: SubmitProjectRunStepRequest,
  projectRoot: string,
  stateStore: ExecutionStateStore,
): Promise<ProjectRunStepResponse> {

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
    history: persisted.history,
    execution: {
      execution_id: persisted.execution_id,
      feature: persisted.feature,
      branch: persisted.branch,
      state: persisted.state,
      iteration: persisted.iteration,
      remediation_iteration: persisted.remediation_iteration,
    },
  };

  const coordinator = buildStepCoordinator(persisted.execution_id, projectRoot, config, persisted, stateStore, request.maxSteps, persisted.revision ?? 0);

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
    if (err instanceof CheckpointWriteError) throw err;
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
  baseRevision: number,
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
      baseRevision,
    },
  });
}

async function runPrepare(
  context: CoordinatorExecutionContext,
  config: ProjectWorkflowConfig,
  projectRoot: string,
  stateStore: ExecutionStateStore,
  maxSteps: number | undefined,
  baseRevision: number,
): Promise<ProjectRunStepResponse> {
  const executionId = context.execution_id ?? context.execution?.execution_id ?? "unknown";
  const coordinator = buildStepCoordinator(executionId, projectRoot, config, undefined, stateStore, maxSteps, baseRevision);

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
    if (err instanceof CheckpointWriteError) throw err;
    return failed(executionId, context.state ?? "INTAKE", (err as Error).message);
  }
}
