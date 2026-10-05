// packages/project-run-engine/src/project/project-config.ts

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRole, AgentRuntime } from "../domain/types.js";

export type SkillConfigItem =
  | string
  | {
      id: string;
      required?: boolean;
      capability?: string;
      description?: string;
    };

export interface AgentRoleConfig {
  name?: string;
  description?: string;
  enabled?: boolean;
  required_skills: SkillConfigItem[];
  optional_skills?: SkillConfigItem[];
}

export interface ProjectWorkflowConfig {
  project: {
    name: string;
    workflow_version: string;
    feature_directory?: string;
  };
  runtime: {
    default_runtime: AgentRuntime;
    supported_runtimes?: AgentRuntime[];
  };
  agents: Partial<Record<AgentRole, AgentRoleConfig>>;
  skills?: {
    search_paths?: string[];
  };
  metadata?: Record<string, unknown>;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors?: string[];
  config?: ProjectWorkflowConfig;
}

/**
 * Normalizes a SkillConfigItem into a SkillRequirement.
 */
export function normalizeSkillRequirement(
  item: SkillConfigItem,
  defaultRequired = true,
): import("../domain/types.js").SkillRequirement {
  if (typeof item === "string") {
    return { id: item, required: defaultRequired };
  }
  return {
    id: item.id,
    required: item.required ?? defaultRequired,
    capability: item.capability,
    description: item.description,
  };
}

/**
 * Extracts and normalizes all skill requirements for an agent role.
 */
export function getRoleSkillRequirements(
  roleConfig: AgentRoleConfig | undefined,
): import("../domain/types.js").SkillRequirement[] {
  if (!roleConfig) return [];
  const result: import("../domain/types.js").SkillRequirement[] = [];

  if (Array.isArray(roleConfig.required_skills)) {
    for (const item of roleConfig.required_skills) {
      result.push(normalizeSkillRequirement(item, true));
    }
  }

  if (Array.isArray(roleConfig.optional_skills)) {
    for (const item of roleConfig.optional_skills) {
      result.push(normalizeSkillRequirement(item, false));
    }
  }

  return result;
}

/**
 * Validates the structure and required fields of a ProjectWorkflowConfig.
 */
export function validateProjectConfig(rawConfig: unknown): ConfigValidationResult {
  const errors: string[] = [];

  if (!rawConfig || typeof rawConfig !== "object") {
    return { valid: false, errors: ["Configuration must be an object"] };
  }

  const c = rawConfig as Partial<ProjectWorkflowConfig>;

  // Validate project
  if (!c.project || typeof c.project !== "object") {
    errors.push("Missing 'project' section in configuration");
  } else {
    if (!c.project.name || typeof c.project.name !== "string" || !c.project.name.trim()) {
      errors.push("project.name is required and must be a non-empty string");
    }
    if (!c.project.workflow_version || typeof c.project.workflow_version !== "string") {
      errors.push("project.workflow_version is required");
    }
  }

  // Validate runtime
  if (!c.runtime || typeof c.runtime !== "object") {
    errors.push("Missing 'runtime' section in configuration");
  } else {
    if (!c.runtime.default_runtime || typeof c.runtime.default_runtime !== "string" || !c.runtime.default_runtime.trim()) {
      errors.push("runtime.default_runtime is required (e.g. ANTIGRAVITY, CLAUDE, CURSOR, MOCK, or custom runtime)");
    }
  }

  // Validate agents
  if (!c.agents || typeof c.agents !== "object") {
    errors.push("Missing 'agents' section in configuration");
  } else {
    for (const [role, agentConfig] of Object.entries(c.agents)) {
      if (!agentConfig || typeof agentConfig !== "object") {
        errors.push(`agents.${role} must be an object`);
        continue;
      }
      if (!Array.isArray(agentConfig.required_skills)) {
        errors.push(`agents.${role}.required_skills must be an array of skill requirements`);
      } else {
        for (let i = 0; i < agentConfig.required_skills.length; i++) {
          const skill = agentConfig.required_skills[i];
          const isValid =
            typeof skill === "string"
              ? skill.trim().length > 0
              : skill && typeof skill === "object" && typeof skill.id === "string" && skill.id.trim().length > 0;
          if (!isValid) {
            errors.push(`agents.${role}.required_skills[${i}] must be a valid skill string or object with 'id'`);
          }
        }
      }

      if (agentConfig.optional_skills !== undefined) {
        if (!Array.isArray(agentConfig.optional_skills)) {
          errors.push(`agents.${role}.optional_skills must be an array of skill requirements`);
        } else {
          for (let i = 0; i < agentConfig.optional_skills.length; i++) {
            const skill = agentConfig.optional_skills[i];
            const isValid =
              typeof skill === "string"
                ? skill.trim().length > 0
                : skill && typeof skill === "object" && typeof skill.id === "string" && skill.id.trim().length > 0;
            if (!isValid) {
              errors.push(`agents.${role}.optional_skills[${i}] must be a valid skill string or object with 'id'`);
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, config: c as ProjectWorkflowConfig };
}

/**
 * Loads and validates project configuration from disk.
 * Looks for:
 * 1. customConfigPath if supplied
 * 2. `<projectRoot>/.project-run/config.json`
 * 3. `<projectRoot>/.project-run/workflow.json`
 */
export async function loadProjectConfig(
  projectRoot = process.cwd(),
  customConfigPath?: string,
): Promise<ProjectWorkflowConfig> {
  const candidatePaths = customConfigPath
    ? [path.isAbsolute(customConfigPath) ? customConfigPath : path.join(projectRoot, customConfigPath)]
    : [
        path.join(projectRoot, ".project-run", "config.json"),
        path.join(projectRoot, ".project-run", "workflow.json"),
      ];

  let resolvedPath: string | null = null;
  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      resolvedPath = candidate;
      break;
    }
  }

  if (!resolvedPath) {
    throw new Error(
      `Project workflow configuration not found. Checked: ${candidatePaths.join(", ")}`,
    );
  }

  let content: string;
  try {
    content = fs.readFileSync(resolvedPath, "utf8");
  } catch (err) {
    throw new Error(`Failed to read project config at ${resolvedPath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON in project config at ${resolvedPath}: ${(err as Error).message}`);
  }

  const validation = validateProjectConfig(parsed);
  if (!validation.valid || !validation.config) {
    throw new Error(
      `Project configuration at ${resolvedPath} is invalid:\n- ${validation.errors?.join("\n- ")}`,
    );
  }

  return validation.config;
}

/**
 * Creates default Spec-Kit configuration for standard workflow.
 */
export function createDefaultProjectConfig(projectName = "default-project"): ProjectWorkflowConfig {
  return {
    project: {
      name: projectName,
      workflow_version: "v1",
      feature_directory: "specs/feature-001",
    },
    runtime: {
      default_runtime: "ANTIGRAVITY",
      supported_runtimes: ["ANTIGRAVITY", "CLAUDE", "CURSOR", "MOCK"],
    },
    agents: {
      SPECIFICATION: {
        name: "Specification Agent",
        description: "Defines and clarifies implementation specifications.",
        required_skills: [
          { id: "speckit-specify", required: true },
          { id: "speckit-clarify", required: false },
        ],
      },
      ARCHITECTURE: {
        name: "Architecture Agent",
        description: "Defines technical architecture, tasks, and consistency analysis.",
        required_skills: [
          { id: "speckit-plan", required: true },
          { id: "speckit-tasks", required: true },
          { id: "speckit-analyze", required: true },
        ],
      },
      IMPLEMENTATION: {
        name: "Implementation Agent",
        description: "Executes approved implementation tasks.",
        required_skills: [
          { id: "speckit-implement", required: true },
        ],
      },
      INDEPENDENT_REVIEW: {
        name: "Independent Review Agent",
        description: "Independently reviews implementation and produces findings.",
        required_skills: [
          { id: "speckit-analyze", required: true },
        ],
      },
      REMEDIATION: {
        name: "Remediation Agent",
        description: "Addresses findings using Spec Kit bugfix methodology.",
        required_skills: [
          { id: "speckit-bug-assess", required: true },
          { id: "speckit-bug-fix", required: true },
          { id: "speckit-bug-test", required: true },
        ],
      },
      CONVERGENCE: {
        name: "Convergence Agent",
        description: "Determines whether the implementation has converged.",
        required_skills: [
          { id: "speckit-converge", required: true },
        ],
      },
    },
    skills: {
      search_paths: [".project-run/skills", ".agents/skills"],
    },
  };
}
