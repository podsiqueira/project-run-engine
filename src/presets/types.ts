// packages/project-run-engine/src/presets/types.ts

import type {
  AgentCapability,
  AgentRole,
  AgentSkill,
  CoordinatorState,
  RoleSkillMetadata,
} from "../domain/types.js";
import type {
  CoordinatorExecutionContext,
  TransitionDecision,
  CompleteDecision,
  RequireHumanInterventionDecision,
} from "../decision/types.js";

/**
 * Generic contract for a workflow preset.
 *
 * A workflow preset defines the methodology-specific contracts (e.g. Spec-Kit V1,
 * Agile Feature, Bug Triage) including role mappings, skill requirements,
 * state metadata, and optional custom transition evaluation, without hardcoding
 * them into the core Coordinator or Decision Engine.
 */
export interface WorkflowPreset {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly validStates?: ReadonlySet<CoordinatorState>;
  readonly allowedTransitions?: ReadonlyMap<CoordinatorState, ReadonlySet<CoordinatorState>>;
  readonly stateToRole?: ReadonlyMap<CoordinatorState, AgentRole>;
  getExpectedOutput?(state: CoordinatorState): { status: string; evidence_required: boolean };
  getStateSkillConfig?(state: CoordinatorState): {
    skill?: string;
    capability?: AgentCapability | string;
    metadata?: RoleSkillMetadata;
  } | undefined;
  getSkillsForRole?(role: AgentRole): AgentSkill[];
  resolveTransition?(
    context: CoordinatorExecutionContext,
  ): TransitionDecision | CompleteDecision | RequireHumanInterventionDecision | undefined;
}
