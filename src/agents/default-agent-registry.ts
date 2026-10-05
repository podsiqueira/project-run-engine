// packages/project-run-engine/src/agents/default-agent-registry.ts

import type { AgentDefinition, AgentRuntime } from "../domain/types.js";
import type { WorkflowPreset } from "../presets/types.js";
import { AgentRegistry } from "./agent-registry.js";
import { SpecKitV1Preset } from "../presets/spec-kit-preset.js";

export function createDefaultAgentDefinitions(
  additionalRuntimes: AgentRuntime[] = [],
  preset: WorkflowPreset = SpecKitV1Preset,
): AgentDefinition[] {
  const baseRuntimes: AgentRuntime[] = ["ANTIGRAVITY", "CLAUDE", "CURSOR", "MOCK"];
  const supportedRuntimes = Array.from(new Set([...baseRuntimes, ...additionalRuntimes]));

  const getSkills = (role: any) =>
    preset.getSkillsForRole ? preset.getSkillsForRole(role) : [];

  return [
    {
      role: "SPECIFICATION",
      name: "Specification Agent",
      description: "Defines and clarifies the implementation specification.",
      supportedRuntimes,
      capability: "spec-kit/specify",
      capabilities: ["spec-kit/specify", "spec-kit/clarify"],
      skill: "speckit-specify",
      skills: getSkills("SPECIFICATION"),
      skillMetadata: {
        skill: "speckit-specify",
        workflow: "spec-kit/specify",
        capability: "spec-kit/specify",
        description: "Creates and clarifies feature specifications using Spec Kit specify workflow.",
      },
    },
    {
      role: "ARCHITECTURE",
      name: "Architecture Agent",
      description: "Defines the technical architecture and implementation approach.",
      supportedRuntimes,
      capability: "spec-kit/plan",
      capabilities: ["spec-kit/plan", "spec-kit/tasks", "spec-kit/analyze"],
      skill: "speckit-plan",
      skills: getSkills("ARCHITECTURE"),
      skillMetadata: {
        skill: "speckit-plan",
        workflow: "spec-kit/plan",
        capability: "spec-kit/plan",
        description: "Generates architectural plan, implementation tasks, and consistency analysis.",
      },
    },
    {
      role: "IMPLEMENTATION",
      name: "Implementation Agent",
      description: "Implements the approved implementation tasks.",
      supportedRuntimes,
      capability: "spec-kit/implement",
      capabilities: ["spec-kit/implement"],
      skill: "speckit-implement",
      skills: getSkills("IMPLEMENTATION"),
      skillMetadata: {
        skill: "speckit-implement",
        workflow: "spec-kit/implement",
        capability: "spec-kit/implement",
        description: "Executes implementation tasks and creates technical verification evidence.",
      },
    },
    {
      role: "INDEPENDENT_REVIEW",
      name: "Independent Review Agent",
      description: "Independently reviews the implementation and produces findings.",
      supportedRuntimes,
      capability: "spec-kit/independent-review",
      capabilities: ["spec-kit/independent-review", "spec-kit/analyze"],
      skill: "speckit-analyze",
      skills: getSkills("INDEPENDENT_REVIEW"),
      skillMetadata: {
        skill: "speckit-analyze",
        workflow: "spec-kit/independent-review",
        capability: "spec-kit/independent-review",
        description: "Performs independent review against requirements, plan, contracts, and quality standards.",
      },
    },
    {
      role: "REMEDIATION",
      name: "Remediation Agent",
      description: "Addresses findings produced by independent review.",
      supportedRuntimes,
      capability: "spec-kit/bugfix",
      capabilities: ["spec-kit/bugfix", "spec-kit/bug-assess", "spec-kit/bug-test"],
      skill: "speckit-bug-fix",
      skills: getSkills("REMEDIATION"),
      skillMetadata: {
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
    {
      role: "CONVERGENCE",
      name: "Convergence Agent",
      description: "Determines whether the implementation has converged to the required state.",
      supportedRuntimes,
      capability: "spec-kit/converge",
      capabilities: ["spec-kit/converge"],
      skill: "speckit-converge",
      skills: getSkills("CONVERGENCE"),
      skillMetadata: {
        skill: "speckit-converge",
        workflow: "spec-kit/converge",
        capability: "spec-kit/converge",
        description: "Assesses implementation convergence against spec, plan, and tasks.",
      },
    },
  ];
}

export function createDefaultAgentRegistry(
  additionalRuntimes: AgentRuntime[] = [],
  preset: WorkflowPreset = SpecKitV1Preset,
): AgentRegistry {
  return new AgentRegistry(createDefaultAgentDefinitions(additionalRuntimes, preset));
}
