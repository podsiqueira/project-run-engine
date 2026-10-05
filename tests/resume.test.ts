import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  executeProjectRun,
  executeProjectResume,
} from "../src/project/project-run.js";
import {
  FileExecutionStateStore,
  type PersistedExecutionState,
} from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";
import { MockRuntimeAdapter } from "../src/runtime/mock-runtime-adapter.js";
import { AgentRegistry } from "../src/agents/agent-registry.js";
import { SkillResolver } from "../src/skills/skill-resolver.js";
import { SkillValidator } from "../src/skills/skill-validator.js";
import type { AgentDispatchRequest, AgentResult, AgentRuntimeAdapter } from "../src/index.js";

describe("G-5: Human Intervention Resume Protocol & Provider Neutrality", () => {
  let tmpDir: string;
  let stateStore: FileExecutionStateStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-test-"));
    stateStore = new FileExecutionStateStore(tmpDir);

    // Initialize canonical skills and config via runProjectInit
    await runProjectInit({ projectRoot: tmpDir, silent: true });

    // Create minimal project config in tmpDir
    const configDir = path.join(tmpDir, ".project-run");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          project: {
            name: "resume-service",
            workflow_version: "v1",
            feature_directory: "specs/resume-feature",
          },
          runtime: {
            default_runtime: "MOCK",
            supported_runtimes: ["MOCK", "CI_AGENT"],
          },
          agents: {
            SPECIFICATION: {
              name: "Spec Agent",
              required_skills: [{ id: "speckit-specify", required: false }],
            },
            ARCHITECTURE: {
              name: "Arch Agent",
              required_skills: [{ id: "speckit-plan", required: false }],
            },
            IMPLEMENTATION: {
              name: "Impl Agent",
              required_skills: [{ id: "speckit-implement", required: false }],
            },
            INDEPENDENT_REVIEW: {
              name: "Review Agent",
              required_skills: [{ id: "speckit-analyze", required: false }],
            },
            REMEDIATION: {
              name: "Rem Agent",
              required_skills: [{ id: "speckit-bug-fix", required: false }],
            },
            CONVERGENCE: {
              name: "Conv Agent",
              required_skills: [{ id: "speckit-converge", required: false }],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    // Create specs directory
    const specDir = path.join(tmpDir, "specs", "resume-feature");
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, "spec.md"), "# Feature Spec\n", "utf8");

    // Create git repository dummy
    const gitDir = path.join(tmpDir, ".git");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(
      path.join(gitDir, "HEAD"),
      "ref: refs/heads/feat/resume-feature\n",
      "utf8",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resumes an execution that reached HUMAN_INTERVENTION_REQUIRED and continues to completion", async () => {
    const executionId = "exec-human-resume-1";

    // 1. Manually seed a suspended execution state that reached HUMAN_INTERVENTION_REQUIRED
    const suspendedState: PersistedExecutionState = {
      version: 1,
      execution_id: executionId,
      project: "resume-service",
      feature: "resume-feature",
      branch: "feat/resume-feature",
      state: "HUMAN_INTERVENTION_REQUIRED",
      suspended_from: "CLARIFY", // suspended from clarify
      lifecycle_status: "HUMAN_INTERVENTION_REQUIRED",
      runtime: "MOCK",
      iteration: 1,
      remediation_iteration: 0,
      preset: "v1",
      context: { issue: "Ambiguity clarified by human" },
      last_result: {
        execution_id: executionId,
        agent: "SPECIFICATION",
        state: "CLARIFY",
        status: "PASS",
        evidence: [],
        findings: [],
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await stateStore.save(suspendedState);

    // 2. Set up mock adapter to pass subsequent steps (PLAN, TASKS, ANALYZE, IMPLEMENT, REVIEW, CONVERGE)
    const mockAdapter = new MockRuntimeAdapter((request) => ({
      execution_id: request.execution_id,
      agent: request.role,
      state: request.state,
      status: "PASS",
      evidence: [],
      findings: [],
    }));

    // 3. Resume execution
    const resumeResult = await executeProjectResume({
      executionId,
      projectRoot: tmpDir,
      stateStore,
      adapters: [mockAdapter],
      runtime: "MOCK",
    });

    expect(resumeResult.status).toBe("COMPLETED");
    expect(resumeResult.state).toBe("READY_FOR_PR");
    expect(resumeResult.stepsCount).toBeGreaterThan(0);

    // 4. Verify updated checkpoint state reflects COMPLETED
    const finalState = await stateStore.load(executionId);
    expect(finalState).toBeDefined();
    expect(finalState?.state).toBe("READY_FOR_PR");
    expect(finalState?.lifecycle_status).toBe("COMPLETED");
  });

  it("does not re-execute completed agent on resume", async () => {
    const executionId = "exec-no-rerun";
    let specAgentInvocationCount = 0;

    class CountingMockAdapter implements AgentRuntimeAdapter {
      readonly runtime = "MOCK";
      async execute(request: AgentDispatchRequest): Promise<AgentResult> {
        if (request.role === "SPECIFICATION") {
          specAgentInvocationCount++;
        }
        return {
          execution_id: request.execution_id,
          agent: request.role,
          state: request.state,
          status: "PASS",
          evidence: [],
          findings: [],
        };
      }
    }

    // Seeding state where CLARIFY completed and had an ambiguity that is now human-resolved
    const suspendedState: PersistedExecutionState = {
      version: 1,
      execution_id: executionId,
      project: "resume-service",
      feature: "resume-feature",
      branch: "feat/resume-feature",
      state: "HUMAN_INTERVENTION_REQUIRED",
      suspended_from: "CLARIFY",
      lifecycle_status: "HUMAN_INTERVENTION_REQUIRED",
      runtime: "MOCK",
      iteration: 1,
      remediation_iteration: 0,
      preset: "v1",
      last_result: {
        execution_id: executionId,
        agent: "SPECIFICATION",
        state: "CLARIFY",
        status: "PASS",
        evidence: [],
        findings: [],
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await stateStore.save(suspendedState);

    const adapter = new CountingMockAdapter();
    await executeProjectResume({
      executionId,
      projectRoot: tmpDir,
      stateStore,
      adapters: [adapter],
      runtime: "MOCK",
    });

    // SPECIFICATION agent was already completed in CLARIFY, so it must NOT have been executed again
    expect(specAgentInvocationCount).toBe(0);
  });

  it("fails with EXECUTION_NOT_FOUND when resuming an unknown execution ID", async () => {
    const result = await executeProjectResume({
      executionId: "exec-does-not-exist",
      projectRoot: tmpDir,
      stateStore,
    });

    expect(result.status).toBe("FAILED");
    expect(result.failureReason).toContain("EXECUTION_NOT_FOUND");
  });

  it("fails with EXECUTION_NOT_RESUMABLE when resuming a completed execution (READY_FOR_PR)", async () => {
    const executionId = "exec-already-done";
    const completedState: PersistedExecutionState = {
      version: 1,
      execution_id: executionId,
      project: "resume-service",
      feature: "resume-feature",
      branch: "feat/resume-feature",
      state: "READY_FOR_PR",
      lifecycle_status: "COMPLETED",
      runtime: "MOCK",
      iteration: 1,
      remediation_iteration: 0,
      preset: "v1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await stateStore.save(completedState);

    const result = await executeProjectResume({
      executionId,
      projectRoot: tmpDir,
      stateStore,
    });

    expect(result.status).toBe("FAILED");
    expect(result.failureReason).toContain("EXECUTION_NOT_RESUMABLE");
    expect(result.failureReason).toContain("Cannot resume completed execution");
  });

  it("fails safely when persisted state file is corrupted", async () => {
    const runsDir = path.join(tmpDir, ".project-run", "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(
      path.join(runsDir, "exec-corrupted.json"),
      "{ invalid-json }",
      "utf8",
    );

    const result = await executeProjectResume({
      executionId: "exec-corrupted",
      projectRoot: tmpDir,
      stateStore,
    });

    expect(result.status).toBe("FAILED");
    expect(result.failureReason).toBeDefined();
  });

  describe("F-2 Regression: Resume after reaching maximum remediation iterations", () => {
    it("resumes an execution suspended from RE_REVIEW at max remediation iterations (3), re-verifies via review agent, and completes to READY_FOR_PR", async () => {
      const executionId = "exec-re-review-max-resume";
      const dispatchedRoles: string[] = [];

      // 1. Seed state where RE_REVIEW reached max remediation iterations (3) with open findings
      const suspendedState: PersistedExecutionState = {
        version: 1,
        execution_id: executionId,
        project: "resume-service",
        feature: "resume-feature",
        branch: "feat/resume-feature",
        state: "HUMAN_INTERVENTION_REQUIRED",
        suspended_from: "RE_REVIEW",
        lifecycle_status: "HUMAN_INTERVENTION_REQUIRED",
        runtime: "MOCK",
        iteration: 4,
        remediation_iteration: 3, // reached MAX_REMEDIATION_ITERATIONS
        preset: "v1",
        context: { issue: "Failed 3 remediation iterations, human intervention required" },
        findings: [
          {
            id: "F-BLOCKING-1",
            severity: "HIGH",
            status: "OPEN",
            evidence: "Memory leak in event listener",
            required_remediation: "Remove listener on unmount",
          },
        ],
        last_result: {
          execution_id: executionId,
          agent: "INDEPENDENT_REVIEW",
          state: "RE_REVIEW",
          status: "FINDINGS",
          evidence: [],
          findings: [
            {
              id: "F-BLOCKING-1",
              severity: "HIGH",
              status: "OPEN",
            },
          ],
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      await stateStore.save(suspendedState);

      // 2. Set up mock adapter representing human fix verified by agents:
      // - INDEPENDENT_REVIEW in RE_REVIEW verifies human fix and passes
      // - CONVERGENCE in CONVERGE verifies convergence and passes
      const mockAdapter = new MockRuntimeAdapter((request) => {
        dispatchedRoles.push(`${request.role}:${request.state}`);

        if (request.role === "INDEPENDENT_REVIEW" && request.state === "RE_REVIEW") {
          return {
            execution_id: request.execution_id,
            agent: request.role,
            state: request.state,
            status: "PASS",
            evidence: [{ check: "human-fix-verified", passed: true }],
            findings: [],
          };
        }

        if (request.role === "CONVERGENCE" && request.state === "CONVERGE") {
          return {
            execution_id: request.execution_id,
            agent: request.role,
            state: request.state,
            status: "PASS",
            evidence: [{ check: "convergence-verified", passed: true }],
            findings: [],
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
      });

      // 3. Resume the execution
      const resumeResult = await executeProjectResume({
        executionId,
        projectRoot: tmpDir,
        stateStore,
        adapters: [mockAdapter],
        runtime: "MOCK",
      });

      // 4. Assertions:
      // a) Resumed execution did NOT loop immediately into HUMAN_INTERVENTION_REQUIRED
      expect(resumeResult.status).toBe("COMPLETED");
      expect(resumeResult.state).toBe("READY_FOR_PR");

      // b) The review agent was actually dispatched to re-evaluate the human fix
      expect(dispatchedRoles).toContain("INDEPENDENT_REVIEW:RE_REVIEW");
      expect(dispatchedRoles).toContain("CONVERGENCE:CONVERGE");

      // c) State store updated to COMPLETED / READY_FOR_PR
      const finalState = await stateStore.load(executionId);
      expect(finalState).toBeDefined();
      expect(finalState?.state).toBe("READY_FOR_PR");
      expect(finalState?.lifecycle_status).toBe("COMPLETED");
    });

    it("resumes an execution from RE_REVIEW, but does not declare success when blocking findings still remain upon re-review", async () => {
      const executionId = "exec-re-review-still-failing";
      const dispatchedRoles: string[] = [];

      // 1. Seed state where RE_REVIEW reached max remediation iterations (3)
      const suspendedState: PersistedExecutionState = {
        version: 1,
        execution_id: executionId,
        project: "resume-service",
        feature: "resume-feature",
        branch: "feat/resume-feature",
        state: "HUMAN_INTERVENTION_REQUIRED",
        suspended_from: "RE_REVIEW",
        lifecycle_status: "HUMAN_INTERVENTION_REQUIRED",
        runtime: "MOCK",
        iteration: 4,
        remediation_iteration: 3,
        preset: "v1",
        findings: [
          {
            id: "F-UNFIXED",
            severity: "HIGH",
            status: "OPEN",
          },
        ],
        last_result: {
          execution_id: executionId,
          agent: "INDEPENDENT_REVIEW",
          state: "RE_REVIEW",
          status: "FINDINGS",
          evidence: [],
          findings: [{ id: "F-UNFIXED", severity: "HIGH", status: "OPEN" }],
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      await stateStore.save(suspendedState);

      // 2. Set up mock adapter where the re-review STILL finds blocking issues
      const mockAdapter = new MockRuntimeAdapter((request) => {
        dispatchedRoles.push(`${request.role}:${request.state}`);

        if (request.role === "INDEPENDENT_REVIEW" && request.state === "RE_REVIEW") {
          return {
            execution_id: request.execution_id,
            agent: request.role,
            state: request.state,
            status: "FINDINGS",
            evidence: [],
            findings: [{ id: "F-STILL-BROKEN", severity: "HIGH", status: "OPEN" }],
          };
        }

        if (request.role === "REMEDIATION") {
          return {
            execution_id: request.execution_id,
            agent: request.role,
            state: request.state,
            status: "PASS",
            evidence: [],
            findings: [],
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
      });

      // 3. Resume the execution
      const resumeResult = await executeProjectResume({
        executionId,
        projectRoot: tmpDir,
        stateStore,
        adapters: [mockAdapter],
        runtime: "MOCK",
        maxSteps: 5, // Limit steps to observe transition behavior
      });

      // 4. Assertions:
      // a) Does NOT declare success when blocking findings remain
      expect(resumeResult.status).not.toBe("COMPLETED");
      expect(resumeResult.state).not.toBe("READY_FOR_PR");

      // b) Re-review was dispatched
      expect(dispatchedRoles).toContain("INDEPENDENT_REVIEW:RE_REVIEW");

      // c) Routing transitioned to REMEDIATION to address the remaining finding
      expect(dispatchedRoles).toContain("REMEDIATION:REMEDIATION");
    });
  });

  describe("Provider Agnosticism with Custom Runtime (CI_AGENT)", () => {
    it("persists, resumes, and dispatches through a completely custom CI_AGENT adapter without modifying engine source", async () => {
      const executionId = "exec-ci-agent-test";
      const ciAgentCalls: string[] = [];

      class CiAgentAdapter implements AgentRuntimeAdapter {
        readonly runtime = "CI_AGENT";
        async execute(request: AgentDispatchRequest): Promise<AgentResult> {
          ciAgentCalls.push(`${request.role}:${request.state}`);
          return {
            execution_id: request.execution_id,
            agent: request.role,
            state: request.state,
            status: "PASS",
            evidence: [{ runner: "GitHub Actions CI" }],
            findings: [],
          };
        }
      }

      const customAdapter = new CiAgentAdapter();

      // 1. Start execution with custom runtime CI_AGENT
      const runResult = await executeProjectRun({
        executionId,
        projectRoot: tmpDir,
        runtime: "CI_AGENT",
        stateStore,
        adapters: [customAdapter],
        context: {
          state: "INTAKE",
          runtime: "CI_AGENT",
        },
      });

      expect(runResult.status).toBe("COMPLETED");
      expect(ciAgentCalls.length).toBeGreaterThan(0);
      expect(ciAgentCalls[0]).toBe("SPECIFICATION:SPECIFY");

      // Verify persisted state saved custom runtime correctly
      const loaded = await stateStore.load(executionId);
      expect(loaded).toBeDefined();
      expect(loaded?.runtime).toBe("CI_AGENT");
      expect(loaded?.lifecycle_status).toBe("COMPLETED");
    });
  });
});
