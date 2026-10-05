// packages/project-run-engine/src/decision/decision-engine.ts

import type {
  AgentRole,
  AgentRuntime,
  AgentCapability,
  AgentDispatchRequest,
  CoordinatorState,
  RoleSkillMetadata,
  StructuredFinding,
} from "../domain/types.js";
import type { WorkflowPreset } from "../presets/types.js";
import { SpecKitV1Preset } from "../presets/spec-kit-preset.js";
import type {
  CoordinatorDecision,
  CoordinatorExecutionContext,
  DispatchAgentDecision,
  TransitionDecision,
  CompleteDecision,
  RequireHumanInterventionDecision,
} from "./types.js";

export const MAX_REMEDIATION_ITERATIONS = 3;

const DEFAULT_VALID_STATES = new Set<CoordinatorState>([
  "INTAKE",
  "SPECIFY",
  "CLARIFY",
  "PLAN",
  "TASKS",
  "ANALYZE",
  "IMPLEMENT",
  "INDEPENDENT_REVIEW",
  "REMEDIATION",
  "RE_REVIEW",
  "CONVERGE",
  "READY_FOR_PR",
  "HUMAN_INTERVENTION_REQUIRED",
]);

const DEFAULT_ALLOWED_TRANSITIONS: ReadonlyMap<CoordinatorState, ReadonlySet<CoordinatorState>> = new Map([
  ["INTAKE", new Set<CoordinatorState>(["SPECIFY", "HUMAN_INTERVENTION_REQUIRED"])],
  ["SPECIFY", new Set<CoordinatorState>(["CLARIFY", "HUMAN_INTERVENTION_REQUIRED"])],
  ["CLARIFY", new Set<CoordinatorState>(["PLAN", "HUMAN_INTERVENTION_REQUIRED"])],
  ["PLAN", new Set<CoordinatorState>(["TASKS", "HUMAN_INTERVENTION_REQUIRED"])],
  ["TASKS", new Set<CoordinatorState>(["ANALYZE", "HUMAN_INTERVENTION_REQUIRED"])],
  ["ANALYZE", new Set<CoordinatorState>(["IMPLEMENT", "HUMAN_INTERVENTION_REQUIRED"])],
  ["IMPLEMENT", new Set<CoordinatorState>(["INDEPENDENT_REVIEW", "HUMAN_INTERVENTION_REQUIRED"])],
  ["INDEPENDENT_REVIEW", new Set<CoordinatorState>(["CONVERGE", "REMEDIATION", "HUMAN_INTERVENTION_REQUIRED"])],
  ["REMEDIATION", new Set<CoordinatorState>(["RE_REVIEW", "HUMAN_INTERVENTION_REQUIRED"])],
  ["RE_REVIEW", new Set<CoordinatorState>(["CONVERGE", "REMEDIATION", "HUMAN_INTERVENTION_REQUIRED"])],
  ["CONVERGE", new Set<CoordinatorState>(["READY_FOR_PR", "REMEDIATION", "HUMAN_INTERVENTION_REQUIRED"])],
  ["READY_FOR_PR", new Set<CoordinatorState>()],
  ["HUMAN_INTERVENTION_REQUIRED", new Set<CoordinatorState>()],
]);

const DEFAULT_STATE_TO_ROLE: ReadonlyMap<CoordinatorState, AgentRole> = new Map([
  ["SPECIFY", "SPECIFICATION"],
  ["CLARIFY", "SPECIFICATION"],
  ["PLAN", "ARCHITECTURE"],
  ["TASKS", "ARCHITECTURE"],
  ["ANALYZE", "ARCHITECTURE"],
  ["IMPLEMENT", "IMPLEMENTATION"],
  ["INDEPENDENT_REVIEW", "INDEPENDENT_REVIEW"],
  ["REMEDIATION", "REMEDIATION"],
  ["RE_REVIEW", "INDEPENDENT_REVIEW"],
  ["CONVERGE", "CONVERGENCE"],
]);

export interface CoordinatorDecisionEngineOptions {
  preset?: WorkflowPreset;
  maxRemediationIterations?: number;
}

function defaultGetExpectedOutput(state: CoordinatorState): {
  status: string;
  evidence_required: boolean;
} {
  switch (state) {
    case "INDEPENDENT_REVIEW":
    case "RE_REVIEW":
    case "CONVERGE":
      return { status: "PASS_OR_FINDINGS", evidence_required: true };
    default:
      return { status: "PASS", evidence_required: true };
  }
}

/**
 * Evaluates whether an individual finding is actionable (open and requires tracking).
 *
 * Rules:
 * 1. Resolved or accepted findings are non-actionable (status: "RESOLVED" | "ACCEPTED").
 * 2. Explicit advisory findings are non-actionable (severity: "ADVISORY" | advisory: true).
 * 3. All other open findings (CRITICAL, HIGH, MEDIUM, LOW) are actionable.
 */
export function isFindingActionable(finding: unknown): boolean {
  if (!finding || typeof finding !== "object") return false;
  const f = finding as Partial<StructuredFinding>;

  // If explicitly resolved or accepted, it is not actionable
  if (f.status === "RESOLVED" || f.status === "ACCEPTED") {
    return false;
  }

  // If explicit advisory finding (severity: "ADVISORY" or advisory: true)
  if (
    (f.severity as string) === "ADVISORY" ||
    (f as { advisory?: boolean }).advisory === true
  ) {
    return false;
  }

  // All open findings (CRITICAL, HIGH, MEDIUM, LOW, or unspecified) are actionable
  return true;
}

/**
 * Evaluates whether an individual finding is blocking (halts the workflow or forces remediation).
 *
 * Rules:
 * 1. Non-actionable findings (resolved, accepted, advisory) are NEVER blocking.
 * 2. If the finding explicitly defines `blocking`, its boolean value is authoritative.
 * 3. Otherwise, based on standard severity:
 *    - CRITICAL, HIGH, MEDIUM: blocking (true).
 *    - LOW: non-blocking (false). LOW findings are actionable/observable, but do not
 *      force the workflow into remediation or premature human intervention.
 *    - Unspecified severity on an open finding defaults to blocking (true).
 */
export function isFindingBlocking(finding: unknown): boolean {
  if (!isFindingActionable(finding)) {
    return false;
  }

  const f = finding as Partial<StructuredFinding>;

  if (typeof f.blocking === "boolean") {
    return f.blocking;
  }

  const severity = (f.severity as string | undefined)?.toUpperCase();
  if (severity === "LOW" || severity === "ADVISORY") {
    return false;
  }

  // CRITICAL, HIGH, MEDIUM, or unspecified default to blocking
  return true;
}

export function hasActionableFindings(context: CoordinatorExecutionContext): boolean {
  const checkList = (list: unknown[] | undefined): boolean => {
    if (!Array.isArray(list) || list.length === 0) return false;
    return list.some(isFindingActionable);
  };

  if (context.result) {
    if (Array.isArray(context.result.findings)) {
      if (context.result.findings.length > 0) {
        return checkList(context.result.findings as unknown[]);
      }
      if (context.result.status !== "FINDINGS") {
        return false;
      }
    }
    if (context.result.status === "FINDINGS") {
      return true;
    }
  }

  if (Array.isArray(context.findings) && context.findings.length > 0) {
    return checkList(context.findings as unknown[]);
  }

  return false;
}

export function hasBlockingFindings(context: CoordinatorExecutionContext): boolean {
  const checkList = (list: unknown[] | undefined): boolean => {
    if (!Array.isArray(list) || list.length === 0) return false;
    return list.some(isFindingBlocking);
  };

  if (context.result) {
    if (Array.isArray(context.result.findings)) {
      if (context.result.findings.length > 0) {
        return checkList(context.result.findings as unknown[]);
      }
      if (context.result.status !== "FINDINGS") {
        return false;
      }
    }
    if (context.result.status === "FINDINGS") {
      return true;
    }
  }

  if (Array.isArray(context.findings) && context.findings.length > 0) {
    return checkList(context.findings as unknown[]);
  }

  return false;
}

/**
 * Pure, deterministic Decision Engine for the V1 Coordinator.
 *
 * Interprets the current execution state and context and returns the next
 * orchestration action without performing any execution, side effects,
 * network requests, or direct LLM calls.
 *
 * Fully preset-agnostic: relies on an injected or default WorkflowPreset
 * (such as SpecKitV1Preset) without hardcoding workflow specifics into the core engine.
 */
export class CoordinatorDecisionEngine {
  private readonly preset: WorkflowPreset;
  private readonly maxRemediationIterations: number;
  private readonly validStates: ReadonlySet<CoordinatorState>;
  private readonly allowedTransitions: ReadonlyMap<CoordinatorState, ReadonlySet<CoordinatorState>>;
  private readonly stateToRole: ReadonlyMap<CoordinatorState, AgentRole>;

  constructor(options?: CoordinatorDecisionEngineOptions) {
    this.preset = options?.preset ?? SpecKitV1Preset;
    this.maxRemediationIterations =
      options?.maxRemediationIterations ?? MAX_REMEDIATION_ITERATIONS;
    this.validStates = this.preset.validStates ?? DEFAULT_VALID_STATES;
    this.allowedTransitions =
      this.preset.allowedTransitions ?? DEFAULT_ALLOWED_TRANSITIONS;
    this.stateToRole = this.preset.stateToRole ?? DEFAULT_STATE_TO_ROLE;
  }

  /**
   * Evaluates the execution context and returns the next orchestration decision.
   */
  decide(context: CoordinatorExecutionContext): CoordinatorDecision {
    const state = this.normalizeState(context);

    if (state === "READY_FOR_PR") {
      return this.resolveTransition(context);
    }

    if (state === "HUMAN_INTERVENTION_REQUIRED") {
      return this.resolveTransition(context);
    }

    if (state === "INTAKE") {
      return this.resolveTransition(context);
    }

    // If an execution outcome (result, gateStatus, or blocking condition) is present,
    // evaluate the state transition. Otherwise, decide agent dispatch.
    const hasOutcome =
      context.result !== undefined ||
      context.gateStatus !== undefined ||
      context.blockingAmbiguity !== undefined ||
      context.blockingFindings !== undefined;

    if (hasOutcome) {
      return this.resolveTransition(context);
    }

    return this.resolveDispatch(context);
  }

  /**
   * Resolves the agent dispatch decision for the active state.
   */
  resolveDispatch(context: CoordinatorExecutionContext): DispatchAgentDecision {
    const state = this.normalizeState(context);

    if (state === "READY_FOR_PR" || state === "HUMAN_INTERVENTION_REQUIRED") {
      throw new Error(`Cannot dispatch agent in terminal state: ${state}`);
    }

    if (state === "INTAKE") {
      throw new Error("Cannot dispatch agent in INTAKE state: no agent is mapped to INTAKE");
    }

    const role = this.stateToRole.get(state);
    if (!role) {
      throw new Error(`No agent role mapped for state: ${state}`);
    }

    const executionId =
      context.execution?.execution_id ??
      context.execution?.id ??
      context.execution_id ??
      "";
    const feature = context.execution?.feature ?? context.feature ?? "";
    const branch = context.execution?.branch ?? context.branch ?? "";
    const iteration = context.execution?.iteration ?? context.iteration ?? 1;
    const remediationIteration =
      context.execution?.remediation_iteration ?? context.remediation_iteration ?? 0;
    const runtime: AgentRuntime = context.runtime ?? "ANTIGRAVITY";

    const expectedOutput = this.preset.getExpectedOutput
      ? this.preset.getExpectedOutput(state)
      : defaultGetExpectedOutput(state);

    const skillConfig = this.preset.getStateSkillConfig?.(state);
    const skill = skillConfig?.skill;
    const capability = skillConfig?.capability ?? skillConfig?.metadata?.workflow;
    const skillMetadata = skillConfig?.metadata;
    const roleSkills = this.preset.getSkillsForRole ? this.preset.getSkillsForRole(role) : [];
    const skillsList = roleSkills.length > 0 ? [...roleSkills] : undefined;

    const request: AgentDispatchRequest = {
      execution_id: executionId,
      feature,
      branch,
      state,
      role,
      iteration,
      remediation_iteration: remediationIteration,
      context: context.context ?? {},
      expected_output: expectedOutput,
      capability,
      skill,
      skills: skillsList,
      required_skills: skillsList,
      skill_metadata: skillMetadata,
      options: context.executionOptions,
    };

    return {
      action: "DISPATCH_AGENT",
      role,
      runtime,
      state,
      execution_id: executionId,
      feature,
      branch,
      iteration,
      remediation_iteration: remediationIteration,
      context: context.context ?? {},
      expected_output: expectedOutput,
      capability,
      skill,
      skills: skillsList,
      required_skills: skillsList,
      skill_metadata: skillMetadata,
      options: context.executionOptions,
      request,
    };
  }

  /**
   * Resolves the state transition or control decision based on execution results or gate outcomes.
   */
  resolveTransition(
    context: CoordinatorExecutionContext,
  ): TransitionDecision | CompleteDecision | RequireHumanInterventionDecision {
    if (this.preset.resolveTransition) {
      const presetDecision = this.preset.resolveTransition(context);
      if (presetDecision) {
        return presetDecision;
      }
    }

    const state = this.normalizeState(context);
    const remediationIteration =
      context.execution?.remediation_iteration ?? context.remediation_iteration ?? 0;

    switch (state) {
      case "READY_FOR_PR":
        return {
          action: "COMPLETE",
          state: "READY_FOR_PR",
          reason: "Feature development completed and ready for PR",
        };

      case "HUMAN_INTERVENTION_REQUIRED":
        return {
          action: "REQUIRE_HUMAN_INTERVENTION",
          state: "HUMAN_INTERVENTION_REQUIRED",
          reason: "Workflow is in terminal human intervention state",
        };

      case "INTAKE": {
        const executionId =
          context.execution?.execution_id ??
          context.execution?.id ??
          context.execution_id ??
          "";
        const feature = context.execution?.feature ?? context.feature ?? "";
        const branch = context.execution?.branch ?? context.branch ?? "";

        if (!executionId.trim() || !feature.trim() || !branch.trim()) {
          return {
            action: "REQUIRE_HUMAN_INTERVENTION",
            state: "HUMAN_INTERVENTION_REQUIRED",
            from: "INTAKE",
            reason: "Invalid execution context in INTAKE: missing required fields",
          };
        }

        return {
          action: "TRANSITION",
          from: "INTAKE",
          to: "SPECIFY",
          reason: "Intake context validated",
        };
      }

      case "SPECIFY":
        return {
          action: "TRANSITION",
          from: "SPECIFY",
          to: "CLARIFY",
          reason: "Specification gate passed",
        };

      case "CLARIFY":
        // Blocking ambiguity is represented the same way every other blocking
        // condition in this state machine is represented: as a StructuredFinding
        // on the agent result (see ANALYZE below, and INDEPENDENT_REVIEW/RE_REVIEW/
        // CONVERGE). `context.blockingAmbiguity` remains a supported explicit
        // override for a host that wants to force the gate, but it must never be
        // the ONLY path to detecting a blocking condition — a finding the
        // Specification agent actually returned must never be lost here.
        if (context.blockingAmbiguity || hasBlockingFindings(context)) {
          return {
            action: "REQUIRE_HUMAN_INTERVENTION",
            from: "CLARIFY",
            state: "HUMAN_INTERVENTION_REQUIRED",
            reason: "Blocking ambiguity cannot be resolved automatically",
          };
        }
        return {
          action: "TRANSITION",
          from: "CLARIFY",
          to: "PLAN",
          reason: "Clarification complete",
        };

      case "PLAN":
        return {
          action: "TRANSITION",
          from: "PLAN",
          to: "TASKS",
          reason: "Planning gate passed",
        };

      case "TASKS":
        return {
          action: "TRANSITION",
          from: "TASKS",
          to: "ANALYZE",
          reason: "Tasks gate passed",
        };

      case "ANALYZE":
        if (context.blockingFindings || hasBlockingFindings(context)) {
          return {
            action: "REQUIRE_HUMAN_INTERVENTION",
            from: "ANALYZE",
            state: "HUMAN_INTERVENTION_REQUIRED",
            reason: "Blocking analysis findings detected",
          };
        }
        return {
          action: "TRANSITION",
          from: "ANALYZE",
          to: "IMPLEMENT",
          reason: "Analyze gate passed without blocking findings",
        };

      case "IMPLEMENT":
        return {
          action: "TRANSITION",
          from: "IMPLEMENT",
          to: "INDEPENDENT_REVIEW",
          reason: "Implementation gate passed",
        };

      case "INDEPENDENT_REVIEW":
        if (hasBlockingFindings(context)) {
          return {
            action: "TRANSITION",
            from: "INDEPENDENT_REVIEW",
            to: "REMEDIATION",
            reason: "Review findings require remediation",
          };
        }
        return {
          action: "TRANSITION",
          from: "INDEPENDENT_REVIEW",
          to: "CONVERGE",
          reason: "Independent review passed",
        };

      case "REMEDIATION":
        return {
          action: "TRANSITION",
          from: "REMEDIATION",
          to: "RE_REVIEW",
          reason: "Remediation complete; re-review required",
        };

      case "RE_REVIEW":
        if (hasBlockingFindings(context)) {
          if (remediationIteration < this.maxRemediationIterations) {
            return {
              action: "TRANSITION",
              from: "RE_REVIEW",
              to: "REMEDIATION",
              reason: "Re-review found findings; starting next remediation iteration",
              remediation_iteration: remediationIteration + 1,
            };
          }
          return {
            action: "REQUIRE_HUMAN_INTERVENTION",
            from: "RE_REVIEW",
            state: "HUMAN_INTERVENTION_REQUIRED",
            reason: `Maximum remediation iterations reached (${this.maxRemediationIterations})`,
          };
        }
        return {
          action: "TRANSITION",
          from: "RE_REVIEW",
          to: "CONVERGE",
          reason: "Independent re-review passed",
        };

      case "CONVERGE":
        if (hasBlockingFindings(context) || context.result?.status === "FAIL") {
          if (remediationIteration < this.maxRemediationIterations) {
            return {
              action: "TRANSITION",
              from: "CONVERGE",
              to: "REMEDIATION",
              reason: "Convergence findings require remediation",
              remediation_iteration: remediationIteration + 1,
            };
          }
          return {
            action: "REQUIRE_HUMAN_INTERVENTION",
            from: "CONVERGE",
            state: "HUMAN_INTERVENTION_REQUIRED",
            reason: `Maximum remediation iterations reached (${this.maxRemediationIterations})`,
          };
        }
        return {
          action: "TRANSITION",
          from: "CONVERGE",
          to: "READY_FOR_PR",
          reason: "Convergence gate passed",
        };
    }
  }

  /**
   * Validates whether a direct transition from one state to another is allowed
   * by the formal state machine transition matrix.
   */
  isTransitionAllowed(from: CoordinatorState, to: CoordinatorState): boolean {
    if (!this.validStates.has(from) || !this.validStates.has(to)) {
      return false;
    }

    const allowed = this.allowedTransitions.get(from);
    return allowed ? allowed.has(to) : false;
  }

  private normalizeState(context: CoordinatorExecutionContext): CoordinatorState {
    const rawState = context.execution?.state ?? context.state;
    if (!rawState || !this.validStates.has(rawState)) {
      throw new Error(`Unsupported or invalid coordinator state: ${rawState}`);
    }
    return rawState;
  }
}
