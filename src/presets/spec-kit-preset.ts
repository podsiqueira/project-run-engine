// packages/project-run-engine/src/presets/spec-kit-preset.ts

import type {
  AgentCapability,
  AgentRole,
  AgentSkill,
  CoordinatorState,
  RoleSkillMetadata,
} from "../domain/types.js";
import type { WorkflowPreset } from "./types.js";

/**
 * Spec Kit skill definitions mapped directly from validated repository skills
 * located in .agents/skills/ and Spec Kit documentation.
 *
 * All definitions are completely provider-agnostic and runtime-agnostic.
 * They describe processes, capabilities, execution ordering, and evidence requirements,
 * without binding to any LLM, API, CLI, or host environment.
 *
 * Note: The engine validates that these skills exist locally in the project,
 * but does NOT automatically download them.
 */

export const SPECKIT_SPECIFY_SKILL: AgentSkill = {
  id: "speckit-specify",
  name: "Spec Kit Specify",
  description: "Creates or updates the feature specification from a natural language feature description.",
  capability: "spec-kit/specify",
  required: true,
  execution_order: 1,
  workflow: "spec-kit/specify",
};

export const SPECKIT_CLARIFY_SKILL: AgentSkill = {
  id: "speckit-clarify",
  name: "Spec Kit Clarify",
  description: "Identifies underspecified areas in the feature spec by asking targeted clarification questions and encoding answers back into the spec.",
  capability: "spec-kit/clarify",
  required: false,
  execution_order: 2,
  workflow: "spec-kit/clarify",
};

export const SPECKIT_PLAN_SKILL: AgentSkill = {
  id: "speckit-plan",
  name: "Spec Kit Plan",
  description: "Executes the implementation planning workflow using the plan template to generate design artifacts.",
  capability: "spec-kit/plan",
  required: true,
  execution_order: 1,
  workflow: "spec-kit/plan",
};

export const SPECKIT_TASKS_SKILL: AgentSkill = {
  id: "speckit-tasks",
  name: "Spec Kit Tasks",
  description: "Generates an actionable, dependency-ordered tasks.md for the feature based on available design artifacts.",
  capability: "spec-kit/tasks",
  required: true,
  execution_order: 2,
  workflow: "spec-kit/tasks",
};

export const SPECKIT_ANALYZE_SKILL: AgentSkill = {
  id: "speckit-analyze",
  name: "Spec Kit Analyze",
  description: "Performs non-destructive cross-artifact consistency and quality analysis across spec.md, plan.md, and tasks.md.",
  capability: "spec-kit/analyze",
  required: true,
  execution_order: 3,
  workflow: "spec-kit/analyze",
};

export const SPECKIT_IMPLEMENT_SKILL: AgentSkill = {
  id: "speckit-implement",
  name: "Spec Kit Implement",
  description: "Executes the implementation plan by processing and executing all tasks defined in tasks.md.",
  capability: "spec-kit/implement",
  required: true,
  execution_order: 1,
  workflow: "spec-kit/implement",
};

export const SPECKIT_INDEPENDENT_REVIEW_SKILL: AgentSkill = {
  id: "speckit-analyze",
  name: "Spec Kit Independent Review",
  description: "Performs independent review and verification against requirements, architecture plan, and quality contracts.",
  capability: "spec-kit/independent-review",
  required: true,
  execution_order: 1,
  workflow: "spec-kit/independent-review",
};

export const SPECKIT_BUG_ASSESS_SKILL: AgentSkill = {
  id: "speckit-bug-assess",
  name: "Spec Kit Bug Assess",
  description: "Assesses a bug report against the codebase and produces an assessment with possible remediation.",
  capability: "spec-kit/bug-assess",
  required: true,
  execution_order: 1,
  workflow: "spec-kit/bug-assess",
};

export const SPECKIT_BUG_FIX_SKILL: AgentSkill = {
  id: "speckit-bug-fix",
  name: "Spec Kit Bug Fix",
  description: "Applies remediation from bug assessment, capturing root cause, fix, and validation evidence.",
  capability: "spec-kit/bugfix",
  required: true,
  execution_order: 2,
  workflow: "spec-kit/bugfix",
  evidenceRequirements: [
    "finding",
    "root_cause",
    "correction",
    "validation_performed",
    "remaining_risks",
  ],
};

export const SPECKIT_BUG_TEST_SKILL: AgentSkill = {
  id: "speckit-bug-test",
  name: "Spec Kit Bug Test",
  description: "Validates that a previously fixed bug is resolved and records the verification report.",
  capability: "spec-kit/bug-test",
  required: true,
  execution_order: 3,
  workflow: "spec-kit/bug-test",
};

export const SPECKIT_CONVERGE_SKILL: AgentSkill = {
  id: "speckit-converge",
  name: "Spec Kit Converge",
  description: "Assesses current codebase against spec, plan, and tasks, appending any unbuilt work as new tasks.",
  capability: "spec-kit/converge",
  required: true,
  execution_order: 1,
  workflow: "spec-kit/converge",
};

/**
 * Authoritative role-to-skills mapping for Spec-Kit preset.
 */
export const SPEC_KIT_ROLE_SKILLS_MAP: Readonly<Record<string, readonly AgentSkill[]>> = {
  SPECIFICATION: [
    SPECKIT_SPECIFY_SKILL,
    SPECKIT_CLARIFY_SKILL,
  ],
  ARCHITECTURE: [
    SPECKIT_PLAN_SKILL,
    SPECKIT_TASKS_SKILL,
    SPECKIT_ANALYZE_SKILL,
  ],
  IMPLEMENTATION: [
    SPECKIT_IMPLEMENT_SKILL,
  ],
  INDEPENDENT_REVIEW: [
    SPECKIT_INDEPENDENT_REVIEW_SKILL,
  ],
  REMEDIATION: [
    SPECKIT_BUG_ASSESS_SKILL,
    SPECKIT_BUG_FIX_SKILL,
    SPECKIT_BUG_TEST_SKILL,
  ],
  CONVERGENCE: [
    SPECKIT_CONVERGE_SKILL,
  ],
};

export const ROLE_SKILLS_MAP = SPEC_KIT_ROLE_SKILLS_MAP;

export interface StateSkillConfig {
  skill: string;
  capability: AgentCapability;
  metadata: RoleSkillMetadata;
}

export const SPEC_KIT_STATE_SKILL_MAP: ReadonlyMap<CoordinatorState, StateSkillConfig> = new Map([
  [
    "SPECIFY",
    {
      skill: "speckit-specify",
      capability: "spec-kit/specify",
      metadata: {
        skill: "speckit-specify",
        workflow: "spec-kit/specify",
        capability: "spec-kit/specify",
        description: "Creates feature specification using Spec Kit specify workflow.",
      },
    },
  ],
  [
    "CLARIFY",
    {
      skill: "speckit-clarify",
      capability: "spec-kit/clarify",
      metadata: {
        skill: "speckit-clarify",
        workflow: "spec-kit/clarify",
        capability: "spec-kit/clarify",
        description: "Resolves ambiguities using Spec Kit clarify workflow.",
      },
    },
  ],
  [
    "PLAN",
    {
      skill: "speckit-plan",
      capability: "spec-kit/plan",
      metadata: {
        skill: "speckit-plan",
        workflow: "spec-kit/plan",
        capability: "spec-kit/plan",
        description: "Creates architectural plan using Spec Kit plan workflow.",
      },
    },
  ],
  [
    "TASKS",
    {
      skill: "speckit-tasks",
      capability: "spec-kit/tasks",
      metadata: {
        skill: "speckit-tasks",
        workflow: "spec-kit/tasks",
        capability: "spec-kit/tasks",
        description: "Generates implementation tasks using Spec Kit tasks workflow.",
      },
    },
  ],
  [
    "ANALYZE",
    {
      skill: "speckit-analyze",
      capability: "spec-kit/analyze",
      metadata: {
        skill: "speckit-analyze",
        workflow: "spec-kit/analyze",
        capability: "spec-kit/analyze",
        description: "Validates consistency across spec, plan, and tasks using Spec Kit analyze workflow.",
      },
    },
  ],
  [
    "IMPLEMENT",
    {
      skill: "speckit-implement",
      capability: "spec-kit/implement",
      metadata: {
        skill: "speckit-implement",
        workflow: "spec-kit/implement",
        capability: "spec-kit/implement",
        description: "Executes implementation tasks and produces technical evidence.",
      },
    },
  ],
  [
    "INDEPENDENT_REVIEW",
    {
      skill: "speckit-analyze",
      capability: "spec-kit/independent-review",
      metadata: {
        skill: "speckit-analyze",
        workflow: "spec-kit/independent-review",
        capability: "spec-kit/independent-review",
        description: "Independently reviews implementation against spec, plan, and contracts.",
      },
    },
  ],
  [
    "REMEDIATION",
    {
      skill: "speckit-bug-fix",
      capability: "spec-kit/bugfix",
      metadata: {
        skill: "speckit-bug-fix",
        workflow: "spec-kit/bugfix",
        capability: "spec-kit/bugfix",
        description: "Executes Spec Kit bugfix workflow: captures finding, root cause, correction, validation, and risks.",
        evidenceRequirements: [
          "finding",
          "root_cause",
          "correction",
          "validation_performed",
          "remaining_risks",
        ],
      },
    },
  ],
  [
    "RE_REVIEW",
    {
      skill: "speckit-analyze",
      capability: "spec-kit/independent-review",
      metadata: {
        skill: "speckit-analyze",
        workflow: "spec-kit/independent-review",
        capability: "spec-kit/independent-review",
        description: "Independently validates remediation results against previous findings.",
      },
    },
  ],
  [
    "CONVERGE",
    {
      skill: "speckit-converge",
      capability: "spec-kit/converge",
      metadata: {
        skill: "speckit-converge",
        workflow: "spec-kit/converge",
        capability: "spec-kit/converge",
        description: "Verifies full implementation convergence against spec, plan, and tasks.",
      },
    },
  ],
]);

/**
 * Returns the ordered skills for a given agent role, sorted deterministically
 * by execution_order ascending.
 */
export function getSkillsForRole(role: AgentRole): AgentSkill[] {
  const skills = SPEC_KIT_ROLE_SKILLS_MAP[role] ?? [];
  return [...skills].sort((a, b) => a.execution_order - b.execution_order);
}

/**
 * Resolves a skill by its identifier.
 */
export function getSkillById(id: string): AgentSkill | undefined {
  const allSkills = getAllSpecKitSkills();
  return allSkills.find((skill) => skill.id === id);
}

/**
 * Returns all distinct Spec Kit skills defined in the catalog.
 */
export function getAllSpecKitSkills(): AgentSkill[] {
  return [
    SPECKIT_SPECIFY_SKILL,
    SPECKIT_CLARIFY_SKILL,
    SPECKIT_PLAN_SKILL,
    SPECKIT_TASKS_SKILL,
    SPECKIT_ANALYZE_SKILL,
    SPECKIT_IMPLEMENT_SKILL,
    SPECKIT_INDEPENDENT_REVIEW_SKILL,
    SPECKIT_BUG_ASSESS_SKILL,
    SPECKIT_BUG_FIX_SKILL,
    SPECKIT_BUG_TEST_SKILL,
    SPECKIT_CONVERGE_SKILL,
  ];
}

/**
 * Formal Spec-Kit V1 Workflow Preset.
 */
export const SpecKitV1Preset: WorkflowPreset = {
  id: "spec-kit-v1",
  name: "Spec-Kit V1 Workflow Preset",
  description: "Standard Spec-Kit specification, planning, implementation, review, remediation, and convergence workflow.",
  getSkillsForRole,
  getStateSkillConfig(state: CoordinatorState) {
    return SPEC_KIT_STATE_SKILL_MAP.get(state);
  },
};
