// packages/project-run-engine/src/project/doctor.ts

import type { AgentRole, AgentRuntime } from "../domain/types.js";
import { SkillResolver } from "../skills/skill-resolver.js";
import {
  type ProjectWorkflowConfig,
  getRoleSkillRequirements,
  loadProjectConfig,
  validateProjectConfig,
} from "./project-config.js";

export interface ProjectDoctorOptions {
  projectRoot?: string;
  config?: ProjectWorkflowConfig;
  configPath?: string;
  resolver?: SkillResolver;
  registeredAdapters?: AgentRuntime[];
}

export interface DoctorSkillCheck {
  id: string;
  required: boolean;
  status: "AVAILABLE" | "MISSING";
  source?: string;
  version?: string;
  description?: string;
}

export interface DoctorRoleReport {
  role: AgentRole;
  name?: string;
  enabled: boolean;
  status: "HEALTHY" | "MISSING_REQUIRED_SKILLS";
  skills: DoctorSkillCheck[];
}

export interface ProjectDoctorReport {
  timestamp: string;
  project: {
    name: string;
    configPath?: string;
    configFound: boolean;
    configValid: boolean;
    workflowVersion: string;
    errors?: string[];
  };
  roles: DoctorRoleReport[];
  skills: {
    discoveredCount: number;
    skills: Array<{
      id: string;
      available: boolean;
      source?: string;
      version?: string;
      description?: string;
    }>;
  };
  runtime: {
    defaultRuntime: AgentRuntime;
    configuredRuntimes: AgentRuntime[];
    registeredAdapters: AgentRuntime[];
    adapterAvailableForDefault: boolean;
    valid: boolean;
  };
  overallStatus: "HEALTHY" | "ISSUES_FOUND";
  issues: string[];
}

/**
 * Runs a non-destructive diagnostic check on the project workflow environment.
 *
 * Verifies:
 * 1. Project configuration integrity.
 * 2. Required skills availability per configured agent role.
 * 3. Runtime configuration and adapter availability.
 *
 * Invariants:
 * - Does NOT invoke an LLM.
 * - Does NOT invoke an agent.
 * - Does NOT modify any project or feature files.
 */
export async function runProjectDoctor(
  options: ProjectDoctorOptions = {},
): Promise<ProjectDoctorReport> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const issues: string[] = [];

  let config: ProjectWorkflowConfig | null = null;
  let configFound = false;
  let configValid = false;
  let configErrors: string[] | undefined;

  // 1. Resolve & Validate Configuration
  if (options.config) {
    configFound = true;
    const validation = validateProjectConfig(options.config);
    configValid = validation.valid;
    configErrors = validation.errors;
    if (configValid && validation.config) {
      config = validation.config;
    } else {
      issues.push(`Provided project configuration is invalid: ${validation.errors?.join(", ")}`);
    }
  } else {
    try {
      config = await loadProjectConfig(projectRoot, options.configPath);
      configFound = true;
      configValid = true;
    } catch (err) {
      configFound = false;
      configValid = false;
      configErrors = [(err as Error).message];
      issues.push(`Failed to load project configuration: ${(err as Error).message}`);
    }
  }

  // 2. Discover Skills
  const searchPaths = config?.skills?.search_paths ?? [];
  const resolver =
    options.resolver ??
    new SkillResolver({
      projectRoot,
      searchPaths,
    });

  const discoveredSkillsMap = await resolver.resolveSkills();
  const discoveredSkillsList = Array.from(discoveredSkillsMap.values()).map((s) => ({
    id: s.id,
    available: s.available,
    source: s.source,
    version: s.version,
    description: s.description,
  }));

  // 3. Inspect Roles & Skills Requirements
  const rolesReport: DoctorRoleReport[] = [];
  const agentConfigs = config?.agents ?? {};

  for (const [roleKey, roleCfg] of Object.entries(agentConfigs)) {
    const role = roleKey as AgentRole;
    if (!roleCfg) continue;

    const skillChecks: DoctorSkillCheck[] = [];
    let roleHasMissingRequired = false;

    const skillReqs = getRoleSkillRequirements(roleCfg);

    for (const req of skillReqs) {
      const descriptor = discoveredSkillsMap.get(req.id);
      const isAvailable = !!descriptor?.available;
      const isRequired = req.required !== false;

      if (!isAvailable && isRequired) {
        roleHasMissingRequired = true;
        issues.push(`Role ${role} missing required skill: ${req.id}`);
      }

      skillChecks.push({
        id: req.id,
        required: isRequired,
        status: isAvailable ? "AVAILABLE" : "MISSING",
        source: descriptor?.source,
        version: descriptor?.version,
        description: descriptor?.description ?? req.description,
      });
    }

    rolesReport.push({
      role,
      name: roleCfg.name,
      enabled: roleCfg.enabled !== false,
      status: roleHasMissingRequired ? "MISSING_REQUIRED_SKILLS" : "HEALTHY",
      skills: skillChecks,
    });
  }

  // 4. Runtime Validation
  const defaultRuntime: AgentRuntime = config?.runtime.default_runtime ?? "ANTIGRAVITY";
  const configuredRuntimes: AgentRuntime[] =
    config?.runtime.supported_runtimes ?? [defaultRuntime];
  const registeredAdapters: AgentRuntime[] = options.registeredAdapters ?? [];

  const adapterAvailableForDefault =
    registeredAdapters.length === 0 || registeredAdapters.includes(defaultRuntime);

  if (registeredAdapters.length > 0 && !adapterAvailableForDefault) {
    issues.push(
      `No adapter registered for default runtime '${defaultRuntime}'. Registered: ${registeredAdapters.join(", ")}`,
    );
  }

  const overallStatus = issues.length === 0 ? "HEALTHY" : "ISSUES_FOUND";

  return {
    timestamp: new Date().toISOString(),
    project: {
      name: config?.project.name ?? "unknown",
      configPath: options.configPath,
      configFound,
      configValid,
      workflowVersion: config?.project.workflow_version ?? "unknown",
      errors: configErrors,
    },
    roles: rolesReport,
    skills: {
      discoveredCount: discoveredSkillsList.length,
      skills: discoveredSkillsList,
    },
    runtime: {
      defaultRuntime,
      configuredRuntimes,
      registeredAdapters,
      adapterAvailableForDefault,
      valid: configValid,
    },
    overallStatus,
    issues,
  };
}

/**
 * Formats a ProjectDoctorReport into a human-readable diagnostic text output.
 */
export function formatDoctorReport(report: ProjectDoctorReport): string {
  const lines: string[] = [];

  lines.push("==================================================");
  lines.push("          PROJECT WORKFLOW DOCTOR REPORT          ");
  lines.push("==================================================");
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push(`Overall Status: ${report.overallStatus === "HEALTHY" ? "✓ HEALTHY" : "✗ ISSUES FOUND"}`);
  lines.push("");

  lines.push("[1] Project Configuration:");
  lines.push(`  - Project: ${report.project.name}`);
  lines.push(`  - Workflow Version: ${report.project.workflowVersion}`);
  lines.push(
    `  - Config Status: ${report.project.configFound ? (report.project.configValid ? "VALID" : "INVALID") : "NOT FOUND"}`,
  );
  if (report.project.errors && report.project.errors.length > 0) {
    for (const err of report.project.errors) {
      lines.push(`    ✗ Error: ${err}`);
    }
  }
  lines.push("");

  lines.push("[2] Agent Roles & Skill Requirements:");
  if (report.roles.length === 0) {
    lines.push("  (No agent roles configured)");
  } else {
    for (const r of report.roles) {
      const symbol = r.status === "HEALTHY" ? "✓" : "✗";
      lines.push(`  ${symbol} Role: ${r.role} (${r.name ?? "unnamed"})`);
      for (const s of r.skills) {
        const sSym = s.status === "AVAILABLE" ? "✓" : "✗";
        const reqStr = s.required ? "required" : "optional";
        const verStr = s.version ? ` [v${s.version}]` : "";
        lines.push(`      ${sSym} ${s.id}${verStr} (${s.status}, ${reqStr})`);
        if (s.source) {
          lines.push(`        source: ${s.source}`);
        }
      }
    }
  }
  lines.push("");

  lines.push("[3] Discovered Workspace Skills:");
  lines.push(`  - Total Discovered: ${report.skills.discoveredCount}`);
  for (const s of report.skills.skills) {
    const ver = s.version ? ` [v${s.version}]` : "";
    lines.push(`    - ${s.id}${ver}`);
    if (s.source) {
      lines.push(`      location: ${s.source}`);
    }
  }
  lines.push("");

  lines.push("[4] Runtime Configuration:");
  lines.push(`  - Default Runtime: ${report.runtime.defaultRuntime}`);
  lines.push(`  - Configured Runtimes: ${report.runtime.configuredRuntimes.join(", ")}`);
  if (report.runtime.registeredAdapters.length > 0) {
    lines.push(`  - Registered Adapters: ${report.runtime.registeredAdapters.join(", ")}`);
  }
  lines.push("  - LLM Calls: NONE (Safe non-destructive diagnostic check)");
  lines.push("");

  if (report.issues.length > 0) {
    lines.push("[!] Identified Issues:");
    for (const issue of report.issues) {
      lines.push(`  ✗ ${issue}`);
    }
    lines.push("");
  }

  lines.push("==================================================");
  return lines.join("\n");
}
