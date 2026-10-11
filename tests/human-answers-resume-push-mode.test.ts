// packages/project-run-engine/tests/human-answers-resume-push-mode.test.ts
//
// Push-mode counterpart of human-answers-resume-stages.test.ts. `executeProjectResume` shares
// `reconstructResumeContext` with the pull-mode step API, so a stage missing from the resume
// re-verification policy strands a push-mode execution the same way. The push contract differs
// from pull in two real ways, and these tests target them:
//   - `resume` runs the Coordinator loop to its next terminal point in ONE call, so after the
//     responsible agent is re-invoked and passes, the run continues (to COMPLETED here);
//   - re-verification does not depend on answers being supplied: a resume without answers also
//     re-invokes the agent (it never advances on its own — only a fresh accepted result does).
// Everything runs for real in a temp directory; only the agent boundary (MockRuntimeAdapter) is
// synthetic.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { executeProjectRun, executeProjectResume } from "../src/project/project-run.js";
import { FileExecutionStateStore } from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";
import { MockRuntimeAdapter } from "../src/runtime/mock-runtime-adapter.js";
import type { AgentDispatchRequest, AgentResult, CoordinatorState } from "../src/domain/types.js";

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

function result(req: AgentDispatchRequest, status: AgentResult["status"], findings: unknown[] = []): AgentResult {
  return { execution_id: req.execution_id, agent: req.role, state: req.state, status, evidence: [], findings: findings as never };
}

const blockingFindings = (stage: string) => [
  { id: `${stage}-Q1`, severity: "HIGH", status: "OPEN", required_remediation: "First decision?" },
  { id: `${stage}-Q2`, severity: "HIGH", status: "OPEN", required_remediation: "Second decision?" },
];

const STAGES: Array<{ stage: CoordinatorState; role: string }> = [
  { stage: "SPECIFY", role: "SPECIFICATION" },
  { stage: "CLARIFY", role: "SPECIFICATION" },
  { stage: "PLAN", role: "ARCHITECTURE" },
  { stage: "TASKS", role: "ARCHITECTURE" },
  { stage: "ANALYZE", role: "ARCHITECTURE" },
  { stage: "IMPLEMENT", role: "IMPLEMENTATION" },
  { stage: "INDEPENDENT_REVIEW", role: "INDEPENDENT_REVIEW" },
  { stage: "REMEDIATION", role: "REMEDIATION" },
  { stage: "RE_REVIEW", role: "INDEPENDENT_REVIEW" },
  { stage: "CONVERGE", role: "CONVERGENCE" },
];

describe("push-mode resume after human answers", () => {
  let tmpDir: string;
  let store: FileExecutionStateStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-push-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
    store = new FileExecutionStateStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** PASS everywhere except what is needed to reach `stage`, and BLOCKED at `stage`. */
  function suspendingHandler(stage: CoordinatorState) {
    let reviews = 0;
    return (req: AgentDispatchRequest): AgentResult => {
      if (req.state === stage) return result(req, "BLOCKED", blockingFindings(stage));
      if (req.state === "INDEPENDENT_REVIEW" && (stage === "REMEDIATION" || stage === "RE_REVIEW") && reviews++ === 0) {
        return result(req, "FINDINGS", [{ id: "REVIEW-1", severity: "HIGH", status: "OPEN" }]);
      }
      return result(req, "PASS");
    };
  }

  async function suspend(executionId: string, stage: CoordinatorState) {
    const run = await executeProjectRun({
      executionId,
      projectRoot: tmpDir,
      runtime: "MOCK",
      stateStore: store,
      adapters: [new MockRuntimeAdapter(suspendingHandler(stage))],
      context: { state: "INTAKE", runtime: "MOCK" },
    });
    expect(run.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    const persisted = (await store.load(executionId))!;
    expect(persisted.suspended_from).toBe(stage);
    expect(persisted.last_result?.status).toBe("BLOCKED");
    return persisted;
  }

  function resume(executionId: string, handler: (req: AgentDispatchRequest) => AgentResult, humanAnswers?: { questionId: string; answer: string }[]) {
    return executeProjectResume({
      executionId,
      projectRoot: tmpDir,
      stateStore: store,
      adapters: [new MockRuntimeAdapter(handler)],
      humanAnswers,
    });
  }

  describe.each(STAGES)("$stage", ({ stage, role }) => {
    it("re-invokes the responsible agent first, then needs its fresh PASS to continue; answers and history survive", async () => {
      const executionId = `exec-push-${stage}`;
      const before = await suspend(executionId, stage);

      const dispatched: string[] = [];
      const resumed = await resume(
        executionId,
        (req) => {
          dispatched.push(`${req.role}:${req.state}`);
          return result(req, "PASS");
        },
        [
          { questionId: `${stage}-Q1`, answer: "A1" },
          { questionId: `${stage}-Q2`, answer: "A2" },
        ],
      );

      expect(dispatched[0]).toBe(`${role}:${stage}`);
      expect(resumed.status).toBe("COMPLETED");

      const after = (await store.load(executionId))!;
      expect(after.human_answers?.map((a) => [a.questionId, a.answer])).toEqual([
        [`${stage}-Q1`, "A1"],
        [`${stage}-Q2`, "A2"],
      ]);
      expect(after.history?.slice(0, before.history!.length)).toEqual(before.history);
      expect(after.step_log?.slice(0, before.step_log!.length)).toEqual(before.step_log);
    });

    it("a fresh BLOCKED suspends again after exactly one re-invocation; a later answer appends", async () => {
      const executionId = `exec-push-${stage}-reblocked`;
      await suspend(executionId, stage);

      const dispatched: string[] = [];
      const blockedAgain = (req: AgentDispatchRequest) => {
        dispatched.push(`${req.role}:${req.state}`);
        return result(req, "BLOCKED", blockingFindings(stage));
      };
      const again = await resume(executionId, blockedAgain, [{ questionId: `${stage}-Q1`, answer: "A1" }]);

      expect(again.status).toBe("HUMAN_INTERVENTION_REQUIRED");
      expect(dispatched).toEqual([`${role}:${stage}`]);
      const persisted = (await store.load(executionId))!;
      expect(persisted.suspended_from).toBe(stage);
      expect(persisted.human_answers).toHaveLength(1);

      await resume(executionId, blockedAgain, [{ questionId: `${stage}-Q2`, answer: "A2" }]);
      expect((await store.load(executionId))?.human_answers?.map((a) => [a.questionId, a.answer])).toEqual([
        [`${stage}-Q1`, "A1"],
        [`${stage}-Q2`, "A2"],
      ]);
    });

    it("resuming without answers still never advances without the agent's fresh accepted result", async () => {
      const executionId = `exec-push-${stage}-noanswers`;
      await suspend(executionId, stage);

      const dispatched: string[] = [];
      const resumed = await resume(executionId, (req) => {
        dispatched.push(`${req.role}:${req.state}`);
        return result(req, "BLOCKED", blockingFindings(stage));
      });

      expect(resumed.status).toBe("HUMAN_INTERVENTION_REQUIRED");
      expect(dispatched).toEqual([`${role}:${stage}`]);
      expect((await store.load(executionId))?.human_answers ?? []).toHaveLength(0);
    });
  });

  describe("REMEDIATION budget", () => {
    /** Reaches a blocked REMEDIATION at remediation_iteration 1 (second remediation of the loop). */
    async function suspendBlockedRemediationAtIteration1(executionId: string) {
      let remediations = 0;
      const run = await executeProjectRun({
        executionId,
        projectRoot: tmpDir,
        runtime: "MOCK",
        stateStore: store,
        adapters: [
          new MockRuntimeAdapter((req) => {
            if (req.state === "INDEPENDENT_REVIEW" || req.state === "RE_REVIEW") {
              return result(req, "FINDINGS", [{ id: "REVIEW-1", severity: "HIGH", status: "OPEN" }]);
            }
            if (req.state === "REMEDIATION") {
              return ++remediations === 2 ? result(req, "BLOCKED", blockingFindings("REMEDIATION")) : result(req, "PASS");
            }
            return result(req, "PASS");
          }),
        ],
        context: { state: "INTAKE", runtime: "MOCK" },
      });
      expect(run.status).toBe("HUMAN_INTERVENTION_REQUIRED");
      const persisted = (await store.load(executionId))!;
      expect(persisted.suspended_from).toBe("REMEDIATION");
      expect(persisted.remediation_iteration).toBe(1);
    }

    it("resume after a blocked REMEDIATION keeps the budget: the loop escalates at MAX_REMEDIATION_ITERATIONS, not three loops later", async () => {
      const executionId = "exec-push-remediation-budget";
      await suspendBlockedRemediationAtIteration1(executionId);

      const dispatched: string[] = [];
      const resumed = await resume(
        executionId,
        (req) => {
          dispatched.push(req.state);
          return req.state === "RE_REVIEW"
            ? result(req, "FINDINGS", [{ id: "REVIEW-1", severity: "HIGH", status: "OPEN" }])
            : result(req, "PASS");
        },
        [{ questionId: "REMEDIATION-Q1", answer: "A1" }],
      );

      // Budget preserved at 1: re-invoked remediation + 2 more loops (iterations 2 and 3), then the
      // re-review gate is exhausted. A reset to 0 would allow a fourth REMEDIATION dispatch.
      expect(dispatched.filter((s) => s === "REMEDIATION")).toHaveLength(3);
      expect(resumed.status).toBe("HUMAN_INTERVENTION_REQUIRED");
      const persisted = (await store.load(executionId))!;
      expect(persisted.suspended_from).toBe("RE_REVIEW");
      expect(persisted.remediation_iteration).toBe(3);
    });
  });
});
