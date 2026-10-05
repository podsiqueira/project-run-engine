// packages/project-run-engine/src/skills/skill-validator.ts

import type {
  AgentRole,
  AgentSkill,
  AgentSkillRequirement,
  SkillDescriptor,
  SkillRequirement,
  SkillValidationResult,
} from "../domain/types.js";
import type { SkillResolver } from "./skill-resolver.js";

export class SkillValidator {
  constructor(private readonly resolver: SkillResolver) {}

  /**
   * Validates that all required skills for a given agent role are available.
   * Fails safely and deterministically without executing any agent or calling an LLM.
   */
  async validateRole(
    role: AgentRole,
    requirements: readonly (SkillRequirement | AgentSkill | AgentSkillRequirement)[],
  ): Promise<SkillValidationResult> {
    const missingRequiredSkills: string[] = [];
    const missingOptionalSkills: string[] = [];
    const availableSkills: SkillDescriptor[] = [];

    const resolvedSkills = await this.resolver.resolveSkills();

    for (const req of requirements) {
      const descriptor = resolvedSkills.get(req.id);
      const isRequired = req.required !== false;

      if (descriptor && descriptor.available) {
        availableSkills.push(descriptor);
      } else {
        if (isRequired) {
          missingRequiredSkills.push(req.id);
        } else {
          missingOptionalSkills.push(req.id);
        }
      }
    }

    if (missingRequiredSkills.length > 0) {
      const failureReason = [
        "Workflow cannot continue.",
        "",
        "Role:",
        `  ${role}`,
        "",
        "Missing required skills:",
        ...missingRequiredSkills.map((s) => `  - ${s}`),
        "",
        "No agent execution was started.",
      ].join("\n");

      return {
        valid: false,
        role,
        missingRequiredSkills,
        missingOptionalSkills,
        availableSkills,
        failureReason,
      };
    }

    return {
      valid: true,
      role,
      missingRequiredSkills: [],
      missingOptionalSkills,
      availableSkills,
    };
  }

  /**
   * Validates requirements across all configured roles.
   */
  async validateAllRoles(
    roleRequirementsMap: Map<AgentRole, readonly (SkillRequirement | AgentSkill | AgentSkillRequirement)[]>,
  ): Promise<Map<AgentRole, SkillValidationResult>> {
    const results = new Map<AgentRole, SkillValidationResult>();

    for (const [role, reqs] of roleRequirementsMap) {
      const result = await this.validateRole(role, reqs);
      results.set(role, result);
    }

    return results;
  }
}
