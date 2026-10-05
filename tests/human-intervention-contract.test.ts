// packages/project-run-engine/tests/human-intervention-contract.test.ts
//
// Phase 1 — Host-Agent Skill Interface: Human-in-the-Loop contract.
//
// Covers: question derivation (pure, deterministic), persistence of the
// human_intervention record and human_answers audit trail, and that resume with
// human answers never mutates the original finding directly (the responsible agent
// is always re-dispatched and independently re-verified).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { deriveHumanQuestions } from "../src/decision/human-intervention.js";
import {
  Coordinator,
  CoordinatorDecisionEngine,
  AgentDispatcher,
  createDefaultAgentRegistry,
  MockRuntimeAdapter,
  type CoordinatorExecutionContext,
} from "../src/index.js";
import { executeProjectRun, executeProjectResume } from "../src/project/project-run.js";
import { FileExecutionStateStore } from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";

describe("Phase 1 — deriveHumanQuestions (pure, deterministic)", () => {
  it("derives one question per blocking finding, reusing the finding's own id", () => {
    const questions = deriveHumanQuestions("Blocking ambiguity cannot be resolved automatically", [
      {
        id: "AMB-AUTH-MODEL",
        severity: "CRITICAL",
        category: "specification-ambiguity",
        evidence: "Spec does not define auth model",
        expected: "Auth model decision resolved",
        actual: "Left ambiguous",
        required_remediation: "Which authentication model should this feature use?",
        status: "OPEN",
      },
    ]);

    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe("AMB-AUTH-MODEL");
    expect(questions[0].question).toContain("Which authentication model should this feature use?");
    expect(questions[0].required).toBe(true);
    expect(questions[0].context).toContain("Spec does not define auth model");
  });

  it("excludes RESOLVED/ACCEPTED findings from the derived questions", () => {
    const questions = deriveHumanQuestions("reason", [
      { id: "F-1", severity: "HIGH", status: "RESOLVED" },
      { id: "F-2", severity: "HIGH", status: "ACCEPTED" },
    ]);

    // Nothing actionable remains, so a single generic fallback question is returned
    // rather than zero questions (the host must always have something to render).
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe("intervention-required");
  });

  it("never returns an empty array, even with zero findings", () => {
    const questions = deriveHumanQuestions("Blocking ambiguity cannot be resolved automatically", []);
    expect(questions.length).toBeGreaterThan(0);
    expect(questions[0].required).toBe(true);
    expect(questions[0].question).toContain("Blocking ambiguity cannot be resolved automatically");
  });

  it("is deterministic: the same input always produces the same output", () => {
    const findings = [{ id: "F-1", severity: "MEDIUM", status: "OPEN", required_remediation: "Fix X" }];
    const a = deriveHumanQuestions("reason", findings);
    const b = deriveHumanQuestions("reason", findings);
    expect(a).toEqual(b);
  });
});

describe("Phase 1 — Coordinator persists the human_intervention record", () => {
  let tmpDir: string;
  let stateStore: FileExecutionStateStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "human-intervention-"));
    stateStore = new FileExecutionStateStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists suspendedFrom, reason, questions, and findings when CLARIFY halts on a blocking finding", async () => {
    const mockAdapter = new MockRuntimeAdapter((req) => {
      if (req.role === "SPECIFICATION" && req.state === "CLARIFY") {
        return {
          execution_id: req.execution_id,
          agent: req.role,
          state: req.state,
          status: "FINDINGS",
          evidence: [],
          findings: [
            {
              id: "AMB-AUTH-MODEL",
              severity: "CRITICAL",
              status: "OPEN",
              evidence: "Spec does not define auth model",
              required_remediation: "Which authentication model should this feature use?",
            },
          ],
        };
      }
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    const registry = createDefaultAgentRegistry();
    const dispatcher = new AgentDispatcher(registry, [mockAdapter]);
    const coordinator = new Coordinator({
      dispatcher,
      decisionEngine: new CoordinatorDecisionEngine(),
      stateStore,
      executionMetadata: {
        executionId: "exec-hitl-persist",
        project: "test-project",
        feature: "test-feature",
        branch: "feat/test",
        runtime: "MOCK",
      },
    });

    const context: CoordinatorExecutionContext = {
      execution_id: "exec-hitl-persist",
      feature: "test-feature",
      branch: "feat/test",
      state: "INTAKE",
      runtime: "MOCK",
    };

    const result = await coordinator.run(context);
    expect(result.status).toBe("HUMAN_INTERVENTION_REQUIRED");

    const persisted = await stateStore.load("exec-hitl-persist");
    expect(persisted?.human_intervention).toBeDefined();
    expect(persisted?.human_intervention?.suspendedFrom).toBe("CLARIFY");
    expect(persisted?.human_intervention?.reason).toContain("Blocking ambiguity");
    expect(persisted?.human_intervention?.questions).toHaveLength(1);
    expect(persisted?.human_intervention?.questions[0].id).toBe("AMB-AUTH-MODEL");
    expect(persisted?.human_intervention?.findings).toHaveLength(1);
  });
});

describe("Phase 1 — resume persists human answers durably without mutating findings", () => {
  let tmpDir: string;
  let stateStore: FileExecutionStateStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "human-answers-"));
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

  it("records the answer with a server-assigned timestamp, keyed to the question id, and the agent is re-dispatched rather than the finding being mutated", async () => {
    const executionId = "exec-answer-persist";

    const blockingAdapter = new MockRuntimeAdapter((req) => {
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

    await executeProjectRun({
      executionId,
      projectRoot: tmpDir,
      runtime: "MOCK",
      stateStore,
      adapters: [blockingAdapter],
      context: { state: "INTAKE", runtime: "MOCK" },
    });

    const beforeResume = await stateStore.load(executionId);
    expect(beforeResume?.human_answers ?? []).toHaveLength(0);
    // The original finding is untouched prior to resume.
    expect((beforeResume?.findings?.[0] as { status: string }).status).toBe("OPEN");

    let specDispatchedAfterResume = false;
    const fixedAdapter = new MockRuntimeAdapter((req) => {
      if (req.role === "SPECIFICATION" && req.state === "CLARIFY") {
        specDispatchedAfterResume = true;
        return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
      }
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    const beforeAnswerTime = Date.now();
    const resumeResult = await executeProjectResume({
      executionId,
      projectRoot: tmpDir,
      stateStore,
      adapters: [fixedAdapter],
      runtime: "MOCK",
      humanAnswers: [{ questionId: "AMB-1", answer: "OAuth", answeredBy: "operator" }],
    });

    expect(resumeResult.status).toBe("COMPLETED");
    // The agent was re-dispatched and independently re-verified — the human's answer
    // did not directly flip the finding to RESOLVED and skip verification.
    expect(specDispatchedAfterResume).toBe(true);

    const afterResume = await stateStore.load(executionId);
    expect(afterResume?.human_answers).toHaveLength(1);
    expect(afterResume?.human_answers?.[0].questionId).toBe("AMB-1");
    expect(afterResume?.human_answers?.[0].answer).toBe("OAuth");
    expect(afterResume?.human_answers?.[0].answeredBy).toBe("operator");
    expect(new Date(afterResume!.human_answers![0].recordedAt).getTime()).toBeGreaterThanOrEqual(beforeAnswerTime);
  });

  it("persists the answer durably even before the resumed re-verification completes (answer is saved immediately, not only on success)", async () => {
    const executionId = "exec-answer-persist-even-if-still-blocked";

    const blockingAdapter = new MockRuntimeAdapter((req) => {
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

    await executeProjectRun({
      executionId,
      projectRoot: tmpDir,
      runtime: "MOCK",
      stateStore,
      adapters: [blockingAdapter],
      context: { state: "INTAKE", runtime: "MOCK" },
    });

    // Resume where the agent STILL reports the same blocking finding (the human's
    // answer did not actually resolve the underlying ambiguity).
    const stillBlockingAdapter = new MockRuntimeAdapter((req) => {
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

    const resumeResult = await executeProjectResume({
      executionId,
      projectRoot: tmpDir,
      stateStore,
      adapters: [stillBlockingAdapter],
      runtime: "MOCK",
      humanAnswers: [{ questionId: "AMB-1", answer: "Not sure, ask again" }],
    });

    expect(resumeResult.status).toBe("HUMAN_INTERVENTION_REQUIRED");

    // Even though the run is suspended again, the answer that was supplied is still
    // durably on record.
    const persisted = await stateStore.load(executionId);
    expect(persisted?.human_answers).toHaveLength(1);
    expect(persisted?.human_answers?.[0].answer).toBe("Not sure, ask again");
    // And a fresh human_intervention record reflects the NEW suspension.
    expect(persisted?.human_intervention?.suspendedFrom).toBe("CLARIFY");
  });
});
