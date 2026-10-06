// packages/project-run-engine/tests/host-status-and-restart.test.ts
//
// Phase 2 — status() and the multi-host restart/recovery scenario.
//
// Proves the engine, not any in-memory host object, is the source of truth: a
// completely separate "Host B" — a fresh FileExecutionStateStore instance sharing no
// object references with "Host A" — can recover an execution Host A started (and then
// "disappeared" from) purely by reading the persisted checkpoint from disk.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { statusProjectRun } from "../src/host/status.js";
import { startProjectRun, resumeProjectRun } from "../src/host/project-run-host.js";
import { FileExecutionStateStore, type PersistedExecutionState } from "../src/project/state-store.js";
import { MockRuntimeAdapter } from "../src/runtime/mock-runtime-adapter.js";
import { runProjectInit } from "../src/project/bootstrap.js";

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

describe("Phase 2 — status(): valid, unknown, and recovered executions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-status-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a structured FAILED/EXECUTION_NOT_FOUND response for an unknown execution id, without throwing", async () => {
    const response = await statusProjectRun({ executionId: "exec-unknown", projectRoot: tmpDir });
    expect(response.status).toBe("FAILED");
    expect(response.terminal).toBe(true);
    expect(response.failureReason).toContain("EXECUTION_NOT_FOUND");
  });

  it("reflects a COMPLETED execution without re-running anything", async () => {
    const executionId = "exec-status-completed";
    const adapter = new MockRuntimeAdapter(() => ({
      execution_id: executionId,
      agent: "ROLE",
      state: "STATE",
      status: "PASS",
      evidence: [],
      findings: [],
    }));

    await startProjectRun({ projectRoot: tmpDir, executionId, runtime: "MOCK", adapters: [adapter] });

    const response = await statusProjectRun({ executionId, projectRoot: tmpDir });
    expect(response.status).toBe("COMPLETED");
    expect(response.terminal).toBe(true);
    expect(response.state).toBe("READY_FOR_PR");
  });

  it("reflects a RUNNING execution for a checkpoint left mid-sequence (e.g. a crashed process)", async () => {
    const executionId = "exec-status-running";
    const stateStore = new FileExecutionStateStore(tmpDir);

    // Simulate a checkpoint written mid-run, as if the driving process had crashed
    // between two steps before ever reaching a terminal or paused state.
    const midRun: PersistedExecutionState = {
      version: 1,
      execution_id: executionId,
      project: "svc",
      feature: "feat",
      branch: "feat/feat",
      state: "PLAN",
      lifecycle_status: "IN_PROGRESS",
      runtime: "MOCK",
      iteration: 3,
      remediation_iteration: 0,
      preset: "v1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await stateStore.save(midRun);

    const response = await statusProjectRun({ executionId, projectRoot: tmpDir });
    expect(response.status).toBe("RUNNING");
    expect(response.terminal).toBe(false);
    expect(response.state).toBe("PLAN");
  });

  it("reflects a HUMAN_INTERVENTION_REQUIRED execution with the exact persisted questions, not a recomputation that could drift", async () => {
    const executionId = "exec-status-hitl";
    const blocking = new MockRuntimeAdapter((req) => {
      if (req.role === "SPECIFICATION" && req.state === "CLARIFY") {
        return {
          execution_id: req.execution_id,
          agent: req.role,
          state: req.state,
          status: "FINDINGS",
          evidence: [],
          findings: [{ id: "AMB-1", severity: "CRITICAL", status: "OPEN", required_remediation: "Pick an auth model" }],
        };
      }
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    await startProjectRun({ projectRoot: tmpDir, executionId, runtime: "MOCK", adapters: [blocking] });

    const response = await statusProjectRun({ executionId, projectRoot: tmpDir });
    expect(response.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(response.terminal).toBe(false);
    expect(response.humanIntervention?.suspendedFrom).toBe("CLARIFY");
    expect(response.humanIntervention?.questions).toHaveLength(1);
    expect(response.humanIntervention?.questions[0].id).toBe("AMB-1");
  });
});

describe('Phase 2 — multi-host restart recovery: "Host A disappears, Host B recovers via status()/resume()"', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-restart-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Host B recovers the execution purely from disk, with zero shared JS object references to Host A", async () => {
    const executionId = "exec-restart-recovery";

    // --- Host A: starts the execution, hits a blocking finding, then "disappears"
    // (this call constructs and discards its own internal FileExecutionStateStore
    // and MockRuntimeAdapter closure — nothing from it is reused below). ---
    {
      const blocking = new MockRuntimeAdapter((req) => {
        if (req.role === "SPECIFICATION" && req.state === "CLARIFY") {
          return {
            execution_id: req.execution_id,
            agent: req.role,
            state: req.state,
            status: "FINDINGS",
            evidence: [],
            findings: [{ id: "AMB-1", severity: "CRITICAL", status: "OPEN", required_remediation: "Pick an auth model" }],
          };
        }
        return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
      });

      const started = await startProjectRun({
        projectRoot: tmpDir,
        executionId,
        runtime: "MOCK",
        adapters: [blocking],
      });
      expect(started.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    }
    // Host A's adapter closure and internal state store are now unreachable — only
    // the file on disk under tmpDir/.project-run/runs/ represents what happened.

    // --- Host B: a fresh call with no reference to anything above, identified only
    // by `projectRoot` + `executionId` — exactly what a different process restarting
    // against the same workspace would have. ---
    const statusFromHostB = await statusProjectRun({ executionId, projectRoot: tmpDir });
    expect(statusFromHostB.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(statusFromHostB.humanIntervention?.suspendedFrom).toBe("CLARIFY");
    expect(statusFromHostB.humanIntervention?.questions[0].id).toBe("AMB-1");

    const fixed = new MockRuntimeAdapter((req) => ({
      execution_id: req.execution_id,
      agent: req.role,
      state: req.state,
      status: "PASS",
      evidence: [],
      findings: [],
    }));

    const resumedByHostB = await resumeProjectRun({
      executionId,
      projectRoot: tmpDir,
      adapters: [fixed],
      humanAnswers: [{ questionId: "AMB-1", answer: "OAuth" }],
    });

    expect(resumedByHostB.status).toBe("COMPLETED");

    // The engine, not either host, is the source of truth: a third, independent read
    // confirms completion and the full answer audit trail.
    const finalStatus = await statusProjectRun({ executionId, projectRoot: tmpDir });
    expect(finalStatus.status).toBe("COMPLETED");

    const finalPersisted = await new FileExecutionStateStore(tmpDir).load(executionId);
    expect(finalPersisted?.human_answers).toHaveLength(1);
    expect(finalPersisted?.human_answers?.[0].questionId).toBe("AMB-1");
  });
});
