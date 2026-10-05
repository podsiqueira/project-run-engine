// packages/project-run-engine/tests/analyze-resume-safety-gate.test.ts
//
// Phase 1 — ANALYZE resume safety.
//
// Phase 0 identified that ANALYZE -> HUMAN_INTERVENTION_REQUIRED has the same
// resume-staleness characteristic CLARIFY originally had: resuming restored the
// stale blocking result verbatim, which could immediately re-trigger
// HUMAN_INTERVENTION_REQUIRED without the Architecture agent ever being re-dispatched
// to verify a fix. This suite proves the generalized `shouldReverifyOnResume`
// mechanism (extracted in src/project/project-run.ts) fixes this for ANALYZE exactly
// as it already does for CLARIFY, without touching unrelated states' resume behavior.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { executeProjectRun, executeProjectResume } from "../src/project/project-run.js";
import { FileExecutionStateStore, type PersistedExecutionState } from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";
import { MockRuntimeAdapter } from "../src/runtime/mock-runtime-adapter.js";

describe("Phase 1 — ANALYZE resume safety gate", () => {
  let tmpDir: string;
  let stateStore: FileExecutionStateStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-resume-safety-"));
    stateStore = new FileExecutionStateStore(tmpDir);

    await runProjectInit({ projectRoot: tmpDir, silent: true });

    const configDir = path.join(tmpDir, ".project-run");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          project: { name: "svc", workflow_version: "v1", feature_directory: "specs/feat" },
          runtime: { default_runtime: "MOCK", supported_runtimes: ["MOCK"] },
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

    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".git", "HEAD"), "ref: refs/heads/feat/feat\n", "utf8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a blocking ANALYZE finding suspends execution at HUMAN_INTERVENTION_REQUIRED and is persisted", async () => {
    const executionId = "exec-analyze-blocking";

    const blockingAdapter = new MockRuntimeAdapter((req) => {
      if (req.role === "ARCHITECTURE" && req.state === "ANALYZE") {
        return {
          execution_id: req.execution_id,
          agent: req.role,
          state: req.state,
          status: "FINDINGS",
          evidence: [],
          findings: [
            {
              id: "ANALYZE-INCONSISTENCY-1",
              severity: "HIGH",
              category: "consistency",
              evidence: "tasks.md references a data model field not defined in data-model.md",
              required_remediation: "Reconcile tasks.md with data-model.md before implementation",
              status: "OPEN",
            },
          ],
        };
      }
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    const runResult = await executeProjectRun({
      executionId,
      projectRoot: tmpDir,
      runtime: "MOCK",
      stateStore,
      adapters: [blockingAdapter],
      context: { state: "INTAKE", runtime: "MOCK" },
    });

    expect(runResult.status).toBe("HUMAN_INTERVENTION_REQUIRED");

    const persisted = await stateStore.load(executionId);
    expect(persisted?.state).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(persisted?.suspended_from).toBe("ANALYZE");
    expect(persisted?.findings).toHaveLength(1);
    expect((persisted?.findings?.[0] as { id: string }).id).toBe("ANALYZE-INCONSISTENCY-1");
    expect(persisted?.human_intervention?.suspendedFrom).toBe("ANALYZE");
  });

  it("resumes correctly: the Architecture agent is freshly re-dispatched for ANALYZE and, once clean, the workflow proceeds to completion", async () => {
    const executionId = "exec-analyze-resume-fixed";
    const resumedDispatchedRoles: string[] = [];

    const blockingAdapter = new MockRuntimeAdapter((req) => {
      if (req.role === "ARCHITECTURE" && req.state === "ANALYZE") {
        return {
          execution_id: req.execution_id,
          agent: req.role,
          state: req.state,
          status: "FINDINGS",
          evidence: [],
          findings: [{ id: "ANALYZE-INCONSISTENCY-1", severity: "HIGH", status: "OPEN" }],
        };
      }
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    const runResult = await executeProjectRun({
      executionId,
      projectRoot: tmpDir,
      runtime: "MOCK",
      stateStore,
      adapters: [blockingAdapter],
      context: { state: "INTAKE", runtime: "MOCK" },
    });
    expect(runResult.status).toBe("HUMAN_INTERVENTION_REQUIRED");

    const fixedAdapter = new MockRuntimeAdapter((req) => {
      resumedDispatchedRoles.push(`${req.role}:${req.state}`);
      if (req.role === "ARCHITECTURE" && req.state === "ANALYZE") {
        return {
          execution_id: req.execution_id,
          agent: req.role,
          state: req.state,
          status: "PASS",
          evidence: [{ check: "tasks-datamodel-reconciled", passed: true }],
          findings: [],
        };
      }
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    const resumeResult = await executeProjectResume({
      executionId,
      projectRoot: tmpDir,
      stateStore,
      adapters: [fixedAdapter],
      runtime: "MOCK",
    });

    // The Architecture agent must be genuinely re-dispatched for ANALYZE, not skipped
    // because the (stale) persisted result happened to still be on the context.
    expect(resumedDispatchedRoles).toContain("ARCHITECTURE:ANALYZE");

    expect(resumeResult.status).toBe("COMPLETED");
    expect(resumeResult.state).toBe("READY_FOR_PR");

    const finalState = await stateStore.load(executionId);
    expect(finalState?.state).toBe("READY_FOR_PR");
    expect(finalState?.lifecycle_status).toBe("COMPLETED");
  });

  it("does not fabricate success on resume: a still-blocking ANALYZE re-evaluation remains suspended", async () => {
    const executionId = "exec-analyze-resume-still-blocked";

    const blockingAdapter = new MockRuntimeAdapter((req) => {
      if (req.role === "ARCHITECTURE" && req.state === "ANALYZE") {
        return {
          execution_id: req.execution_id,
          agent: req.role,
          state: req.state,
          status: "FINDINGS",
          evidence: [],
          findings: [{ id: "ANALYZE-INCONSISTENCY-1", severity: "HIGH", status: "OPEN" }],
        };
      }
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    await executeProjectRun({
      executionId,
      projectRoot: tmpDir,
      runtime: "MOCK",
      stateStore,
      adapters: [blockingAdapter],
      context: { state: "INTAKE", runtime: "MOCK" },
    });

    const stillBlockingAdapter = new MockRuntimeAdapter((req) => {
      if (req.role === "ARCHITECTURE" && req.state === "ANALYZE") {
        return {
          execution_id: req.execution_id,
          agent: req.role,
          state: req.state,
          status: "FINDINGS",
          evidence: [],
          findings: [{ id: "ANALYZE-INCONSISTENCY-1", severity: "HIGH", status: "OPEN" }],
        };
      }
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    const resumeResult = await executeProjectResume({
      executionId,
      projectRoot: tmpDir,
      stateStore,
      adapters: [stillBlockingAdapter],
      runtime: "MOCK",
    });

    expect(resumeResult.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(resumeResult.status).not.toBe("COMPLETED");

    const finalState = await stateStore.load(executionId);
    expect(finalState?.state).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(finalState?.suspended_from).toBe("ANALYZE");
  });

  it("regression guard: a resume from ANALYZE whose persisted result was already clean (unrelated suspension reason) does not wastefully re-dispatch the Architecture agent", async () => {
    const executionId = "exec-analyze-unrelated-suspension";

    const suspendedState: PersistedExecutionState = {
      version: 1,
      execution_id: executionId,
      project: "svc",
      feature: "feat",
      branch: "feat/feat",
      state: "HUMAN_INTERVENTION_REQUIRED",
      suspended_from: "ANALYZE",
      lifecycle_status: "HUMAN_INTERVENTION_REQUIRED",
      runtime: "MOCK",
      iteration: 1,
      remediation_iteration: 0,
      preset: "v1",
      last_result: {
        execution_id: executionId,
        agent: "ARCHITECTURE",
        state: "ANALYZE",
        status: "PASS",
        evidence: [],
        findings: [],
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await stateStore.save(suspendedState);

    let architectureDispatchedAtAnalyze = false;
    const countingAdapter = new MockRuntimeAdapter((req) => {
      if (req.role === "ARCHITECTURE" && req.state === "ANALYZE") {
        architectureDispatchedAtAnalyze = true;
      }
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    const resumeResult = await executeProjectResume({
      executionId,
      projectRoot: tmpDir,
      stateStore,
      adapters: [countingAdapter],
      runtime: "MOCK",
    });

    expect(architectureDispatchedAtAnalyze).toBe(false);
    expect(resumeResult.status).toBe("COMPLETED");
  });
});
