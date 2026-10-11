// packages/project-run-engine/tests/human-answers-resume-stages.test.ts
//
// Resume-after-human-answers audit, one parametrized matrix over every stage that has an agent
// gate. For each stage whose agent returns BLOCKED, the execution suspends; registering answers
// and resuming (pull mode, the documented workflow) must RE-DISPATCH the responsible agent, and
// only a fresh accepted result may advance the run. Answers alone never clear a finding.
//
// CLARIFY, ANALYZE, RE_REVIEW and CONVERGE already re-verified before this audit and act as
// controls; the remaining stages are the ones the audit checked. IMPLEMENT also has its own
// file (implement-resume-human-answers.test.ts). Everything runs for real in a temp directory;
// only the agent boundary is synthetic.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { nextProjectRunStep, submitProjectRunStep } from "../src/host/project-run-step.js";
import { reconstructResumeContext } from "../src/project/project-run.js";
import { FileExecutionStateStore } from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";
import type { AgentResult, CoordinatorState } from "../src/domain/types.js";
import type { ProjectRunStepResponse } from "../src/host/step-types.js";

type ActionResponse = Extract<ProjectRunStepResponse, { status: "AGENT_ACTION_REQUIRED" }>;

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

const blockingFindings = (stage: string) =>
  [
    { id: `${stage}-Q1`, severity: "HIGH", status: "OPEN", required_remediation: "First decision?" },
    { id: `${stage}-Q2`, severity: "HIGH", status: "OPEN", required_remediation: "Second decision?" },
  ] as never;

interface StageCase {
  stage: CoordinatorState;
  role: string;
  /** state of the next agent action after a fresh PASS here, or COMPLETED. */
  next: CoordinatorState | "COMPLETED";
  /** ALWAYS-reverify stages drop even a clean saved result on resume; the rest keep it. */
  clearsCleanResult: boolean;
}

const STAGES: StageCase[] = [
  { stage: "SPECIFY", role: "SPECIFICATION", next: "CLARIFY", clearsCleanResult: false },
  { stage: "CLARIFY", role: "SPECIFICATION", next: "PLAN", clearsCleanResult: false },
  { stage: "PLAN", role: "ARCHITECTURE", next: "TASKS", clearsCleanResult: false },
  { stage: "TASKS", role: "ARCHITECTURE", next: "ANALYZE", clearsCleanResult: false },
  { stage: "ANALYZE", role: "ARCHITECTURE", next: "IMPLEMENT", clearsCleanResult: false },
  { stage: "IMPLEMENT", role: "IMPLEMENTATION", next: "INDEPENDENT_REVIEW", clearsCleanResult: false },
  { stage: "INDEPENDENT_REVIEW", role: "INDEPENDENT_REVIEW", next: "CONVERGE", clearsCleanResult: false },
  { stage: "REMEDIATION", role: "REMEDIATION", next: "RE_REVIEW", clearsCleanResult: false },
  { stage: "RE_REVIEW", role: "INDEPENDENT_REVIEW", next: "CONVERGE", clearsCleanResult: true },
  { stage: "CONVERGE", role: "CONVERGENCE", next: "COMPLETED", clearsCleanResult: true },
];

describe.each(STAGES)("resume after human answers: $stage", ({ stage, role, next, clearsCleanResult }) => {
  let tmpDir: string;
  let store: FileExecutionStateStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-stages-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
    store = new FileExecutionStateStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Drives the workflow with PASS everywhere except what is needed to REACH `stage`
   * (a blocking review finding to get to REMEDIATION / RE_REVIEW), and BLOCKED at `stage`.
   */
  async function driveToSuspension(executionId: string): Promise<ProjectRunStepResponse> {
    let reviewDispatches = 0;
    let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    for (let guard = 0; response.status === "AGENT_ACTION_REQUIRED" && guard < 30; guard++) {
      const action = response as ActionResponse;
      const state = action.request.state;
      let result: AgentResult;
      if (state === stage) {
        result = resultFor(action, { status: "BLOCKED", findings: blockingFindings(stage) });
      } else if (state === "INDEPENDENT_REVIEW" && (stage === "REMEDIATION" || stage === "RE_REVIEW") && reviewDispatches++ === 0) {
        result = resultFor(action, {
          status: "FINDINGS",
          findings: [{ id: "REVIEW-1", severity: "HIGH", status: "OPEN" }] as never,
        });
      } else {
        result = resultFor(action, { status: "PASS" });
      }
      response = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: action.stepId, result });
    }
    return response;
  }

  async function suspend(executionId: string): Promise<void> {
    const response = await driveToSuspension(executionId);
    expect(response.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    const persisted = await store.load(executionId);
    expect(persisted?.suspended_from).toBe(stage);
    expect(persisted?.last_result?.status).toBe("BLOCKED");
    expect(persisted?.human_intervention?.questions.map((q) => q.id)).toEqual([`${stage}-Q1`, `${stage}-Q2`]);
  }

  it("re-dispatches the responsible agent; only a fresh PASS advances; answers and history survive", async () => {
    const executionId = `exec-${stage}-resume`;
    await suspend(executionId);
    const before = (await store.load(executionId))!;

    const resumed = await nextProjectRunStep({
      projectRoot: tmpDir,
      executionId,
      humanAnswers: [
        { questionId: `${stage}-Q1`, answer: "A1", answeredBy: "alice" },
        { questionId: `${stage}-Q2`, answer: "A2", answeredBy: "alice" },
      ],
    });
    const action = expectAction(resumed);
    expect(action.request.state).toBe(stage);
    expect(action.request.role).toBe(role);

    const mid = (await store.load(executionId))!;
    expect(mid.human_answers?.map((a) => [a.questionId, a.answer])).toEqual([
      [`${stage}-Q1`, "A1"],
      [`${stage}-Q2`, "A2"],
    ]);
    expect(mid.history?.slice(0, before.history!.length)).toEqual(before.history);
    expect(mid.step_log?.slice(0, before.step_log!.length)).toEqual(before.step_log);

    const advanced = await submitProjectRunStep({
      projectRoot: tmpDir,
      executionId,
      stepId: action.stepId,
      result: resultFor(action, { status: "PASS" }),
    });
    if (next === "COMPLETED") {
      expect(advanced.status).toBe("COMPLETED");
    } else {
      expect(expectAction(advanced).request.state).toBe(next);
    }

    const after = (await new FileExecutionStateStore(tmpDir).load(executionId))!;
    expect(after.human_answers?.map((a) => a.questionId)).toEqual([`${stage}-Q1`, `${stage}-Q2`]);
    expect(after.history?.slice(0, before.history!.length)).toEqual(before.history);
    expect(after.step_log?.slice(0, before.step_log!.length)).toEqual(before.step_log);
  });

  it("a fresh BLOCKED suspends again; answers are not duplicated and a later answer appends", async () => {
    const executionId = `exec-${stage}-reblocked`;
    await suspend(executionId);

    const resumed = expectAction(
      await nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: [{ questionId: `${stage}-Q1`, answer: "A1" }] }),
    );
    expect(resumed.request.state).toBe(stage);

    const again = await submitProjectRunStep({
      projectRoot: tmpDir,
      executionId,
      stepId: resumed.stepId,
      result: resultFor(resumed, { status: "BLOCKED", findings: blockingFindings(stage) }),
    });
    expect(again.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    const persisted = (await store.load(executionId))!;
    expect(persisted.suspended_from).toBe(stage);
    expect(persisted.human_answers).toHaveLength(1);

    const resumedAgain = expectAction(
      await nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: [{ questionId: `${stage}-Q2`, answer: "A2" }] }),
    );
    expect(resumedAgain.request.state).toBe(stage);
    expect((await store.load(executionId))?.human_answers?.map((a) => [a.questionId, a.answer])).toEqual([
      [`${stage}-Q1`, "A1"],
      [`${stage}-Q2`, "A2"],
    ]);
  });

  it("no answers / empty answers keep the run suspended; a partial answer still needs a fresh agent result", async () => {
    const executionId = `exec-${stage}-gate`;
    await suspend(executionId);

    for (const humanAnswers of [undefined, []]) {
      const response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers });
      expect(response.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    }
    expect((await store.load(executionId))?.human_answers ?? []).toHaveLength(0);

    const partial = expectAction(
      await nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: [{ questionId: `${stage}-Q1`, answer: "A1" }] }),
    );
    expect(partial.request.state).toBe(stage);
    expect((await store.load(executionId))?.state).not.toBe(next);
  });

  it(`a clean saved result is ${clearsCleanResult ? "cleared (always re-verified)" : "preserved (conditional re-verification)"} on resume`, async () => {
    const executionId = `exec-${stage}-clean`;
    await suspend(executionId);

    const persisted = (await store.load(executionId))!;
    await store.save(
      { ...persisted, last_result: { ...persisted.last_result!, status: "PASS", findings: [] }, findings: [] },
      { expectedRevision: persisted.revision ?? 0 },
    );

    const reconstructed = await reconstructResumeContext({ executionId, projectRoot: tmpDir, stateStore: store });
    expect(reconstructed.ok).toBe(true);
    if (!reconstructed.ok) return;
    expect(reconstructed.context.state).toBe(stage);
    if (clearsCleanResult) {
      expect(reconstructed.context.result).toBeUndefined();
    } else {
      expect(reconstructed.context.result?.status).toBe("PASS");
    }
  });
});

describe("REMEDIATION resume keeps its remediation budget", () => {
  let tmpDir: string;
  let store: FileExecutionStateStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-remediation-budget-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
    store = new FileExecutionStateStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a human answer to a blocked REMEDIATION does not reset remediation_iteration (only an exhausted gate re-grants budget)", async () => {
    const executionId = "exec-remediation-budget";
    const finding = [{ id: "REVIEW-1", severity: "HIGH", status: "OPEN" }] as never;
    let remediations = 0;

    let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    for (let guard = 0; response.status === "AGENT_ACTION_REQUIRED" && guard < 30; guard++) {
      const action = response as ActionResponse;
      const { state } = action.request;
      let result: AgentResult;
      if (state === "INDEPENDENT_REVIEW" || state === "RE_REVIEW") {
        result = resultFor(action, { status: "FINDINGS", findings: finding }); // keeps looping through REMEDIATION
      } else if (state === "REMEDIATION") {
        result =
          ++remediations === 2
            ? resultFor(action, { status: "BLOCKED", findings: blockingFindings("REMEDIATION") })
            : resultFor(action, { status: "PASS" });
      } else {
        result = resultFor(action, { status: "PASS" });
      }
      response = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: action.stepId, result });
    }
    expect(response.status).toBe("HUMAN_INTERVENTION_REQUIRED");

    const persisted = (await store.load(executionId))!;
    expect(persisted.suspended_from).toBe("REMEDIATION");
    expect(persisted.remediation_iteration).toBe(1);

    const reconstructed = await reconstructResumeContext({
      executionId,
      projectRoot: tmpDir,
      stateStore: store,
      humanAnswers: [{ questionId: "REMEDIATION-Q1", answer: "A1" }],
    });
    expect(reconstructed.ok).toBe(true);
    if (!reconstructed.ok) return;
    expect(reconstructed.context.result).toBeUndefined();
    expect(reconstructed.context.remediation_iteration).toBe(1);
    expect(reconstructed.context.execution?.remediation_iteration).toBe(1);
  });
});
