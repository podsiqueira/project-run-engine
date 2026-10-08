// packages/project-run-engine/src/host/project-run-host.ts
//
// Thin, provider-agnostic wrapper around the pre-existing `executeProjectRun` /
// `executeProjectResume` programmatic API. Deliberately does NOT reimplement any
// orchestration logic: the Coordinator, CoordinatorDecisionEngine, skill validation,
// context discovery, and checkpoint persistence are all reused exactly as-is. This
// layer only translates between the host-facing request/response/event shapes and the
// engine's existing internal shapes, so the CLI and any future host integration can
// share a single, machine-readable, non-CLI-output-parsing entry point.

import { countAgentSteps, type ExecutionStepRecord, type AgentDispatchRequest, type AgentResult, type StructuredFinding } from "../domain/types.js";
import type { AgentRuntimeAdapter } from "../runtime/runtime-adapter.js";
import type { HostExecutionOptions } from "../runtime/host-execution-contract.js";
import type { StepRecord } from "../coordinator/coordinator.js";
import type { DecisionRecord } from "../decision/types.js";
import {
  executeProjectRun,
  executeProjectResume,
  type ProjectRunExecutionResult,
} from "../project/project-run.js";
import { FileExecutionStateStore, type PersistedExecutionState } from "../project/state-store.js";
import { deriveHumanQuestions, type HumanInterventionRequired } from "../decision/human-intervention.js";
import type {
  ProjectRunHost,
  ProjectRunHostRequest,
  ProjectRunHostResponse,
  ProjectRunResumeRequest,
} from "./types.js";
import type { ProjectRunEventSink } from "./events.js";
import { statusProjectRun } from "./status.js";

function now(): string {
  return new Date().toISOString();
}

/**
 * Wraps each host-supplied runtime adapter so that AGENT_DISPATCH_STARTED /
 * AGENT_DISPATCH_COMPLETED events are emitted around the real `execute()` call,
 * with genuine pre/post-dispatch timing (not synthesized after the fact from step
 * history). Implemented entirely as a decorator over the existing, stable
 * `AgentRuntimeAdapter` interface — no change to `Coordinator`, `AgentDispatcher`, or
 * `HostDispatchAdapter` is required for this.
 */
function withDispatchEvents(
  adapters: AgentRuntimeAdapter[],
  executionId: string,
  emit: ProjectRunEventSink,
): AgentRuntimeAdapter[] {
  return adapters.map((adapter) => ({
    runtime: adapter.runtime,
    async execute(request: AgentDispatchRequest, options?: HostExecutionOptions): Promise<AgentResult> {
      await emit({
        type: "AGENT_DISPATCH_STARTED",
        executionId,
        timestamp: now(),
        role: request.role,
        state: request.state,
      });

      const result = await adapter.execute(request, options);

      await emit({
        type: "AGENT_DISPATCH_COMPLETED",
        executionId,
        timestamp: now(),
        role: request.role,
        state: request.state,
        status: result.status,
      });

      return result;
    },
  }));
}

/**
 * Translates Coordinator step records into STATE_CHANGED events. Only TRANSITION
 * decisions represent an actual state change; DISPATCH_AGENT steps are covered by the
 * adapter-wrapping above, and COMPLETE/REQUIRE_HUMAN_INTERVENTION are terminal and
 * covered by the top-level RUN_COMPLETED/HUMAN_INTERVENTION_REQUIRED events.
 */
function createStepEventTranslator(
  executionId: string,
  emit: ProjectRunEventSink,
): (record: StepRecord) => Promise<void> {
  return async (record: StepRecord) => {
    if (record.decision.action === "TRANSITION") {
      await emit({
        type: "STATE_CHANGED",
        executionId,
        timestamp: record.timestamp,
        from: record.decision.from,
        to: record.decision.to,
      });
    }
  };
}

function extractFindings(result: ProjectRunExecutionResult): StructuredFinding[] {
  const context = result.coordinatorResult?.context;
  const findings = context?.result?.findings ?? context?.findings ?? [];
  return (Array.isArray(findings) ? findings : []) as StructuredFinding[];
}

/**
 * The durable, execution-wide records (`stepLog`, decision `history`) for a response.
 * Normally taken from the run that just happened; when the call was rejected before any
 * context existed (e.g. resuming a completed execution, or a missing config), falls back
 * to whatever the checkpoint already holds — so a rejected call never reports an existing
 * execution as having no record. Unreadable/absent checkpoint -> empty.
 */
async function resolveDurableRecord(
  executionId: string,
  result: ProjectRunExecutionResult,
  projectRoot: string | undefined,
): Promise<{ stepLog: ExecutionStepRecord[]; history: DecisionRecord[] }> {
  const liveLog = result.stepLog ?? result.coordinatorResult?.context.stepLog;
  const liveHistory = result.decisionHistory ?? result.coordinatorResult?.context.history;
  if (liveLog && liveHistory) return { stepLog: liveLog, history: liveHistory };
  let persisted: PersistedExecutionState | null = null;
  try {
    persisted = await new FileExecutionStateStore(projectRoot ?? process.cwd()).load(executionId);
  } catch {
    // unreadable checkpoint: report what we have
  }
  return { stepLog: liveLog ?? persisted?.step_log ?? [], history: liveHistory ?? persisted?.history ?? [] };
}

async function buildHostResponse(
  executionId: string,
  result: ProjectRunExecutionResult,
  emit: ProjectRunEventSink,
  projectRoot: string | undefined,
): Promise<ProjectRunHostResponse> {
  const { state } = result;
  const findings = extractFindings(result);
  // `stepsCount` is the number of agent steps in the whole execution, derived from the
  // durable step log — NOT `result.stepsCount`, the Coordinator's per-call loop counter
  // (which also counts pure transitions and restarts at 0 on every resume).
  const { stepLog, history } = await resolveDurableRecord(executionId, result, projectRoot);
  const stepsCount = countAgentSteps(stepLog);

  switch (result.status) {
    case "COMPLETED": {
      await emit({ type: "RUN_COMPLETED", executionId, timestamp: now(), state, stepsCount });
      return { status: "COMPLETED", terminal: true, executionId, state, stepsCount, history, findings, stepLog };
    }

    case "HUMAN_INTERVENTION_REQUIRED": {
      const terminalDecision = result.coordinatorResult?.terminalDecision;
      const suspendedFrom =
        (terminalDecision?.action === "REQUIRE_HUMAN_INTERVENTION" ? terminalDecision.from : undefined) ?? state;
      const reason =
        terminalDecision?.action === "REQUIRE_HUMAN_INTERVENTION"
          ? terminalDecision.reason
          : "Human intervention required";

      const humanIntervention: HumanInterventionRequired = {
        executionId,
        suspendedFrom,
        reason,
        questions: deriveHumanQuestions(reason, findings),
        findings,
      };

      await emit({
        type: "HUMAN_INTERVENTION_REQUIRED",
        executionId,
        timestamp: now(),
        suspendedFrom,
        reason,
        questionCount: humanIntervention.questions.length,
      });

      return {
        status: "HUMAN_INTERVENTION_REQUIRED",
        terminal: false,
        executionId,
        state,
        stepsCount,
        history,
        findings,
        stepLog,
        humanIntervention,
      };
    }

    case "BLOCKED_MISSING_SKILLS": {
      return {
        status: "BLOCKED_MISSING_SKILLS",
        terminal: false,
        executionId,
        state,
        stepsCount,
        history,
        findings,
        stepLog,
        role: result.role,
        missingSkills: result.missingSkills,
        failureReason: result.failureReason,
      };
    }

    case "FAILED":
    default: {
      await emit({
        type: "RUN_FAILED",
        executionId,
        timestamp: now(),
        reason: result.failureReason ?? "Unknown failure",
      });
      return {
        status: "FAILED",
        // Lock contention rejects THIS call only; the execution is intact and retryable.
        terminal: !result.failureReason?.startsWith("EXECUTION_LOCKED"),
        executionId,
        state,
        stepsCount,
        history,
        findings,
        stepLog,
        failureReason: result.failureReason,
      };
    }
  }
}

function noopSink(): void {}

/**
 * Starts a new Project Run execution on behalf of a host agent.
 *
 * This is the machine-readable equivalent of `npx project-run` — it never requires a
 * host to parse human-readable CLI output. See `ProjectRunHostRequest`/
 * `ProjectRunHostResponse` in `./types.js` for the full contract.
 */
export async function startProjectRun(request: ProjectRunHostRequest): Promise<ProjectRunHostResponse> {
  const executionId =
    request.executionId ?? `exec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const emit = request.onEvent ?? noopSink;

  await emit({
    type: "RUN_STARTED",
    executionId,
    timestamp: now(),
    feature: request.feature,
    branch: request.branch,
  });

  const result = await executeProjectRun({
    projectRoot: request.projectRoot,
    config: request.config,
    configPath: request.configPath,
    context: { state: "INTAKE", runtime: request.runtime },
    runtime: request.runtime,
    executionId,
    explicitFeature: request.feature,
    explicitBranch: request.branch,
    adapters: withDispatchEvents(request.adapters, executionId, emit),
    executionOptions: request.executionOptions,
    maxSteps: request.maxSteps,
    onStep: createStepEventTranslator(executionId, emit),
  });

  return buildHostResponse(executionId, result, emit, request.projectRoot);
}

/**
 * Resumes a suspended Project Run execution, optionally supplying the human's answers
 * to the questions returned on the prior HUMAN_INTERVENTION_REQUIRED suspension.
 *
 * Answers are persisted durably as part of the execution's checkpoint record (see
 * `executeProjectResume`'s `humanAnswers` option) but never used to directly mutate a
 * finding or force a transition — the agent responsible for the suspended state is
 * always re-dispatched to independently verify the fix.
 */
export async function resumeProjectRun(request: ProjectRunResumeRequest): Promise<ProjectRunHostResponse> {
  const emit = request.onEvent ?? noopSink;

  await emit({ type: "RESUME_STARTED", executionId: request.executionId, timestamp: now() });

  const result = await executeProjectResume({
    executionId: request.executionId,
    projectRoot: request.projectRoot,
    config: request.config,
    configPath: request.configPath,
    adapters: withDispatchEvents(request.adapters, request.executionId, emit),
    runtime: request.runtime,
    executionOptions: request.executionOptions,
    maxSteps: request.maxSteps,
    humanAnswers: request.humanAnswers,
    onStep: createStepEventTranslator(request.executionId, emit),
  });

  return buildHostResponse(request.executionId, result, emit, request.projectRoot);
}

/** The `ProjectRunHost` implementation — see `./types.js` for the contract. */
export const projectRunHost: ProjectRunHost = {
  start: startProjectRun,
  resume: resumeProjectRun,
  status: statusProjectRun,
};
