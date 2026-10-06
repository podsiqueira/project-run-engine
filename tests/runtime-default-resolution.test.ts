// packages/project-run-engine/tests/runtime-default-resolution.test.ts
//
// Phase 4 Closure — regression coverage for the runtime-default resolution defect
// found during the Phase 0-4 architecture review:
//
//   config.runtime.default_runtime = "CLAUDE_CODE"
//   runtime omitted from the request
//           -> engine silently fell back to the hardcoded "ANTIGRAVITY" literal
//              inside CoordinatorDecisionEngine/Coordinator.checkpoint(), ignoring
//              the project's configured default entirely
//           -> "Agent SPECIFICATION does not support runtime ANTIGRAVITY"
//
// Root cause: `context.runtime` was read, but never back-filled with the
// config-resolved runtime, before the Coordinator's decision loop ran. Fixed by
// `resolveRuntime()` (src/project/project-run.ts), called once at every fresh-start
// entry point (`executeProjectRun`, `nextProjectRunStep`) and reused (not duplicated)
// by `reconstructResumeContext()` for the resume path.
//
// This suite proves the fix without re-testing anything `tests/host-status-and-
// restart.test.ts` or `tests/project-run-step-api.test.ts` already cover — every
// other existing test in the suite explicitly passes `runtime` on both the request
// and the context, which is exactly what masked this defect; these tests deliberately
// omit it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { executeProjectRun } from "../src/project/project-run.js";
import { nextProjectRunStep } from "../src/host/project-run-step.js";
import { FileExecutionStateStore } from "../src/project/state-store.js";
import { MockRuntimeAdapter } from "../src/runtime/mock-runtime-adapter.js";
import { runProjectInit } from "../src/project/bootstrap.js";

function setUpProject(tmpDir: string, supportedRuntimes: string[] = ["CLAUDE_CODE"]): void {
  const configDir = path.join(tmpDir, ".project-run");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify(
      {
        project: { name: "svc", workflow_version: "v1", feature_directory: "specs/feat" },
        // The configured default is a custom, non-standard runtime identifier
        // (exactly as a real Claude Code deployment would configure it) -
        // deliberately NOT "ANTIGRAVITY". `supported_runtimes` deliberately does
        // NOT include "ANTIGRAVITY" by default either, so a silent fallback to the
        // hardcoded literal fails loudly (registry.resolve() rejects it) instead of
        // incidentally succeeding — this is what makes these tests fail pre-fix
        // rather than passing vacuously; it mirrors the real fixture that reproduced
        // the original defect live (Phase 4 review).
        runtime: { default_runtime: "CLAUDE_CODE", supported_runtimes: supportedRuntimes },
        agents: {
          SPECIFICATION: { name: "Spec", required_skills: [{ id: "speckit-specify", required: false }] },
          ARCHITECTURE: { name: "Arch", required_skills: [{ id: "speckit-plan", required: false }] },
          IMPLEMENTATION: { name: "Impl", required_skills: [{ id: "speckit-implement", required: false }] },
          INDEPENDENT_REVIEW: { name: "Rev", required_skills: [{ id: "speckit-analyze", required: false }] },
          REMEDIATION: { name: "Rem", required_skills: [{ id: "speckit-bug-fix", required: false }] },
          CONVERGENCE: { name: "Conv", required_skills: [{ id: "speckit-converge", required: false }] },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  fs.mkdirSync(path.join(tmpDir, "specs", "feat"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "specs", "feat", "spec.md"), "# Feature\n", "utf8");
}

describe("Phase 4 Closure — runtime.default_runtime is honored when runtime is omitted", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-default-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".git", "HEAD"), "ref: refs/heads/feat/feat\n", "utf8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Test A — push mode (executeProjectRun): omitting runtime dispatches via the configured default_runtime, never ANTIGRAVITY", async () => {
    const executionId = "exec-runtime-default-push";
    const stateStore = new FileExecutionStateStore(tmpDir);
    const claudeCodeAdapter = new MockRuntimeAdapter(
      async (req) => ({ execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] }),
      undefined,
      "CLAUDE_CODE",
    );

    const result = await executeProjectRun({
      executionId,
      projectRoot: tmpDir,
      stateStore,
      adapters: [claudeCodeAdapter],
      // Deliberately no `runtime` option and no `context.runtime` — the whole point
      // of this test is that the config default alone must be sufficient.
      context: { state: "INTAKE" },
    });

    expect(result.agentExecuted).toBe(true);
    expect(result.failureReason).toBeUndefined();

    const persisted = await stateStore.load(executionId);
    expect(persisted?.runtime).toBe("CLAUDE_CODE");
  });

  it("Test B — push mode: an explicit request runtime still wins over the configured default", async () => {
    const executionId = "exec-runtime-explicit-wins-push";
    // This test's config registers BOTH runtimes, unlike the shared fixture above —
    // the point here is purely precedence (explicit beats config default), not
    // whether a wrong default fails loudly (that's Tests A/C/E).
    setUpProject(tmpDir, ["CLAUDE_CODE", "ANTIGRAVITY"]);
    const stateStore = new FileExecutionStateStore(tmpDir);
    // Only an ANTIGRAVITY adapter is registered — if the explicit override were
    // ignored in favor of the config default ("CLAUDE_CODE"), dispatch would fail
    // with "No runtime adapter registered for runtime: CLAUDE_CODE".
    const antigravityAdapter = new MockRuntimeAdapter(
      async (req) => ({ execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] }),
      undefined,
      "ANTIGRAVITY",
    );

    const result = await executeProjectRun({
      executionId,
      projectRoot: tmpDir,
      stateStore,
      adapters: [antigravityAdapter],
      runtime: "ANTIGRAVITY",
      context: { state: "INTAKE" },
    });

    expect(result.agentExecuted).toBe(true);
    expect(result.failureReason).toBeUndefined();

    const persisted = await stateStore.load(executionId);
    expect(persisted?.runtime).toBe("ANTIGRAVITY");
  });

  it("Test C — pull mode (nextProjectRunStep): omitting runtime resolves the configured default, never ANTIGRAVITY", async () => {
    const executionId = "exec-runtime-default-pull";
    const stateStore = new FileExecutionStateStore(tmpDir);

    const response = await nextProjectRunStep({
      executionId,
      projectRoot: tmpDir,
      feature: "feat",
      stateStore,
      // No `runtime` field at all.
    });

    expect(response.status).toBe("AGENT_ACTION_REQUIRED");

    const persisted = await stateStore.load(executionId);
    expect(persisted?.runtime).toBe("CLAUDE_CODE");
    if (response.status === "AGENT_ACTION_REQUIRED") {
      expect(response.request.role).toBe("SPECIFICATION");
    }
  });

  it("Test D — push/legacy path does not regress: an explicit runtime on every call behaves exactly as before", async () => {
    const executionId = "exec-runtime-legacy-regression";
    const stateStore = new FileExecutionStateStore(tmpDir);
    const adapter = new MockRuntimeAdapter(
      async (req) => ({ execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] }),
      undefined,
      "CLAUDE_CODE",
    );

    const result = await executeProjectRun({
      executionId,
      projectRoot: tmpDir,
      stateStore,
      adapters: [adapter],
      runtime: "CLAUDE_CODE",
      context: { state: "INTAKE", runtime: "CLAUDE_CODE" },
    });

    expect(result.agentExecuted).toBe(true);
    expect(result.failureReason).toBeUndefined();
  });

  it("Test E — recovery: a persisted execution continues using its already-resolved runtime, not a recomputed default", async () => {
    const executionId = "exec-runtime-recovery";
    const stateStore = new FileExecutionStateStore(tmpDir);

    const first = await nextProjectRunStep({
      executionId,
      projectRoot: tmpDir,
      feature: "feat",
      stateStore,
    });
    expect(first.status).toBe("AGENT_ACTION_REQUIRED");

    const persistedAfterFirst = await stateStore.load(executionId);
    expect(persistedAfterFirst?.runtime).toBe("CLAUDE_CODE");

    // A second, independent call recovering the same pending action — still omitting
    // `runtime` — must return the exact same pending request without recomputing a
    // different (wrong) default.
    const second = await nextProjectRunStep({
      executionId,
      projectRoot: tmpDir,
      stateStore,
    });

    expect(second.status).toBe("AGENT_ACTION_REQUIRED");
    if (first.status === "AGENT_ACTION_REQUIRED" && second.status === "AGENT_ACTION_REQUIRED") {
      expect(second.stepId).toBe(first.stepId);
    }

    const persistedAfterSecond = await stateStore.load(executionId);
    expect(persistedAfterSecond?.runtime).toBe("CLAUDE_CODE");
  });
});
