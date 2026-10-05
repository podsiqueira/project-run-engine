// packages/project-run-engine/src/coordinator/coordinator.ts

import type {
  AgentDispatchRequest,
  AgentResult,
  AgentRuntime,
  CoordinatorState,
  StructuredFinding,
} from "../domain/types.js";
import type {
  CoordinatorDecision,
  CoordinatorExecutionContext,
  CompleteDecision,
  FindingInput,
  RequireHumanInterventionDecision,
} from "../decision/types.js";
import { CoordinatorDecisionEngine } from "../decision/decision-engine.js";
import { AgentDispatcher } from "../agents/agent-dispatcher.js";
import type {
  ExecutionLifecycleState,
  ExecutionStateStore,
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
  stepsCount: number;
  terminalDecision: CompleteDecision | RequireHumanInterventionDecision;
}

export interface CoordinatorStepResult {
  decision: CoordinatorDecision;
  result?: AgentResult;
  terminal: boolean;
}

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
        findings: (context.result?.findings ?? context.findings) as (StructuredFinding | unknown)[] | undefined,
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

        // Store result in context so next iteration has outcome for transition evaluation
        context.result = result;
        if (Array.isArray(result.findings)) {
          context.findings = result.findings as FindingInput[];
        }

        await this.checkpoint(context, "IN_PROGRESS", result);

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
