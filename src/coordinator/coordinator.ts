// packages/project-run-engine/src/coordinator/coordinator.ts

import type {
  AgentDispatchRequest,
  AgentResult,
  AgentRuntime,
  CoordinatorState,
  ExecutionStepRecord,
  StructuredFinding,
} from "../domain/types.js";
import type {
  CoordinatorDecision,
  CoordinatorExecutionContext,
  CompleteDecision,
  DecisionRecord,
  DispatchAgentDecision,
  FindingInput,
  RequireHumanInterventionDecision,
} from "../decision/types.js";
import { CoordinatorDecisionEngine } from "../decision/decision-engine.js";
import { deriveHumanQuestions, type HumanInterventionRequired } from "../decision/human-intervention.js";
import { AgentDispatcher } from "../agents/agent-dispatcher.js";
import type {
  ExecutionLifecycleState,
  ExecutionStateStore,
  PersistedPendingAction,
} from "../project/state-store.js";

export type CoordinatorExecutionStatus =
  | "COMPLETED"
  | "HUMAN_INTERVENTION_REQUIRED";

export interface StepRecord {
  step: number;
  state: CoordinatorState;
  decision: CoordinatorDecision;
  result?: AgentResult;
  timestamp: string;
}

export interface CoordinatorRunResult {
  status: CoordinatorExecutionStatus;
  state: CoordinatorState;
  context: CoordinatorExecutionContext;
  history: StepRecord[];
  /**
   * Coordinator loop iterations in this `run()` call, including pure state transitions
   * and the terminal decision; bounded by `maxSteps` and reset on every resume. This is
   * a loop counter, NOT the number of agent steps in the execution — that is
   * `countAgentSteps(context.stepLog)`, which is what the host-level
   * `ProjectRunHostResponse.stepsCount` reports.
   */
  stepsCount: number;
  terminalDecision: CompleteDecision | RequireHumanInterventionDecision;
}

export interface CoordinatorStepResult {
  decision: CoordinatorDecision;
  result?: AgentResult;
  terminal: boolean;
}

/**
 * The result of `Coordinator.prepareNextAction()` — the pull-based counterpart to
 * `step()`. `DISPATCH_PENDING` is returned instead of a dispatched `AgentResult`
 * whenever the decision engine says a role needs to execute: the caller (a host that
 * IS its own agent runtime, e.g. an interactive coding-agent session) performs the
 * work itself and reports back via `applyExternalResult()`, rather than the
 * Coordinator calling an `AgentDispatcher` on the caller's behalf.
 */
export type PreparedAction =
  | { kind: "DISPATCH_PENDING"; stepId: string; request: AgentDispatchRequest; runtime: AgentRuntime; decision: DispatchAgentDecision }
  | { kind: "TERMINAL"; decision: CompleteDecision | RequireHumanInterventionDecision };

export interface CoordinatorExecutionMetadata {
  executionId: string;
  project: string;
  feature: string;
  branch: string;
  runtime: AgentRuntime;
  preset?: string;
}

export interface CoordinatorOptions {
  decisionEngine?: CoordinatorDecisionEngine;
  dispatcher: AgentDispatcher;
  maxSteps?: number;
  stateStore?: ExecutionStateStore;
  executionMetadata?: CoordinatorExecutionMetadata;
  onStep?: (record: StepRecord) => void | Promise<void>;
}

export const DEFAULT_MAX_STEPS = 100;

/**
 * Generates a correlation token for a pending agent action. Uses only `Date.now()` +
 * `Math.random()` — the same pattern `executeProjectRun` already uses for execution
 * ids — rather than `node:crypto`'s `randomUUID`, to preserve this package's strict,
 * test-enforced dependency boundary (only `node:fs`/`node:path` built-ins permitted;
 * see `tests/package-boundary.test.ts` and `PACKAGING.md`).
 */
function generateStepId(): string {
  return `step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Coordinator Execution Loop.
 *
 * Connects the deterministic DecisionEngine, AgentDispatcher, and Execution Context
 * into an automated orchestration loop that advances the lifecycle step-by-step
 * until a terminal state (READY_FOR_PR or HUMAN_INTERVENTION_REQUIRED) is reached.
 *
 * This layer is strictly provider-agnostic and contains no LLM calls, prompts,
 * or host CLI commands.
 */
export class Coordinator {
  private readonly decisionEngine: CoordinatorDecisionEngine;
  private readonly dispatcher: AgentDispatcher;
  private readonly maxSteps: number;
  private readonly stateStore?: ExecutionStateStore;
  private readonly executionMetadata?: CoordinatorExecutionMetadata;
  private readonly onStep?: (record: StepRecord) => void | Promise<void>;

  constructor(options: CoordinatorOptions) {
    if (!options.dispatcher) {
      throw new Error("Coordinator requires an AgentDispatcher instance");
    }
    this.dispatcher = options.dispatcher;
    this.decisionEngine = options.decisionEngine ?? new CoordinatorDecisionEngine();
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.stateStore = options.stateStore;
    this.executionMetadata = options.executionMetadata;
    this.onStep = options.onStep;
  }

  private async checkpoint(
    context: CoordinatorExecutionContext,
    status: ExecutionLifecycleState,
    lastResult?: AgentResult,
    terminalReason?: string,
    suspendedFrom?: CoordinatorState,
    pendingAction?: PersistedPendingAction,
  ): Promise<void> {
    if (!this.stateStore) return;

    const executionId =
      context.execution?.execution_id ??
      context.execution?.id ??
      context.execution_id ??
      this.executionMetadata?.executionId ??
      "unknown-execution";

    const project = this.executionMetadata?.project ?? "default-project";
    const feature =
      context.execution?.feature ??
      context.feature ??
      this.executionMetadata?.feature ??
      "";
    const branch =
      context.execution?.branch ??
      context.branch ??
      this.executionMetadata?.branch ??
      "";
    const runtime =
      context.runtime ??
      this.executionMetadata?.runtime ??
      "ANTIGRAVITY";
    const preset = this.executionMetadata?.preset ?? "spec-kit-v1";
    const iteration =
      context.execution?.iteration ?? context.iteration ?? 1;
    const remediationIteration =
      context.execution?.remediation_iteration ??
      context.remediation_iteration ??
      0;

    const rawState = context.execution?.state ?? context.state ?? "INTAKE";
    const findings = (context.result?.findings ?? context.findings) as
      | (StructuredFinding | unknown)[]
      | undefined;

    // Human-in-the-Loop record: computed here, once, from the same findings/reason
    // the decision that caused this checkpoint already evaluated, so the persisted
    // record and the structured response a host receives are always derived
    // identically (see `deriveHumanQuestions`). Only recomputed when we are actually
    // suspending for human intervention; an in-progress checkpoint leaves any
    // previously recorded intervention untouched by omitting the field here, since
    // `human_intervention` describes the MOST RECENT suspension, not the full history.
    const humanIntervention: HumanInterventionRequired | undefined =
      status === "HUMAN_INTERVENTION_REQUIRED"
        ? {
            executionId,
            suspendedFrom: suspendedFrom ?? rawState,
            reason: terminalReason ?? "Human intervention required",
            questions: deriveHumanQuestions(terminalReason ?? "", findings ?? []),
            findings: (findings ?? []) as StructuredFinding[],
          }
        : undefined;

    try {
      await this.stateStore.save({
        version: 1,
        execution_id: executionId,
        project,
        feature,
        branch,
        state: rawState,
        lifecycle_status: status,
        suspended_from: suspendedFrom,
        runtime,
        iteration,
        remediation_iteration: remediationIteration,
        preset,
        context: context.context,
        last_result: (lastResult ?? context.result) as AgentResult | undefined,
        findings,
        step_log: context.stepLog,
        history: context.history,
        human_intervention: humanIntervention,
        // Carried forward from the context (see CoordinatorExecutionContext.humanAnswers)
        // since the state store overwrites the whole record on every save rather than
        // merging — this is what keeps previously recorded answers from being dropped
        // by a later checkpoint within the same (resumed) run.
        human_answers: context.humanAnswers,
        // Only set on the one checkpoint call that raises it (prepareNextAction's
        // DISPATCH_AGENT case); every other checkpoint call omits it, which correctly
        // clears a previously pending action the moment it's no longer outstanding —
        // unlike human_intervention/human_answers, a pending action is NOT an audit
        // trail entry and must not be carried forward once resolved.
        pending_action: pendingAction,
        terminal_reason: terminalReason,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch {
      // Non-fatal if checkpoint save fails, don't crash main loop
    }
  }

  /**
   * Executes a single step of the orchestration cycle.
   */
  async step(context: CoordinatorExecutionContext): Promise<CoordinatorStepResult> {
    const decision = this.decisionEngine.decide(context);
    this.recordDecision(context, decision);

    switch (decision.action) {
      case "COMPLETE": {
        this.syncState(context, "READY_FOR_PR");
        await this.checkpoint(context, "COMPLETED", undefined, decision.reason);
        return {
          decision,
          terminal: true,
        };
      }

      case "REQUIRE_HUMAN_INTERVENTION": {
        this.recordHumanIntervention(context, decision);
        this.syncState(context, "HUMAN_INTERVENTION_REQUIRED");
        await this.checkpoint(
          context,
          "HUMAN_INTERVENTION_REQUIRED",
          undefined,
          decision.reason,
          decision.from,
        );
        return {
          decision,
          terminal: true,
        };
      }

      case "DISPATCH_AGENT": {
        // Dispatch the agent via the dispatcher.
        // Operational errors (network/disk/process crash) reject and propagate directly.
        const result = await this.dispatcher.dispatch(
          decision.request,
          decision.runtime,
          decision.request.options,
        );

        await this.applyExternalResult(context, result);

        return {
          decision,
          result,
          terminal: false,
        };
      }

      case "TRANSITION": {
        this.syncState(context, decision.to);

        if (decision.remediation_iteration !== undefined) {
          this.syncRemediationIteration(context, decision.remediation_iteration);
        }

        // Clear previous execution outcome so the new state evaluates dispatch
        context.result = undefined;
        context.gateStatus = undefined;

        await this.checkpoint(context, "IN_PROGRESS");

        return {
          decision,
          terminal: false,
        };
      }

      default: {
        const unexpected = decision as { action?: string };
        throw new Error(`Unexpected coordinator decision action: ${unexpected.action}`);
      }
    }
  }

  /**
   * Applies a host-submitted `AgentResult` exactly as `step()`'s `DISPATCH_AGENT`
   * branch does after a real `AgentDispatcher.dispatch()` call — WITHOUT ever calling
   * the dispatcher. This is the "submit" half of the pull-based step contract
   * (`src/host/project-run-step.ts`): the host IS the agent runtime for this
   * execution and already has the result in hand, so there is nothing for an
   * `AgentDispatcher`/`AgentRuntimeAdapter` to do here.
   *
   * Reused by `step()` itself (see above) so the push-based and pull-based paths
   * apply a result identically — one implementation, not two.
   */
  async applyExternalResult(
    context: CoordinatorExecutionContext,
    result: AgentResult,
    stepId?: string,
  ): Promise<void> {
    // The step log is appended BEFORE `context.findings` is replaced below, and is
    // never itself replaced: `context.findings` is the decision engine's gate input
    // (a clean re-run MUST clear it), so it cannot double as the execution's record of
    // what was ever reported. See `ExecutionStepRecord`.
    this.appendStepRecord(context, {
      kind: "AGENT_STEP",
      state: context.execution?.state ?? context.state ?? (result.state as CoordinatorState),
      role: result.agent,
      status: result.status,
      step_id: stepId,
      findings: Array.isArray(result.findings) ? [...result.findings] : [],
      evidence_count: Array.isArray(result.evidence) ? result.evidence.length : 0,
    });
    context.result = result;
    if (Array.isArray(result.findings)) {
      context.findings = result.findings as FindingInput[];
    }
    await this.checkpoint(context, "IN_PROGRESS", result);
  }

  /**
   * Appends the decision to the execution-wide history BEFORE any checkpoint that
   * follows it, so the persisted record can never lag the state it explains. Stores
   * only the compact, scalar form (see `DecisionRecord`).
   */
  private recordDecision(
    context: CoordinatorExecutionContext,
    decision: CoordinatorDecision,
    stepId?: string,
  ): void {
    const log = context.history ?? [];
    const state = context.execution?.state ?? context.state ?? "INTAKE";
    let recorded: DecisionRecord["decision"];
    if (decision.action === "DISPATCH_AGENT") {
      recorded = {
        action: "DISPATCH_AGENT",
        role: decision.role,
        runtime: decision.runtime,
        state: decision.state,
        iteration: decision.iteration,
        remediation_iteration: decision.remediation_iteration,
        ...(stepId !== undefined ? { step_id: stepId } : {}),
      };
    } else {
      recorded = { ...decision };
    }
    context.history = [...log, { step: log.length + 1, state, decision: recorded, timestamp: new Date().toISOString() }];
  }

  private recordHumanIntervention(
    context: CoordinatorExecutionContext,
    decision: RequireHumanInterventionDecision,
  ): void {
    this.appendStepRecord(context, {
      kind: "HUMAN_INTERVENTION",
      state: decision.from ?? context.execution?.state ?? context.state ?? "INTAKE",
      reason: decision.reason,
    });
  }

  private appendStepRecord(
    context: CoordinatorExecutionContext,
    record: Omit<ExecutionStepRecord, "seq" | "recorded_at">,
  ): void {
    const log = context.stepLog ?? [];
    const entry: ExecutionStepRecord = { ...record, seq: log.length + 1, recorded_at: new Date().toISOString() };
    if (entry.step_id === undefined) delete entry.step_id;
    context.stepLog = [...log, entry];
  }

  /**
   * The pull-based counterpart to `step()`/`run()`: evaluates decisions and applies
   * every one that needs no agent work (`TRANSITION`) automatically, exactly as
   * `run()`'s loop would — but the moment a `DISPATCH_AGENT` decision is reached, it
   * returns the request to the caller instead of invoking an `AgentDispatcher`,
   * checkpointing `AWAITING_AGENT_ACTION` so the pending request survives a restart.
   * Terminal decisions (`COMPLETE`/`REQUIRE_HUMAN_INTERVENTION`) are checkpointed and
   * returned exactly as `step()` already does.
   *
   * This is deliberately NOT a second Coordinator: it reuses the same
   * `CoordinatorDecisionEngine`, the same `syncState`/`syncRemediationIteration`
   * helpers, and the same `checkpoint()` method `step()`/`run()` use — the only
   * difference is that a `DISPATCH_AGENT` decision is reported rather than acted on.
   */
  async prepareNextAction(
    context: CoordinatorExecutionContext,
    maxSteps: number = this.maxSteps,
  ): Promise<PreparedAction> {
    for (let i = 0; i < maxSteps; i++) {
      const decision = this.decisionEngine.decide(context);
      // A dispatch is recorded below, once its stepId exists; everything else now.
      if (decision.action !== "DISPATCH_AGENT") this.recordDecision(context, decision);

      switch (decision.action) {
        case "COMPLETE": {
          this.syncState(context, "READY_FOR_PR");
          await this.checkpoint(context, "COMPLETED", undefined, decision.reason);
          return { kind: "TERMINAL", decision };
        }

        case "REQUIRE_HUMAN_INTERVENTION": {
          this.recordHumanIntervention(context, decision);
          this.syncState(context, "HUMAN_INTERVENTION_REQUIRED");
          await this.checkpoint(
            context,
            "HUMAN_INTERVENTION_REQUIRED",
            undefined,
            decision.reason,
            decision.from,
          );
          return { kind: "TERMINAL", decision };
        }

        case "DISPATCH_AGENT": {
          // Enrich + validate exactly as a real dispatch() would (registry-resolved
          // capability/skill metadata, skill-requirement validation) — a pull-mode
          // host must see the identical request a push-mode AgentRuntimeAdapter
          // would, and must be told about a missing required skill before being
          // asked to do undefined work. Throws SkillValidationError exactly as
          // dispatch() does; the caller (src/host/project-run-step.ts) handles it
          // the same way executeProjectRun already does for push-mode.
          const enrichedRequest = await this.dispatcher.prepareRequest(decision.request, decision.runtime);

          const stepId = generateStepId();
          this.recordDecision(context, decision, stepId);
          const pendingAction: PersistedPendingAction = {
            step_id: stepId,
            role: decision.role,
            runtime: decision.runtime,
            request: enrichedRequest,
            requested_at: new Date().toISOString(),
          };
          await this.checkpoint(context, "AWAITING_AGENT_ACTION", undefined, undefined, undefined, pendingAction);
          return {
            kind: "DISPATCH_PENDING",
            stepId,
            request: enrichedRequest,
            runtime: decision.runtime,
            decision,
          };
        }

        case "TRANSITION": {
          this.syncState(context, decision.to);
          if (decision.remediation_iteration !== undefined) {
            this.syncRemediationIteration(context, decision.remediation_iteration);
          }
          context.result = undefined;
          context.gateStatus = undefined;
          await this.checkpoint(context, "IN_PROGRESS");
          continue;
        }

        default: {
          const unexpected = decision as { action?: string };
          throw new Error(`Unexpected coordinator decision action: ${unexpected.action}`);
        }
      }
    }

    throw new Error(
      `prepareNextAction exceeded maximum step limit of ${maxSteps} steps without requiring agent action or reaching a terminal state.`,
    );
  }

  /**
   * Runs the coordinator execution loop until a terminal state is reached
   * (READY_FOR_PR or HUMAN_INTERVENTION_REQUIRED) or maxSteps is exceeded.
   */
  async run(context: CoordinatorExecutionContext): Promise<CoordinatorRunResult> {
    const history: StepRecord[] = [];
    let stepsCount = 0;

    // Initial checkpoint when execution starts
    await this.checkpoint(context, "IN_PROGRESS");

    try {
      while (stepsCount < this.maxSteps) {
        stepsCount++;
        const currentState = this.getCurrentState(context);

        const stepResult = await this.step(context);

        const record: StepRecord = {
          step: stepsCount,
          state: currentState,
          decision: stepResult.decision,
          result: stepResult.result,
          timestamp: new Date().toISOString(),
        };

        history.push(record);

        if (this.onStep) {
          await this.onStep(record);
        }

        if (stepResult.terminal) {
          if (stepResult.decision.action === "COMPLETE") {
            return {
              status: "COMPLETED",
              state: "READY_FOR_PR",
              context,
              history,
              stepsCount,
              terminalDecision: stepResult.decision,
            };
          }

          if (stepResult.decision.action === "REQUIRE_HUMAN_INTERVENTION") {
            return {
              status: "HUMAN_INTERVENTION_REQUIRED",
              state: "HUMAN_INTERVENTION_REQUIRED",
              context,
              history,
              stepsCount,
              terminalDecision: stepResult.decision,
            };
          }
        }
      }

      throw new Error(
        `Coordinator execution exceeded maximum step limit of ${this.maxSteps} steps. Terminal state was not reached.`,
      );
    } catch (err) {
      await this.checkpoint(context, "FAILED", undefined, (err as Error).message);
      throw err;
    }
  }

  private getCurrentState(context: CoordinatorExecutionContext): CoordinatorState {
    const rawState = context.execution?.state ?? context.state;
    if (!rawState) {
      throw new Error("Execution context missing state");
    }
    return rawState;
  }

  private syncState(context: CoordinatorExecutionContext, state: CoordinatorState): void {
    context.state = state;
    if (context.execution) {
      context.execution.state = state;
    }
  }

  private syncRemediationIteration(
    context: CoordinatorExecutionContext,
    remediationIteration: number,
  ): void {
    context.remediation_iteration = remediationIteration;
    if (context.execution) {
      context.execution.remediation_iteration = remediationIteration;
    }
  }
}
