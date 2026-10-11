// packages/project-run-engine/tests/human-answers-validation.test.ts
//
// The `humanAnswers` contract on resume (audit-trail quality and host feedback — NOT the safety
// invariant, which is covered by human-answers-resume-*.test.ts: answers never clear a finding or
// advance the run, only the responsible agent's fresh accepted result does):
//   - every questionId must belong to the CURRENT suspension's questions;
//   - answers are recorded trimmed and must not be empty;
//   - inside one call identical answers collapse and different answers for one question conflict;
//   - across calls nothing is deduplicated: each call appends, so corrections keep both events;
//   - one invalid entry rejects the whole call (INVALID_HUMAN_ANSWERS): nothing is recorded, no
//     agent runs, the execution stays suspended and a corrected call then succeeds;
//   - a checkpoint with no persisted questions (older than they were persisted) cannot be checked
//     against ids, but still gets the empty/conflict rules.
// Missing/partial answers are deliberately NOT validated (a separate, deferred decision).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { nextProjectRunStep, submitProjectRunStep } from "../src/host/project-run-step.js";
import { resumeProjectRun } from "../src/host/project-run-host.js";
import { executeProjectRun, executeProjectResume } from "../src/project/project-run.js";
import { FileExecutionStateStore } from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";
import { MockRuntimeAdapter } from "../src/runtime/mock-runtime-adapter.js";
import {
  MAX_REFLECTED_ID_LENGTH,
  describeInvalidHumanAnswers,
  validateHumanAnswers,
} from "../src/decision/human-answer-validation.js";
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

describe("validateHumanAnswers (unit)", () => {
  const questions = [
    { id: "Q1", question: "?", required: true },
    { id: "Q2", question: "?", required: true },
  ];

  it("accepts known ids, trims answers and keeps extra audit fields", () => {
    const r = validateHumanAnswers([{ questionId: "Q1", answer: "  OAuth \n", answeredBy: "alice" }], questions);
    expect(r).toEqual({ ok: true, answers: [{ questionId: "Q1", answer: "OAuth", answeredBy: "alice" }] });
  });

  it("answering fewer questions than were asked is accepted (missing answers are not validated)", () => {
    expect(validateHumanAnswers([{ questionId: "Q2", answer: "x" }], questions).ok).toBe(true);
  });

  it("collects every problem rather than stopping at the first", () => {
    const r = validateHumanAnswers(
      [
        { questionId: "NOPE", answer: "x" },
        { questionId: "Q1", answer: "   " },
        { questionId: "Q2", answer: "a" },
        { questionId: "Q2", answer: "b" },
        null,
        { questionId: "Q1", answer: 7 },
        { answer: "no id" },
      ],
      questions,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toEqual([
      "UNKNOWN_QUESTION_ID",
      "EMPTY_ANSWER",
      "CONFLICTING_ANSWERS",
      "MALFORMED_ANSWER",
      "MALFORMED_ANSWER",
      "MALFORMED_ANSWER",
    ]);
  });

  it("collapses identical answers inside a call (after trimming) and reports a conflict once per question", () => {
    const same = validateHumanAnswers([{ questionId: "Q1", answer: "A" }, { questionId: "Q1", answer: " A " }], questions);
    expect(same).toEqual({ ok: true, answers: [{ questionId: "Q1", answer: "A" }] });

    const conflict = validateHumanAnswers(
      [{ questionId: "Q1", answer: "A" }, { questionId: "Q1", answer: "B" }, { questionId: "Q1", answer: "C" }],
      questions,
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.issues).toHaveLength(1);
  });

  it("without persisted questions ids cannot be checked, but empty/conflicting answers are still rejected", () => {
    for (const q of [undefined, []]) {
      expect(validateHumanAnswers([{ questionId: "anything", answer: "x" }], q).ok).toBe(true);
      expect(validateHumanAnswers([{ questionId: "anything", answer: " " }], q).ok).toBe(false);
    }
  });
});

describe("diagnostics are bounded (unit)", () => {
  const SECRET = "SECRET-ANSWER-TEXT-do-not-echo";
  const questions = [{ id: "Q1", question: "?", required: true }];
  const reason = (submitted: unknown[], qs: typeof questions | undefined = questions) => {
    const r = validateHumanAnswers(submitted, qs);
    expect(r.ok).toBe(false);
    return r.ok ? "" : describeInvalidHumanAnswers("exec", r.issues);
  };

  it("shows an id of exactly the limit in full and clips one character longer, reporting its length", () => {
    const atLimit = "a".repeat(MAX_REFLECTED_ID_LENGTH);
    const over = "b".repeat(MAX_REFLECTED_ID_LENGTH + 1);
    expect(reason([{ questionId: atLimit, answer: SECRET }])).toContain(`'${atLimit}'`);
    const clipped = reason([{ questionId: over, answer: SECRET }]);
    expect(clipped).not.toContain(over);
    expect(clipped).toContain(`'${"b".repeat(MAX_REFLECTED_ID_LENGTH)}...(${MAX_REFLECTED_ID_LENGTH + 1} chars)'`);
  });

  it("an enormous unknown id is still rejected (as unknown) and yields a short message", () => {
    const huge = "x".repeat(1_000_000);
    const r = validateHumanAnswers([{ questionId: huge, answer: SECRET }], questions);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toEqual(["UNKNOWN_QUESTION_ID"]);
    expect(describeInvalidHumanAnswers("exec", r.issues).length).toBeLessThan(600);
  });

  it("neutralises control characters so an id cannot forge extra lines in a log", () => {
    const text = reason([{ questionId: "Q9\nINVALID_HUMAN_ANSWERS: forged\r\u0000", answer: SECRET }]);
    expect(text).not.toMatch(/[\u0000-\u001f]/);
    expect(text).toContain("Q9?INVALID_HUMAN_ANSWERS: forged??");
  });

  it("never echoes answer text, whatever the problem", () => {
    const text = reason([
      { questionId: "NOPE", answer: SECRET },
      { questionId: "Q1", answer: " " },
      { questionId: "Q1", answer: 42 },
      { questionId: "Q1", answer: SECRET },
      { questionId: "Q1", answer: `${SECRET}-different` },
    ]);
    expect(text).not.toContain("SECRET");
  });

  it("lists at most a few valid ids and at most a few problems, summarising the rest", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `Q-${i}`, question: "?", required: true }));
    const idsText = reason([{ questionId: "NOPE", answer: "a" }], many);
    expect(idsText).toContain("Q-0, Q-1, Q-2, Q-3, Q-4, Q-5, Q-6, Q-7, and 42 more");
    expect(idsText).not.toContain("Q-8");

    const flood = Array.from({ length: 500 }, (_, i) => ({ questionId: `bad-${i}`, answer: "a" }));
    const floodText = reason(flood);
    expect(floodText).toContain("and 480 more problems");
    expect(floodText.length).toBeLessThan(4000);
  });

  it("does not invent an id-length rule: a long id that IS a question of the suspension is accepted", () => {
    const longId = "finding-".concat("z".repeat(500));
    const r = validateHumanAnswers([{ questionId: longId, answer: "ok" }], [{ id: longId, question: "?", required: true }]);
    expect(r).toEqual({ ok: true, answers: [{ questionId: longId, answer: "ok" }] });
  });
});

describe("humanAnswers validation on resume", () => {
  let tmpDir: string;
  let store: FileExecutionStateStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "answers-validation-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
    store = new FileExecutionStateStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("pull mode", () => {
    /** Suspends at IMPLEMENT (BLOCKED) with questions IMPL-Q1 and IMPL-Q2. */
    async function suspend(executionId: string, ids: string[] = ["IMPL-Q1", "IMPL-Q2"]): Promise<void> {
      let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
      for (let guard = 0; response.status === "AGENT_ACTION_REQUIRED" && guard < 20; guard++) {
        const action = response as ActionResponse;
        const result =
          action.request.state === "IMPLEMENT"
            ? resultFor(action.request, "BLOCKED", findings(...ids))
            : resultFor(action.request, "PASS");
        response = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: action.stepId, result });
      }
      expect(response.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    }

    const answer = (executionId: string, humanAnswers: { questionId: string; answer: string }[]) =>
      nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers });

    function expectRejected(response: ProjectRunStepResponse, ...fragments: string[]): void {
      expect(response.status).toBe("FAILED");
      if (response.status !== "FAILED") return;
      expect(response.failureCode).toBe("INVALID_HUMAN_ANSWERS");
      expect(response.terminal).toBe(false);
      expect(response.state).toBe("HUMAN_INTERVENTION_REQUIRED");
      expect(response.failureReason).toMatch(/^INVALID_HUMAN_ANSWERS:/);
      for (const f of fragments) expect(response.failureReason).toContain(f);
    }

    it("rejects an unknown question id; nothing is recorded and the suspension is intact", async () => {
      const executionId = "exec-val-unknown";
      await suspend(executionId);
      const before = (await store.load(executionId))!;

      expectRejected(await answer(executionId, [{ questionId: "IMPL-Q9", answer: "x" }]), "UNKNOWN_QUESTION_ID", "IMPL-Q9", "IMPL-Q1, IMPL-Q2");

      const after = (await store.load(executionId))!;
      expect(after.revision).toBe(before.revision);
      expect(after.lifecycle_status).toBe("HUMAN_INTERVENTION_REQUIRED");
      expect(after.human_answers ?? []).toHaveLength(0);
      expect((await nextProjectRunStep({ projectRoot: tmpDir, executionId })).status).toBe("HUMAN_INTERVENTION_REQUIRED");
    });

    it("rejects empty and whitespace-only answers", async () => {
      const executionId = "exec-val-empty";
      await suspend(executionId);
      for (const text of ["", "   \n\t"]) {
        expectRejected(await answer(executionId, [{ questionId: "IMPL-Q1", answer: text }]), "EMPTY_ANSWER", "IMPL-Q1");
      }
      expect((await store.load(executionId))?.human_answers ?? []).toHaveLength(0);
    });

    it("an invalid call records nothing at all, even its valid entries; the corrected call then succeeds", async () => {
      const executionId = "exec-val-atomic";
      await suspend(executionId);
      const before = (await store.load(executionId))!;

      expectRejected(
        await answer(executionId, [
          { questionId: "IMPL-Q1", answer: "OAuth" }, // valid
          { questionId: "BOGUS", answer: "x" }, // invalid
          { questionId: "IMPL-Q2", answer: "" }, // invalid
        ]),
        "UNKNOWN_QUESTION_ID",
        "EMPTY_ANSWER",
      );
      const afterReject = (await store.load(executionId))!;
      expect(afterReject.human_answers ?? []).toHaveLength(0);
      expect(afterReject.revision).toBe(before.revision);
      expect(afterReject.step_log).toEqual(before.step_log);
      expect(afterReject.history).toEqual(before.history);

      const ok = await answer(executionId, [
        { questionId: "IMPL-Q1", answer: "OAuth" },
        { questionId: "IMPL-Q2", answer: "Soft delete" },
      ]);
      expect(ok.status).toBe("AGENT_ACTION_REQUIRED");
      expect((await store.load(executionId))?.human_answers).toHaveLength(2);
    });

    it("identical answers inside one call are recorded once, trimmed", async () => {
      const executionId = "exec-val-identical";
      await suspend(executionId);
      const resumed = await answer(executionId, [
        { questionId: "IMPL-Q1", answer: "OAuth" },
        { questionId: "IMPL-Q1", answer: "  OAuth  " },
      ]);
      expect(resumed.status).toBe("AGENT_ACTION_REQUIRED");
      expect((await store.load(executionId))?.human_answers?.map((a) => [a.questionId, a.answer])).toEqual([["IMPL-Q1", "OAuth"]]);
    });

    it("conflicting answers to one question inside a call reject the whole call", async () => {
      const executionId = "exec-val-conflict";
      await suspend(executionId);
      expectRejected(
        await answer(executionId, [
          { questionId: "IMPL-Q1", answer: "OAuth" },
          { questionId: "IMPL-Q2", answer: "Soft" },
          { questionId: "IMPL-Q1", answer: "SAML" },
        ]),
        "CONFLICTING_ANSWERS",
        "IMPL-Q1",
      );
      expect((await store.load(executionId))?.human_answers ?? []).toHaveLength(0);
    });

    it("answers across calls are never deduplicated: a correction (and even a repeat) appends, earlier answers are kept", async () => {
      const executionId = "exec-val-cross-call";
      await suspend(executionId);

      const resume = async (humanAnswers: { questionId: string; answer: string; answeredBy?: string }[]) => {
        const action = (await nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers })) as ActionResponse;
        expect(action.status).toBe("AGENT_ACTION_REQUIRED");
        // the agent is still blocked: the same questions are asked again
        const again = await submitProjectRunStep({
          projectRoot: tmpDir,
          executionId,
          stepId: action.stepId,
          result: resultFor(action.request, "BLOCKED", findings("IMPL-Q1", "IMPL-Q2")),
        });
        expect(again.status).toBe("HUMAN_INTERVENTION_REQUIRED");
      };

      await resume([{ questionId: "IMPL-Q1", answer: "OAuth", answeredBy: "alice" }]);
      await resume([
        { questionId: "IMPL-Q1", answer: "SAML", answeredBy: "bob" }, // correction
        { questionId: "IMPL-Q2", answer: "Soft delete" },
      ]);
      await resume([{ questionId: "IMPL-Q1", answer: "SAML" }]); // identical to the previous call's answer

      const records = (await store.load(executionId))!.human_answers!;
      expect(records.map((a) => [a.questionId, a.answer])).toEqual([
        ["IMPL-Q1", "OAuth"],
        ["IMPL-Q1", "SAML"],
        ["IMPL-Q2", "Soft delete"],
        ["IMPL-Q1", "SAML"],
      ]);
      expect(records.every((a) => typeof a.recordedAt === "string")).toBe(true);
      expect(records[0].answeredBy).toBe("alice");
      expect(records[1].answeredBy).toBe("bob");
    });

    it("stale ids: after the execution re-suspends with new questions, answers to the earlier suspension's ids are rejected", async () => {
      const executionId = "exec-val-stale-ids";
      await suspend(executionId);

      const action = (await answer(executionId, [{ questionId: "IMPL-Q1", answer: "OAuth" }])) as ActionResponse;
      expect(action.status).toBe("AGENT_ACTION_REQUIRED");
      const resuspended = await submitProjectRunStep({
        projectRoot: tmpDir,
        executionId,
        stepId: action.stepId,
        result: resultFor(action.request, "BLOCKED", findings("NEW-Q1")),
      });
      expect(resuspended.status).toBe("HUMAN_INTERVENTION_REQUIRED");
      const before = (await store.load(executionId))!;
      expect(before.human_intervention?.questions.map((q) => q.id)).toEqual(["NEW-Q1"]);

      expectRejected(await answer(executionId, [{ questionId: "IMPL-Q2", answer: "late answer" }]), "UNKNOWN_QUESTION_ID", "IMPL-Q2", "NEW-Q1");
      const afterReject = (await store.load(executionId))!;
      expect(afterReject.revision).toBe(before.revision);
      expect(afterReject.human_answers).toHaveLength(1);

      expect((await answer(executionId, [{ questionId: "NEW-Q1", answer: "fresh" }])).status).toBe("AGENT_ACTION_REQUIRED");
      expect((await store.load(executionId))?.human_answers?.map((a) => a.questionId)).toEqual(["IMPL-Q1", "NEW-Q1"]);
    });

    it("a host with a stale view of an execution another host already resumed gets the pending action; its answers are not recorded", async () => {
      const executionId = "exec-val-stale-view";
      await suspend(executionId);
      const hostA = (await answer(executionId, [{ questionId: "IMPL-Q1", answer: "OAuth" }])) as ActionResponse;
      expect(hostA.status).toBe("AGENT_ACTION_REQUIRED");

      const hostB = await answer(executionId, [{ questionId: "IMPL-Q1", answer: "OAuth" }]);
      expect(hostB.status).toBe("AGENT_ACTION_REQUIRED");
      if (hostB.status === "AGENT_ACTION_REQUIRED") expect(hostB.stepId).toBe(hostA.stepId);
      expect((await store.load(executionId))?.human_answers).toHaveLength(1);
    });

    it("a checkpoint without persisted questions skips the id check but still enforces empty/conflict rules", async () => {
      const executionId = "exec-val-legacy";
      await suspend(executionId);
      const persisted = (await store.load(executionId))!;
      await store.save({ ...persisted, human_intervention: undefined }, { expectedRevision: persisted.revision ?? 0 });
      expect((await store.load(executionId))?.human_intervention).toBeUndefined();

      expectRejected(await answer(executionId, [{ questionId: "whatever", answer: " " }]), "EMPTY_ANSWER");
      expect((await answer(executionId, [{ questionId: "whatever", answer: "recorded" }])).status).toBe("AGENT_ACTION_REQUIRED");
      expect((await store.load(executionId))?.human_answers?.map((a) => [a.questionId, a.answer])).toEqual([["whatever", "recorded"]]);
    });

    it("an enormous unknown id is rejected with a bounded failureReason and the checkpoint untouched", async () => {
      const executionId = "exec-val-huge-id";
      await suspend(executionId);
      const before = (await store.load(executionId))!;

      const response = await answer(executionId, [{ questionId: "q".repeat(200_000), answer: "SECRET-ANSWER-TEXT" }]);
      expectRejected(response, "UNKNOWN_QUESTION_ID", "(200000 chars)");
      if (response.status === "FAILED") {
        expect(response.failureReason.length).toBeLessThan(1500);
        expect(response.failureReason).not.toContain("SECRET");
      }
      expect((await store.load(executionId))?.revision).toBe(before.revision);
    });

    it("invalid answers never clear the finding or advance the run; the agent is not re-dispatched", async () => {
      const executionId = "exec-val-no-progress";
      await suspend(executionId);
      const before = (await store.load(executionId))!;
      await answer(executionId, [{ questionId: "IMPL-Q9", answer: "x" }]);
      const after = (await store.load(executionId))!;
      expect(after.state).toBe("HUMAN_INTERVENTION_REQUIRED");
      expect(after.suspended_from).toBe("IMPLEMENT");
      expect(after.last_result).toEqual(before.last_result);
      expect(after.findings).toEqual(before.findings);
      expect(after.pending_action).toBeUndefined();
    });
  });

  describe("push mode", () => {
    function blockedAtImplement(ids: string[] = ["IMPL-Q1", "IMPL-Q2"]) {
      return (req: AgentDispatchRequest): AgentResult =>
        req.state === "IMPLEMENT" ? resultFor(req, "BLOCKED", findings(...ids)) : resultFor(req, "PASS");
    }

    async function suspend(executionId: string, ids?: string[]): Promise<void> {
      const run = await executeProjectRun({
        executionId,
        projectRoot: tmpDir,
        runtime: "MOCK",
        stateStore: store,
        adapters: [new MockRuntimeAdapter(blockedAtImplement(ids))],
        context: { state: "INTAKE", runtime: "MOCK" },
      });
      expect(run.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    }

    function resume(
      executionId: string,
      humanAnswers: { questionId: string; answer: string }[] | undefined,
      handler: (req: AgentDispatchRequest) => AgentResult = (req) => resultFor(req, "PASS"),
      dispatched: string[] = [],
    ) {
      return executeProjectResume({
        executionId,
        projectRoot: tmpDir,
        stateStore: store,
        adapters: [
          new MockRuntimeAdapter((req) => {
            dispatched.push(`${req.role}:${req.state}`);
            return handler(req);
          }),
        ],
        humanAnswers,
      });
    }

    it("rejects invalid answers as a whole: no agent runs, nothing is recorded, the execution is unchanged", async () => {
      const executionId = "exec-push-val-reject";
      await suspend(executionId);
      const before = (await store.load(executionId))!;

      const dispatched: string[] = [];
      const rejected = await resume(
        executionId,
        [
          { questionId: "IMPL-Q1", answer: "OAuth" },
          { questionId: "NOPE", answer: "x" },
        ],
        undefined,
        dispatched,
      );

      expect(rejected.status).toBe("FAILED");
      expect(rejected.answerFailure).toBe("INVALID_HUMAN_ANSWERS");
      expect(rejected.failureReason).toMatch(/^INVALID_HUMAN_ANSWERS:.*UNKNOWN_QUESTION_ID.*NOPE/);
      expect(dispatched).toEqual([]);
      const after = (await store.load(executionId))!;
      expect(after.revision).toBe(before.revision);
      expect(after.lifecycle_status).toBe("HUMAN_INTERVENTION_REQUIRED");
      expect(after.human_answers ?? []).toHaveLength(0);

      const ok = await resume(executionId, [{ questionId: "IMPL-Q1", answer: "OAuth" }], undefined, dispatched);
      expect(ok.status).toBe("COMPLETED");
      expect(dispatched[0]).toBe("IMPLEMENTATION:IMPLEMENT");
      expect((await store.load(executionId))?.human_answers).toHaveLength(1);
    });

    it("the host contract reports it as a non-terminal FAILED with failureCode INVALID_HUMAN_ANSWERS", async () => {
      const executionId = "exec-push-val-host";
      await suspend(executionId);

      const response = await resumeProjectRun({
        executionId,
        projectRoot: tmpDir,
        stateStore: store,
        adapters: [new MockRuntimeAdapter((req) => resultFor(req, "PASS"))],
        humanAnswers: [{ questionId: "IMPL-Q1", answer: "   " }],
      });

      expect(response.status).toBe("FAILED");
      expect(response.failureCode).toBe("INVALID_HUMAN_ANSWERS");
      expect(response.terminal).toBe(false);
      expect(response.state).toBe("HUMAN_INTERVENTION_REQUIRED");
      expect(response.failureReason).toContain("EMPTY_ANSWER");
      expect((await store.load(executionId))?.lifecycle_status).toBe("HUMAN_INTERVENTION_REQUIRED");
    });

    it("conflicting answers in one call are rejected; identical ones are recorded once", async () => {
      const executionId = "exec-push-val-dupes";
      await suspend(executionId);

      const conflict = await resume(executionId, [
        { questionId: "IMPL-Q1", answer: "A" },
        { questionId: "IMPL-Q1", answer: "B" },
      ]);
      expect(conflict.answerFailure).toBe("INVALID_HUMAN_ANSWERS");
      expect((await store.load(executionId))?.human_answers ?? []).toHaveLength(0);

      const same = await resume(executionId, [
        { questionId: "IMPL-Q1", answer: "A" },
        { questionId: "IMPL-Q1", answer: " A" },
      ]);
      expect(same.status).toBe("COMPLETED");
      expect((await store.load(executionId))?.human_answers?.map((a) => [a.questionId, a.answer])).toEqual([["IMPL-Q1", "A"]]);
    });

    it("cross-call corrections append; earlier answers and the audit order are kept", async () => {
      const executionId = "exec-push-val-cross";
      await suspend(executionId);
      const stillBlocked = blockedAtImplement();

      await resume(executionId, [{ questionId: "IMPL-Q1", answer: "OAuth" }], stillBlocked);
      await resume(executionId, [{ questionId: "IMPL-Q1", answer: "SAML" }, { questionId: "IMPL-Q2", answer: "Soft" }], stillBlocked);
      await resume(executionId, [{ questionId: "IMPL-Q1", answer: "SAML" }]);

      expect((await store.load(executionId))?.human_answers?.map((a) => [a.questionId, a.answer])).toEqual([
        ["IMPL-Q1", "OAuth"],
        ["IMPL-Q1", "SAML"],
        ["IMPL-Q2", "Soft"],
        ["IMPL-Q1", "SAML"],
      ]);
    });

    it("stale ids after a re-suspension with new questions are rejected, and the checkpoint is untouched", async () => {
      const executionId = "exec-push-val-stale";
      await suspend(executionId);
      await resume(executionId, [{ questionId: "IMPL-Q1", answer: "OAuth" }], blockedAtImplement(["NEW-Q1"]));
      const before = (await store.load(executionId))!;
      expect(before.human_intervention?.questions.map((q) => q.id)).toEqual(["NEW-Q1"]);

      const stale = await resume(executionId, [{ questionId: "IMPL-Q2", answer: "late" }]);
      expect(stale.answerFailure).toBe("INVALID_HUMAN_ANSWERS");
      const after = (await store.load(executionId))!;
      expect(after.revision).toBe(before.revision);
      expect(after.human_answers).toHaveLength(1);
    });

    it("a checkpoint without persisted questions skips the id check", async () => {
      const executionId = "exec-push-val-legacy";
      await suspend(executionId);
      const persisted = (await store.load(executionId))!;
      await store.save({ ...persisted, human_intervention: undefined }, { expectedRevision: persisted.revision ?? 0 });

      expect((await resume(executionId, [{ questionId: "whatever", answer: " " }])).answerFailure).toBe("INVALID_HUMAN_ANSWERS");
      expect((await resume(executionId, [{ questionId: "whatever", answer: "ok" }])).status).toBe("COMPLETED");
    });

    it("answers sent to an already completed execution fail as not-resumable, not as invalid answers", async () => {
      const executionId = "exec-push-val-completed";
      await suspend(executionId);
      expect((await resume(executionId, [{ questionId: "IMPL-Q1", answer: "OAuth" }])).status).toBe("COMPLETED");

      const late = await resume(executionId, [{ questionId: "BOGUS", answer: "x" }]);
      expect(late.status).toBe("FAILED");
      expect(late.answerFailure).toBeUndefined();
      expect(late.failureReason).toMatch(/^EXECUTION_NOT_RESUMABLE/);
    });
  });
});
