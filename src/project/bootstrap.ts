import * as fs from "node:fs";
import * as path from "node:path";
import {
  createDefaultProjectConfig,
  validateProjectConfig,
  type ProjectWorkflowConfig,
} from "./project-config.js";

export interface ProjectInitOptions {
  /** Target workspace root directory. Defaults to process.cwd(). */
  projectRoot?: string;
  /** Explicit project name. Inferred from package.json or directory if omitted. */
  name?: string;
  /** When true, overwrites existing config and conflicting skills. Default is false. */
  force?: boolean;
  /** Workflow preset to configure. Defaults to "v1". */
  preset?: string;
  /** Feature specifications directory. Defaults to "specs". */
  featureDirectory?: string;
  /** When true, suppresses console output in programmatic calls. */
  silent?: boolean;
}

export type SkillInstallStatus = "INSTALLED" | "ALREADY_EXISTS" | "CONFLICT" | "UPDATED";

export interface SkillInstallResult {
  id: string;
  status: SkillInstallStatus;
  path: string;
  message?: string;
}

export interface ProjectInitResult {
  success: boolean;
  projectRoot: string;
  projectName: string;
  configCreated: boolean;
  configPath: string;
  skillsInstalled: SkillInstallResult[];
  conflicts: string[];
  issues: string[];
}

/**
 * Resolves the bundled template directory containing canonical skills.
 * Searches relative to current module location and package root candidates.
 */
export function resolveTemplatesDir(): string {
  // Derive module directory from import.meta.url without external module dependencies
  let currentDir = "";
  try {
    const rawUrl = import.meta.url;
    const cleanPath = decodeURIComponent(rawUrl.replace(/^file:\/\//, ""));
    currentDir = path.dirname(cleanPath);
  } catch {
    currentDir = process.cwd();
  }

  const candidatePaths = [
    path.resolve(currentDir, "../templates"),
    path.resolve(currentDir, "../../templates"),
    path.resolve(currentDir, "../../../templates"),
    path.resolve(process.cwd(), "templates"),
    path.resolve(process.cwd(), "packages/project-run-engine/templates"),
    path.resolve(process.cwd(), "node_modules/@incito-labs/project-run-engine/templates"),
    path.resolve(process.cwd(), "node_modules/project-run-engine/templates"),
  ];

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, "skills"))) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to locate bundled project-run-engine templates directory. Checked paths:\n- ${candidatePaths.join("\n- ")}`,
  );
}

/**
 * Infers the project name for a target workspace root.
 * Priority:
 * 1. Explicit name provided in options.
 * 2. Name from existing package.json at project root.
 * 3. Name from existing .project-run/config.json.
 * 4. Directory name of project root.
 */
export function inferProjectName(projectRoot: string, explicitName?: string): string {
  if (explicitName && explicitName.trim()) {
    return explicitName.trim();
  }

  // Check package.json
  const packageJsonPath = path.join(projectRoot, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const content = fs.readFileSync(packageJsonPath, "utf8");
      const parsed = JSON.parse(content);
      if (parsed.name && typeof parsed.name === "string" && parsed.name.trim()) {
        return parsed.name.trim();
      }
    } catch {
      // Ignore parse errors, proceed to next source
    }
  }

  // Check existing config.json
  const configPath = path.join(projectRoot, ".project-run", "config.json");
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, "utf8");
      const parsed = JSON.parse(content);
      if (parsed.project?.name && typeof parsed.project.name === "string") {
        return parsed.project.name.trim();
      }
    } catch {
      // Ignore parse errors, proceed to fallback
    }
  }

  // Fallback to directory basename
  const baseName = path.basename(path.resolve(projectRoot));
  if (baseName && baseName !== "/" && baseName !== ".") {
    return baseName;
  }

  return "default-project";
}

/**
 * Initializes a repository for project-run-engine execution:
 * 1. Creates .project-run/config.json with valid default configuration.
 * 2. Scaffolds canonical Spec-Kit skills in .agents/skills/.
 * 3. Enforces idempotency and non-destructive conflict handling unless --force is set.
 */
export async function runProjectInit(options: ProjectInitOptions = {}): Promise<ProjectInitResult> {
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : process.cwd();
  const projectName = inferProjectName(projectRoot, options.name);
  const force = options.force ?? false;
  const issues: string[] = [];
  const conflicts: string[] = [];
  const skillsInstalled: SkillInstallResult[] = [];

  // Ensure workspace directory exists
  if (!fs.existsSync(projectRoot)) {
    fs.mkdirSync(projectRoot, { recursive: true });
  }

  // 1. Scaffold .project-run/config.json
  const projectRunDir = path.join(projectRoot, ".project-run");
  const configPath = path.join(projectRunDir, "config.json");
  let configCreated = false;

  fs.mkdirSync(projectRunDir, { recursive: true });

  const defaultConfig: ProjectWorkflowConfig = createDefaultProjectConfig(projectName);
  if (options.featureDirectory) {
    defaultConfig.project.feature_directory = options.featureDirectory;
  }
  if (options.preset) {
    defaultConfig.project.workflow_version = options.preset;
  }

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + "\n", "utf8");
    configCreated = true;
  } else if (force) {
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + "\n", "utf8");
    configCreated = true;
  } else {
    // Validate existing configuration
    try {
      const existingContent = fs.readFileSync(configPath, "utf8");
      const parsed = JSON.parse(existingContent);
      const validation = validateProjectConfig(parsed);
      if (!validation.valid) {
        issues.push(
          `Existing .project-run/config.json is invalid:\n  - ${validation.errors?.join("\n  - ")}`,
        );
      }
    } catch (err) {
      issues.push(`Existing .project-run/config.json could not be parsed: ${(err as Error).message}`);
    }
  }

  // 2. Scaffold Canonical Spec-Kit Skills (.agents/skills/)
  const targetSkillsDir = path.join(projectRoot, ".agents", "skills");
  fs.mkdirSync(targetSkillsDir, { recursive: true });

  let templatesDir: string;
  try {
    templatesDir = resolveTemplatesDir();
  } catch (err) {
    issues.push((err as Error).message);
    return {
      success: false,
      projectRoot,
      projectName,
      configCreated,
      configPath,
      skillsInstalled: [],
      conflicts: [],
      issues,
    };
  }

  const templateSkillsDir = path.join(templatesDir, "skills");
  if (fs.existsSync(templateSkillsDir)) {
    const entries = fs.readdirSync(templateSkillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillId = entry.name;
      const srcSkillDir = path.join(templateSkillsDir, skillId);
      const srcSkillFile = path.join(srcSkillDir, "SKILL.md");

      if (!fs.existsSync(srcSkillFile)) {
        continue;
      }

      const templateContent = fs.readFileSync(srcSkillFile, "utf8");
      const destSkillDir = path.join(targetSkillsDir, skillId);
      const destSkillFile = path.join(destSkillDir, "SKILL.md");

      if (!fs.existsSync(destSkillFile)) {
        // Missing skill: install from template
        fs.mkdirSync(destSkillDir, { recursive: true });
        fs.writeFileSync(destSkillFile, templateContent, "utf8");
        skillsInstalled.push({
          id: skillId,
          status: "INSTALLED",
          path: destSkillFile,
        });
      } else {
        // Skill exists: check if identical or modified
        const existingContent = fs.readFileSync(destSkillFile, "utf8");

        if (existingContent === templateContent) {
          skillsInstalled.push({
            id: skillId,
            status: "ALREADY_EXISTS",
            path: destSkillFile,
          });
        } else if (force) {
          // Force overwrite
          fs.writeFileSync(destSkillFile, templateContent, "utf8");
          skillsInstalled.push({
            id: skillId,
            status: "UPDATED",
            path: destSkillFile,
            message: "Overwritten with canonical template via --force",
          });
        } else {
          // Conflict: existing skill modified, force flag not specified
          conflicts.push(skillId);
          skillsInstalled.push({
            id: skillId,
            status: "CONFLICT",
            path: destSkillFile,
            message: "Existing skill content differs from canonical template. Use --force to overwrite.",
          });
        }
      }
    }
  }

  const hasConflicts = conflicts.length > 0;
  const hasErrors = issues.length > 0;
  const success = !hasConflicts && !hasErrors;

  return {
    success,
    projectRoot,
    projectName,
    configCreated,
    configPath,
    skillsInstalled,
    conflicts,
    issues,
  };
}

/**
 * Formats a human-readable ASCII report for project-run init.
 */
export function formatInitReport(result: ProjectInitResult): string {
  const lines: string[] = [];

  lines.push("==================================================");
  lines.push("          PROJECT RUN INITIALIZATION REPORT       ");
  lines.push("==================================================");
  lines.push(`Project Name: ${result.projectName}`);
  lines.push(`Project Root: ${result.projectRoot}`);
  lines.push(`Overall Status: ${result.success ? "✓ INITIALIZED" : "✗ INITIALIZATION FAILED"}`);
  lines.push("");

  lines.push("[1] Configuration:");
  if (result.configCreated) {
    lines.push(`  ✓ Created ${result.configPath}`);
  } else {
    lines.push(`  ✓ Preserved existing ${result.configPath}`);
  }
  lines.push("");

  const installed = result.skillsInstalled.filter((s) => s.status === "INSTALLED");
  const upToDate = result.skillsInstalled.filter((s) => s.status === "ALREADY_EXISTS");
  const updated = result.skillsInstalled.filter((s) => s.status === "UPDATED");
  const conflicts = result.skillsInstalled.filter((s) => s.status === "CONFLICT");

  lines.push("[2] Skills Scaffolding (.agents/skills/):");
  lines.push(`  - Installed fresh: ${installed.length}`);
  for (const s of installed) {
    lines.push(`      + ${s.id} (installed from canonical template)`);
  }
  lines.push(`  - Already up-to-date: ${upToDate.length}`);
  if (updated.length > 0) {
    lines.push(`  - Force updated: ${updated.length}`);
    for (const s of updated) {
      lines.push(`      ↺ ${s.id} (overwritten via --force)`);
    }
  }
  if (conflicts.length > 0) {
    lines.push(`  - Conflicts detected (not overwritten): ${conflicts.length}`);
    for (const s of conflicts) {
      lines.push(`      ! ${s.id} (${s.message})`);
    }
  }
  lines.push("");

  if (result.issues.length > 0) {
    lines.push("[3] Issues / Errors:");
    for (const issue of result.issues) {
      lines.push(`  ✗ ${issue}`);
    }
    lines.push("");
  }

  if (result.success) {
    lines.push("Next steps:");
    lines.push('  1. Run "project-run doctor" to verify workspace readiness.');
    lines.push('  2. Run "project-run" to start your workflow.');
  } else {
    lines.push("Remediation:");
    if (result.conflicts.length > 0) {
      lines.push('  - Run "project-run init --force" to overwrite modified skills with canonical templates.');
    }
    if (result.issues.length > 0) {
      lines.push("  - Review the errors above and resolve repository configuration issues.");
    }
  }
  lines.push("==================================================");

  return lines.join("\n");
}
