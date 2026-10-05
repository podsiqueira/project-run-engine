// packages/project-run-engine/tests/host-api.test.ts
//
// Phase 1 — Host Skill Contract (`ProjectRunHost.start` / `.resume`).
//
// Proves the host-facing API is machine-readable end-to-end: a host never needs to
// parse CLI stdout, structured HUMAN_INTERVENTION_REQUIRED responses carry
// HumanQuestion[], and progress events are emitted in the order a host would need to
// render live progress.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { projectRunHost, startProjectRun, resumeProjectRun } from "../src/host/project-run-host.js";
import type { ProjectRunEvent } from "../src/host/events.js";
import { FileExecutionStateStore, type PersistedExecutionState } from "../src/project/state-store.js";
import { MockRuntimeAdapter } from "../src/runtime/mock-runtime-adapter.js";
import { runProjectInit } from "../src/project/bootstrap.js";

describe("Phase 1 — Host API (ProjectRunHost)", () => {
  let tmpDir: string;
  let stateStore: FileExecutionStateStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-api-"));
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

  it("start(): a clean run reaches COMPLETED with a machine-readable response (no CLI output parsing)", async () => {
    const adapter = new MockRuntimeAdapter(() => ({
      execution_id: "x",
      agent: "ROLE",
      state: "STATE",
      status: "PASS",
      evidence: [],
      findings: [],
    }));

    const response = await projectRunHost.start({
      projectRoot: tmpDir,
      feature: "feat",
      branch: "feat/feat",
      executionId: "exec-host-clean",
      runtime: "MOCK",
      adapters: [adapter],
      executionOptions: undefined,
    });

    expect(response.status).toBe("COMPLETED");
    expect(response.state).toBe("READY_FOR_PR");
    expect(response.executionId).toBe("exec-host-clean");
    expect(response.stepsCount).toBeGreaterThan(0);
    expect(Array.isArray(response.findings)).toBe(true);
    expect(response.humanIntervention).toBeUndefined();
  });

  it("start(): a blocking finding at CLARIFY returns a structured HumanInterventionRequired with HumanQuestion[] — a host can render this without parsing logs", async () => {
    const adapter = new MockRuntimeAdapter((req) => {
      if (req.role === "SPECIFICATION" && req.state === "CLARIFY") {
        return {
          execution_id: req.execution_id,
          agent: req.role,
          state: req.state,
          status: "FINDINGS",
          evidence: [],
          findings: [
            {
              id: "AMB-AUTH",
              severity: "CRITICAL",
              status: "OPEN",
              required_remediation: "Which authentication model should this feature use?",
            },
          ],
        };
      }
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    const response = await projectRunHost.start({
      projectRoot: tmpDir,
      executionId: "exec-host-hitl",
      runtime: "MOCK",
      adapters: [adapter],
    });

    expect(response.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(response.humanIntervention).toBeDefined();
    expect(response.humanIntervention?.suspendedFrom).toBe("CLARIFY");
    expect(response.humanIntervention?.questions).toHaveLength(1);
    expect(response.humanIntervention?.questions[0].question).toContain(
      "Which authentication model should this feature use?",
    );
  });

  it("resume(): supplying human answers resumes the execution and completes once the agent re-verifies cleanly", async () => {
    const executionId = "exec-host-resume";

    const blocking = new MockRuntimeAdapter((req) => {
      if (req.role === "SPECIFICATION" && req.state === "CLARIFY") {
        return {
          execution_id: req.execution_id,
          agent: req.role,
          state: req.state,
          status: "FINDINGS",
          evidence: [],
          findings: [{ id: "AMB-1", severity: "CRITICAL", status: "OPEN" }],
        };
      }
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    const started = await projectRunHost.start({
      projectRoot: tmpDir,
      executionId,
      runtime: "MOCK",
      adapters: [blocking],
    });
    expect(started.status).toBe("HUMAN_INTERVENTION_REQUIRED");

    const fixed = new MockRuntimeAdapter((req) => ({
      execution_id: req.execution_id,
      agent: req.role,
      state: req.state,
      status: "PASS",
      evidence: [],
      findings: [],
    }));

    const resumed = await projectRunHost.resume({
      executionId,
      projectRoot: tmpDir,
      adapters: [fixed],
      runtime: "MOCK",
      humanAnswers: [{ questionId: "AMB-1", answer: "OAuth" }],
    });

    expect(resumed.status).toBe("COMPLETED");
    expect(resumed.state).toBe("READY_FOR_PR");
  });

  it("resume(): invalid execution id returns FAILED with a clear reason, not a thrown exception", async () => {
    const response = await resumeProjectRun({
      executionId: "exec-does-not-exist",
      projectRoot: tmpDir,
      adapters: [],
    });

    expect(response.status).toBe("FAILED");
    expect(response.failureReason).toContain("EXECUTION_NOT_FOUND");
  });

  it("resume(): an already-completed execution returns FAILED with EXECUTION_NOT_RESUMABLE", async () => {
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
      iteration: 1,
      remediation_iteration: 0,
      preset: "v1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await stateStore.save(completed);

    const response = await resumeProjectRun({
      executionId,
      projectRoot: tmpDir,
      adapters: [],
    });

    expect(response.status).toBe("FAILED");
    expect(response.failureReason).toContain("EXECUTION_NOT_RESUMABLE");
  });

  it("resume(): an already-failed execution returns FAILED with EXECUTION_NOT_RESUMABLE", async () => {
    const executionId = "exec-already-failed";
    const failed: PersistedExecutionState = {
      version: 1,
      execution_id: executionId,
      project: "svc",
      feature: "feat",
      branch: "feat/feat",
      state: "IMPLEMENT",
      lifecycle_status: "FAILED",
      runtime: "MOCK",
      iteration: 1,
      remediation_iteration: 0,
      preset: "v1",
      terminal_reason: "Simulated fatal error",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await stateStore.save(failed);

    const response = await resumeProjectRun({
      executionId,
      projectRoot: tmpDir,
      adapters: [],
    });

    expect(response.status).toBe("FAILED");
    expect(response.failureReason).toContain("EXECUTION_NOT_RESUMABLE");
  });

  it("events: a full run emits RUN_STARTED, per-step dispatch/state events, and RUN_COMPLETED in order, without the host polling logs", async () => {
    const events: ProjectRunEvent[] = [];

    const adapter = new MockRuntimeAdapter((req) => ({
      execution_id: req.execution_id,
      agent: req.role,
      state: req.state,
      status: "PASS",
      evidence: [],
      findings: [],
    }));

    const response = await startProjectRun({
      projectRoot: tmpDir,
      executionId: "exec-events",
      runtime: "MOCK",
      adapters: [adapter],
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(response.status).toBe("COMPLETED");

    expect(events[0].type).toBe("RUN_STARTED");
    expect(events[events.length - 1].type).toBe("RUN_COMPLETED");

    const types = events.map((e) => e.type);
    expect(types).toContain("AGENT_DISPATCH_STARTED");
    expect(types).toContain("AGENT_DISPATCH_COMPLETED");
    expect(types).toContain("STATE_CHANGED");

    // Every AGENT_DISPATCH_STARTED must be followed (eventually) by a matching
    // AGENT_DISPATCH_COMPLETED before the run ends — a host rendering "→ Architecture"
    // must also eventually see the completion for that same step.
    const startedCount = types.filter((t) => t === "AGENT_DISPATCH_STARTED").length;
    const completedCount = types.filter((t) => t === "AGENT_DISPATCH_COMPLETED").length;
    expect(startedCount).toBe(completedCount);
    expect(startedCount).toBeGreaterThan(0);
  });

  it("events: a HUMAN_INTERVENTION_REQUIRED outcome emits a HUMAN_INTERVENTION_REQUIRED event with the question count, and RESUME_STARTED is emitted on resume", async () => {
    const executionId = "exec-events-hitl";
    const events: ProjectRunEvent[] = [];

    const blocking = new MockRuntimeAdapter((req) => {
      if (req.role === "SPECIFICATION" && req.state === "CLARIFY") {
        return {
          execution_id: req.execution_id,
          agent: req.role,
          state: req.state,
          status: "FINDINGS",
          evidence: [],
          findings: [{ id: "AMB-1", severity: "CRITICAL", status: "OPEN" }],
        };
      }
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    await startProjectRun({
      projectRoot: tmpDir,
      executionId,
      runtime: "MOCK",
      adapters: [blocking],
      onEvent: (e) => events.push(e),
    });

    const hitlEvent = events.find((e) => e.type === "HUMAN_INTERVENTION_REQUIRED");
    expect(hitlEvent).toBeDefined();
    if (hitlEvent?.type === "HUMAN_INTERVENTION_REQUIRED") {
      expect(hitlEvent.suspendedFrom).toBe("CLARIFY");
      expect(hitlEvent.questionCount).toBe(1);
    }

    const resumeEvents: ProjectRunEvent[] = [];
    const fixed = new MockRuntimeAdapter((req) => ({
      execution_id: req.execution_id,
      agent: req.role,
      state: req.state,
      status: "PASS",
      evidence: [],
      findings: [],
    }));

    await resumeProjectRun({
      executionId,
      projectRoot: tmpDir,
      adapters: [fixed],
      onEvent: (e) => resumeEvents.push(e),
    });

    expect(resumeEvents[0].type).toBe("RESUME_STARTED");
    expect(resumeEvents[resumeEvents.length - 1].type).toBe("RUN_COMPLETED");
  });

  it("events: a FAILED run (bad config) emits RUN_FAILED with the failure reason", async () => {
    const events: ProjectRunEvent[] = [];

    const response = await startProjectRun({
      projectRoot: path.join(os.tmpdir(), "nonexistent-project-root-" + Math.random().toString(36).slice(2)),
      executionId: "exec-events-failed",
      runtime: "MOCK",
      adapters: [],
      onEvent: (e) => events.push(e),
    });

    expect(response.status).toBe("FAILED");
    const failedEvent = events.find((e) => e.type === "RUN_FAILED");
    expect(failedEvent).toBeDefined();
  });
});
