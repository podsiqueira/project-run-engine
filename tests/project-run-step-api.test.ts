// packages/project-run-engine/tests/project-run-step-api.test.ts
//
// Phase 3 Closure — the pull-based step API (`nextProjectRunStep`/`submitProjectRunStep`).
//
// This is the primitive that closes the Phase 3 HIGH finding: a live, same-session
// interactive host (Claude Code, Cursor, Codex, Antigravity) can perform each
// dispatched role's work itself and report back a result, without the engine ever
// spawning a nested agent process and without the host needing any knowledge of
// Coordinator internals, the decision engine, or the checkpoint file format.
//
// Only the agent-execution boundary is synthetic here (a controlled test harness
// standing in for "the host performed the described work") — Coordinator,
// CoordinatorDecisionEngine, skill validation, and FileExecutionStateStore persistence
// all run for real underneath, exactly as in every prior phase's tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { nextProjectRunStep, submitProjectRunStep } from "../src/host/project-run-step.js";
import { FileExecutionStateStore, type PersistedExecutionState } from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";
import type { AgentResult } from "../src/domain/types.js";
import type { ProjectRunStepResponse } from "../src/host/step-types.js";

function setUpProject(tmpDir: string): void {
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
}

/** Synthesizes a clean PASS AgentResult for whatever action was requested. */
function passResultFor(response: Extract<ProjectRunStepResponse, { status: "AGENT_ACTION_REQUIRED" }>): AgentResult {
  return {
    execution_id: response.request.execution_id,
    agent: response.request.role,
    state: response.request.state,
    status: "PASS",
    evidence: [],
    findings: [],
  };
}

describe("Phase 3 Closure — pull-based step API: full workflow coverage", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "step-api-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("drives the full SPECIFY -> ... -> CONVERGE -> READY_FOR_PR lifecycle purely via next/submit, with no AgentRuntimeAdapter ever constructed", async () => {
    const executionId = "exec-step-full-lifecycle";
    const rolesPerformed: string[] = [];

    let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });

    let guard = 0;
    while (response.status === "AGENT_ACTION_REQUIRED" && guard++ < 50) {
      rolesPerformed.push(`${response.request.role}:${response.request.state}`);
      const result = passResultFor(response);
      response = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: response.stepId, result });
    }

    expect(response.status).toBe("COMPLETED");
    expect(response.terminal).toBe(true);
    if (response.status === "COMPLETED") {
      expect(response.result.state).toBe("READY_FOR_PR");
    }

    // Every role in the 10-state lifecycle was asked for, in order.
    expect(rolesPerformed).toEqual([
      "SPECIFICATION:SPECIFY",
      "SPECIFICATION:CLARIFY",
      "ARCHITECTURE:PLAN",
      "ARCHITECTURE:TASKS",
      "ARCHITECTURE:ANALYZE",
      "IMPLEMENTATION:IMPLEMENT",
      "INDEPENDENT_REVIEW:INDEPENDENT_REVIEW",
      "CONVERGENCE:CONVERGE",
    ]);
  });

  it("routes a blocking INDEPENDENT_REVIEW finding through REMEDIATION and RE_REVIEW before CONVERGE, purely via next/submit", async () => {
    const executionId = "exec-step-remediation";
    const rolesPerformed: string[] = [];
    let reviewAttempt = 0;

    let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    let guard = 0;
    while (response.status === "AGENT_ACTION_REQUIRED" && guard++ < 50) {
      rolesPerformed.push(`${response.request.role}:${response.request.state}`);

      let result: AgentResult;
      if (response.request.role === "INDEPENDENT_REVIEW") {
        reviewAttempt++;
        result =
          reviewAttempt === 1
            ? {
                execution_id: response.request.execution_id,
                agent: response.request.role,
                state: response.request.state,
                status: "FINDINGS",
                evidence: [],
                findings: [{ id: "F-1", severity: "HIGH", status: "OPEN" }],
              }
            : passResultFor(response);
      } else {
        result = passResultFor(response);
      }

      response = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: response.stepId, result });
    }

    expect(response.status).toBe("COMPLETED");
    expect(rolesPerformed).toContain("REMEDIATION:REMEDIATION");
    expect(rolesPerformed).toContain("INDEPENDENT_REVIEW:RE_REVIEW");
  });
});

describe("Phase 3 Closure — pull-based step API: Human-in-the-Loop", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "step-api-hitl-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a blocking CLARIFY finding yields HUMAN_INTERVENTION_REQUIRED with machine-readable questions, and supplying humanAnswers resumes with a fresh re-dispatch", async () => {
    const executionId = "exec-step-hitl";

    let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    expect(response.status).toBe("AGENT_ACTION_REQUIRED");
    if (response.status !== "AGENT_ACTION_REQUIRED") return;
    expect(response.request.role).toBe("SPECIFICATION");

    // SPECIFY passes cleanly.
    response = await submitProjectRunStep({
      projectRoot: tmpDir,
      executionId,
      stepId: response.stepId,
      result: passResultFor(response),
    });

    // CLARIFY reports a blocking finding.
    expect(response.status).toBe("AGENT_ACTION_REQUIRED");
    if (response.status !== "AGENT_ACTION_REQUIRED") return;
    expect(response.request.state).toBe("CLARIFY");

    response = await submitProjectRunStep({
      projectRoot: tmpDir,
      executionId,
      stepId: response.stepId,
      result: {
        execution_id: response.request.execution_id,
        agent: response.request.role,
        state: response.request.state,
        status: "FINDINGS",
        evidence: [],
        findings: [{ id: "AMB-1", severity: "CRITICAL", status: "OPEN", required_remediation: "Pick an auth model" }],
      },
    });

    expect(response.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    if (response.status !== "HUMAN_INTERVENTION_REQUIRED") return;
    expect(response.humanIntervention.suspendedFrom).toBe("CLARIFY");
    expect(response.humanIntervention.questions).toHaveLength(1);
    const questionId = response.humanIntervention.questions[0].id;

    // Reading again without answers is a pure, non-mutating read of the same state.
    const reread = await nextProjectRunStep({ projectRoot: tmpDir, executionId });
    expect(reread.status).toBe("HUMAN_INTERVENTION_REQUIRED");

    // Supplying the answer resumes and forces a FRESH SPECIFICATION:CLARIFY dispatch
    // (the answer does not directly resolve the finding).
    const resumed = await nextProjectRunStep({
      projectRoot: tmpDir,
      executionId,
      humanAnswers: [{ questionId, answer: "OAuth" }],
    });
    expect(resumed.status).toBe("AGENT_ACTION_REQUIRED");
    if (resumed.status !== "AGENT_ACTION_REQUIRED") return;
    expect(resumed.request.role).toBe("SPECIFICATION");
    expect(resumed.request.state).toBe("CLARIFY");

    // Completing the re-verification cleanly continues the workflow.
    const afterClarify = await submitProjectRunStep({
      projectRoot: tmpDir,
      executionId,
      stepId: resumed.stepId,
      result: passResultFor(resumed),
    });
    expect(afterClarify.status).toBe("AGENT_ACTION_REQUIRED");
    if (afterClarify.status === "AGENT_ACTION_REQUIRED") {
      expect(afterClarify.request.state).toBe("PLAN");
    }

    const persisted = await new FileExecutionStateStore(tmpDir).load(executionId);
    expect(persisted?.human_answers).toHaveLength(1);
    expect(persisted?.human_answers?.[0].questionId).toBe(questionId);
  });
});

describe("Phase 3 Closure — pull-based step API: safety rejections", () => {
  let tmpDir: string;
  let stateStore: FileExecutionStateStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "step-api-safety-"));
    stateStore = new FileExecutionStateStore(tmpDir);
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("submitProjectRunStep with an unknown execution id returns a structured FAILED, never throws", async () => {
    const response = await submitProjectRunStep({
      executionId: "exec-nope",
      stepId: "whatever",
      projectRoot: tmpDir,
      result: { execution_id: "exec-nope", agent: "SPECIFICATION", state: "SPECIFY", status: "PASS", evidence: [], findings: [] },
    });
    expect(response.status).toBe("FAILED");
    expect(response.terminal).toBe(true);
    expect(response.failureReason).toContain("EXECUTION_NOT_FOUND");
  });

  it("rejects a submission when no agent action is pending (execution is mid-HITL)", async () => {
    const executionId = "exec-no-pending";
    const suspended: PersistedExecutionState = {
      version: 1,
      execution_id: executionId,
      project: "svc",
      feature: "feat",
      branch: "feat/feat",
      state: "HUMAN_INTERVENTION_REQUIRED",
      suspended_from: "CLARIFY",
      lifecycle_status: "HUMAN_INTERVENTION_REQUIRED",
      runtime: "MOCK",
      iteration: 1,
      remediation_iteration: 0,
      preset: "v1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await stateStore.save(suspended);

    const response = await submitProjectRunStep({
      executionId,
      stepId: "any-step-id",
      projectRoot: tmpDir,
      result: { execution_id: executionId, agent: "SPECIFICATION", state: "CLARIFY", status: "PASS", evidence: [], findings: [] },
    });

    expect(response.status).toBe("FAILED");
    expect(response.terminal).toBe(false);
    expect(response.failureReason).toContain("NO_PENDING_ACTION");
  });

  it("rejects a duplicate/stale submission whose stepId does not match the current pending action", async () => {
    const executionId = "exec-stale-step";
    let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    expect(response.status).toBe("AGENT_ACTION_REQUIRED");
    if (response.status !== "AGENT_ACTION_REQUIRED") return;

    const firstStepId = response.stepId;

    // Submit it successfully once — this clears the pending action and advances.
    const afterFirst = await submitProjectRunStep({
      projectRoot: tmpDir,
      executionId,
      stepId: firstStepId,
      result: passResultFor(response),
    });
    expect(afterFirst.status).toBe("AGENT_ACTION_REQUIRED");

    // Attempting to submit AGAIN with the now-stale first stepId must be rejected —
    // not silently re-applied, and not crashing.
    const duplicate = await submitProjectRunStep({
      projectRoot: tmpDir,
      executionId,
      stepId: firstStepId,
      result: passResultFor(response),
    });
    expect(duplicate.status).toBe("FAILED");
    expect(duplicate.terminal).toBe(false);
    expect(duplicate.failureReason).toContain("STALE_STEP");
  });

  it("rejects a result whose execution_id does not match the submission's executionId (forgery guard)", async () => {
    const executionId = "exec-forged-result";
    const response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    expect(response.status).toBe("AGENT_ACTION_REQUIRED");
    if (response.status !== "AGENT_ACTION_REQUIRED") return;

    const forged = await submitProjectRunStep({
      projectRoot: tmpDir,
      executionId,
      stepId: response.stepId,
      result: { execution_id: "some-other-execution", agent: response.request.role, state: response.request.state, status: "PASS", evidence: [], findings: [] },
    });

    expect(forged.status).toBe("FAILED");
    expect(forged.terminal).toBe(false);
    expect(forged.failureReason).toContain("INVALID_RESULT");
  });

  it("rejects submission against an already-completed execution", async () => {
    const executionId = "exec-already-completed";
    const completed: PersistedExecutionState = {
      version: 1,
      execution_id: executionId,
      project: "svc",
      feature: "feat",
      branch: "feat/feat",
      state: "READY_FOR_PR",
      lifecycle_status: "COMPLETED",
      runtime: "MOCK",
      iteration: 10,
      remediation_iteration: 0,
      preset: "v1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await stateStore.save(completed);

    const response = await submitProjectRunStep({
      executionId,
      stepId: "irrelevant",
      projectRoot: tmpDir,
      result: { execution_id: executionId, agent: "CONVERGENCE", state: "CONVERGE", status: "PASS", evidence: [], findings: [] },
    });

    expect(response.status).toBe("FAILED");
    expect(response.terminal).toBe(true);
    expect(response.failureReason).toContain("EXECUTION_NOT_RESUMABLE");
  });

  it("nextProjectRunStep on an already-completed execution reports COMPLETED informatively, not as a rejection", async () => {
    const executionId = "exec-query-completed";
    const completed: PersistedExecutionState = {
      version: 1,
      execution_id: executionId,
      project: "svc",
      feature: "feat",
      branch: "feat/feat",
      state: "READY_FOR_PR",
      lifecycle_status: "COMPLETED",
      runtime: "MOCK",
      iteration: 10,
      remediation_iteration: 0,
      preset: "v1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await stateStore.save(completed);

    const response = await nextProjectRunStep({ executionId, projectRoot: tmpDir });
    expect(response.status).toBe("COMPLETED");
    expect(response.terminal).toBe(true);
  });
});

describe("Phase 3 Closure — pull-based step API: restart / multi-host recovery", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "step-api-restart-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Host B recovers the exact pending stepId/request Host A received, purely from disk, and submits successfully", async () => {
    const executionId = "exec-step-restart";

    // --- Host A: asks for the first action, then "disappears" without submitting. ---
    const fromHostA = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    expect(fromHostA.status).toBe("AGENT_ACTION_REQUIRED");
    if (fromHostA.status !== "AGENT_ACTION_REQUIRED") return;

    // --- Host B: a fresh call with no reference to Host A's in-memory state at all,
    // identified only by projectRoot + executionId. ---
    const fromHostB = await nextProjectRunStep({ projectRoot: tmpDir, executionId });
    expect(fromHostB.status).toBe("AGENT_ACTION_REQUIRED");
    if (fromHostB.status !== "AGENT_ACTION_REQUIRED") return;

    // The exact same pending action — same stepId, same request — is recovered.
    expect(fromHostB.stepId).toBe(fromHostA.stepId);
    expect(fromHostB.request.role).toBe(fromHostA.request.role);
    expect(fromHostB.request.state).toBe(fromHostA.request.state);

    const submitted = await submitProjectRunStep({
      projectRoot: tmpDir,
      executionId,
      stepId: fromHostB.stepId,
      result: passResultFor(fromHostB),
    });
    expect(submitted.status).toBe("AGENT_ACTION_REQUIRED");
  });
});

describe("Phase 3 Closure — pull-based step API: BLOCKED_MISSING_SKILLS", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "step-api-missing-skills-"));
    // Deliberately do NOT run project-run init: no skills exist on disk at all, and
    // this config marks speckit-specify required:true (unlike the other describe
    // blocks' fixtures), so the pull-based path must surface the same
    // BLOCKED_MISSING_SKILLS signal the push-based path already does.
    const configDir = path.join(tmpDir, ".project-run");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          project: { name: "svc", workflow_version: "v1", feature_directory: "specs/feat" },
          runtime: { default_runtime: "MOCK", supported_runtimes: ["MOCK"] },
          agents: {
            SPECIFICATION: { name: "Spec", required_skills: [{ id: "speckit-specify", required: true }] },
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

  it("nextProjectRunStep reports BLOCKED_MISSING_SKILLS rather than an unexplained crash or a silently-wrong request", async () => {
    const response = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "exec-step-missing-skill", runtime: "MOCK" });
    expect(response.status).toBe("BLOCKED_MISSING_SKILLS");
    if (response.status === "BLOCKED_MISSING_SKILLS") {
      expect(response.role).toBe("SPECIFICATION");
      expect(response.missingSkills).toContain("speckit-specify");
    }
  });
});
