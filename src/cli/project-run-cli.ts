#!/usr/bin/env node
// packages/project-run-engine/src/cli/project-run-cli.ts

import * as path from "node:path";
import { runProjectDoctor, formatDoctorReport } from "../project/doctor.js";
import { runProjectInit, formatInitReport } from "../project/bootstrap.js";
import { startProjectRun, resumeProjectRun } from "../host/project-run-host.js";
import type { AgentRuntime } from "../domain/types.js";

// The CLI is one possible consumer of the engine's public orchestration API, not the
// orchestration layer itself: `run`/`resume` below go through the same host-facing
// `startProjectRun`/`resumeProjectRun` entry points any interactive coding-agent host
// (Claude Code, Cursor, Antigravity, Codex) would use, rather than calling
// `executeProjectRun`/`executeProjectResume` (or Coordinator internals) directly. No
// runtime adapters are wired in here, matching this binary's existing behavior: a real
// deployment supplies its own adapters via the programmatic API (see CONSUMER-GUIDE.md).

function printHelp(): void {
  console.log(`
project-run - Provider-agnostic agent orchestration engine

Usage:
  project-run [command] [options]

Commands:
  init      Initialize .project-run/config.json and scaffold canonical Spec-Kit skills
  doctor    Verify workspace configuration and required skills health
  run       Execute the full 13-state delivery workflow (default command)
  resume    Resume an execution that was paused or required human intervention

Options:
  --execution-id <id>   Execution ID to resume (required for "resume")
  --feature <name>      Explicit feature name (defaults to auto-discovery from branch/specs)
  --branch <name>       Explicit git branch name (defaults to active git branch)
  --name <name>         Explicit project name for "init" (defaults to package.json name)
  --force               Force overwrite existing config and conflicting skills in "init"
  --dir <path>          Target workspace root directory (defaults to process.cwd())
  --runtime <runtime>   Agent runtime for execution (ANTIGRAVITY | CLAUDE | CURSOR | MOCK)
  --help, -h            Show this help message

Examples:
  npx project-run init
  npx project-run init --name my-service --force
  npx project-run doctor
  npx project-run
  npx project-run --feature 004-campaigns-and-lead-attribution
  npx project-run resume --execution-id exec-123456
`);
}

/**
 * CLI command runner for project-run, project-run init, doctor, and resume.
 */
export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }

  // Parse target directory if provided
  let projectRoot: string | undefined;
  const dirIdx = args.indexOf("--dir");
  if (dirIdx >= 0 && args[dirIdx + 1]) {
    projectRoot = path.resolve(args[dirIdx + 1]);
  }

  const isInit = args.includes("init");
  const isDoctor = args.includes("doctor");
  const isResume = args.includes("resume");

  // Handle "project-run init"
  if (isInit) {
    let name: string | undefined;
    const nameIdx = args.indexOf("--name");
    if (nameIdx >= 0 && args[nameIdx + 1]) {
      name = args[nameIdx + 1];
    }
    const force = args.includes("--force");

    try {
      const result = await runProjectInit({
        projectRoot,
        name,
        force,
      });

      console.log(formatInitReport(result));
      return result.success ? 0 : 1;
    } catch (err) {
      console.error(`Initialization failed: ${(err as Error).message}`);
      return 1;
    }
  }

  // Handle "project-run doctor"
  if (isDoctor) {
    try {
      const report = await runProjectDoctor({ projectRoot });
      console.log(formatDoctorReport(report));
      return report.overallStatus === "HEALTHY" ? 0 : 1;
    } catch (err) {
      console.error(`Doctor diagnostic failed: ${(err as Error).message}`);
      return 1;
    }
  }

  // Handle "project-run resume"
  if (isResume) {
    let executionId: string | undefined;
    const execIdx = args.indexOf("--execution-id");
    if (execIdx >= 0 && args[execIdx + 1]) {
      executionId = args[execIdx + 1];
    }

    if (!executionId) {
      console.error("Error: --execution-id <id> is required for 'project-run resume'.");
      return 1;
    }

    let runtime: AgentRuntime | undefined;
    const runtimeIdx = args.indexOf("--runtime");
    if (runtimeIdx >= 0 && args[runtimeIdx + 1]) {
      runtime = args[runtimeIdx + 1] as AgentRuntime;
    }

    try {
      const result = await resumeProjectRun({
        projectRoot,
        executionId,
        runtime,
        adapters: [],
      });

      if (result.status === "BLOCKED_MISSING_SKILLS") {
        console.error(result.failureReason);
        return 2;
      }

      if (result.status === "FAILED") {
        console.error(`Project resume failed: ${result.failureReason}`);
        return 1;
      }

      console.log(`Project resume status: ${result.status} (state: ${result.state})`);
      return 0;
    } catch (err) {
      console.error(`Fatal error resuming project run: ${(err as Error).message}`);
      return 1;
    }
  }

  // Handle standard workflow run ("project-run" or "project-run run")
  let runtime: AgentRuntime | undefined;
  const runtimeIdx = args.indexOf("--runtime");
  if (runtimeIdx >= 0 && args[runtimeIdx + 1]) {
    runtime = args[runtimeIdx + 1] as AgentRuntime;
  }

  let explicitFeature: string | undefined;
  const featIdx = args.indexOf("--feature");
  if (featIdx >= 0 && args[featIdx + 1]) {
    explicitFeature = args[featIdx + 1];
  }

  let explicitBranch: string | undefined;
  const branchIdx = args.indexOf("--branch");
  if (branchIdx >= 0 && args[branchIdx + 1]) {
    explicitBranch = args[branchIdx + 1];
  }

  try {
    const result = await startProjectRun({
      projectRoot,
      feature: explicitFeature,
      branch: explicitBranch,
      runtime,
      adapters: [],
    });

    if (result.status === "BLOCKED_MISSING_SKILLS") {
      console.error(result.failureReason);
      return 2;
    }

    if (result.status === "FAILED") {
      console.error(`Project run failed: ${result.failureReason}`);
      return 1;
    }

    console.log(`Project run status: ${result.status} (final state: ${result.state})`);
    return 0;
  } catch (err) {
    console.error(`Fatal error executing project run: ${(err as Error).message}`);
    return 1;
  }
}

// Auto-run if executed as CLI entry point
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("project-run-cli.js") ||
    process.argv[1].endsWith("project-run-cli.ts") ||
    process.argv[1].endsWith("project-run"));

if (isDirectExecution) {
  main()
    .then((code) => {
      if (code !== 0) {
        process.exit(code);
      }
    })
    .catch((err) => {
      console.error("Fatal error:", err);
      process.exit(1);
    });
}
