// packages/project-run-engine/tests/implement-resume-human-answers.test.ts
//
// Regression: an execution suspended at HUMAN_INTERVENTION_REQUIRED from IMPLEMENT after a
// BLOCKED result must be recoverable once the human decisions are registered.
//
// Root cause under test: `shouldReverifyOnResume` (src/project/project-run.ts) re-verified
// RE_REVIEW/CONVERGE (always) and CLARIFY/ANALYZE (conditionally) but not IMPLEMENT, so resume
// kept the stale BLOCKED `last_result`; the decision engine's IMPLEMENT gate then re-evaluated
// it and suspended again immediately, without the Implementation agent ever being re-dispatched
// — regardless of the answers on file. Everything runs for real (Coordinator, decision engine,
// FileExecutionStateStore) in a disposable temp directory; only the agent boundary is synthetic.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { nextProjectRunStep, submitProjectRunStep } from "../src/host/project-run-step.js";
import { reconstructResumeContext } from "../src/project/project-run.js";
import { FileExecutionStateStore } from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";
import type { AgentResult } from "../src/domain/types.js";
import type { ProjectRunStepResponse } from "../src/host/step-types.js";

type ActionResponse = Extract<ProjectRunStepResponse, { status: "AGENT_ACTION_REQUIRED" }>;
type SuspendedResponse = Extract<ProjectRunStepResponse, { status: "HUMAN_INTERVENTION_REQUIRED" }>;

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

function resultFor(response: ActionResponse, extra: Partial<AgentResult> & { status: AgentResult["status"] }): AgentResult {
  return {
    execution_id: response.request.execution_id,
    agent: response.request.role,
    state: response.request.state,
    evidence: [],
    findings: [],
    ...extra,
  };
}

function expectAction(response: ProjectRunStepResponse): ActionResponse {
  expect(response.status).toBe("AGENT_ACTION_REQUIRED");
  return response as ActionResponse;
}

const BLOCKING_FINDINGS = [
  { id: "IMPL-Q1", severity: "HIGH", status: "OPEN", required_remediation: "Which auth model should the endpoint use?" },
  { id: "IMPL-Q2", severity: "HIGH", status: "OPEN", required_remediation: "Should deletes be soft or hard?" },
] as never;

describe("IMPLEMENT suspension recovery (pull mode)", () => {
  let tmpDir: string;
  let store: FileExecutionStateStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "implement-resume-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
    store = new FileExecutionStateStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Drives SPECIFY..ANALYZE to PASS, then has IMPLEMENT return BLOCKED with two required decisions. */
  async function suspendAtImplement(executionId: string): Promise<SuspendedResponse> {
    let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    let guard = 0;
    while (response.status === "AGENT_ACTION_REQUIRED" && guard++ < 20) {
      const action = response as ActionResponse;
      const result =
        action.request.state === "IMPLEMENT"
          ? resultFor(action, { status: "BLOCKED", findings: BLOCKING_FINDINGS })
          : resultFor(action, { status: "PASS" });
      response = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: action.stepId, result });
    }
    expect(response.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    return response as SuspendedResponse;
  }

  it("registered answers re-dispatch the Implementation agent instead of re-suspending on the stale BLOCKED result", async () => {
    const executionId = "exec-implement-resume";
    const suspended = await suspendAtImplement(executionId);
    expect(suspended.humanIntervention.suspendedFrom).toBe("IMPLEMENT");
    const questionIds = suspended.humanIntervention.questions.map((q) => q.id);
    expect(questionIds).toEqual(["IMPL-Q1", "IMPL-Q2"]);

    const before = await store.load(executionId);
    expect(before?.suspended_from).toBe("IMPLEMENT");
    expect(before?.last_result?.status).toBe("BLOCKED");

    // Reading without answers is a non-mutating read of the same suspension.
    const reread = await nextProjectRunStep({ projectRoot: tmpDir, executionId });
    expect(reread.status).toBe("HUMAN_INTERVENTION_REQUIRED");

    // Register both answers; resume through the documented pull-mode workflow.
    const resumed = await nextProjectRunStep({
      projectRoot: tmpDir,
      executionId,
      humanAnswers: [
        { questionId: "IMPL-Q1", answer: "OAuth", answeredBy: "alice" },
        { questionId: "IMPL-Q2", answer: "Soft delete", answeredBy: "alice" },
      ],
    });
    const action = expectAction(resumed);
    expect(action.request.role).toBe("IMPLEMENTATION");
    expect(action.request.state).toBe("IMPLEMENT");

    // Answers are persisted, tied to their questions, and not duplicated.
    const mid = await store.load(executionId);
    expect(mid?.human_answers?.map((a) => [a.questionId, a.answer])).toEqual([
      ["IMPL-Q1", "OAuth"],
      ["IMPL-Q2", "Soft delete"],
    ]);
    expect(mid?.human_answers?.every((a) => typeof a.recordedAt === "string")).toBe(true);

    // Prior history is intact (resumed record extends, never rewrites, what existed).
    expect(mid?.history?.slice(0, before!.history!.length)).toEqual(before!.history);
    expect(mid?.step_log?.slice(0, before!.step_log!.length)).toEqual(before!.step_log);

    // The re-verification passes: valid transition to INDEPENDENT_REVIEW; answers survive it.
    const next = await submitProjectRunStep({
      projectRoot: tmpDir,
      executionId,
      stepId: action.stepId,
      result: resultFor(action, { status: "PASS" }),
    });
    expect(expectAction(next).request.state).toBe("INDEPENDENT_REVIEW");

    const after = await new FileExecutionStateStore(tmpDir).load(executionId);
    expect(after?.human_answers).toHaveLength(2);
    expect(after?.human_answers?.map((a) => a.questionId)).toEqual(["IMPL-Q1", "IMPL-Q2"]);
    expect(after?.history?.slice(0, before!.history!.length)).toEqual(before!.history);
  });

  it("a genuinely unresolved BLOCKED finding still suspends after the re-dispatch, without duplicating answers", async () => {
    const executionId = "exec-implement-still-blocked";
    await suspendAtImplement(executionId);

    const resumed = expectAction(
      await nextProjectRunStep({
        projectRoot: tmpDir,
        executionId,
        humanAnswers: [{ questionId: "IMPL-Q1", answer: "OAuth" }],
      }),
    );
    expect(resumed.request.state).toBe("IMPLEMENT");

    // The agent independently verifies and is still blocked: the gate must still hold.
    const again = await submitProjectRunStep({
      projectRoot: tmpDir,
      executionId,
      stepId: resumed.stepId,
      result: resultFor(resumed, { status: "BLOCKED", findings: BLOCKING_FINDINGS }),
    });
    expect(again.status).toBe("HUMAN_INTERVENTION_REQUIRED");

    const persisted = await store.load(executionId);
    expect(persisted?.state).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(persisted?.suspended_from).toBe("IMPLEMENT");
    expect(persisted?.human_answers).toHaveLength(1);

    // A later answer for the remaining question appends; the earlier answer is not lost or overwritten.
    const resumedAgain = expectAction(
      await nextProjectRunStep({
        projectRoot: tmpDir,
        executionId,
        humanAnswers: [{ questionId: "IMPL-Q2", answer: "Soft delete" }],
      }),
    );
    expect(resumedAgain.request.state).toBe("IMPLEMENT");
    const final = await store.load(executionId);
    expect(final?.human_answers?.map((a) => [a.questionId, a.answer])).toEqual([
      ["IMPL-Q1", "OAuth"],
      ["IMPL-Q2", "Soft delete"],
    ]);
  });

  it("no answers (or an empty list) keep the execution suspended and never advance it", async () => {
    const executionId = "exec-implement-no-answers";
    await suspendAtImplement(executionId);

    for (const humanAnswers of [undefined, []]) {
      const response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers });
      expect(response.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    }
    const persisted = await store.load(executionId);
    expect(persisted?.state).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(persisted?.human_answers ?? []).toHaveLength(0);
  });

  it("incomplete answers never advance by themselves: only a fresh PASS from the agent moves past IMPLEMENT", async () => {
    const executionId = "exec-implement-partial";
    await suspendAtImplement(executionId);

    const resumed = expectAction(
      await nextProjectRunStep({
        projectRoot: tmpDir,
        executionId,
        humanAnswers: [{ questionId: "IMPL-Q1", answer: "OAuth" }], // IMPL-Q2 unanswered
      }),
    );
    expect(resumed.request.state).toBe("IMPLEMENT");
    expect((await store.load(executionId))?.state).not.toBe("INDEPENDENT_REVIEW");
  });

  it("an IMPLEMENT suspension whose persisted result is clean keeps that result on resume (conditional, like CLARIFY/ANALYZE)", async () => {
    const executionId = "exec-implement-clean-snapshot";
    await suspendAtImplement(executionId);

    // Simulate a suspension that was not caused by the agent's own result.
    const persisted = (await store.load(executionId))!;
    await store.save(
      { ...persisted, last_result: { ...persisted.last_result!, status: "PASS", findings: [] }, findings: [] },
      { expectedRevision: persisted.revision ?? 0 },
    );

    const reconstructed = await reconstructResumeContext({ executionId, projectRoot: tmpDir, stateStore: store });
    expect(reconstructed.ok).toBe(true);
    if (!reconstructed.ok) return;
    expect(reconstructed.context.state).toBe("IMPLEMENT");
    expect(reconstructed.context.result?.status).toBe("PASS");
  });
});
