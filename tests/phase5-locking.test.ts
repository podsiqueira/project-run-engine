// packages/project-run-engine/tests/phase5-locking.test.ts
//
// Phase 5 — persistence hardening: atomic checkpoint writes and the advisory
// per-execution lock.
//
// Everything here runs the REAL FileExecutionStateStore and the REAL pull/push entry
// points; nothing about locking is mocked. Cross-process cases spawn genuine child Node
// processes against a one-off compile of this package, so "independent host turns" means
// independent OS processes, not two promises in one event loop.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { nextProjectRunStep, submitProjectRunStep } from "../src/host/project-run-step.js";
import { executeProjectResume, executeProjectRun } from "../src/project/project-run.js";
import { statusProjectRun } from "../src/host/status.js";
import { FileExecutionStateStore, withExecutionLock, type PersistedExecutionState } from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";
import { MockRuntimeAdapter } from "../src/runtime/mock-runtime-adapter.js";
import { ExecutionLockTimeoutError, type AgentResult } from "../src/domain/types.js";
import type { ProjectRunStepResponse } from "../src/host/step-types.js";

type ActionRequired = Extract<ProjectRunStepResponse, { status: "AGENT_ACTION_REQUIRED" }>;

const REPO_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------------------
// One-off compile of the package so child processes can import it as plain ESM.
// ---------------------------------------------------------------------------------------
let compiledDir: string;
let workerPath: string;

const WORKER_SOURCE = `
import * as fs from "node:fs";
const [mode, argJson] = process.argv.slice(2);
const arg = JSON.parse(argJson);
const { FileExecutionStateStore, withExecutionLock } = await import(arg.dist + "/project/state-store.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (mode === "increment") {
  // Read-modify-write on a shared counter file, with a gap between read and write that
  // makes lost updates likely unless the turn is mutually exclusive.
  const store = new FileExecutionStateStore(arg.root);
  const turn = async () => {
    const n = Number(fs.readFileSync(arg.file, "utf8"));
    await sleep(2);
    fs.writeFileSync(arg.file, String(n + 1));
  };
  for (let i = 0; i < arg.n; i++) {
    if (arg.useLock) await withExecutionLock(store, arg.executionId, turn, { timeoutMs: 60000 });
    else await turn();
  }
} else if (mode === "save-loop") {
  // Large checkpoints written back-to-back, so a non-atomic write is observable mid-flight.
  const store = new FileExecutionStateStore(arg.root);
  for (let i = 1; i <= arg.n; i++) {
    await store.save({
      version: 1, execution_id: arg.executionId, project: "svc", feature: "feat", branch: "feat", state: "SPECIFY",
      lifecycle_status: "IN_PROGRESS", runtime: "MOCK", iteration: 1, remediation_iteration: 0, preset: "v1",
      context: { padding: "x".repeat(400000), n: i }, created_at: "t", updated_at: "t",
    });
  }
} else if (mode === "hold-lock") {
  const store = new FileExecutionStateStore(arg.root);
  await store.withLock(arg.executionId, async () => {
    console.log("LOCKED");
    await sleep(60000);
  });
} else if (mode === "pull-then-die") {
  const { nextProjectRunStep, submitProjectRunStep } = await import(arg.dist + "/host/project-run-step.js");
  let r = await nextProjectRunStep({ projectRoot: arg.root, executionId: arg.executionId, runtime: "MOCK" });
  for (let i = 0; i < arg.steps; i++) {
    r = await submitProjectRunStep({ projectRoot: arg.root, executionId: arg.executionId, stepId: r.stepId,
      result: { execution_id: arg.executionId, agent: r.request.role, state: r.request.state, status: "PASS", evidence: [], findings: [] } });
  }
  console.log("DIED_AFTER " + JSON.stringify({ stepId: r.stepId }));
  process.kill(process.pid, "SIGKILL");
} else if (mode === "submit-at") {
  const { submitProjectRunStep } = await import(arg.dist + "/host/project-run-step.js");
  while (Date.now() < arg.startAt) await sleep(1);
  const r = await submitProjectRunStep({ projectRoot: arg.root, executionId: arg.executionId, stepId: arg.stepId, result: arg.result });
  console.log("RESULT " + JSON.stringify({ status: r.status, state: r.state, failureReason: r.failureReason }));
}
`;

beforeAll(() => {
  compiledDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-compiled-"));
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

function distDir(): string {
  return path.join(compiledDir, "dist");
}

function runWorker(mode: string, arg: Record<string, unknown>): ChildProcess {
  return spawn(process.execPath, [workerPath, mode, JSON.stringify({ dist: pathToFileUrl(distDir()), ...arg })], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function pathToFileUrl(p: string): string {
  return "file://" + p;
}

function collect(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function waitForLine(child: ChildProcess, needle: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for '${needle}'; saw: ${buf}`)), 20_000);
    child.stdout?.on("data", (d) => {
      buf += d;
      if (buf.includes(needle)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (!buf.includes(needle)) reject(new Error(`child exited before '${needle}'; saw: ${buf}`));
    });
  });
}

// ---------------------------------------------------------------------------------------
// Project fixtures
// ---------------------------------------------------------------------------------------
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

function resultFor(response: ActionRequired, status = "PASS", findings: unknown[] = []): AgentResult {
  return { execution_id: response.request.execution_id, agent: response.request.role, state: response.request.state, status, evidence: [], findings };
}

function lockFiles(tmpDir: string): string[] {
  const dir = path.join(tmpDir, ".project-run", "runs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".lock") || f.endsWith(".reap") || f.endsWith(".tmp")) : [];
}

// =======================================================================================
describe("Phase 5 — FileExecutionStateStore.withLock (real lock, real processes)", () => {
  let tmpDir: string;
  let store: FileExecutionStateStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-lock-"));
    store = new FileExecutionStateStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serialises overlapping turns inside one process (no interleaving)", async () => {
    const events: string[] = [];
    const turn = (name: string) => () =>
      withExecutionLock(store, "exec-a", async () => {
        events.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 15));
        events.push(`${name}:end`);
      });
    await Promise.all([turn("A")(), turn("B")(), turn("C")()]);
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i].endsWith(":start")).toBe(true);
      expect(events[i + 1]).toBe(events[i].replace(":start", ":end"));
    }
    expect(events).toHaveLength(6);
  });

  it("locks are per execution: a held lock does not block a different execution", async () => {
    let otherRan = false;
    await withExecutionLock(store, "exec-a", async () => {
      await withExecutionLock(store, "exec-b", async () => {
        otherRan = true;
      });
    });
    expect(otherRan).toBe(true);
  });

  it("prevents lost updates across independent OS processes (and the same workload WITHOUT the lock does lose them)", async () => {
    const counter = path.join(tmpDir, "counter.txt");
    const run = async (useLock: boolean) => {
      fs.writeFileSync(counter, "0");
      const kids = [0, 1, 2].map(() => runWorker("increment", { root: tmpDir, executionId: "exec-race", file: counter, n: 15, useLock }));
      const outs = await Promise.all(kids.map(collect));
      for (const o of outs) expect(o.code, o.stderr).toBe(0);
      return Number(fs.readFileSync(counter, "utf8"));
    };
    const unlocked = await run(false);
    const locked = await run(true);
    expect(unlocked).toBeLessThan(45); // the race is real: updates were lost
    expect(locked).toBe(45); // 3 processes x 15 increments, none lost
    expect(lockFiles(tmpDir)).toEqual([]);
  }, 60_000);

  it("releases the lock after success, after a thrown error, and after a rejected operation", async () => {
    await withExecutionLock(store, "exec-r", async () => "ok");
    expect(lockFiles(tmpDir)).toEqual([]);

    await expect(withExecutionLock(store, "exec-r", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(lockFiles(tmpDir)).toEqual([]);

    await expect(withExecutionLock(store, "exec-r", () => Promise.reject(new Error("rejected")))).rejects.toThrow("rejected");
    expect(lockFiles(tmpDir)).toEqual([]);

    // ...and the lock is genuinely free again.
    await expect(withExecutionLock(store, "exec-r", async () => 42, { timeoutMs: 200 })).resolves.toBe(42);
  });

  it("times out with a structured EXECUTION_LOCKED error while another holder is alive, without disturbing it", async () => {
    let release!: () => void;
    const held = withExecutionLock(store, "exec-t", () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 20));

    const err = await withExecutionLock(store, "exec-t", async () => "never", { timeoutMs: 120, pollMs: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionLockTimeoutError);
    expect(err.code).toBe("EXECUTION_LOCKED");
    expect(err.message).toContain("EXECUTION_LOCKED");
    expect(err.executionId).toBe("exec-t");

    // The failed waiter did not remove or corrupt the live holder's lock.
    expect(lockFiles(tmpDir)).toEqual(["exec-t.lock"]);
    release();
    await held;
    expect(lockFiles(tmpDir)).toEqual([]);
  });

  it("a holder killed with SIGKILL leaves a stale lock that the next operation reclaims promptly", async () => {
    const holder = runWorker("hold-lock", { root: tmpDir, executionId: "exec-crash" });
    await waitForLine(holder, "LOCKED");
    expect(lockFiles(tmpDir)).toEqual(["exec-crash.lock"]);

    holder.kill("SIGKILL");
    await collect(holder);
    expect(lockFiles(tmpDir)).toEqual(["exec-crash.lock"]); // abandoned, not cleaned up by the dead process

    const started = Date.now();
    await expect(withExecutionLock(store, "exec-crash", async () => "reclaimed", { timeoutMs: 5000 })).resolves.toBe("reclaimed");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(lockFiles(tmpDir)).toEqual([]);
  });

  it("reclaims a stale lock under contention without ever admitting two holders", async () => {
    // Plant a lock owned by a pid that no longer exists.
    const dead = spawn(process.execPath, ["-e", "0"]);
    const deadPid = dead.pid!;
    await collect(dead);
    fs.mkdirSync(store.runsDir, { recursive: true });
    fs.writeFileSync(path.join(store.runsDir, "exec-reap.lock"), JSON.stringify({ pid: deadPid, token: "dead-token", acquired_at: new Date().toISOString() }));

    let inside = 0;
    let maxInside = 0;
    let completed = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withExecutionLock(store, "exec-reap", async () => {
          maxInside = Math.max(maxInside, ++inside);
          await new Promise((r) => setTimeout(r, 5));
          inside--;
          completed++;
        }, { timeoutMs: 10_000 }),
      ),
    );
    expect(completed).toBe(6);
    expect(maxInside).toBe(1);
    expect(lockFiles(tmpDir)).toEqual([]);
  });

  it("does not steal a fresh, still-being-written lock, but reclaims an old unreadable one", async () => {
    fs.mkdirSync(store.runsDir, { recursive: true });
    const lock = path.join(store.runsDir, "exec-partial.lock");
    fs.writeFileSync(lock, ""); // creator is between open() and write()

    await expect(withExecutionLock(store, "exec-partial", async () => 1, { timeoutMs: 100, pollMs: 10 })).rejects.toBeInstanceOf(ExecutionLockTimeoutError);
    expect(fs.existsSync(lock)).toBe(true);

    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old); // creator died there long ago
    await expect(withExecutionLock(store, "exec-partial", async () => 2, { timeoutMs: 2000 })).resolves.toBe(2);
  });

  it("releasing never deletes a lock that is no longer ours", async () => {
    const lock = path.join(store.runsDir, "exec-mine.lock");
    await withExecutionLock(store, "exec-mine", async () => {
      // Simulate having been (wrongly) deemed dead and replaced by another holder.
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "someone-else", acquired_at: new Date().toISOString() }));
    });
    expect(JSON.parse(fs.readFileSync(lock, "utf8")).token).toBe("someone-else");
  });

  it("a store without withLock degrades to running unlocked (the pre-Phase-5 behaviour)", async () => {
    const bare = { save: store.save.bind(store), load: store.load.bind(store), exists: store.exists.bind(store) };
    await expect(withExecutionLock(bare, "exec-x", async () => "ran")).resolves.toBe("ran");
  });
});

// =======================================================================================
describe("Phase 5 — atomic checkpoint writes", () => {
  let tmpDir: string;
  let store: FileExecutionStateStore;

  const state = (n: number): PersistedExecutionState => ({
    version: 1,
    execution_id: "exec-atomic",
    project: "svc",
    feature: "feat",
    branch: "feat",
    state: "SPECIFY",
    lifecycle_status: "IN_PROGRESS",
    runtime: "MOCK",
    iteration: 1,
    remediation_iteration: 0,
    preset: "v1",
    context: { padding: "x".repeat(200_000), n },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-atomic-"));
    store = new FileExecutionStateStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a reader in this process racing a writer in ANOTHER process never sees a torn checkpoint, and no temp files are left behind", async () => {
    await store.save(state(0));
    const writer = runWorker("save-loop", { root: tmpDir, executionId: "exec-atomic", n: 120 });
    const done = collect(writer);
    let finished = false;
    void done.then(() => (finished = true));

    let reads = 0;
    const failures: string[] = [];
    while (!finished) {
      try {
        const loaded = await store.load("exec-atomic");
        if (loaded?.execution_id !== "exec-atomic") failures.push("wrong record");
      } catch (err) {
        failures.push((err as Error).message.slice(0, 120)); // InvalidPersistedStateError on a truncated/partial file
      }
      reads++;
      await new Promise((r) => setImmediate(r)); // let the child's exit event run
    }
    const out = await done;
    expect(out.code, out.stderr).toBe(0);
    expect(reads).toBeGreaterThan(10);
    expect(failures).toEqual([]);
    expect(lockFiles(tmpDir)).toEqual([]);
  }, 60_000);

  it("a crashed writer's leftover temp file does not affect load, exists or list", async () => {
    await store.save(state(1));
    fs.writeFileSync(path.join(store.runsDir, "exec-atomic.json.99999.deadbeef.tmp"), '{"version":1,"execution_id":"exec-at'); // half-written
    expect(await store.exists("exec-atomic")).toBe(true);
    expect((await store.load("exec-atomic"))?.context).toMatchObject({ n: 1 });
    expect((await store.list()).map((s) => s.execution_id)).toEqual(["exec-atomic"]);
  });

  it("a failed save leaves the previous checkpoint intact and cleans up its temp file", async () => {
    await store.save(state(1));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(store.save({ ...state(2), context: circular })).rejects.toThrow();
    expect((await store.load("exec-atomic"))?.context).toMatchObject({ n: 1 });
    expect(lockFiles(tmpDir)).toEqual([]);
  });
});

// =======================================================================================
describe("Phase 5 — engine entry points are safe under competing host turns", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-engine-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("two simultaneous submits of the SAME step: exactly one applies, the other is STALE_STEP, nothing is double-recorded", async () => {
    const executionId = "exec-dup-submit";
    const first = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    if (first.status !== "AGENT_ACTION_REQUIRED") throw new Error("expected action");

    const [a, b] = await Promise.all([
      submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: first.stepId, result: resultFor(first) }),
      submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: first.stepId, result: resultFor(first) }),
    ]);
    const outcomes = [a, b].map((r) => r.status).sort();
    expect(outcomes).toEqual(["AGENT_ACTION_REQUIRED", "FAILED"]);
    const loser = [a, b].find((r) => r.status === "FAILED");
    expect(loser && loser.status === "FAILED" && loser.failureReason).toContain("STALE_STEP");
    expect(loser && loser.status === "FAILED" && loser.terminal).toBe(false);

    const status = await statusProjectRun({ executionId, projectRoot: tmpDir });
    expect(status.stepsCount).toBe(1);
    expect(status.stepLog.filter((r) => r.kind === "AGENT_STEP")).toHaveLength(1);
    expect(status.history.filter((r) => r.decision.action === "DISPATCH_AGENT" && r.decision.step_id === first.stepId)).toHaveLength(1);
    expect(status.history.map((r) => r.step)).toEqual(status.history.map((_, i) => i + 1));
    expect(lockFiles(tmpDir)).toEqual([]);
  });

  it("the same race across two independent OS processes also yields exactly one winner", async () => {
    const executionId = "exec-dup-submit-procs";
    const first = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    if (first.status !== "AGENT_ACTION_REQUIRED") throw new Error("expected action");

    const startAt = Date.now() + 1500; // both children are loaded and spinning before this instant
    const kids = [0, 1].map(() =>
      runWorker("submit-at", { root: tmpDir, executionId, stepId: first.stepId, result: resultFor(first), startAt }),
    );
    const outs = await Promise.all(kids.map(collect));
    const results = outs.map((o) => {
      expect(o.code, o.stderr).toBe(0);
      return JSON.parse(o.stdout.split("RESULT ")[1]) as { status: string; failureReason?: string };
    });
    expect(results.map((r) => r.status).sort()).toEqual(["AGENT_ACTION_REQUIRED", "FAILED"]);
    expect(results.find((r) => r.status === "FAILED")?.failureReason).toContain("STALE_STEP");

    const status = await statusProjectRun({ executionId, projectRoot: tmpDir });
    expect(status.stepsCount).toBe(1);
    expect(status.history.filter((r) => r.decision.action === "DISPATCH_AGENT")).toHaveLength(2); // SPECIFY, then CLARIFY (pending)
    expect(lockFiles(tmpDir)).toEqual([]);
  }, 60_000);

  it("two hosts answering the same human question concurrently: answers recorded once, one re-dispatch, same stepId to both", async () => {
    const executionId = "exec-dup-answers";
    let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    for (let guard = 0; guard < 20 && response.status === "AGENT_ACTION_REQUIRED"; guard++) {
      const block = response.request.state === "ANALYZE";
      response = await submitProjectRunStep({
        projectRoot: tmpDir,
        executionId,
        stepId: response.stepId,
        result: block ? resultFor(response, "FINDINGS", [{ id: "A-1", severity: "HIGH", status: "OPEN" }]) : resultFor(response),
      });
    }
    if (response.status !== "HUMAN_INTERVENTION_REQUIRED") throw new Error(`expected suspension, got ${response.status}`);
    const answers = response.humanIntervention.questions.map((q) => ({ questionId: q.id, answer: "same answer" }));
    const dispatchesBefore = (await statusProjectRun({ executionId, projectRoot: tmpDir })).history.filter((r) => r.decision.action === "DISPATCH_AGENT").length;

    const [a, b] = await Promise.all([
      nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: answers }),
      nextProjectRunStep({ projectRoot: tmpDir, executionId, humanAnswers: answers }),
    ]);
    expect(a.status).toBe("AGENT_ACTION_REQUIRED");
    expect(b.status).toBe("AGENT_ACTION_REQUIRED");
    if (a.status !== "AGENT_ACTION_REQUIRED" || b.status !== "AGENT_ACTION_REQUIRED") return;
    expect(a.stepId).toBe(b.stepId);

    const persisted = await new FileExecutionStateStore(tmpDir).load(executionId);
    expect(persisted?.human_answers).toHaveLength(answers.length); // not doubled
    const dispatchesAfter = persisted?.history?.filter((r) => r.decision.action === "DISPATCH_AGENT").length ?? 0;
    expect(dispatchesAfter - dispatchesBefore).toBe(1); // exactly one fresh ANALYZE dispatch
    expect(persisted?.step_log?.filter((r) => r.kind === "HUMAN_INTERVENTION")).toHaveLength(1);
  });

  it("sequential duplicate/stale submissions are still rejected without side effects (idempotency preserved)", async () => {
    const executionId = "exec-seq-dup";
    const first = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK" });
    if (first.status !== "AGENT_ACTION_REQUIRED") throw new Error("expected action");
    const second = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: first.stepId, result: resultFor(first) });
    if (second.status !== "AGENT_ACTION_REQUIRED") throw new Error("expected next action");

    const before = await new FileExecutionStateStore(tmpDir).load(executionId);
    const replay = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: first.stepId, result: resultFor(first) });
    expect(replay.status === "FAILED" && replay.failureReason).toContain("STALE_STEP");
    const after = await new FileExecutionStateStore(tmpDir).load(executionId);
    expect(after?.step_log).toEqual(before?.step_log);
    expect(after?.history).toEqual(before?.history);
    expect(after?.pending_action?.step_id).toBe(second.stepId);
    expect(lockFiles(tmpDir)).toEqual([]);
  });

  it("a held lock surfaces as a structured, NON-terminal EXECUTION_LOCKED failure; the checkpoint is untouched and a retry succeeds", async () => {
    const executionId = "exec-contended";
    const impatient = new FileExecutionStateStore(tmpDir, undefined, { timeoutMs: 150, pollMs: 10 });
    const first = await nextProjectRunStep({ projectRoot: tmpDir, executionId, runtime: "MOCK", stateStore: impatient });
    if (first.status !== "AGENT_ACTION_REQUIRED") throw new Error("expected action");
    const checkpointBefore = fs.readFileSync(path.join(tmpDir, ".project-run", "runs", `${executionId}.json`), "utf8");

    let release!: () => void;
    const held = new FileExecutionStateStore(tmpDir).withLock(executionId, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 20));

    const blocked = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: first.stepId, result: resultFor(first), stateStore: impatient });
    expect(blocked.status).toBe("FAILED");
    if (blocked.status !== "FAILED") return;
    expect(blocked.failureReason).toContain("EXECUTION_LOCKED");
    expect(blocked.terminal).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, ".project-run", "runs", `${executionId}.json`), "utf8")).toBe(checkpointBefore);

    // Pure reads never wait behind a writer.
    expect((await statusProjectRun({ executionId, projectRoot: tmpDir })).status).toBe("RUNNING");
    expect((await nextProjectRunStep({ projectRoot: tmpDir, executionId, stateStore: impatient })).status).toBe("AGENT_ACTION_REQUIRED");

    release();
    await held;
    const retry = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: first.stepId, result: resultFor(first), stateStore: impatient });
    expect(retry.status).toBe("AGENT_ACTION_REQUIRED");
    expect(lockFiles(tmpDir)).toEqual([]);
  });

  it("push-mode resume under contention returns FAILED EXECUTION_LOCKED and does not touch the checkpoint", async () => {
    const executionId = "exec-push-contended";
    const impatient = new FileExecutionStateStore(tmpDir, undefined, { timeoutMs: 150, pollMs: 10 });
    const adapter = new MockRuntimeAdapter((req) => ({
      execution_id: req.execution_id,
      agent: req.role,
      state: req.state,
      status: req.state === "ANALYZE" ? "FINDINGS" : "PASS",
      evidence: [],
      findings: req.state === "ANALYZE" ? [{ id: "A-1", severity: "HIGH", status: "OPEN" }] : [],
    }));
    const started = await executeProjectRun({ projectRoot: tmpDir, executionId, runtime: "MOCK", context: { state: "INTAKE", runtime: "MOCK" }, adapters: [adapter], stateStore: impatient });
    expect(started.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    const checkpointBefore = fs.readFileSync(path.join(tmpDir, ".project-run", "runs", `${executionId}.json`), "utf8");

    let release!: () => void;
    const held = new FileExecutionStateStore(tmpDir).withLock(executionId, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 20));

    const blocked = await executeProjectResume({ projectRoot: tmpDir, executionId, runtime: "MOCK", adapters: [adapter], stateStore: impatient, humanAnswers: [{ questionId: "q", answer: "a" }] });
    expect(blocked.status).toBe("FAILED");
    expect(blocked.failureReason).toContain("EXECUTION_LOCKED");
    expect(fs.readFileSync(path.join(tmpDir, ".project-run", "runs", `${executionId}.json`), "utf8")).toBe(checkpointBefore);

    release();
    await held;
    expect(lockFiles(tmpDir)).toEqual([]);
  });
});

// =======================================================================================
describe("Phase 5 — crash and recovery across real process death", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-crash-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    setUpProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("host A is SIGKILLed mid-execution; host B loads the checkpoint, sees the history, and finishes the run", async () => {
    const executionId = "exec-crash-recover";
    const hostA = runWorker("pull-then-die", { root: tmpDir, executionId, steps: 3 });
    const out = await collect(hostA);
    expect(out.signal).toBe("SIGKILL");
    const pendingStepId = JSON.parse(out.stdout.split("DIED_AFTER ")[1]).stepId as string;

    // Host B: a brand-new process view of the same execution.
    const recovered = await statusProjectRun({ executionId, projectRoot: tmpDir });
    expect(recovered.status).toBe("RUNNING");
    expect(recovered.stepsCount).toBe(3);
    expect(recovered.stepLog.map((r) => r.state)).toEqual(["SPECIFY", "CLARIFY", "PLAN"]);
    const recoveredHistory = recovered.history;
    expect(recoveredHistory.length).toBeGreaterThan(3);
    expect(recoveredHistory.at(-1)?.decision).toMatchObject({ action: "DISPATCH_AGENT", step_id: pendingStepId });

    let response = await nextProjectRunStep({ projectRoot: tmpDir, executionId });
    expect(response.status === "AGENT_ACTION_REQUIRED" && response.stepId).toBe(pendingStepId); // same pending action, from disk
    for (let guard = 0; response.status === "AGENT_ACTION_REQUIRED" && guard < 40; guard++) {
      response = await submitProjectRunStep({ projectRoot: tmpDir, executionId, stepId: response.stepId, result: resultFor(response) });
    }
    expect(response.status).toBe("COMPLETED");
    if (response.status !== "COMPLETED") return;

    // The pre-crash history is an unchanged prefix of the final history, with continuous numbering.
    expect(response.result.history.slice(0, recoveredHistory.length)).toEqual(recoveredHistory);
    expect(response.result.history.map((r) => r.step)).toEqual(response.result.history.map((_, i) => i + 1));
    expect(response.result.stepsCount).toBe(8);
    expect(lockFiles(tmpDir)).toEqual([]);
  }, 60_000);
});
