// ExecutionStateStore contract: revisions + optimistic concurrency (compare-and-swap), storage
// neutrality, and what happens when the per-execution lock did NOT hold.
//
//   * every conforming store assigns a strictly increasing `revision` and rejects a stale
//     `expectedRevision` with CheckpointConflictError, changing nothing (file store AND a store with no
//     filesystem at all);
//   * the file store's compare-and-swap is exact across real OS processes, with no execution lock held;
//   * with the lock bypassed (store without mutual exclusion) or deleted by an operator, two concurrent
//     turns can no longer silently overwrite each other: the loser gets a non-terminal CHECKPOINT_CONFLICT;
//   * the whole engine (pull, push, host start/resume/status) runs on a store with no filesystem;
//   * a store written against the 0.3.0 contract (void save, no revisions) keeps working unchanged.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { nextProjectRunStep, submitProjectRunStep } from "../src/host/project-run-step.js";
import { executeProjectResume, executeProjectRun } from "../src/project/project-run.js";
import { startProjectRun, resumeProjectRun } from "../src/host/project-run-host.js";
import { statusProjectRun } from "../src/host/status.js";
import { FileExecutionStateStore, type ExecutionStateStore, type PersistedExecutionState } from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";
import { MockRuntimeAdapter } from "../src/runtime/mock-runtime-adapter.js";
import { CheckpointConflictError, CheckpointWriteError, type AgentResult } from "../src/domain/types.js";
import { MemoryExecutionStateStore, LegacyExecutionStateStore } from "./helpers/memory-store.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

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

const passResult = (req: { execution_id: string; role: string; state: string }, status = "PASS", findings: unknown[] = []): AgentResult =>
  ({ execution_id: req.execution_id, agent: req.role, state: req.state, status, evidence: [], findings }) as AgentResult;

const BLOCKING = [{ id: "A", severity: "HIGH", status: "OPEN" }];

async function resultForRequest(store: ExecutionStateStore, req: { execution_id: string; role: string; state: string }): Promise<AgentResult> {
  const answered = ((await store.load(req.execution_id))?.human_answers ?? []).length > 0;
  return req.state === "ANALYZE" && !answered ? passResult(req, "FINDINGS", BLOCKING) : passResult(req);
}

function sampleState(id: string, over: Partial<PersistedExecutionState> = {}): PersistedExecutionState {
  return {
    version: 1, execution_id: id, project: "p", feature: "f", branch: "b", state: "SPECIFY", lifecycle_status: "IN_PROGRESS",
    runtime: "MOCK", iteration: 1, remediation_iteration: 0, preset: "spec-kit-v1", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", ...over,
  } as PersistedExecutionState;
}

/** Drives a whole pull lifecycle (with a human round trip) on any store through the public API. */
async function drivePull(store: ExecutionStateStore, projectRoot: string, id: string): Promise<PersistedExecutionState> {
  let r = await nextProjectRunStep({ projectRoot, executionId: id, runtime: "MOCK", stateStore: store });
  for (let g = 0; g < 100 && r.status !== "COMPLETED"; g++) {
    if (r.status === "AGENT_ACTION_REQUIRED") {
      r = await submitProjectRunStep({ projectRoot, executionId: id, stepId: r.stepId, result: await resultForRequest(store, r.request), stateStore: store });
    } else if (r.status === "HUMAN_INTERVENTION_REQUIRED") {
      r = await nextProjectRunStep({ projectRoot, executionId: id, stateStore: store, humanAnswers: r.humanIntervention.questions.map((q) => ({ questionId: q.id, answer: "ok" })) });
    } else throw new Error(`unexpected ${r.status}: ${JSON.stringify(r)}`);
  }
  return (await store.load(id))!;
}

let tmpDir: string;
beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p6-store-"));
  await runProjectInit({ projectRoot: tmpDir, silent: true });
  setUpProject(tmpDir);
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =======================================================================================
// The contract, run against every conforming store
// =======================================================================================
const conforming: Array<{ name: string; make: (dir: string) => ExecutionStateStore }> = [
  { name: "FileExecutionStateStore", make: (dir) => new FileExecutionStateStore(dir) },
  { name: "MemoryExecutionStateStore (no filesystem)", make: () => new MemoryExecutionStateStore() },
];

for (const { name, make } of conforming) {
  describe(`ExecutionStateStore contract — ${name}`, () => {
    it("assigns strictly increasing revisions from 1, reports them in the receipt, and returns them from load()", async () => {
      const store = make(tmpDir);
      expect(await store.load("c1")).toBeNull();
      const r1 = await store.save(sampleState("c1"));
      const r2 = await store.save(sampleState("c1", { state: "CLARIFY" }));
      const r3 = await store.save(sampleState("c1", { state: "ANALYZE" }));
      expect([r1, r2, r3].map((r) => (r as { revision: number }).revision)).toEqual([1, 2, 3]);
      const loaded = (await store.load("c1"))!;
      expect(loaded.revision).toBe(3);
      expect(loaded.state).toBe("ANALYZE");
    });

    it("ignores a caller-supplied revision: the store owns the counter", async () => {
      const store = make(tmpDir);
      await store.save(sampleState("c2", { revision: 99 }));
      expect((await store.load("c2"))!.revision).toBe(1);
    });

    it("expectedRevision matching => applied; mismatching => CheckpointConflictError, NOTHING written", async () => {
      const store = make(tmpDir);
      await store.save(sampleState("c3")); // revision 1
      await store.save(sampleState("c3", { state: "CLARIFY" }), { expectedRevision: 1 }); // -> 2

      const before = JSON.stringify(await store.load("c3"));
      const err = await store.save(sampleState("c3", { state: "ANALYZE" }), { expectedRevision: 1 }).catch((e) => e);
      expect(err).toBeInstanceOf(CheckpointConflictError);
      expect(err).toBeInstanceOf(CheckpointWriteError);
      expect(err.code).toBe("CHECKPOINT_CONFLICT");
      expect(err.expectedRevision).toBe(1);
      expect(err.actualRevision).toBe(2);
      expect(err.message).toMatch(/^CHECKPOINT_CONFLICT:/);
      expect(JSON.stringify(await store.load("c3"))).toBe(before); // untouched, revision still 2
    });

    it("expectedRevision 0 means 'must not exist yet': a second creator is rejected", async () => {
      const store = make(tmpDir);
      await store.save(sampleState("c4"), { expectedRevision: 0 });
      await expect(store.save(sampleState("c4", { state: "CLARIFY" }), { expectedRevision: 0 })).rejects.toBeInstanceOf(CheckpointConflictError);
      expect((await store.load("c4"))!.state).toBe("SPECIFY");
    });

    it("a save without options is unconditional (and still advances the revision)", async () => {
      const store = make(tmpDir);
      await store.save(sampleState("c5"));
      await store.save(sampleState("c5", { state: "CLARIFY" }));
      expect((await store.load("c5"))!.revision).toBe(2);
    });

    it("exists() agrees with load()", async () => {
      const store = make(tmpDir);
      expect(await store.exists("c6")).toBe(false);
      await store.save(sampleState("c6"));
      expect(await store.exists("c6")).toBe(true);
    });
  });
}

describe("FileExecutionStateStore — revisions and compatibility", () => {
  it("a checkpoint written before revisions existed loads with no revision, reads as 0, and can be written with expectedRevision 0", async () => {
    const store = new FileExecutionStateStore(tmpDir);
    fs.mkdirSync(store.runsDir, { recursive: true });
    fs.writeFileSync(path.join(store.runsDir, "legacy.json"), JSON.stringify(sampleState("legacy")), "utf8"); // no `revision` key
    expect((await store.load("legacy"))!.revision).toBeUndefined();
    const receipt = await store.save(sampleState("legacy", { state: "CLARIFY" }), { expectedRevision: 0 });
    expect(receipt.revision).toBe(1);
    await expect(store.save(sampleState("legacy"), { expectedRevision: 0 })).rejects.toBeInstanceOf(CheckpointConflictError);
  });

  it("rejects an invalid persisted revision instead of guessing", async () => {
    const store = new FileExecutionStateStore(tmpDir);
    fs.mkdirSync(store.runsDir, { recursive: true });
    fs.writeFileSync(path.join(store.runsDir, "bad.json"), JSON.stringify({ ...sampleState("bad"), revision: -3 }), "utf8");
    await expect(store.load("bad")).rejects.toMatchObject({ code: "INVALID_PERSISTED_STATE" });
  });

  it("an unreadable stored checkpoint is a failed write (not a fake conflict) when a revision is expected; an unconditional save repairs it", async () => {
    const store = new FileExecutionStateStore(tmpDir);
    fs.mkdirSync(store.runsDir, { recursive: true });
    fs.writeFileSync(path.join(store.runsDir, "corrupt.json"), "{ not json", "utf8");
    const err = await store.save(sampleState("corrupt"), { expectedRevision: 1 }).catch((e) => e);
    expect(err).not.toBeInstanceOf(CheckpointConflictError);
    expect(String(err.message)).toMatch(/cannot be read/);
    await store.save(sampleState("corrupt")); // unconditional repair
    expect((await store.load("corrupt"))!.revision).toBe(1);
  });

  it("a write guard abandoned by a process that died is reclaimed (dead holder), so a crash inside save() can never wedge an execution", async () => {
    const store = new FileExecutionStateStore(tmpDir);
    await store.save(sampleState("wedge"));
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((r) => dead.on("close", r));
    fs.writeFileSync(
      path.join(store.runsDir, "wedge.cas"),
      JSON.stringify({ pid: dead.pid, token: "dead-writer", acquired_at: new Date().toISOString() }),
    );
    const started = Date.now();
    const receipt = await store.save(sampleState("wedge", { state: "CLARIFY" }), { expectedRevision: 1 });
    expect(receipt.revision).toBe(2);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fs.readdirSync(store.runsDir).filter((f) => !f.endsWith(".json"))).toEqual([]);
  });

  it("a write guard held by a LIVE process is never stolen: the save fails (as a checkpoint write failure) instead of racing it", async () => {
    const store = new FileExecutionStateStore(tmpDir);
    await store.save(sampleState("held"));
    // Held by this very process (alive): a second save must give up after its bounded wait, not reclaim it.
    fs.writeFileSync(path.join(store.runsDir, "held.cas"), JSON.stringify({ pid: process.pid, token: "someone-else", acquired_at: new Date().toISOString() }));
    const slowStore = new FileExecutionStateStore(tmpDir);
    const err = await Promise.race([
      slowStore.save(sampleState("held", { state: "CLARIFY" })).then(() => "saved", (e) => e),
      new Promise((r) => setTimeout(() => r("still-waiting"), 1_500)),
    ]);
    expect(err).toBe("still-waiting"); // waiting on the live holder (bounded by its 10s guard budget), never overwriting
    expect((await store.load("held"))!.state).toBe("SPECIFY");
    fs.rmSync(path.join(store.runsDir, "held.cas"), { force: true }); // release it; the waiting save then completes
    await new Promise((r) => setTimeout(r, 300));
    expect((await store.load("held"))!.state).toBe("CLARIFY");
  });

  it("leaves no guard, lock or temp files behind after saves, conflicts and failures", async () => {
    const store = new FileExecutionStateStore(tmpDir);
    await store.save(sampleState("tidy"));
    await store.save(sampleState("tidy"), { expectedRevision: 1 });
    await store.save(sampleState("tidy"), { expectedRevision: 1 }).catch(() => undefined);
    expect(fs.readdirSync(store.runsDir).filter((f) => !f.endsWith(".json"))).toEqual([]);
  });
});

// =======================================================================================
// Exact compare-and-swap across real processes
// =======================================================================================

describe("FileExecutionStateStore — compare-and-swap across real OS processes (no execution lock held)", () => {
  let compiledDir: string;
  let workerPath: string;

  beforeAll(() => {
    compiledDir = fs.mkdtempSync(path.join(os.tmpdir(), "p6-compiled-"));
    execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(REPO_ROOT, "tsconfig.build.json"), "--outDir", path.join(compiledDir, "dist"), "--declaration", "false", "--declarationMap", "false", "--sourceMap", "false"],
      { cwd: REPO_ROOT, stdio: "pipe" },
    );
    fs.writeFileSync(path.join(compiledDir, "package.json"), JSON.stringify({ type: "module" }));
    workerPath = path.join(compiledDir, "cas-worker.mjs");
    fs.writeFileSync(
      workerPath,
      `import { FileExecutionStateStore } from "file://${compiledDir}/dist/project/state-store.js";
const [root, id, startAt, tag] = process.argv.slice(2);
const store = new FileExecutionStateStore(root);
const loaded = await store.load(id);
const expected = loaded?.revision ?? 0;
while (Date.now() < Number(startAt)) await new Promise((r) => setTimeout(r, 1));
try {
  const r = await store.save({ ...loaded, iteration: Number(tag) }, { expectedRevision: expected });
  console.log("OK " + r.revision + " " + tag);
} catch (e) {
  console.log((e.name === "CheckpointConflictError" ? "CONFLICT " : "ERROR " + e.message + " ") + tag);
}
`,
    );
  }, 120_000);

  afterAll(() => {
    fs.rmSync(compiledDir, { recursive: true, force: true });
  });

  function run(args: string[]): Promise<string> {
    return new Promise((resolve) => {
      const child: ChildProcess = spawn(process.execPath, [workerPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout!.on("data", (b) => (out += b));
      child.on("close", () => resolve(out.trim()));
    });
  }

  it("N processes that all read revision r and write at the same instant: exactly one wins, the rest are told CONFLICT, the file is valid at r+1", async () => {
    const store = new FileExecutionStateStore(tmpDir);
    for (let round = 0; round < 5; round++) {
      const id = `race-${round}`;
      await store.save(sampleState(id));
      await store.save(sampleState(id)); // revision 2
      const startAt = Date.now() + 700;
      const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => run([tmpDir, id, String(startAt), String(i + 10)])));
      const ok = outs.filter((o) => o.startsWith("OK"));
      const conflicts = outs.filter((o) => o.startsWith("CONFLICT"));
      expect(outs.filter((o) => o.startsWith("ERROR")), outs.join("\n")).toEqual([]);
      expect(ok, outs.join("\n")).toHaveLength(1);
      expect(conflicts).toHaveLength(7);
      const final = (await store.load(id))!;
      expect(final.revision).toBe(3);
      expect(String(final.iteration)).toBe(ok[0].split(" ")[2]); // the stored write is the winner's
    }
    expect(fs.readdirSync(store.runsDir).filter((f) => !f.endsWith(".json"))).toEqual([]);
  }, 120_000);
});

// =======================================================================================
// When the lock did not hold
// =======================================================================================
describe("lost updates are rejected when the per-execution lock did not hold", () => {
  /** A store whose first load() (the one that starts a turn) can be paused, to interleave two turns deterministically. */
  class GatedStore extends FileExecutionStateStore {
    private gate: Promise<void> | null = null;
    private onReached: (() => void) | null = null;
    private skip = 0;
    /** Pauses the n-th load() from now (1 = the next one), after it has read the checkpoint. */
    pauseNextLoad(n = 1): { reached: Promise<void>; release: () => void } {
      let release!: () => void;
      this.gate = new Promise<void>((r) => (release = r));
      this.skip = n - 1;
      const reached = new Promise<void>((r) => (this.onReached = r));
      return { reached, release };
    }
    override async load(id: string) {
      const v = await super.load(id);
      if (this.gate && this.skip-- <= 0) {
        const g = this.gate;
        this.gate = null;
        this.onReached?.();
        await g;
      }
      return v;
    }
  }
  /** Mutual exclusion switched off: what a store without `withLock` (or a lock bypassed by an operator) gives. */
  class UnlockedStore extends GatedStore {
    override async withLock<T>(_id: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    }
  }

  async function startPending(store: ExecutionStateStore, id: string) {
    const first = await nextProjectRunStep({ projectRoot: tmpDir, executionId: id, runtime: "MOCK", stateStore: store });
    if (first.status !== "AGENT_ACTION_REQUIRED") throw new Error("setup");
    return first;
  }

  it("two submits of the same step with NO mutual exclusion: the interleaved loser is a non-terminal CHECKPOINT_CONFLICT and the winner's progress stands (0.3.0 would double-apply)", async () => {
    const store = new UnlockedStore(tmpDir);
    const first = await startPending(store, "lost1");
    const result = passResult(first.request);

    const gate = store.pauseNextLoad();
    const slow = submitProjectRunStep({ projectRoot: tmpDir, executionId: "lost1", stepId: first.stepId, result, stateStore: store });
    await gate.reached; // the slow turn has read the checkpoint and validated it; it is now paused
    const fast = await submitProjectRunStep({ projectRoot: tmpDir, executionId: "lost1", stepId: first.stepId, result, stateStore: store });
    expect(fast.status).toBe("AGENT_ACTION_REQUIRED"); // the winner completed its whole turn
    const winnerCp = (await store.load("lost1"))!;
    gate.release();

    const loser = await slow;
    expect(loser.status).toBe("FAILED");
    if (loser.status !== "FAILED") return;
    expect(loser.failureCode).toBe("CHECKPOINT_CONFLICT");
    expect(loser.terminal).toBe(false);
    expect(loser.failureReason).toMatch(/^CHECKPOINT_CONFLICT:/);

    const after = (await store.load("lost1"))!;
    expect(after.revision).toBe(winnerCp.revision); // the loser wrote nothing
    expect(after.pending_action?.step_id).toBe(winnerCp.pending_action?.step_id);
    expect(after.step_log!.filter((e) => e.kind === "AGENT_STEP")).toHaveLength(1); // applied exactly once
    // And the execution carries on from the winner's state.
    const next = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "lost1", stateStore: store });
    expect(next.status === "AGENT_ACTION_REQUIRED" && next.stepId).toBe(winnerCp.pending_action?.step_id);
  });

  it("an operator deleting a LIVE holder's lock file (the documented manual recovery, misapplied) can no longer corrupt the execution", async () => {
    const store = new GatedStore(tmpDir, undefined, { timeoutMs: 2_000, pollMs: 5 });
    const first = await startPending(store, "lost2");
    const result = passResult(first.request);

    const gate = store.pauseNextLoad();
    const slow = submitProjectRunStep({ projectRoot: tmpDir, executionId: "lost2", stepId: first.stepId, result, stateStore: store });
    await gate.reached; // slow holds the REAL lock, paused mid-turn
    fs.rmSync(path.join(store.runsDir, "lost2.lock"), { force: true }); // "the lock looks stuck, delete it"
    const other = new FileExecutionStateStore(tmpDir, undefined, { timeoutMs: 2_000, pollMs: 5 });
    const fast = await submitProjectRunStep({ projectRoot: tmpDir, executionId: "lost2", stepId: first.stepId, result, stateStore: other });
    expect(fast.status).toBe("AGENT_ACTION_REQUIRED");
    gate.release();

    const loser = await slow;
    expect(loser.status === "FAILED" && loser.failureCode).toBe("CHECKPOINT_CONFLICT");
    const cp = (await store.load("lost2"))!;
    expect(cp.step_log!.filter((e) => e.kind === "AGENT_STEP")).toHaveLength(1);
    expect(fs.readdirSync(store.runsDir).filter((f) => !f.endsWith(".json"))).toEqual([]);
  });

  it("two hosts starting the same NEW execution id with no mutual exclusion: one creates it, the other is a CHECKPOINT_CONFLICT (expected revision 0)", async () => {
    const store = new UnlockedStore(tmpDir);
    // The read pass (load #1) sees "does not exist"; the locked pass (load #2) is the one that decides to
    // create it — pause there, after it has read, so the other host can create the execution first.
    const gate = store.pauseNextLoad(2);
    const slow = nextProjectRunStep({ projectRoot: tmpDir, executionId: "new1", runtime: "MOCK", stateStore: store });
    await gate.reached; // slow has (again) seen "does not exist" and is about to create it
    const fast = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "new1", runtime: "MOCK", stateStore: store });
    expect(fast.status).toBe("AGENT_ACTION_REQUIRED");
    gate.release();
    const loser = await slow;
    expect(loser.status === "FAILED" && loser.failureCode).toBe("CHECKPOINT_CONFLICT");
    expect(loser.status === "FAILED" && loser.terminal).toBe(false);
    const cp = (await store.load("new1"))!;
    expect(cp.pending_action?.step_id).toBe(fast.status === "AGENT_ACTION_REQUIRED" ? fast.stepId : "?");
  });

  it("push mode: a change made to the execution while a run is in flight makes the run's next checkpoint a CHECKPOINT_CONFLICT; the other change stands", async () => {
    const store = new FileExecutionStateStore(tmpDir);
    const intruder = new FileExecutionStateStore(tmpDir);
    let calls = 0;
    const adapter = new MockRuntimeAdapter(async (req) => {
      calls++;
      if (calls === 2) {
        const cp = (await intruder.load("push-conflict"))!;
        await intruder.save({ ...cp, terminal_reason: "touched by someone else" }); // bumps the revision behind the run's back
      }
      return resultForRequest(store, req);
    });
    const res = await executeProjectRun({ projectRoot: tmpDir, executionId: "push-conflict", runtime: "MOCK", context: { state: "INTAKE", runtime: "MOCK" }, adapters: [adapter], stateStore: store });
    expect(res.status).toBe("FAILED");
    expect(res.persistenceFailure).toBe("CHECKPOINT_CONFLICT");
    expect(res.failureReason).toMatch(/^CHECKPOINT_CONFLICT:/);
    const cp = (await store.load("push-conflict"))!;
    expect(cp.terminal_reason).toBe("touched by someone else"); // not clobbered
    expect(cp.lifecycle_status).not.toBe("FAILED"); // a conflict never marks the execution failed
    // Host layer: non-terminal with failureCode.
    const host = await startProjectRun({
      projectRoot: tmpDir, executionId: "push-conflict-2", runtime: "MOCK", stateStore: store,
      adapters: [new MockRuntimeAdapter(async (req) => {
        const cp2 = await store.load("push-conflict-2");
        if (cp2 && req.state !== "SPECIFY") await intruder.save({ ...cp2, terminal_reason: "x" });
        return passResult(req);
      })],
    });
    expect(host.status).toBe("FAILED");
    expect(host.terminal).toBe(false);
    expect(host.failureCode).toBe("CHECKPOINT_CONFLICT");
  });
});

// =======================================================================================
// Revision chaining in normal operation
// =======================================================================================
describe("revision chaining", () => {
  it("every checkpoint of a full pull lifecycle is a compare-and-swap from the previous revision, and revisions are exactly 1..N", async () => {
    class SpyStore extends FileExecutionStateStore {
      calls: Array<{ expected: number | undefined; got: number }> = [];
      override async save(state: PersistedExecutionState, options?: { expectedRevision?: number }) {
        const receipt = await super.save(state, options);
        this.calls.push({ expected: options?.expectedRevision, got: receipt.revision });
        return receipt;
      }
    }
    const store = new SpyStore(tmpDir);
    const final = await drivePull(store, tmpDir, "chain");
    expect(store.calls.length).toBeGreaterThan(20);
    store.calls.forEach((c, i) => {
      expect(c.got).toBe(i + 1);
      expect(c.expected, `save #${i + 1} was not a compare-and-swap`).toBe(i); // expected = previous revision (0 for the first)
    });
    expect(final.revision).toBe(store.calls.length);
  }, 60_000);
});

// =======================================================================================
// Storage neutrality
// =======================================================================================
describe("the engine is storage-neutral", () => {
  it("a full pull lifecycle runs on a store with no filesystem, and touches no runs directory", async () => {
    const store = new MemoryExecutionStateStore();
    const final = await drivePull(store, tmpDir, "mem-pull");
    expect(final.lifecycle_status).toBe("COMPLETED");
    expect(final.revision).toBe(store.saves);
    expect(fs.existsSync(path.join(tmpDir, ".project-run", "runs"))).toBe(false);
  }, 60_000);

  it("the host start()/resume()/status() accept a store, round-trip a human suspension on it, and report the durable record from it", async () => {
    const store = new MemoryExecutionStateStore();
    const adapter = new MockRuntimeAdapter(async (req) => resultForRequest(store, req));
    const started = await startProjectRun({ projectRoot: tmpDir, executionId: "mem-host", runtime: "MOCK", adapters: [adapter], stateStore: store });
    expect(started.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(started.stepsCount).toBeGreaterThan(0);
    expect(started.stepLog.length).toBeGreaterThan(0);
    const status = await statusProjectRun({ executionId: "mem-host", projectRoot: tmpDir, stateStore: store });
    expect(status.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(status.history).toEqual(started.history);
    const resumed = await resumeProjectRun({
      projectRoot: tmpDir, executionId: "mem-host", runtime: "MOCK", adapters: [adapter], stateStore: store,
      humanAnswers: started.humanIntervention!.questions.map((q) => ({ questionId: q.id, answer: "ok" })),
    });
    expect(resumed.status).toBe("COMPLETED");
    expect(resumed.stepLog.length).toBeGreaterThan(started.stepLog.length);
    expect(fs.existsSync(path.join(tmpDir, ".project-run", "runs"))).toBe(false); // no filesystem knowledge leaked
  }, 60_000);

  it("a call rejected before any run context exists still reports the durable record from the supplied store (not the file store, not empty)", async () => {
    const store = new MemoryExecutionStateStore();
    const adapter = new MockRuntimeAdapter(async (req) => resultForRequest(store, req));
    let res = await startProjectRun({ projectRoot: tmpDir, executionId: "mem-done", runtime: "MOCK", adapters: [adapter], stateStore: store });
    res = await resumeProjectRun({ projectRoot: tmpDir, executionId: "mem-done", runtime: "MOCK", adapters: [adapter], stateStore: store, humanAnswers: res.humanIntervention!.questions.map((q) => ({ questionId: q.id, answer: "ok" })) });
    expect(res.status).toBe("COMPLETED");
    const again = await resumeProjectRun({ projectRoot: tmpDir, executionId: "mem-done", runtime: "MOCK", adapters: [adapter], stateStore: store });
    expect(again.status).toBe("FAILED"); // EXECUTION_NOT_RESUMABLE: rejected before a context was built
    expect(again.stepLog).toEqual(res.stepLog);
    expect(again.history).toEqual(res.history);
    expect(again.stepsCount).toBe(res.stepsCount);
  }, 60_000);

  it("a store written against the 0.3.0 contract (void save, no revisions, no lock) keeps working: pull and push complete", async () => {
    const legacy = new LegacyExecutionStateStore();
    const pull = await drivePull(legacy, tmpDir, "leg-pull");
    expect(pull.lifecycle_status).toBe("COMPLETED");

    const adapter = new MockRuntimeAdapter(async (req) => resultForRequest(legacy, req));
    let res = await executeProjectRun({ projectRoot: tmpDir, executionId: "leg-push", runtime: "MOCK", context: { state: "INTAKE", runtime: "MOCK" }, adapters: [adapter], stateStore: legacy });
    if (res.status === "HUMAN_INTERVENTION_REQUIRED") {
      const cp = (await legacy.load("leg-push"))!;
      res = await executeProjectResume({ projectRoot: tmpDir, executionId: "leg-push", runtime: "MOCK", adapters: [adapter], stateStore: legacy, humanAnswers: (cp.human_intervention?.questions ?? []).map((q) => ({ questionId: q.id, answer: "ok" })) });
    }
    expect(res.status).toBe("COMPLETED");
  }, 60_000);

  it("failure injection on a non-file store: a rejected save is a CHECKPOINT_WRITE_FAILED and the execution recovers (same contract as the file store)", async () => {
    const store = new MemoryExecutionStateStore();
    const first = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "mem-fail", runtime: "MOCK", stateStore: store });
    if (first.status !== "AGENT_ACTION_REQUIRED") throw new Error("setup");
    store.failNextSave = new Error("connection reset");
    const failed = await submitProjectRunStep({ projectRoot: tmpDir, executionId: "mem-fail", stepId: first.stepId, result: passResult(first.request), stateStore: store });
    expect(failed.status === "FAILED" && failed.failureCode).toBe("CHECKPOINT_WRITE_FAILED");
    expect(failed.status === "FAILED" && failed.terminal).toBe(false);
    const again = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "mem-fail", stateStore: store });
    expect(again.status === "AGENT_ACTION_REQUIRED" && again.stepId).toBe(first.stepId);
  });
});

// =======================================================================================
// What is NOT revision-protected (documented in ARCHITECTURE.md §4.17.2)
// =======================================================================================
describe("initial push start is unconditional (characterisation of documented behaviour)", () => {
  const adapterFor = (store: ExecutionStateStore) => new MockRuntimeAdapter(async (req) => resultForRequest(store, req));

  it("a second push start with an existing execution id restarts that execution — its first write does not use expectedRevision 0 — while pull next-step on the same id continues it", async () => {
    class SpyStore extends FileExecutionStateStore {
      calls: Array<{ expected: number | undefined }> = [];
      override async save(state: PersistedExecutionState, options?: { expectedRevision?: number }) {
        this.calls.push({ expected: options?.expectedRevision });
        return super.save(state, options);
      }
    }
    const store = new SpyStore(tmpDir);
    const first = await executeProjectRun({ projectRoot: tmpDir, executionId: "reuse", runtime: "MOCK", context: { state: "INTAKE", runtime: "MOCK" }, adapters: [adapterFor(store)], stateStore: store });
    expect(first.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    // The first write of a push start carries no expected revision; later writes chain from its receipt.
    expect(store.calls[0].expected).toBeUndefined();
    expect(store.calls.slice(1).every((c, i) => c.expected === i + 1)).toBe(true);
    const before = (await store.load("reuse"))!;
    expect(before.step_log!.length).toBeGreaterThan(0);

    store.calls = [];
    const again = await executeProjectRun({ projectRoot: tmpDir, executionId: "reuse", runtime: "MOCK", context: { state: "INTAKE", runtime: "MOCK" }, adapters: [adapterFor(store)], stateStore: store });
    expect(again.status).toBe("HUMAN_INTERVENTION_REQUIRED"); // no conflict, no rejection: the id is simply reused
    expect(again.persistenceFailure).toBeUndefined();
    expect(store.calls[0].expected).toBeUndefined();
    const after = (await store.load("reuse"))!;
    expect(after.revision).toBeGreaterThan(before.revision!); // revisions keep counting across the restart
    expect(after.step_log![0].seq).toBe(1); // ...but the record is the new run's: the old run's log was replaced

    // Pull mode is different: an explicit id that exists is CONTINUED, never reset.
    const pullStore = new MemoryExecutionStateStore();
    const a = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "p1", runtime: "MOCK", stateStore: pullStore });
    const b = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "p1", runtime: "MOCK", stateStore: pullStore });
    expect(a.status === "AGENT_ACTION_REQUIRED" && b.status === "AGENT_ACTION_REQUIRED" && a.stepId === b.stepId).toBe(true);
  }, 60_000);
});
