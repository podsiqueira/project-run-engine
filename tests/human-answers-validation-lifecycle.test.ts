// packages/project-run-engine/tests/human-answers-validation-lifecycle.test.ts
//
// Companion to human-answers-validation.test.ts: how the `humanAnswers` contract behaves when the
// execution is NOT (or no longer) suspended, and when calls race.
//
//   - Answers mean something only against a suspension. The questions are dropped from the
//     checkpoint when the execution resumes, so a call that supplies answers to an execution that
//     is not suspended has nothing to validate them against: they are ignored, never recorded
//     (pull mode always did this; push `resume()` now does too — it used to record them unchecked).
//     That keeps a host's retry of `resume(answers)` after a crash harmless.
//   - The lock serialises racing calls and the answers are validated under it, against the
//     checkpoint as the lock holder sees it: an invalid call never records anything, identical
//     calls record once, and the execution never re-dispatches twice.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { nextProjectRunStep, submitProjectRunStep } from "../src/host/project-run-step.js";
import { executeProjectRun, executeProjectResume } from "../src/project/project-run.js";
import { FileExecutionStateStore } from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";
import { MockRuntimeAdapter } from "../src/runtime/mock-runtime-adapter.js";
import type { AgentDispatchRequest, AgentResult } from "../src/domain/types.js";
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

const findings = (...ids: string[]) =>
  ids.map((id) => ({ id, severity: "HIGH", status: "OPEN", required_remediation: `Decide ${id}` })) as never;

function resultFor(req: { execution_id: string; role: string; state: string }, status: AgentResult["status"], f: unknown[] = []): AgentResult {
  return { execution_id: req.execution_id, agent: req.role, state: req.state, status, evidence: [], findings: f as never } as AgentResult;
}

const BOGUS = [{ questionId: "BOGUS", answer: "x" }];
const BOTH = [
  { questionId: "IMPL-Q1", answer: "OAuth" },
  { questionId: "IMPL-Q2", answer: "Soft delete" },
];

describe("humanAnswers on non-suspended executions and under concurrency", () => {
  let tmpDir: string;
  let store: FileExecutionStateStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "answers-lifecycle-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
    store = new FileExecutionStateStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const lockFiles = () => {
    const dir = path.join(tmpDir, ".project-run", "runs");
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".lock")) : [];
  };

  /** Pull mode: suspends at IMPLEMENT (BLOCKED) with questions IMPL-Q1 and IMPL-Q2. */
  async function suspendPull(executionId: string): Promise<void> {
    let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    for (let guard = 0; response.status === "AGENT_ACTION_REQUIRED" && guard < 20; guard++) {
      const action = response as ActionResponse;
      const result =
        action.request.state === "IMPLEMENT"
          ? resultFor(action.request, "BLOCKED", findings("IMPL-Q1", "IMPL-Q2"))
          : resultFor(action.request, "PASS");
      response = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: action.stepId, result });
    }
    expect(response.status).toBe("HUMAN_INTERVENTION_REQUIRED");
  }

  /** Push mode: the same suspension. */
  async function suspendPush(executionId: string): Promise<void> {
    const run = await executeProjectRun({
      executionId,
      projectRoot: tmpDir,
      runtime: "MOCK",
      stateStore: store,
      adapters: [
        new MockRuntimeAdapter((req) =>
          req.state === "IMPLEMENT" ? resultFor(req, "BLOCKED", findings("IMPL-Q1", "IMPL-Q2")) : resultFor(req, "PASS"),
        ),
      ],
      context: { state: "INTAKE", runtime: "MOCK" },
    });
    expect(run.status).toBe("HUMAN_INTERVENTION_REQUIRED");
  }

  const dispatchCount = async (executionId: string) =>
    ((await store.load(executionId))?.history ?? []).filter((r) => r.decision.action === "DISPATCH_AGENT").length;

  function resumePush(executionId: string, humanAnswers?: { questionId: string; answer: string }[], calls: string[] = []) {
    return executeProjectResume({
      executionId,
      projectRoot: tmpDir,
      stateStore: store,
      adapters: [
        new MockRuntimeAdapter((req: AgentDispatchRequest) => {
          calls.push(`${req.role}:${req.state}`);
          return resultFor(req, "PASS");
        }),
      ],
      humanAnswers,
    });
  }

  /** The AWAITING_AGENT_ACTION checkpoint rewritten as the mid-sequence IN_PROGRESS one (a clean saved result, nothing pending). */
  async function makeInProgress(executionId: string): Promise<void> {
    const p = (await store.load(executionId))!;
    await store.save(
      {
        ...p,
        lifecycle_status: "IN_PROGRESS",
        pending_action: undefined,
        last_result: { ...(p.last_result ?? ({} as AgentResult)), status: "PASS", findings: [] } as AgentResult,
        findings: [],
      },
      { expectedRevision: p.revision ?? 0 },
    );
    expect((await store.load(executionId))?.lifecycle_status).toBe("IN_PROGRESS");
  }

  describe("not suspended: answers are ignored, never recorded", () => {
    it("the checkpoint drops the questions on resume (so there is nothing to validate against)", async () => {
      const executionId = "exec-life-questions";
      await suspendPull(executionId);
      expect((await store.load(executionId))?.human_intervention?.questions).toHaveLength(2);
      expect((await nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: BOTH })).status).toBe("AGENT_ACTION_REQUIRED");
      const resumed = (await store.load(executionId))!;
      expect(resumed.lifecycle_status).toBe("AWAITING_AGENT_ACTION");
      expect(resumed.human_intervention).toBeUndefined();
    });

    it("pull, AWAITING_AGENT_ACTION: the pending action is returned and invalid answers are not recorded", async () => {
      const executionId = "exec-life-pull-awaiting";
      await suspendPull(executionId);
      const pending = (await nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: BOTH })) as ActionResponse;
      const before = (await store.load(executionId))!;

      for (const answers of [BOGUS, [{ questionId: "IMPL-Q1", answer: "  " }]]) {
        const again = await nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: answers });
        expect(again.status).toBe("AGENT_ACTION_REQUIRED");
        if (again.status === "AGENT_ACTION_REQUIRED") expect(again.stepId).toBe(pending.stepId);
      }
      const after = (await store.load(executionId))!;
      expect(after.revision).toBe(before.revision);
      expect(after.human_answers).toHaveLength(2);
    });

    it("pull, IN_PROGRESS: the execution is recovered and advanced; the answers are not recorded", async () => {
      const executionId = "exec-life-pull-inprogress";
      await suspendPull(executionId);
      await nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: BOTH });
      await makeInProgress(executionId);

      const recovered = await nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: BOGUS });
      expect(recovered.status).toBe("AGENT_ACTION_REQUIRED");
      expect((await store.load(executionId))?.human_answers).toHaveLength(2);
    });

    it("pull, COMPLETED: a read of the completed execution; answers are not recorded", async () => {
      const executionId = "exec-life-pull-completed";
      await suspendPull(executionId);
      let r: ProjectRunStepResponse = await nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: BOTH });
      for (let guard = 0; r.status === "AGENT_ACTION_REQUIRED" && guard < 20; guard++) {
        r = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: r.stepId, result: resultFor(r.request, "PASS") });
      }
      expect(r.status).toBe("COMPLETED");

      const late = await nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: BOGUS });
      expect(late.status).toBe("COMPLETED");
      expect((await store.load(executionId))?.human_answers).toHaveLength(2);
    });

    it("push, AWAITING_AGENT_ACTION: the run continues but the answers are not recorded (they used to be, unchecked)", async () => {
      const executionId = "exec-life-push-awaiting";
      await suspendPull(executionId);
      await nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: BOTH });
      expect((await store.load(executionId))?.lifecycle_status).toBe("AWAITING_AGENT_ACTION");

      const calls: string[] = [];
      const resumed = await resumePush(executionId, BOGUS, calls);

      expect(resumed.status).toBe("COMPLETED");
      expect(resumed.answerFailure).toBeUndefined();
      expect(calls[0]).toBe("IMPLEMENTATION:IMPLEMENT");
      expect((await store.load(executionId))?.human_answers?.map((a) => a.questionId)).toEqual(["IMPL-Q1", "IMPL-Q2"]);
    });

    it("push, IN_PROGRESS: the run continues but the answers are not recorded", async () => {
      const executionId = "exec-life-push-inprogress";
      await suspendPull(executionId);
      await nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: BOTH });
      await makeInProgress(executionId);

      const resumed = await resumePush(executionId, [{ questionId: "IMPL-Q1", answer: "again" }]);
      expect(resumed.status).toBe("COMPLETED");
      expect((await store.load(executionId))?.human_answers).toHaveLength(2);
    });

    it("push, retrying resume(answers) after the first call completed the run is not-resumable and records nothing twice", async () => {
      const executionId = "exec-life-push-retry";
      await suspendPush(executionId);
      expect((await resumePush(executionId, BOTH)).status).toBe("COMPLETED");

      const retry = await resumePush(executionId, BOTH);
      expect(retry.status).toBe("FAILED");
      expect(retry.failureReason).toMatch(/^EXECUTION_NOT_RESUMABLE/);
      expect(retry.answerFailure).toBeUndefined();
      expect((await store.load(executionId))?.human_answers).toHaveLength(2);
    });

    it("push, still suspended: validation applies exactly as before (the adjustment only affects non-suspended executions)", async () => {
      const executionId = "exec-life-push-still-suspended";
      await suspendPush(executionId);
      const rejected = await resumePush(executionId, BOGUS);
      expect(rejected.answerFailure).toBe("INVALID_HUMAN_ANSWERS");
      expect((await store.load(executionId))?.human_answers ?? []).toHaveLength(0);
    });
  });

  describe("concurrency", () => {
    it("pull: a valid call and an invalid call racing — only the valid answers are ever recorded, one re-dispatch", async () => {
      for (let round = 0; round < 6; round++) {
        const executionId = `exec-race-valid-invalid-${round}`;
        await suspendPull(executionId);
        const before = await dispatchCount(executionId);

        const valid = nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: BOTH });
        const invalid = nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: BOGUS });
        const [v, i] = round % 2 === 0 ? await Promise.all([valid, invalid]) : (await Promise.all([invalid, valid])).reverse();

        expect(v.status).toBe("AGENT_ACTION_REQUIRED");
        if (i.status === "FAILED") {
          // the invalid call won the lock: rejected whole, and the suspension was left for the valid call
          expect(i.failureCode).toBe("INVALID_HUMAN_ANSWERS");
          expect(i.terminal).toBe(false);
        } else {
          // the valid call won: the invalid one saw the already-resumed execution and got its pending action
          expect(i.status).toBe("AGENT_ACTION_REQUIRED");
          if (i.status === "AGENT_ACTION_REQUIRED" && v.status === "AGENT_ACTION_REQUIRED") expect(i.stepId).toBe(v.stepId);
        }
        const after = (await store.load(executionId))!;
        expect(after.human_answers?.map((a) => [a.questionId, a.answer])).toEqual([
          ["IMPL-Q1", "OAuth"],
          ["IMPL-Q2", "Soft delete"],
        ]);
        expect((await dispatchCount(executionId)) - before).toBe(1);
      }
      expect(lockFiles()).toEqual([]);
    }, 60_000);

    it("pull: two hosts answering DIFFERENT questions at once — one wins, one re-dispatch, no duplicates; the loser's answer is not recorded", async () => {
      for (let round = 0; round < 4; round++) {
        const executionId = `exec-race-different-${round}`;
        await suspendPull(executionId);
        const before = await dispatchCount(executionId);

        const [a, b] = await Promise.all([
          nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: [{ questionId: "IMPL-Q1", answer: "from-A" }] }),
          nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: [{ questionId: "IMPL-Q2", answer: "from-B" }] }),
        ]);
        expect(a.status).toBe("AGENT_ACTION_REQUIRED");
        expect(b.status).toBe("AGENT_ACTION_REQUIRED");
        if (a.status === "AGENT_ACTION_REQUIRED" && b.status === "AGENT_ACTION_REQUIRED") expect(a.stepId).toBe(b.stepId);

        const after = (await store.load(executionId))!;
        expect(after.human_answers).toHaveLength(1);
        expect(["from-A", "from-B"]).toContain(after.human_answers![0].answer);
        expect((await dispatchCount(executionId)) - before).toBe(1);
      }
      expect(lockFiles()).toEqual([]);
    }, 60_000);

    it("push: two identical resume calls racing — answers recorded once, the agent runs once, the loser is not-resumable", async () => {
      for (let round = 0; round < 4; round++) {
        const executionId = `exec-race-push-identical-${round}`;
        await suspendPush(executionId);
        const calls: string[] = [];

        const results = await Promise.all([resumePush(executionId, BOTH, calls), resumePush(executionId, BOTH, calls)]);

        expect(results.map((r) => r.status).sort()).toEqual(["COMPLETED", "FAILED"]);
        const loser = results.find((r) => r.status === "FAILED")!;
        expect(loser.failureReason).toMatch(/^EXECUTION_NOT_RESUMABLE/);
        expect(loser.answerFailure).toBeUndefined();
        expect(calls.filter((c) => c === "IMPLEMENTATION:IMPLEMENT")).toHaveLength(1);
        expect((await store.load(executionId))?.human_answers?.map((a) => a.questionId)).toEqual(["IMPL-Q1", "IMPL-Q2"]);
      }
      expect(lockFiles()).toEqual([]);
    }, 60_000);

    it("push: a valid and an invalid resume racing — the invalid answers are never recorded", async () => {
      for (let round = 0; round < 6; round++) {
        const executionId = `exec-race-push-valid-invalid-${round}`;
        await suspendPush(executionId);

        const valid = resumePush(executionId, BOTH);
        const invalid = resumePush(executionId, BOGUS);
        const [v, i] = round % 2 === 0 ? await Promise.all([valid, invalid]) : (await Promise.all([invalid, valid])).reverse();

        expect(v.status).toBe("COMPLETED");
        expect(i.status).toBe("FAILED");
        // either it lost the lock race (execution already completed) or was rejected first
        expect(i.answerFailure === "INVALID_HUMAN_ANSWERS" || /^EXECUTION_NOT_RESUMABLE/.test(i.failureReason ?? "")).toBe(true);
        const answers = (await store.load(executionId))?.human_answers ?? [];
        expect(answers.map((a) => a.questionId)).toEqual(["IMPL-Q1", "IMPL-Q2"]);
      }
      expect(lockFiles()).toEqual([]);
    }, 60_000);
  });
});
