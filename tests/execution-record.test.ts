// packages/project-run-engine/tests/execution-record.test.ts
//
// ENG-002 — the durable execution record.
//
// A real pull-mode smoke run (nine dispatched steps, four findings, a human
// intervention gate, remediation and an ANALYZE re-run) ended with a COMPLETED response
// reporting `findings: []`, `history: []` and `stepsCount: 1`. Three independent causes:
//
//   A. nothing durable recorded which steps ran / which human suspensions occurred;
//   B. `context.findings` is REPLACED by every result (correct for gating — a clean
//      re-run must clear a blocking gate — but it erased the record of earlier findings);
//   C. `stepsCount` was the constant workflow `iteration`, not a count of agent steps.
//
// The fix keeps gate semantics untouched (`findings` is still the latest result's) and
// adds an append-only `step_log` that `stepLog`/`stepsCount` are derived from.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { nextProjectRunStep, submitProjectRunStep } from "../src/host/project-run-step.js";
import { startProjectRun, resumeProjectRun } from "../src/host/project-run-host.js";
import { statusProjectRun } from "../src/host/status.js";
import { FileExecutionStateStore } from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";
import { MockRuntimeAdapter } from "../src/runtime/mock-runtime-adapter.js";
import type { AgentResult } from "../src/domain/types.js";
import type { ProjectRunStepResponse } from "../src/host/step-types.js";

type ActionRequired = Extract<ProjectRunStepResponse, { status: "AGENT_ACTION_REQUIRED" }>;

function setUpProject(tmpDir: string): void {
  const configDir = path.join(tmpDir, ".project-run");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
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
    }),
    "utf8",
  );
  fs.mkdirSync(path.join(tmpDir, "specs", "feat"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "specs", "feat", "spec.md"), "# Feature\n", "utf8");
  fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, ".git", "HEAD"), "ref: refs/heads/feat/feat\n", "utf8");
}

const ANALYZE_FINDINGS = [
  { id: "A-1", severity: "HIGH", status: "OPEN", required_remediation: "Reconcile tasks with data model" },
  { id: "A-2", severity: "LOW", status: "OPEN" },
];

function resultFor(
  response: ActionRequired,
  status: string,
  findings: unknown[] = [],
  evidence: unknown[] = [],
): AgentResult {
  return {
    execution_id: response.request.execution_id,
    agent: response.request.role,
    state: response.request.state,
    status,
    evidence,
    findings,
  };
}

/** Pull-mode driver for the smoke-test shape: ANALYZE blocks once, then runs clean. */
async function driveAnalyzeBlockedOnce(
  tmpDir: string,
  executionId: string,
): Promise<{ suspended: Extract<ProjectRunStepResponse, { status: "HUMAN_INTERVENTION_REQUIRED" }>; final: ProjectRunStepResponse }> {
  let analyzeAttempts = 0;
  let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
  let suspended: Extract<ProjectRunStepResponse, { status: "HUMAN_INTERVENTION_REQUIRED" }> | undefined;
  let guard = 0;

  while (guard++ < 60) {
    if (response.status === "HUMAN_INTERVENTION_REQUIRED") {
      suspended = response;
      response = await nextProjectRunStep({
        projectRoot: tmpDir,
        executionId,
        humanAnswers: response.humanIntervention.questions.map((q) => ({ questionId: q.id, answer: "reconciled" })),
      });
      continue;
    }
    if (response.status !== "AGENT_ACTION_REQUIRED") break;

    let result: AgentResult;
    if (response.request.state === "ANALYZE") {
      analyzeAttempts++;
      result =
        analyzeAttempts === 1
          ? resultFor(response, "FINDINGS", ANALYZE_FINDINGS, ["analysis-output"])
          : resultFor(response, "PASS");
    } else {
      result = resultFor(response, "PASS");
    }
    response = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: response.stepId, result });
  }

  if (!suspended) throw new Error("expected the workflow to suspend for human intervention at ANALYZE");
  return { suspended, final: response };
}

describe("ENG-002 — pull-mode execution record (the exact observed failure)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-record-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("an earlier finding is still visible in the final response after a later clean result, while gating `findings` is still the latest (empty) set", async () => {
    const executionId = "exec-record-final";
    const { suspended, final } = await driveAnalyzeBlockedOnce(tmpDir, executionId);

    expect(suspended.humanIntervention.suspendedFrom).toBe("ANALYZE");
    expect(final.status).toBe("COMPLETED");
    if (final.status !== "COMPLETED") return;

    // Gate semantics are unchanged: the latest (clean) result's findings.
    expect(final.result.findings).toEqual([]);

    // ...but the record of what was ever reported is not lost.
    const reported = final.result.stepLog.flatMap((r) => r.findings ?? []) as { id: string }[];
    expect(reported.map((f) => f.id)).toEqual(["A-1", "A-2"]);

    const analyzeSteps = final.result.stepLog.filter((r) => r.kind === "AGENT_STEP" && r.state === "ANALYZE");
    expect(analyzeSteps).toHaveLength(2);
    expect(analyzeSteps[0].status).toBe("FINDINGS");
    expect(analyzeSteps[0].findings).toHaveLength(2);
    expect(analyzeSteps[0].evidence_count).toBe(1);
    expect(analyzeSteps[1].status).toBe("PASS");
    expect(analyzeSteps[1].findings).toEqual([]);
  });

  it("records every agent step in order, the human suspension, and the re-run; seq is contiguous and the pull stepId is retained", async () => {
    const executionId = "exec-record-order";
    const { suspended, final } = await driveAnalyzeBlockedOnce(tmpDir, executionId);
    expect(final.status).toBe("COMPLETED");
    if (final.status !== "COMPLETED") return;

    const log = final.result.stepLog;
    expect(log.map((r) => r.seq)).toEqual(log.map((_, i) => i + 1));
    expect(log.map((r) => (r.kind === "AGENT_STEP" ? `${r.role}:${r.state}` : `HITL:${r.state}`))).toEqual([
      "SPECIFICATION:SPECIFY",
      "SPECIFICATION:CLARIFY",
      "ARCHITECTURE:PLAN",
      "ARCHITECTURE:TASKS",
      "ARCHITECTURE:ANALYZE",
      "HITL:ANALYZE",
      "ARCHITECTURE:ANALYZE",
      "IMPLEMENTATION:IMPLEMENT",
      "INDEPENDENT_REVIEW:INDEPENDENT_REVIEW",
      "CONVERGENCE:CONVERGE",
    ]);

    const hitl = log.find((r) => r.kind === "HUMAN_INTERVENTION");
    expect(hitl?.reason).toBeTruthy();
    expect(hitl?.role).toBeUndefined();
    for (const r of log.filter((x) => x.kind === "AGENT_STEP")) {
      expect(r.step_id).toMatch(/^step-/);
      expect(r.recorded_at).toBeTruthy();
    }

    // The human's decision is recorded in its existing, separate audit trail.
    const persisted = await new FileExecutionStateStore(tmpDir).load(executionId);
    expect(persisted?.human_answers).toHaveLength(suspended.humanIntervention.questions.length);
    expect(persisted?.step_log).toEqual(log);
  });

  it("status() of the finished execution (a different host) returns the same durable record", async () => {
    const executionId = "exec-record-status";
    const { final } = await driveAnalyzeBlockedOnce(tmpDir, executionId);
    expect(final.status).toBe("COMPLETED");
    if (final.status !== "COMPLETED") return;

    const status = await statusProjectRun({ executionId, projectRoot: tmpDir });
    expect(status.status).toBe("COMPLETED");
    expect(status.stepLog).toEqual(final.result.stepLog);
    expect(status.stepsCount).toBe(final.result.stepsCount);
    // `history` is documented as live-only; the durable record is `stepLog`.
    expect(status.history).toEqual([]);
  });
});

describe("ENG-002 — stepsCount means agent steps across the whole execution", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-steps-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("advances by one per submitted agent step (multiple dispatched steps), no longer stuck at the workflow iteration", async () => {
    const executionId = "exec-steps-multi";
    let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    expect((await statusProjectRun({ executionId, projectRoot: tmpDir })).stepsCount).toBe(0);

    for (let expected = 1; expected <= 4; expected++) {
      if (response.status !== "AGENT_ACTION_REQUIRED") throw new Error(`unexpected ${response.status}`);
      response = await submitProjectRunStep({
        projectRoot: tmpDir,
        executionId,
        stepId: response.stepId,
        result: resultFor(response, "PASS"),
      });
      const status = await statusProjectRun({ executionId, projectRoot: tmpDir });
      expect(status.stepsCount).toBe(expected);
      expect(status.status).toBe("RUNNING");
    }
  });

  it("a human suspension is not an agent step, and the count continues across the resume", async () => {
    const executionId = "exec-steps-hitl";
    let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    if (response.status !== "AGENT_ACTION_REQUIRED") throw new Error("expected action");
    response = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: response.stepId, result: resultFor(response, "PASS") });
    if (response.status !== "AGENT_ACTION_REQUIRED") throw new Error("expected CLARIFY action");
    response = await submitProjectRunStep({
      projectRoot: tmpDir,
      executionId,
      stepId: response.stepId,
      result: resultFor(response, "FINDINGS", [{ id: "AMB-1", severity: "CRITICAL", status: "OPEN" }]),
    });
    expect(response.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    if (response.status !== "HUMAN_INTERVENTION_REQUIRED") return;

    // SPECIFY + CLARIFY = 2 agent steps; the suspension itself adds none.
    const suspendedStatus = await statusProjectRun({ executionId, projectRoot: tmpDir });
    expect(suspendedStatus.stepsCount).toBe(2);
    expect(suspendedStatus.stepLog.map((r) => r.kind)).toEqual(["AGENT_STEP", "AGENT_STEP", "HUMAN_INTERVENTION"]);

    const resumed = await nextProjectRunStep({
      projectRoot: tmpDir,
      executionId,
      humanAnswers: [{ questionId: response.humanIntervention.questions[0].id, answer: "OAuth" }],
    });
    if (resumed.status !== "AGENT_ACTION_REQUIRED") throw new Error("expected re-dispatch");
    // Re-dispatch is only requested, not yet performed.
    expect((await statusProjectRun({ executionId, projectRoot: tmpDir })).stepsCount).toBe(2);

    await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: resumed.stepId, result: resultFor(resumed, "PASS") });
    const after = await statusProjectRun({ executionId, projectRoot: tmpDir });
    expect(after.stepsCount).toBe(3);
    // The blocking CLARIFY finding is no longer a gate input, but is still on record.
    expect(after.findings).toEqual([]);
    expect((after.stepLog[1].findings as { id: string }[])[0].id).toBe("AMB-1");
  });

  it("completed execution reports the full agent-step count (9 for the smoke-test shape), not 1", async () => {
    const { final } = await driveAnalyzeBlockedOnce(tmpDir, "exec-steps-complete");
    expect(final.status).toBe("COMPLETED");
    if (final.status !== "COMPLETED") return;
    // SPECIFY, CLARIFY, PLAN, TASKS, ANALYZE x2, IMPLEMENT, INDEPENDENT_REVIEW, CONVERGE.
    expect(final.result.stepsCount).toBe(9);
  });

  it("a checkpoint written before the step log existed still advances; the log starts fresh without crashing", async () => {
    const executionId = "exec-steps-legacy";
    const store = new FileExecutionStateStore(tmpDir);
    const first = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    if (first.status !== "AGENT_ACTION_REQUIRED") throw new Error("expected action");

    const persisted = await store.load(executionId);
    if (!persisted) throw new Error("expected persisted state");
    delete persisted.step_log;
    await store.save(persisted);

    const status = await statusProjectRun({ executionId, projectRoot: tmpDir });
    expect(status.stepsCount).toBe(0);
    expect(status.stepLog).toEqual([]);

    const next = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: first.stepId, result: resultFor(first, "PASS") });
    expect(next.status).toBe("AGENT_ACTION_REQUIRED");
    expect((await statusProjectRun({ executionId, projectRoot: tmpDir })).stepsCount).toBe(1);
  });
});

describe("ENG-002 — push-mode (start/resume) reports the same durable record", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-push-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stepsCount counts agent steps (not loop iterations) and continues across resume; earlier findings survive a clean re-run", async () => {
    const executionId = "exec-push-record";
    let analyzeAttempts = 0;
    const adapter = new MockRuntimeAdapter((req) => {
      if (req.state === "ANALYZE") {
        analyzeAttempts++;
        if (analyzeAttempts === 1) {
          return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "FINDINGS", evidence: [], findings: ANALYZE_FINDINGS };
        }
      }
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    const started = await startProjectRun({ projectRoot: tmpDir, executionId, runtime: "MOCK", adapters: [adapter] });
    expect(started.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    // SPECIFY, CLARIFY, PLAN, TASKS, ANALYZE — the loop also ran transitions, which are not steps.
    expect(started.stepsCount).toBe(5);
    expect(started.stepLog.at(-1)?.kind).toBe("HUMAN_INTERVENTION");
    expect(started.findings).toHaveLength(2);

    const resumed = await resumeProjectRun({
      projectRoot: tmpDir,
      executionId,
      runtime: "MOCK",
      adapters: [adapter],
      humanAnswers: started.humanIntervention?.questions.map((q) => ({ questionId: q.id, answer: "ok" })),
    });
    expect(resumed.status).toBe("COMPLETED");
    // 5 before the resume + ANALYZE re-run, IMPLEMENT, INDEPENDENT_REVIEW, CONVERGE.
    expect(resumed.stepsCount).toBe(9);
    expect(resumed.findings).toEqual([]);
    expect((resumed.stepLog.flatMap((r) => r.findings ?? []) as { id: string }[]).map((f) => f.id)).toEqual(["A-1", "A-2"]);
    // Push-mode has no pull correlation id.
    expect(resumed.stepLog.every((r) => r.step_id === undefined)).toBe(true);

    const status = await statusProjectRun({ executionId, projectRoot: tmpDir });
    expect(status.stepsCount).toBe(9);
    expect(status.stepLog).toEqual(resumed.stepLog);
  });
});
