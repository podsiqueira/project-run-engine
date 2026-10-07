// packages/project-run-engine/src/project/context-discovery.ts

import * as fs from "node:fs";
import * as path from "node:path";
import {
  ProjectNotGitRepositoryError,
  FeatureNotDiscoveredError,
} from "../domain/types.js";
import type { ProjectWorkflowConfig } from "./project-config.js";

export interface GitBranchDiscoverySuccess {
  success: true;
  branch: string;
}

export interface GitBranchDiscoveryFailure {
  success: false;
  error: "PROJECT_NOT_GIT_REPOSITORY" | "BRANCH_NOT_DETERMINED";
  reason: string;
}

export type GitBranchDiscoveryResult =
  | GitBranchDiscoverySuccess
  | GitBranchDiscoveryFailure;

export interface FeatureDiscoverySuccess {
  success: true;
  feature: string;
  featureDirectory: string;
}

export interface FeatureDiscoveryFailure {
  success: false;
  error: "FEATURE_NOT_DISCOVERED";
  reason: string;
}

export type FeatureDiscoveryResult =
  | FeatureDiscoverySuccess
  | FeatureDiscoveryFailure;

export interface ContextDiscoveryOptions {
  projectRoot?: string;
  explicitBranch?: string;
  explicitFeature?: string;
  config?: ProjectWorkflowConfig;
}

export interface DiscoveredProjectContext {
  projectRoot: string;
  branch: string;
  feature: string;
  featureDirectory: string;
}

export interface ContextDiscoverySuccess {
  success: true;
  context: DiscoveredProjectContext;
}

export interface ContextDiscoveryFailure {
  success: false;
  error:
    | "PROJECT_NOT_GIT_REPOSITORY"
    | "BRANCH_NOT_DETERMINED"
    | "FEATURE_NOT_DISCOVERED"
    | "CONTEXT_DISCOVERY_FAILED";
  reason: string;
}

export type ContextDiscoveryResult =
  | ContextDiscoverySuccess
  | ContextDiscoveryFailure;

/**
 * Discovers the active Git branch deterministically using filesystem inspection.
 * Supports standard .git directories, git worktrees, and git submodules.
 * Does NOT spawn child processes or execute shell commands.
 */
export function discoverGitBranch(projectRoot: string): GitBranchDiscoveryResult {
  const root = path.resolve(projectRoot);

  // Find .git directory or file
  let currentDir = root;
  let gitEntryPath: string | null = null;

  while (true) {
    const candidate = path.join(currentDir, ".git");
    if (fs.existsSync(candidate)) {
      gitEntryPath = candidate;
      break;
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }

  if (!gitEntryPath) {
    return {
      success: false,
      error: "PROJECT_NOT_GIT_REPOSITORY",
      reason: `Target directory "${root}" is not inside a git repository (.git not found).`,
    };
  }

  try {
    const stat = fs.statSync(gitEntryPath);
    let headPath: string;

    if (stat.isDirectory()) {
      headPath = path.join(gitEntryPath, "HEAD");
    } else if (stat.isFile()) {
      // Worktree or submodule pointer: "gitdir: <path>"
      const content = fs.readFileSync(gitEntryPath, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/m.exec(content);
      if (!match) {
        return {
          success: false,
          error: "PROJECT_NOT_GIT_REPOSITORY",
          reason: `Invalid .git pointer file at "${gitEntryPath}".`,
        };
      }
      const gitDir = path.resolve(path.dirname(gitEntryPath), match[1].trim());
      headPath = path.join(gitDir, "HEAD");
    } else {
      return {
        success: false,
        error: "PROJECT_NOT_GIT_REPOSITORY",
        reason: `Unexpected .git entry type at "${gitEntryPath}".`,
      };
    }

    if (!fs.existsSync(headPath)) {
      return {
        success: false,
        error: "BRANCH_NOT_DETERMINED",
        reason: `Git HEAD file does not exist at "${headPath}".`,
      };
    }

    const headContent = fs.readFileSync(headPath, "utf8").trim();
    const branchMatch = /^ref:\s*refs\/heads\/(.+)$/m.exec(headContent);

    if (branchMatch && branchMatch[1]) {
      return {
        success: true,
        branch: branchMatch[1].trim(),
      };
    }

    // Detached HEAD: 40-character sha or hash
    if (/^[0-9a-f]{40}$/i.test(headContent)) {
      return {
        success: true,
        branch: headContent,
      };
    }

    return {
      success: false,
      error: "BRANCH_NOT_DETERMINED",
      reason: `Unable to parse active branch from HEAD: "${headContent}".`,
    };
  } catch (err) {
    return {
      success: false,
      error: "BRANCH_NOT_DETERMINED",
      reason: `Failed to inspect git repository: ${(err as Error).message}`,
    };
  }
}

/**
 * Discovers the active feature specification directory deterministically.
 *
 * Precedence:
 * 1. Explicit feature option provided by user/caller.
 * 2. Active git branch name matching a folder in specs/ (with standard prefixes like feat/ stripped).
 * 3. Explicit feature_directory configured in .project-run/config.json.
 * 4. Single existing feature folder in specs/ if exactly one candidate exists.
 *
 * If feature cannot be safely determined, returns FEATURE_NOT_DISCOVERED.
 */
export function discoverFeature(
  projectRoot: string,
  options?: {
    branch?: string;
    explicitFeature?: string;
    featureDirectory?: string;
  },
): FeatureDiscoveryResult {
  const root = path.resolve(projectRoot);
  const specsDir = path.join(root, "specs");

  // 1. Explicit feature provided
  if (options?.explicitFeature && options.explicitFeature.trim()) {
    const raw = options.explicitFeature.trim();
    const candidatePath = path.resolve(root, raw);
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
      return {
        success: true,
        feature: path.basename(candidatePath),
        featureDirectory: path.relative(root, candidatePath) || ".",
      };
    }

    const inSpecs = path.join(specsDir, raw);
    if (fs.existsSync(inSpecs) && fs.statSync(inSpecs).isDirectory()) {
      return {
        success: true,
        feature: raw,
        featureDirectory: path.relative(root, inSpecs),
      };
    }

    return {
      success: false,
      error: "FEATURE_NOT_DISCOVERED",
      reason:
        `Explicitly specified feature "${raw}" was not found at "${candidatePath}" or "${inSpecs}". ` +
        `The engine discovers features; it never creates feature directories. For a brand-new feature, ` +
        `the host/consumer must create the feature workspace (by default "specs/${raw}") before starting, then retry.`,
    };
  }

  // 2. Match active git branch
  if (options?.branch && options.branch.trim()) {
    const rawBranch = options.branch.trim();
    // Strip standard prefixes: feat/, feature/, fix/, chore/, bugfix/, hotfix/
    const stripped = rawBranch.replace(/^(?:feat|feature|fix|chore|bugfix|hotfix)\//, "");

    const candidates = [
      path.join(specsDir, stripped),
      path.join(specsDir, rawBranch),
    ];

    for (const cand of candidates) {
      if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) {
        return {
          success: true,
          feature: path.basename(cand),
          featureDirectory: path.relative(root, cand),
        };
      }
    }
  }

  // 3. Configured feature_directory in config
  if (options?.featureDirectory && options.featureDirectory.trim()) {
    const cand = path.resolve(root, options.featureDirectory.trim());
    if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) {
      return {
        success: true,
        feature: path.basename(cand),
        featureDirectory: path.relative(root, cand),
      };
    }
  }

  // 4. Inspect specs directory
  if (fs.existsSync(specsDir) && fs.statSync(specsDir).isDirectory()) {
    try {
      const entries = fs.readdirSync(specsDir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);

      if (dirs.length === 1) {
        return {
          success: true,
          feature: dirs[0],
          featureDirectory: path.join("specs", dirs[0]),
        };
      }

      if (dirs.length === 0) {
        return {
          success: false,
          error: "FEATURE_NOT_DISCOVERED",
          reason: `No feature specifications found in "${specsDir}".`,
        };
      }

      return {
        success: false,
        error: "FEATURE_NOT_DISCOVERED",
        reason: `Multiple feature specifications found in specs/ (${dirs.join(", ")}). Specify a feature explicitly via --feature or match the active branch name.`,
      };
    } catch (err) {
      return {
        success: false,
        error: "FEATURE_NOT_DISCOVERED",
        reason: `Failed to read specs directory "${specsDir}": ${(err as Error).message}`,
      };
    }
  }

  return {
    success: false,
    error: "FEATURE_NOT_DISCOVERED",
    reason: `Feature directory could not be discovered. Checked explicit options, git branch "${options?.branch ?? "none"}", and specs directory at "${specsDir}".`,
  };
}

/**
 * Discovers the active project execution context (branch, feature, project root).
 */
export function discoverProjectContext(
  options: ContextDiscoveryOptions = {},
): ContextDiscoveryResult {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());

  // 1. Discover Branch
  let branch: string;
  if (options.explicitBranch && options.explicitBranch.trim()) {
    branch = options.explicitBranch.trim();
  } else {
    const branchResult = discoverGitBranch(projectRoot);
    if (!branchResult.success) {
      return branchResult;
    }
    branch = branchResult.branch;
  }

  // 2. Discover Feature
  const featureResult = discoverFeature(projectRoot, {
    branch,
    explicitFeature: options.explicitFeature,
    featureDirectory: options.config?.project?.feature_directory,
  });

  if (!featureResult.success) {
    return featureResult;
  }

  return {
    success: true,
    context: {
      projectRoot,
      branch,
      feature: featureResult.feature,
      featureDirectory: featureResult.featureDirectory,
    },
  };
}
