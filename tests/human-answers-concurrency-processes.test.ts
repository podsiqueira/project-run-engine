// packages/project-run-engine/tests/human-answers-concurrency-processes.test.ts
//
// Separate-process counterpart of the in-process races in human-answers-validation-lifecycle.test.ts.
// phase5-locking.test.ts already races two OS processes answering the SAME question; this covers
// what it does not: two processes answering DIFFERENT questions, and a valid call racing an
// invalid one. Cross-process cases spawn genuine child Node processes against a one-off compile of
// this package, so "two hosts" means two OS processes contending for the real file lock.
//
// What the contract guarantees (and what these tests pin):
//   - the lock serialises the turns; the answers of the call that takes it are validated and
//     recorded, the execution is re-dispatched exactly once, and both callers are handed the SAME
//     pending action (same stepId);
//   - a call that finds the execution already resumed is a read: its answers are not recorded. That
//     is not a revision conflict and the loser is not told its answers were dropped — it is told
//     what to do next (the pending action). A host that needs to know what is recorded reads the
//     execution again (`status`). This is documented in ARCHITECTURE.md (§4.2) and CONSUMER-GUIDE.md.
//   - an invalid call never records anything, in either order of arrival.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { nextProjectRunStep, submitProjectRunStep } from "../src/host/project-run-step.js";
import { FileExecutionStateStore } from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";
import type { AgentResult } from "../src/domain/types.js";
import type { ProjectRunStepResponse } from "../src/host/step-types.js";

type ActionResponse = Extract<ProjectRunStepResponse, { status: "AGENT_ACTION_REQUIRED" }>;
interface WorkerResult {
  status: string;
  stepId?: string;
  failureCode?: string;
  terminal?: boolean;
}

const REPO_ROOT = path.resolve(__dirname, "..");

let compiledDir: string;
let workerPath: string;

const WORKER_SOURCE = `
const [mode, argJson] = process.argv.slice(2);
const arg = JSON.parse(argJson);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (mode === "next-at") {
  const { nextProjectRunStep } = await import(arg.dist + "/host/project-run-step.js");
  while (Date.now() < arg.startAt) await sleep(1);
  const r = await nextProjectRunStep({ projectRoot: arg.root, executionId: arg.executionId, humanAnswers: arg.humanAnswers });
  console.log("RESULT " + JSON.stringify({ status: r.status, stepId: r.stepId, failureCode: r.failureCode, terminal: r.terminal }));
}
`;

beforeAll(() => {
  compiledDir = fs.mkdtempSync(path.join(os.tmpdir(), "answers-procs-compiled-"));
  execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(REPO_ROOT, "tsconfig.build.json"), "--outDir", path.join(compiledDir, "dist"), "--declaration", "false", "--declarationMap", "false", "--sourceMap", "false"],
    { cwd: REPO_ROOT, stdio: "pipe" },
  );
  fs.writeFileSync(path.join(compiledDir, "package.json"), JSON.stringify({ type: "module" }));
  workerPath = path.join(compiledDir, "worker.mjs");
  fs.writeFileSync(workerPath, WORKER_SOURCE);
}, 120_000);

afterAll(() => {
  fs.rmSync(compiledDir, { recursive: true, force: true });
});

function runWorker(arg: Record<string, unknown>): Promise<WorkerResult> {
  const child: ChildProcess = spawn(process.execPath, [workerPath, "next-at", JSON.stringify({ dist: "file://" + path.join(compiledDir, "dist"), ...arg })], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`worker exited ${code}: ${stderr}`));
      resolve(JSON.parse(stdout.split("RESULT ")[1]) as WorkerResult);
    });
  });
}

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

function resultFor(req: { execution_id: string; role: string; state: string }, status: AgentResult["status"], f: unknown[] = []): AgentResult {
  return { execution_id: req.execution_id, agent: req.role, state: req.state, status, evidence: [], findings: f as never } as AgentResult;
}

describe("humanAnswers across separate OS processes", () => {
  let tmpDir: string;
  let store: FileExecutionStateStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "answers-procs-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
    store = new FileExecutionStateStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Suspends at IMPLEMENT (BLOCKED) with questions IMPL-Q1 and IMPL-Q2. */
  async function suspend(executionId: string): Promise<void> {
    let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    for (let guard = 0; response.status === "AGENT_ACTION_REQUIRED" && guard < 20; guard++) {
      const action = response as ActionResponse;
      const findings = ["IMPL-Q1", "IMPL-Q2"].map((id) => ({ id, severity: "HIGH", status: "OPEN" }));
      const result =
        action.request.state === "IMPLEMENT" ? resultFor(action.request, "BLOCKED", findings) : resultFor(action.request, "PASS");
      response = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: action.stepId, result });
    }
    expect(response.status).toBe("HUMAN_INTERVENTION_REQUIRED");
  }

  const dispatches = async (executionId: string) =>
    ((await store.load(executionId))?.history ?? []).filter((r) => r.decision.action === "DISPATCH_AGENT").length;
  const lockFiles = () => fs.readdirSync(path.join(tmpDir, ".project-run", "runs")).filter((f) => f.endsWith(".lock"));

  it("two processes answering DIFFERENT questions at the same instant: one wins, one re-dispatch, one stepId, no duplicates", async () => {
    for (let round = 0; round < 3; round++) {
      const executionId = `exec-procs-different-${round}`;
      await suspend(executionId);
      const before = await dispatches(executionId);

      const startAt = Date.now() + 1200;
      const [a, b] = await Promise.all([
        runWorker({ root: tmpDir, executionId, startAt, humanAnswers: [{ questionId: "IMPL-Q1", answer: "from-A" }] }),
        runWorker({ root: tmpDir, executionId, startAt, humanAnswers: [{ questionId: "IMPL-Q2", answer: "from-B" }] }),
      ]);

      // Neither caller is rejected or told about a conflict: both are handed the one pending action.
      expect([a.status, b.status]).toEqual(["AGENT_ACTION_REQUIRED", "AGENT_ACTION_REQUIRED"]);
      expect(a.stepId).toBeDefined();
      expect(a.stepId).toBe(b.stepId);

      const after = (await store.load(executionId))!;
      expect(after.human_answers).toHaveLength(1); // the winner's; the loser's call was a read of the resumed execution
      expect(["from-A", "from-B"]).toContain(after.human_answers![0].answer);
      expect((await dispatches(executionId)) - before).toBe(1);
      expect(after.step_log!.filter((r) => r.kind === "HUMAN_INTERVENTION")).toHaveLength(1);
      expect(after.pending_action?.step_id).toBe(a.stepId);
    }
    expect(lockFiles()).toEqual([]);
  }, 120_000);

  it("a valid and an invalid call from two processes: the invalid answers are never recorded, in either order of arrival", async () => {
    for (let round = 0; round < 3; round++) {
      const executionId = `exec-procs-valid-invalid-${round}`;
      await suspend(executionId);
      const before = await dispatches(executionId);

      const startAt = Date.now() + 1200;
      const answers = [
        { questionId: "IMPL-Q1", answer: "OAuth" },
        { questionId: "IMPL-Q2", answer: "Soft delete" },
      ];
      const [valid, invalid] = await Promise.all([
        runWorker({ root: tmpDir, executionId, startAt, humanAnswers: answers }),
        runWorker({ root: tmpDir, executionId, startAt, humanAnswers: [{ questionId: "BOGUS", answer: "x" }] }),
      ]);

      expect(valid.status).toBe("AGENT_ACTION_REQUIRED");
      if (invalid.status === "FAILED") {
        // the invalid call took the lock first: rejected whole, non-terminal, suspension left for the valid call
        expect(invalid.failureCode).toBe("INVALID_HUMAN_ANSWERS");
        expect(invalid.terminal).toBe(false);
      } else {
        // the valid call took the lock first: the invalid one read the resumed execution (the pending action)
        expect(invalid.status).toBe("AGENT_ACTION_REQUIRED");
        expect(invalid.stepId).toBe(valid.stepId);
      }
      const after = (await store.load(executionId))!;
      expect(after.human_answers?.map((a) => [a.questionId, a.answer])).toEqual([
        ["IMPL-Q1", "OAuth"],
        ["IMPL-Q2", "Soft delete"],
      ]);
      expect((await dispatches(executionId)) - before).toBe(1);
    }
    // Which call arrives first is up to the OS; both outcomes are valid and neither may record BOGUS.
    expect(lockFiles()).toEqual([]);
  }, 120_000);
});
