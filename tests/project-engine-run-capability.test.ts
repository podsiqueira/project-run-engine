// packages/project-run-engine/tests/project-engine-run-capability.test.ts
//
// Phase 2 — the unified, provider-neutral `project-engine-run` capability.
//
// Proves: the single `projectEngineRun({action, ...})` entry point is pure routing
// over the exact same start/resume/status functions (no duplicated orchestration),
// the response is explicit about terminal vs non-terminal states, execution identity
// is always present, and the capability is versioned and safe to invoke repeatedly.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  projectEngineRun,
  PROJECT_ENGINE_RUN_CAPABILITY_VERSION,
  PROJECT_ENGINE_RUN_TOOL_SCHEMA,
} from "../src/host/project-engine-run.js";
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

describe("Phase 2 — project-engine-run: start/resume/status via a single action-discriminated call", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-engine-run-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('action "start" is equivalent to startProjectRun — reaches COMPLETED, non-terminal fields absent', async () => {
    const adapter = new MockRuntimeAdapter((req) => ({
      execution_id: req.execution_id,
      agent: req.role,
      state: req.state,
      status: "PASS",
      evidence: [],
      findings: [],
    }));

    const response = await projectEngineRun({
      action: "start",
      projectRoot: tmpDir,
      executionId: "exec-capability-start",
      runtime: "MOCK",
      adapters: [adapter],
    });

    expect(response.status).toBe("COMPLETED");
    expect(response.terminal).toBe(true);
    expect(response.executionId).toBe("exec-capability-start");
    expect(response.humanIntervention).toBeUndefined();
  });

  it('action "resume" and action "status" compose: start -> blocks -> status shows HUMAN_INTERVENTION_REQUIRED (non-terminal) -> resume completes', async () => {
    const executionId = "exec-capability-flow";

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

    const started = await projectEngineRun({
      action: "start",
      projectRoot: tmpDir,
      executionId,
      runtime: "MOCK",
      adapters: [blocking],
    });
    expect(started.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(started.terminal).toBe(false);
    expect(started.humanIntervention?.questions).toHaveLength(1);

    const status = await projectEngineRun({ action: "status", executionId, projectRoot: tmpDir });
    expect(status.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(status.terminal).toBe(false);
    expect(status.humanIntervention?.suspendedFrom).toBe("CLARIFY");

    const fixed = new MockRuntimeAdapter((req) => ({
      execution_id: req.execution_id,
      agent: req.role,
      state: req.state,
      status: "PASS",
      evidence: [],
      findings: [],
    }));

    const resumed = await projectEngineRun({
      action: "resume",
      executionId,
      projectRoot: tmpDir,
      adapters: [fixed],
      humanAnswers: [{ questionId: "AMB-1", answer: "OAuth" }],
    });
    expect(resumed.status).toBe("COMPLETED");
    expect(resumed.terminal).toBe(true);

    const finalStatus = await projectEngineRun({ action: "status", executionId, projectRoot: tmpDir });
    expect(finalStatus.status).toBe("COMPLETED");
    expect(finalStatus.terminal).toBe(true);
  });

  it("is safe to invoke repeatedly: calling status() many times never mutates the execution or throws", async () => {
    const executionId = "exec-capability-idempotent-status";
    const adapter = new MockRuntimeAdapter(() => ({
      execution_id: executionId,
      agent: "ROLE",
      state: "STATE",
      status: "PASS",
      evidence: [],
      findings: [],
    }));

    await projectEngineRun({ action: "start", projectRoot: tmpDir, executionId, runtime: "MOCK", adapters: [adapter] });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => projectEngineRun({ action: "status", executionId, projectRoot: tmpDir })),
    );

    for (const r of results) {
      expect(r.status).toBe("COMPLETED");
      expect(r.terminal).toBe(true);
    }
  });

  it("unknown execution id on any action returns a structured FAILED response, never throws", async () => {
    const statusResp = await projectEngineRun({ action: "status", executionId: "exec-nope", projectRoot: tmpDir });
    expect(statusResp.status).toBe("FAILED");
    expect(statusResp.terminal).toBe(true);
    expect(statusResp.failureReason).toContain("EXECUTION_NOT_FOUND");

    const resumeResp = await projectEngineRun({
      action: "resume",
      executionId: "exec-nope",
      projectRoot: tmpDir,
      adapters: [],
    });
    expect(resumeResp.status).toBe("FAILED");
    expect(resumeResp.failureReason).toContain("EXECUTION_NOT_FOUND");
  });
});

describe("Phase 2 — project-engine-run capability versioning and schema", () => {
  it("exposes a stable, semver-shaped capability version", () => {
    expect(PROJECT_ENGINE_RUN_CAPABILITY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("the canonical tool schema is provider-neutral JSON Schema, scoped to the JSON-serializable input subset", () => {
    expect(PROJECT_ENGINE_RUN_TOOL_SCHEMA.name).toBe("project_engine_run");
    expect(PROJECT_ENGINE_RUN_TOOL_SCHEMA.input_schema.type).toBe("object");
    expect(PROJECT_ENGINE_RUN_TOOL_SCHEMA.input_schema.properties.action.enum).toEqual(["start", "resume", "status"]);
    // adapters (live functions) must never appear in a JSON-serializable schema.
    expect(Object.keys(PROJECT_ENGINE_RUN_TOOL_SCHEMA.input_schema.properties)).not.toContain("adapters");
    expect(PROJECT_ENGINE_RUN_TOOL_SCHEMA.response_semantics.terminal_statuses).toEqual(["COMPLETED", "FAILED"]);
  });
});
