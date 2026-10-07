// packages/project-run-engine/src/decision/types.ts

import type {
  AgentRole,
  AgentRuntime,
  AgentCapability,
  AgentDispatchRequest,
  AgentResult,
  AgentSkillRequirement,
  CoordinatorState,
  ExecutionStepRecord,
  HostExecutionOptions,
  RoleSkillMetadata,
} from "../domain/types.js";
import type { HumanAnswerRecord } from "./human-intervention.js";

export type CoordinatorDecisionAction =
  | "DISPATCH_AGENT"
  | "TRANSITION"
  | "COMPLETE"
  | "REQUIRE_HUMAN_INTERVENTION";

export interface DispatchAgentDecision {
  action: "DISPATCH_AGENT";
  role: AgentRole;
  runtime: AgentRuntime;
  state: CoordinatorState;
  execution_id: string;
  feature: string;
  branch: string;
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
  request: AgentDispatchRequest;
}

export interface TransitionDecision {
  action: "TRANSITION";
  from: CoordinatorState;
  to: CoordinatorState;
  reason?: string;
  remediation_iteration?: number;
}

export interface CompleteDecision {
  action: "COMPLETE";
  state: "READY_FOR_PR";
  reason: string;
}

export interface RequireHumanInterventionDecision {
  action: "REQUIRE_HUMAN_INTERVENTION";
  state: "HUMAN_INTERVENTION_REQUIRED";
  from?: CoordinatorState;
  reason: string;
}

export type CoordinatorDecision =
  | DispatchAgentDecision
  | TransitionDecision
  | CompleteDecision
  | RequireHumanInterventionDecision;

export interface ExecutionIdentity {
  id?: string;
  execution_id?: string;
  feature?: string;
  branch?: string;
  state: CoordinatorState;
  iteration?: number;
  remediation_iteration?: number;
}

export interface FindingInput {
  id?: string;
  severity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | string;
  status?: "OPEN" | "IN_REMEDIATION" | "RESOLVED" | "ACCEPTED" | string;
  category?: string;
  [key: string]: unknown;
}

export interface CoordinatorExecutionContext {
  execution?: ExecutionIdentity;
  execution_id?: string;
  feature?: string;
  branch?: string;
  state?: CoordinatorState;
  iteration?: number;
  remediation_iteration?: number;

  runtime?: AgentRuntime;
  context?: unknown;
  result?: AgentResult | {
    status: string;
    findings?: FindingInput[];
    evidence?: unknown[];
    [key: string]: unknown;
  };
  gateStatus?: "PASS" | "FAIL" | "PENDING" | "BLOCKED";
  findings?: FindingInput[];
  /**
   * Explicit host override to force CLARIFY into HUMAN_INTERVENTION_REQUIRED.
   * This is NOT the primary signal: the decision engine always derives blocking
   * ambiguity from `findings`/`result.findings` via `hasBlockingFindings()`, the
   * same mechanism every other blocking gate (ANALYZE, INDEPENDENT_REVIEW,
   * RE_REVIEW, CONVERGE) uses. Set this only when a host needs to force the gate
   * for a reason that cannot be expressed as a StructuredFinding.
   */
  blockingAmbiguity?: boolean;
  /**
   * Explicit host override to force ANALYZE into HUMAN_INTERVENTION_REQUIRED.
   * Same caveat as `blockingAmbiguity` above: `hasBlockingFindings()` is the
   * primary signal and already derives this from `findings`/`result.findings`.
   */
  blockingFindings?: boolean;
  human_approved?: boolean;
  human_resolved?: boolean;
  /**
   * The running, append-only record of every human answer supplied so far across
   * this execution's resumes. Carried forward on the context object (not cleared on
   * TRANSITION, unlike `result`/`gateStatus`) purely so `Coordinator.checkpoint()`
   * can keep re-persisting it on every subsequent checkpoint of this run — the
   * state store itself has no merge-on-save semantics, so whatever isn't present
   * on the context at checkpoint time would otherwise be dropped from the file.
   */
  humanAnswers?: HumanAnswerRecord[];
  /**
   * The running, append-only step log (see `ExecutionStepRecord`). Carried on the
   * context for the same reason as `humanAnswers`: the state store overwrites the
   * whole record on every save, so whatever isn't on the context at checkpoint time
   * would be dropped. Never read by the decision engine — gates use `findings`/`result`.
   */
  stepLog?: ExecutionStepRecord[];
  executionOptions?: HostExecutionOptions;
}

