#!/usr/bin/env node
// packages/project-run-engine/src/cli/project-run-cli.ts

import * as path from "node:path";
import { runProjectDoctor, formatDoctorReport } from "../project/doctor.js";
import { runProjectInit, formatInitReport } from "../project/bootstrap.js";
import { startProjectRun, resumeProjectRun } from "../host/project-run-host.js";
import { statusProjectRun } from "../host/status.js";
import { projectEngineRun, type ProjectEngineRunInput } from "../host/project-engine-run.js";
import { nextProjectRunStep, submitProjectRunStep } from "../host/project-run-step.js";
import type { AgentDispatchRequest, AgentResult, AgentRuntime } from "../domain/types.js";
import type { AgentRuntimeAdapter } from "../runtime/runtime-adapter.js";

// The CLI is one possible consumer of the engine's public orchestration API, not the
// orchestration layer itself: `run`/`resume`/`status` below go through the same
// host-facing `startProjectRun`/`resumeProjectRun`/`statusProjectRun` entry points any
// interactive coding-agent host (Claude Code, Cursor, Antigravity, Codex) would use,
// rather than calling `executeProjectRun`/`executeProjectResume` (or Coordinator
// internals) directly. No runtime adapters are wired in here, matching this binary's
// existing behavior: a real deployment supplies its own adapters via the programmatic
// API (see CONSUMER-GUIDE.md).
//
// `project-run engine` (below) exists for a DIFFERENT category of consumer than
// `run`/`resume`/`status`: a host that cannot import TypeScript/JS at all — an
// interactive coding-agent Skill/tool whose only extension mechanism is running a
// local command and parsing its JSON output (see ARCHITECTURE.md §4.10). A
// programmatic host should still prefer importing `projectRunHost`/`projectEngineRun`
// directly; `project-run engine` is the transport for hosts that structurally cannot.

/**
 * A demonstration-only `AgentRuntimeAdapter`, used solely by `project-run engine
 * --mock-scenario`. It does NOT represent a real host integration: a real deployment's
 * adapter is necessarily host-specific (see ARCHITECTURE.md §4.5) and is supplied by
 * the host via the programmatic API, never via this CLI's JSON transport (a live
 * function cannot be serialized into `--json`). This exists only so the reference
 * Claude Code skill (`templates/host-integrations/claude-code/`) and this file's tests
 * can exercise the full start -> HUMAN_INTERVENTION_REQUIRED -> resume -> COMPLETED
 * lifecycle against the real CLI argument parsing and the real `projectEngineRun`,
 * without requiring a genuine external agent.
 */
function createDemoMockAdapter(scenario: "clean" | "clarify-blocked"): AgentRuntimeAdapter {
  return {
    runtime: "MOCK",
    async execute(request: AgentDispatchRequest): Promise<AgentResult> {
      if (scenario === "clarify-blocked" && request.role === "SPECIFICATION" && request.state === "CLARIFY") {
        return {
          execution_id: request.execution_id,
          agent: request.role,
          state: request.state,
          status: "FINDINGS",
          evidence: [],
          findings: [
            {
              id: "DEMO-AMB-1",
              severity: "CRITICAL",
              category: "specification-ambiguity",
              evidence: "Demo scenario: spec intentionally leaves a decision unresolved",
              required_remediation: "Which option should this demo feature use?",
              status: "OPEN",
            },
          ],
        };
      }

      return {
        execution_id: request.execution_id,
        agent: request.role,
        state: request.state,
        status: "PASS",
        evidence: [],
        findings: [],
      };
    },
  };
}

function printHelp(): void {
  console.log(`
project-run - Provider-agnostic agent orchestration engine

Usage:
  project-run [command] [options]

Commands:
  init           Initialize .project-run/config.json and scaffold canonical Spec-Kit skills
  doctor         Verify workspace configuration and required skills health
  run            Execute the full 13-state delivery workflow (default command)
  resume         Resume an execution that was paused or required human intervention
  status         Read an execution's current state without attempting to advance it
  engine <action>
                 Machine-readable JSON transport over the project-engine-run capability,
                 for hosts that cannot import TypeScript/JS (e.g. an AI coding-agent
                 Skill/tool whose only extension mechanism is running a local command).
                 Always prints a single JSON response line to stdout; exits non-zero
                 only if --json was malformed or missing, never because the workflow
                 itself failed/paused.
                   start | resume | status   push-mode (ProjectRunHostResponse) —
                                              requires a real adapter to do real work
                                              (see --mock-scenario for demo-only use).
                   next-step | submit-step   pull-mode (ProjectRunStepResponse) — the
                                              HOST performs each role's work itself and
                                              reports the result via submit-step; no
                                              adapter is ever needed or accepted. This
                                              is how a same-session interactive agent
                                              host drives the workflow without spawning
                                              a nested agent process.

Options:
  --execution-id <id>   Execution ID to resume/check status for (required for "resume"/"status")
  --feature <name>      Explicit feature name (defaults to auto-discovery from branch/specs)
  --branch <name>       Explicit git branch name (defaults to active git branch)
  --name <name>         Explicit project name for "init" (defaults to package.json name)
  --force               Force overwrite existing config and conflicting skills in "init"
  --dir <path>          Target workspace root directory (defaults to process.cwd())
  --runtime <runtime>   Agent runtime for execution (ANTIGRAVITY | CLAUDE | CURSOR | MOCK)
  --json <payload>      JSON request body for "engine" (fields match ProjectEngineRunInput
                         minus "action", which comes from the <action> argument, and minus
                         "adapters", which cannot be expressed as JSON — see --mock-scenario)
  --mock-scenario <s>   DEMO/TEST ONLY. Wires a placeholder adapter into "engine start"/
                         "resume" so the full lifecycle can be exercised without a real
                         host adapter. "clean" always passes; "clarify-blocked" raises one
                         blocking finding at CLARIFY to demonstrate the HUMAN_INTERVENTION_
                         REQUIRED -> resume round trip. Never implies real agent behavior.
  --help, -h            Show this help message

Examples:
  npx project-run init
  npx project-run init --name my-service --force
  npx project-run doctor
  npx project-run
  npx project-run --feature 004-campaigns-and-lead-attribution
  npx project-run resume --execution-id exec-123456
  npx project-run status --execution-id exec-123456
  npx project-run engine start --json '{"feature":"004-campaigns"}' --mock-scenario clean
  npx project-run engine status --json '{"executionId":"exec-123456"}'
  npx project-run engine next-step --json '{"feature":"004-campaigns"}'
  npx project-run engine submit-step --json '{"executionId":"exec-123456","stepId":"step-abc","result":{"execution_id":"exec-123456","agent":"SPECIFICATION","state":"SPECIFY","status":"PASS","evidence":[],"findings":[]}}'
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
  const isEngine = args.includes("engine");
  const isResume = !isEngine && args.includes("resume");
  const isStatus = !isEngine && args.includes("status");

  // Handle "project-run engine <start|resume|status|next-step|submit-step>" — the JSON
  // transport for hosts that cannot import TypeScript/JS (see ARCHITECTURE.md §4.10).
  // Always prints exactly one JSON line; exits non-zero only for a CLI-level usage
  // error (bad/missing --json), never because the workflow itself reported
  // FAILED/HUMAN_INTERVENTION_REQUIRED/etc. — that truth lives entirely in the printed
  // JSON, which the caller must parse.
  //
  // `start`/`resume`/`status` are push-mode (require a real AgentRuntimeAdapter to do
  // anything beyond --mock-scenario demos — see CONSUMER-GUIDE.md §9.1). `next-step`/
  // `submit-step` are the pull-based step API (ARCHITECTURE.md §4.11): the HOST
  // performs the described role's work itself (e.g. using its own session/tools) and
  // reports the result back via `submit-step` — no adapter is ever needed or accepted.
  if (isEngine) {
    const engineIdx = args.indexOf("engine");
    const action = args[engineIdx + 1];

    const jsonIdx = args.indexOf("--json");
    const rawJson = jsonIdx >= 0 && args[jsonIdx + 1] ? args[jsonIdx + 1] : undefined;

    if (action === "next-step" || action === "submit-step") {
      if (!rawJson) {
        console.error(`Error: --json <payload> is required for "project-run engine ${action}".`);
        return 1;
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawJson);
      } catch (err) {
        console.error(`Error: --json payload is not valid JSON: ${(err as Error).message}`);
        return 1;
      }

      try {
        const response =
          action === "next-step"
            ? await nextProjectRunStep({ ...payload, projectRoot: (payload.projectRoot as string) ?? projectRoot })
            : await submitProjectRunStep({ ...payload, projectRoot: (payload.projectRoot as string) ?? projectRoot } as Parameters<typeof submitProjectRunStep>[0]);
        console.log(JSON.stringify(response));
        return 0;
      } catch (err) {
        console.error(`Fatal error in "project-run engine ${action}": ${(err as Error).message}`);
        return 1;
      }
    }

    if (action !== "start" && action !== "resume" && action !== "status") {
      console.error('Error: "project-run engine" requires an action: start, resume, status, next-step, or submit-step.');
      return 1;
    }

    if (!rawJson) {
      console.error('Error: --json <payload> is required for "project-run engine".');
      return 1;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawJson);
    } catch (err) {
      console.error(`Error: --json payload is not valid JSON: ${(err as Error).message}`);
      return 1;
    }

    const mockScenarioIdx = args.indexOf("--mock-scenario");
    const mockScenario = mockScenarioIdx >= 0 ? args[mockScenarioIdx + 1] : undefined;
    const adapters: AgentRuntimeAdapter[] =
      mockScenario === "clean" || mockScenario === "clarify-blocked"
        ? [createDemoMockAdapter(mockScenario)]
        : [];

    try {
      const input = { action, ...payload, projectRoot: payload.projectRoot ?? projectRoot, adapters } as ProjectEngineRunInput;
      const response = await projectEngineRun(input);
      console.log(JSON.stringify(response));
      return 0;
    } catch (err) {
      console.error(`Fatal error in "project-run engine ${action}": ${(err as Error).message}`);
      return 1;
    }
  }

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

  // Handle "project-run status" — reads an execution's persisted state through the
  // same host layer `run`/`resume` use (statusProjectRun), without attempting to
  // advance it. Never spawns an agent, never writes a checkpoint.
  if (isStatus) {
    let executionId: string | undefined;
    const execIdx = args.indexOf("--execution-id");
    if (execIdx >= 0 && args[execIdx + 1]) {
      executionId = args[execIdx + 1];
    }

    if (!executionId) {
      console.error("Error: --execution-id <id> is required for 'project-run status'.");
      return 1;
    }

    try {
      const result = await statusProjectRun({ projectRoot, executionId });

      if (result.status === "FAILED") {
        console.error(`Project status lookup failed: ${result.failureReason}`);
        return 1;
      }

      console.log(`Execution ${result.executionId}: ${result.status} (state: ${result.state}, terminal: ${result.terminal})`);
      if (result.humanIntervention) {
        console.log(`Waiting on ${result.humanIntervention.questions.length} question(s), suspended from ${result.humanIntervention.suspendedFrom}:`);
        for (const q of result.humanIntervention.questions) {
          console.log(`  - [${q.id}] ${q.question}`);
        }
      }
      return 0;
    } catch (err) {
      console.error(`Fatal error checking project status: ${(err as Error).message}`);
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
