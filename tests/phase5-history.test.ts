// packages/project-run-engine/tests/phase5-history.test.ts
//
// Phase 5 — recoverable decision-level history.
//
// `history` is the engine's durable, execution-wide record of what it DECIDED (every
// transition, dispatch, completion and human suspension). It is compact, survives
// resume/restart, and is distinct from `stepLog` (what agents reported). These tests pin
// that contract against the real Coordinator, state store and both execution modes.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { nextProjectRunStep, submitProjectRunStep } from "../src/host/project-run-step.js";
import { startProjectRun, resumeProjectRun } from "../src/host/project-run-host.js";
import { statusProjectRun } from "../src/host/status.js";
import { executeProjectRun } from "../src/project/project-run.js";
import { FileExecutionStateStore } from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";
import { MockRuntimeAdapter } from "../src/runtime/mock-runtime-adapter.js";
import type { AgentResult } from "../src/domain/types.js";
import type { DecisionRecord } from "../src/decision/types.js";
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

function resultFor(response: ActionRequired, status: string, findings: unknown[] = []): AgentResult {
  return {
    execution_id: response.request.execution_id,
    agent: response.request.role,
    state: response.request.state,
    status,
    evidence: ["evidence ".repeat(200)],
    findings,
  };
}

/** Compact label for a recorded decision, for sequence assertions. */
function label(r: DecisionRecord): string {
  const d = r.decision;
  switch (d.action) {
    case "TRANSITION":
      return `${d.from}>${d.to}`;
    case "DISPATCH_AGENT":
      return `dispatch:${d.role}:${d.state}`;
    case "COMPLETE":
      return "COMPLETE";
    case "REQUIRE_HUMAN_INTERVENTION":
      return `HITL:${d.from ?? d.state}`;
  }
}

/** Pull-mode driver: INDEPENDENT_REVIEW blocks once (-> remediation loop), everything else passes. */
async function driveWithRemediation(tmpDir: string, executionId: string): Promise<ProjectRunStepResponse> {
  let reviewAttempts = 0;
  let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
  for (let guard = 0; response.status === "AGENT_ACTION_REQUIRED" && guard < 60; guard++) {
    const blocked = response.request.role === "INDEPENDENT_REVIEW" && ++reviewAttempts === 1;
    const result = blocked
      ? resultFor(response, "FINDINGS", [{ id: "R-1", severity: "HIGH", status: "OPEN", required_remediation: "fix it" }])
      : resultFor(response, "PASS");
    response = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: response.stepId, result });
  }
  return response;
}

describe("Phase 5 — decision history is persisted, ordered and compact", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-history-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records every decision of a remediation lifecycle in order, ending in COMPLETE, with contiguous step numbers", async () => {
    const executionId = "exec-p5-lifecycle";
    const final = await driveWithRemediation(tmpDir, executionId);
    expect(final.status).toBe("COMPLETED");
    if (final.status !== "COMPLETED") return;

    const labels = final.result.history.map(label);
    expect(final.result.history.map((r) => r.step)).toEqual(final.result.history.map((_, i) => i + 1));
    expect(labels[0]).toBe("INTAKE>SPECIFY");
    expect(labels.at(-1)).toBe("COMPLETE");

    // The remediation loop is visible as DECISIONS (pure transitions that stepLog never records).
    expect(labels).toContain("INDEPENDENT_REVIEW>REMEDIATION");
    expect(labels).toContain("REMEDIATION>RE_REVIEW");
    const stepLogStates = final.result.stepLog.map((r) => r.state);
    expect(stepLogStates).not.toContain("INTAKE");
    expect(labels.some((l) => l.includes(">") )).toBe(true);
    expect(final.result.history.length).toBeGreaterThan(final.result.stepLog.length);

    // Every dispatch decision has exactly one applied agent step, in the same order.
    const dispatches = final.result.history.filter((r) => r.decision.action === "DISPATCH_AGENT");
    const agentSteps = final.result.stepLog.filter((r) => r.kind === "AGENT_STEP");
    expect(dispatches).toHaveLength(agentSteps.length);
    expect(dispatches.map((d) => d.decision.action === "DISPATCH_AGENT" && d.decision.role)).toEqual(agentSteps.map((s) => s.role));
    // ...and the pull correlation id links the two records.
    expect(dispatches.map((d) => (d.decision.action === "DISPATCH_AGENT" ? d.decision.step_id : undefined))).toEqual(
      agentSteps.map((s) => s.step_id),
    );
  });

  it("is compact: no dispatch payload, result or evidence is stored, and it stays a small fraction of the live records", async () => {
    const executionId = "exec-p5-compact";
    const final = await driveWithRemediation(tmpDir, executionId);
    if (final.status !== "COMPLETED") throw new Error("expected completion");

    const persisted = await new FileExecutionStateStore(tmpDir).load(executionId);
    const history = persisted?.history ?? [];
    expect(history.length).toBeGreaterThan(0);
    for (const entry of history) {
      expect(Object.keys(entry).sort()).toEqual(["decision", "state", "step", "timestamp"]);
      for (const heavy of ["request", "context", "result", "evidence", "skills", "options", "findings"]) {
        expect(entry.decision).not.toHaveProperty(heavy);
      }
    }

    // For comparison, the same shape of run through push mode returns the live per-call
    // StepRecords (decision payloads + results) — the thing persisting verbatim would have cost.
    const adapter = new MockRuntimeAdapter((req) => ({
      execution_id: req.execution_id,
      agent: req.role,
      state: req.state,
      status: "PASS",
      evidence: ["evidence ".repeat(200)],
      findings: [],
    }));
    const live = await executeProjectRun({
      projectRoot: tmpDir,
      executionId: "exec-p5-live-comparison",
      runtime: "MOCK",
      context: { state: "INTAKE", runtime: "MOCK" },
      adapters: [adapter],
    });
    const durable = JSON.stringify(live.decisionHistory).length;
    const verbatim = JSON.stringify(live.history).length;
    expect(durable).toBeLessThan(verbatim / 8);
  });

  it("a second host (fresh calls, no shared objects) recovers the identical history via status, next-step and the checkpoint", async () => {
    const executionId = "exec-p5-second-host";
    const final = await driveWithRemediation(tmpDir, executionId);
    if (final.status !== "COMPLETED") throw new Error("expected completion");

    const persisted = await new FileExecutionStateStore(tmpDir).load(executionId);
    const viaStatus = await statusProjectRun({ executionId, projectRoot: tmpDir });
    const viaNext = await nextProjectRunStep({ projectRoot: tmpDir, executionId });

    expect(persisted?.history).toEqual(final.result.history);
    expect(viaStatus.history).toEqual(final.result.history);
    expect(viaNext.status === "COMPLETED" && viaNext.result.history).toEqual(final.result.history);
  });

  it("a human suspension is a recorded decision, and the history continues (no restart at 1) after the resume", async () => {
    const executionId = "exec-p5-hitl";
    let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    let analyzeAttempts = 0;
    let suspendedHistoryLength = 0;
    for (let guard = 0; guard < 60; guard++) {
      if (response.status === "HUMAN_INTERVENTION_REQUIRED") {
        const before = await statusProjectRun({ executionId, projectRoot: tmpDir });
        suspendedHistoryLength = before.history.length;
        expect(before.history.at(-1) && label(before.history.at(-1)!)).toBe("HITL:ANALYZE");
        response = await nextProjectRunStep({
          projectRoot: tmpDir,
          executionId,
          humanAnswers: response.humanIntervention.questions.map((q) => ({ questionId: q.id, answer: "ok" })),
        });
        continue;
      }
      if (response.status !== "AGENT_ACTION_REQUIRED") break;
      const block = response.request.state === "ANALYZE" && ++analyzeAttempts === 1;
      response = await submitProjectRunStep({
        projectRoot: tmpDir,
        executionId,
        stepId: response.stepId,
        result: block
          ? resultFor(response, "FINDINGS", [{ id: "A-1", severity: "HIGH", status: "OPEN" }])
          : resultFor(response, "PASS"),
      });
    }
    expect(response.status).toBe("COMPLETED");
    if (response.status !== "COMPLETED") return;

    const history = response.result.history;
    expect(suspendedHistoryLength).toBeGreaterThan(0);
    // The pre-suspension prefix is intact and the post-resume decisions continue the numbering.
    expect(history.slice(0, suspendedHistoryLength).map((r) => r.step)).toEqual(
      Array.from({ length: suspendedHistoryLength }, (_, i) => i + 1),
    );
    expect(history.map((r) => r.step)).toEqual(history.map((_, i) => i + 1));
    expect(history.filter((r) => r.decision.action === "REQUIRE_HUMAN_INTERVENTION")).toHaveLength(1);
    expect(history.at(-1) && label(history.at(-1)!)).toBe("COMPLETE");
  });
});

describe("Phase 5 — push mode reports and recovers the same durable history", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-push-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("start() -> suspend -> resume() carries one execution-wide history, identical to status() and the checkpoint", async () => {
    const executionId = "exec-p5-push";
    let analyzeAttempts = 0;
    const adapter = new MockRuntimeAdapter((req) => {
      if (req.state === "ANALYZE" && ++analyzeAttempts === 1) {
        return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "FINDINGS", evidence: [], findings: [{ id: "A-1", severity: "HIGH", status: "OPEN" }] };
      }
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    const started = await startProjectRun({ projectRoot: tmpDir, executionId, runtime: "MOCK", adapters: [adapter] });
    expect(started.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(started.history.length).toBeGreaterThan(0);
    expect(started.history.at(-1) && label(started.history.at(-1)!)).toBe("HITL:ANALYZE");
    expect((await new FileExecutionStateStore(tmpDir).load(executionId))?.history).toEqual(started.history);

    const resumed = await resumeProjectRun({
      projectRoot: tmpDir,
      executionId,
      runtime: "MOCK",
      adapters: [adapter],
      humanAnswers: started.humanIntervention?.questions.map((q) => ({ questionId: q.id, answer: "ok" })),
    });
    expect(resumed.status).toBe("COMPLETED");
    expect(resumed.history.slice(0, started.history.length)).toEqual(started.history);
    expect(resumed.history.map((r) => r.step)).toEqual(resumed.history.map((_, i) => i + 1));
    expect(resumed.history.at(-1) && label(resumed.history.at(-1)!)).toBe("COMPLETE");

    const status = await statusProjectRun({ executionId, projectRoot: tmpDir });
    expect(status.history).toEqual(resumed.history);
    // stepLog / stepsCount (ENG-002) are unchanged and still distinct.
    expect(status.stepsCount).toBe(9);
    expect(status.stepLog.filter((r) => r.kind === "AGENT_STEP")).toHaveLength(9);
    expect(status.history.filter((r) => r.decision.action === "DISPATCH_AGENT")).toHaveLength(9);
  });
});

describe("Phase 5 — a dispatch that never completed stays visible", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-failed-dispatch-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("push mode: when an adapter throws, history ends with the dispatch decision that has no matching step, in a FAILED checkpoint", async () => {
    let calls = 0;
    const adapter = new MockRuntimeAdapter((req) => {
      if (++calls === 3) throw new Error("runtime crashed");
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });
    const response = await startProjectRun({ projectRoot: tmpDir, executionId: "exec-p5-failed", runtime: "MOCK", adapters: [adapter] });
    expect(response.status).toBe("FAILED");
    expect(response.stepsCount).toBe(2);
    expect(response.history.at(-1) && label(response.history.at(-1)!)).toBe("dispatch:ARCHITECTURE:PLAN");
    expect(response.history.filter((r) => r.decision.action === "DISPATCH_AGENT")).toHaveLength(3); // 2 completed + the one that crashed

    const persisted = await new FileExecutionStateStore(tmpDir).load("exec-p5-failed");
    expect(persisted?.lifecycle_status).toBe("FAILED");
    expect(persisted?.history).toEqual(response.history);
  });
});

describe("Phase 5 — legacy (pre-Phase-5) checkpoints", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-legacy-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a checkpoint with no history loads, reports an empty history, keeps stepLog intact, and continues recording only new decisions", async () => {
    const executionId = "exec-p5-legacy";
    const store = new FileExecutionStateStore(tmpDir);
    let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    for (let i = 0; i < 2 && response.status === "AGENT_ACTION_REQUIRED"; i++) {
      response = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: response.stepId, result: resultFor(response, "PASS") });
    }
    if (response.status !== "AGENT_ACTION_REQUIRED") throw new Error("expected a pending action");

    // Rewrite exactly as a 0.2.0 engine would have left it: stepLog present, no history.
    const persisted = await store.load(executionId);
    if (!persisted) throw new Error("expected state");
    const priorStepLog = persisted.step_log;
    delete persisted.history;
    await store.save(persisted);
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, ".project-run", "runs", `${executionId}.json`), "utf8")).history).toBeUndefined();

    const legacy = await statusProjectRun({ executionId, projectRoot: tmpDir });
    expect(legacy.history).toEqual([]);
    expect(legacy.stepLog).toEqual(priorStepLog);
    expect(legacy.stepsCount).toBe(2);

    const pending = await nextProjectRunStep({ projectRoot: tmpDir, executionId });
    expect(pending.status === "AGENT_ACTION_REQUIRED" && pending.stepId).toBe(response.stepId);

    const next = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: response.stepId, result: resultFor(response, "PASS") });
    expect(next.status).toBe("AGENT_ACTION_REQUIRED");

    const after = await statusProjectRun({ executionId, projectRoot: tmpDir });
    // Only decisions made after the upgrade; nothing is fabricated for the two earlier steps.
    expect(after.history.map((r) => r.step)).toEqual(after.history.map((_, i) => i + 1));
    expect(after.history.map(label)).toEqual(expect.arrayContaining([expect.stringMatching(/^dispatch:/)]));
    expect(after.history.some((r) => r.decision.action === "TRANSITION" && r.decision.from === "INTAKE")).toBe(false);
    expect(after.stepsCount).toBe(3);
    expect(after.stepLog).toHaveLength(3);
  });
});
