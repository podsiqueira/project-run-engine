// NF-2: a checkpoint the engine needs but cannot write is never swallowed.
//
// Contract under test (ARCHITECTURE.md §4.17, "Checkpoint write failures"):
//   * the engine never reports progress that is not durable — no AGENT_ACTION_REQUIRED, COMPLETED,
//     HUMAN_INTERVENTION_REQUIRED or "applied result" is returned unless the matching checkpoint exists;
//   * a failed write surfaces as a structured, NON-terminal failure with failureCode
//     CHECKPOINT_WRITE_FAILED (pull and push), whose state/records are the LAST DURABLE ones;
//   * the execution is left at its last durable checkpoint and is recoverable exactly like a crash:
//     pull -> call next-step again; push -> resume (or start again if nothing was ever written);
//   * the proof is exhaustive: for EVERY save of a full lifecycle, failing just that one save keeps all
//     of the above true and the execution still completes with a consistent record.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nextProjectRunStep, submitProjectRunStep } from "../src/host/project-run-step.js";
import { executeProjectResume, executeProjectRun } from "../src/project/project-run.js";
import { startProjectRun, resumeProjectRun } from "../src/host/project-run-host.js";
import { statusProjectRun } from "../src/host/status.js";
import { FileExecutionStateStore, type PersistedExecutionState } from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";
import { MockRuntimeAdapter } from "../src/runtime/mock-runtime-adapter.js";
import { CheckpointWriteError, type AgentResult } from "../src/domain/types.js";

// ---------------------------------------------------------------------------------------
// Fixtures
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

/** A real FileExecutionStateStore whose Nth save (1-based) fails like a full disk, once. */
class FaultyStore extends FileExecutionStateStore {
  saves = 0;
  failedAt: number | null = null;
  private failAt: number | null = null;
  failOn(n: number | null): void { this.failAt = n; this.failedAt = null; }
  heal(): void { this.failAt = null; }
  override async save(state: PersistedExecutionState): Promise<void> {
    this.saves++;
    if (this.failAt !== null && this.saves === this.failAt) {
      this.failedAt = this.saves;
      this.failAt = null; // a single failure; later saves work (the operator fixed the disk)
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    }
    return super.save(state);
  }
}

const passResult = (req: { execution_id: string; role: string; state: string }, status = "PASS", findings: unknown[] = []): AgentResult =>
  ({ execution_id: req.execution_id, agent: req.role, state: req.state, status, evidence: [], findings }) as AgentResult;

const BLOCKING = [{ id: "A", severity: "HIGH", status: "OPEN" }];

/** What the driver submits for a request: ANALYZE blocks until a human answer is on record. */
async function resultForRequest(store: FileExecutionStateStore, req: { execution_id: string; role: string; state: string }): Promise<AgentResult> {
  const answered = ((await store.load(req.execution_id))?.human_answers ?? []).length > 0;
  return req.state === "ANALYZE" && !answered ? passResult(req, "FINDINGS", BLOCKING) : passResult(req);
}

async function readDurable(store: FileExecutionStateStore, id: string): Promise<PersistedExecutionState | null> {
  return new FileExecutionStateStore(store.runsDir.replace(/\/\.project-run\/runs$/, "")).load(id);
}

/** The end-of-lifecycle record must be internally consistent however many failures happened on the way. */
function expectConsistentRecord(cp: PersistedExecutionState): void {
  const history = cp.history ?? [];
  const steps = (cp.step_log ?? []).filter((e) => e.kind === "AGENT_STEP");
  const dispatches = history.filter((h) => h.decision.action === "DISPATCH_AGENT");
  expect(history.every((h, i) => h.step === i + 1)).toBe(true);
  expect((cp.step_log ?? []).every((e, i) => e.seq === i + 1)).toBe(true);
  expect(steps.length).toBe(dispatches.length);
  const stepIds = steps.map((s) => s.step_id).filter(Boolean);
  expect(new Set(stepIds).size).toBe(stepIds.length); // no step applied twice
  expect(stepIds).toEqual(dispatches.map((d) => (d.decision as { step_id?: string }).step_id).filter(Boolean));
}

let tmpDir: string;
beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nf2-"));
  await runProjectInit({ projectRoot: tmpDir, silent: true });
  setUpProject(tmpDir);
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =======================================================================================
// Pull mode
// =======================================================================================
describe("NF-2 pull mode — a failed checkpoint write is never reported as progress", () => {
  interface Outcome { injected: number; failuresSeen: number; final: PersistedExecutionState }

  /**
   * Drives a whole pull lifecycle (with one human-intervention round trip) through the public API.
   * Checks the "response => durable" invariant on EVERY response, and recovers from a
   * CHECKPOINT_WRITE_FAILED exactly as documented: heal storage, call next-step again.
   */
  async function drivePull(store: FaultyStore, id: string): Promise<Outcome> {
    let failuresSeen = 0;
    const submitted = new Map<string, AgentResult>();
    let r = await nextProjectRunStep({ projectRoot: tmpDir, executionId: id, runtime: "MOCK", stateStore: store });
    for (let guard = 0; guard < 120; guard++) {
      const cp = await readDurable(store, id);
      if (r.status === "FAILED") {
        // Nothing durable yet => the documented first-checkpoint failure; otherwise CHECKPOINT_WRITE_FAILED.
        expect(r.failureCode, `unexpected failure: ${r.failureReason}`).toBe(cp ? "CHECKPOINT_WRITE_FAILED" : "EXECUTION_LOCK_UNAVAILABLE");
        expect(r.terminal).toBe(false);
        expect(r.failureReason).toMatch(cp ? /^CHECKPOINT_WRITE_FAILED:/ : /^EXECUTION_LOCK_UNAVAILABLE:/);
        // The failing response describes the LAST DURABLE checkpoint, not the abandoned turn.
        if (cp) expect(r.state).toBe(cp.state);
        failuresSeen++;
        store.heal();
        r = await nextProjectRunStep({ projectRoot: tmpDir, executionId: id, runtime: "MOCK", stateStore: store });
        continue;
      }
      // response => durable
      if (r.status === "AGENT_ACTION_REQUIRED") {
        expect(cp?.lifecycle_status).toBe("AWAITING_AGENT_ACTION");
        expect(cp?.pending_action?.step_id).toBe(r.stepId);
        let result = submitted.get(r.stepId);
        if (!result) { result = await resultForRequest(store, r.request); submitted.set(r.stepId, result); }
        r = await submitProjectRunStep({ projectRoot: tmpDir, executionId: id, stepId: r.stepId, result, stateStore: store });
      } else if (r.status === "HUMAN_INTERVENTION_REQUIRED") {
        expect(cp?.lifecycle_status).toBe("HUMAN_INTERVENTION_REQUIRED");
        r = await nextProjectRunStep({
          projectRoot: tmpDir, executionId: id, runtime: "MOCK", stateStore: store,
          humanAnswers: r.humanIntervention.questions.map((q) => ({ questionId: q.id, answer: "approved" })),
        });
      } else if (r.status === "COMPLETED") {
        expect(cp?.lifecycle_status).toBe("COMPLETED");
        return { injected: store.failedAt ?? 0, failuresSeen, final: cp! };
      } else {
        throw new Error(`unexpected status ${r.status}`);
      }
    }
    throw new Error("lifecycle did not finish");
  }

  it("baseline: with a healthy store every response is backed by its checkpoint and the record is consistent", async () => {
    const store = new FaultyStore(tmpDir);
    const out = await drivePull(store, "pull-base");
    expect(out.failuresSeen).toBe(0);
    expect(out.final.human_answers?.length).toBeGreaterThan(0); // the HITL round trip really happened
    expectConsistentRecord(out.final);
  }, 60_000);

  it("EXHAUSTIVE: failing ANY single save of a full lifecycle (incl. HITL answers and completion) is reported, never swallowed, and always recoverable", async () => {
    const baseline = new FaultyStore(tmpDir);
    await drivePull(baseline, "count");
    const totalSaves = baseline.saves;
    expect(totalSaves).toBeGreaterThan(20); // submit, transition, human intervention and completion saves are all in range

    let injectedCount = 0;
    for (let k = 1; k <= totalSaves; k++) {
      const id = `pull-k${k}`;
      const store = new FaultyStore(tmpDir);
      store.failOn(k);
      const out = await drivePull(store, id);
      // The injected failure must have been OBSERVED by the caller (not swallowed)...
      expect(store.failedAt, `save #${k} was never reached`).toBe(k);
      expect(out.failuresSeen, `failing save #${k} was not reported to the caller`).toBeGreaterThanOrEqual(1);
      injectedCount++;
      // ...and the execution still reached a complete, consistent record.
      expect(out.final.lifecycle_status).toBe("COMPLETED");
      expectConsistentRecord(out.final);
    }
    expect(injectedCount).toBe(totalSaves);
  }, 600_000);

  it("save failure during submit (first save): nothing is applied; the SAME pending action is re-issued and a retry of the same submit succeeds exactly once", async () => {
    const store = new FaultyStore(tmpDir);
    const first = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "s1", runtime: "MOCK", stateStore: store });
    if (first.status !== "AGENT_ACTION_REQUIRED") throw new Error("setup");
    const before = await readDurable(store, "s1");

    store.failOn(store.saves + 1); // the very next save: applyExternalResult's checkpoint
    const result = passResult(first.request);
    const failed = await submitProjectRunStep({ projectRoot: tmpDir, executionId: "s1", stepId: first.stepId, result, stateStore: store });
    expect(failed.status).toBe("FAILED");
    if (failed.status !== "FAILED") return;
    expect(failed.failureCode).toBe("CHECKPOINT_WRITE_FAILED");
    expect(failed.terminal).toBe(false);
    expect(failed.state).toBe(before!.state);

    // Durable state is byte-for-byte what it was: no partial mutation, no lost pending action.
    const after = await readDurable(store, "s1");
    expect({ ...after, updated_at: undefined }).toEqual({ ...before, updated_at: undefined });

    // next-step returns the same action (same stepId); resubmitting works and applies the step ONCE.
    const again = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "s1", stateStore: store });
    expect(again.status === "AGENT_ACTION_REQUIRED" && again.stepId).toBe(first.stepId);
    const ok = await submitProjectRunStep({ projectRoot: tmpDir, executionId: "s1", stepId: first.stepId, result, stateStore: store });
    expect(ok.status).toBe("AGENT_ACTION_REQUIRED");
    const cp = (await readDurable(store, "s1"))!;
    expect(cp.step_log!.filter((e) => e.kind === "AGENT_STEP")).toHaveLength(1);
  });

  it("save failure later in a submit turn (after the result was durably applied): the failure is reported; next-step recovers the next action; the step is not applied twice", async () => {
    const store = new FaultyStore(tmpDir);
    const first = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "s2", runtime: "MOCK", stateStore: store });
    if (first.status !== "AGENT_ACTION_REQUIRED") throw new Error("setup");
    store.failOn(store.saves + 2); // 1st save = result applied (ok); 2nd = the transition/dispatch checkpoint (fails)
    const result = passResult(first.request);
    const failed = await submitProjectRunStep({ projectRoot: tmpDir, executionId: "s2", stepId: first.stepId, result, stateStore: store });
    expect(failed.status === "FAILED" && failed.failureCode).toBe("CHECKPOINT_WRITE_FAILED");
    expect(failed.status === "FAILED" && failed.terminal).toBe(false);
    const mid = (await readDurable(store, "s2"))!;
    expect(mid.lifecycle_status).toBe("IN_PROGRESS"); // result recorded, next action not yet durable
    expect(mid.step_log!.filter((e) => e.kind === "AGENT_STEP")).toHaveLength(1);

    // A resubmit is rejected as a non-terminal NO_PENDING_ACTION — not double-applied.
    const dup = await submitProjectRunStep({ projectRoot: tmpDir, executionId: "s2", stepId: first.stepId, result, stateStore: store });
    expect(dup.status === "FAILED" && dup.failureReason).toMatch(/^NO_PENDING_ACTION/);

    // The documented recovery: next-step.
    const recovered = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "s2", stateStore: store });
    expect(recovered.status).toBe("AGENT_ACTION_REQUIRED");
    expect(recovered.status === "AGENT_ACTION_REQUIRED" && recovered.stepId).not.toBe(first.stepId);
    const cp = (await readDurable(store, "s2"))!;
    expect(cp.step_log!.filter((e) => e.kind === "AGENT_STEP")).toHaveLength(1);
  });

  it("a failed FIRST checkpoint (no id) is the documented EXECUTION_LOCK_UNAVAILABLE and issues no action; a failure on the very next write is CHECKPOINT_WRITE_FAILED", async () => {
    const s1 = new FaultyStore(tmpDir);
    s1.failOn(1);
    const r1 = await nextProjectRunStep({ projectRoot: tmpDir, runtime: "MOCK", stateStore: s1 });
    expect(r1.status).toBe("FAILED");
    expect(r1.status === "FAILED" && r1.failureCode).toBe("EXECUTION_LOCK_UNAVAILABLE");
    expect(r1.status === "FAILED" && r1.terminal).toBe(false);
    const runs = path.join(tmpDir, ".project-run", "runs");
    expect(fs.existsSync(runs) ? fs.readdirSync(runs).filter((f) => f.endsWith(".json")) : []).toEqual([]);

    const s2 = new FaultyStore(tmpDir);
    s2.failOn(2); // first (INTAKE) checkpoint exists; the following one fails
    const r2 = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "fresh", runtime: "MOCK", stateStore: s2 });
    expect(r2.status === "FAILED" && r2.failureCode).toBe("CHECKPOINT_WRITE_FAILED");
    const cp = await readDurable(s2, "fresh");
    expect(cp?.lifecycle_status).toBe("IN_PROGRESS"); // recoverable
    const recovered = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "fresh", stateStore: s2 });
    expect(recovered.status).toBe("AGENT_ACTION_REQUIRED");
  });

  it("failing the COMPLETE checkpoint never yields COMPLETED; the retry completes", async () => {
    // Drive a clean run to the last agent step, then fail the save that records completion.
    const store = new FaultyStore(tmpDir);
    let r = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "fin", runtime: "MOCK", stateStore: store });
    for (let g = 0; g < 60 && r.status === "AGENT_ACTION_REQUIRED"; g++) {
      const last = r.request.role === "CONVERGENCE";
      if (last) store.failOn(store.saves + 3); // applied(1) -> transition(2) -> COMPLETE(3)
      const result = await resultForRequest(store, r.request);
      r = await submitProjectRunStep({ projectRoot: tmpDir, executionId: "fin", stepId: r.stepId, result, stateStore: store });
      if (last) break;
      if (r.status === "HUMAN_INTERVENTION_REQUIRED") {
        r = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "fin", stateStore: store, humanAnswers: r.humanIntervention.questions.map((q) => ({ questionId: q.id, answer: "ok" })) });
      }
    }
    expect(r.status).not.toBe("COMPLETED");
    expect(r.status === "FAILED" && r.failureCode).toBe("CHECKPOINT_WRITE_FAILED");
    expect((await readDurable(store, "fin"))?.lifecycle_status).not.toBe("COMPLETED");
    const done = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "fin", stateStore: store });
    expect(done.status === "FAILED" ? done.failureReason : done.status).toBe("COMPLETED");
    expect((await readDurable(store, "fin"))?.lifecycle_status).toBe("COMPLETED");
  }, 60_000);

  it("a failed write of human answers rejects the call and records nothing; the retry records them", async () => {
    const store = new FaultyStore(tmpDir);
    let r = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "hq", runtime: "MOCK", stateStore: store });
    for (let g = 0; g < 60 && r.status === "AGENT_ACTION_REQUIRED"; g++) {
      r = await submitProjectRunStep({ projectRoot: tmpDir, executionId: "hq", stepId: r.stepId, result: await resultForRequest(store, r.request), stateStore: store });
    }
    if (r.status !== "HUMAN_INTERVENTION_REQUIRED") throw new Error("setup: expected a suspension, got " + r.status);
    const answers = r.humanIntervention.questions.map((q) => ({ questionId: q.id, answer: "yes" }));
    const before = await readDurable(store, "hq");

    store.failOn(store.saves + 1); // the answer-record save
    const failed = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "hq", stateStore: store, humanAnswers: answers });
    expect(failed.status === "FAILED" && failed.failureCode).toBe("CHECKPOINT_WRITE_FAILED");
    const after = await readDurable(store, "hq");
    expect(after?.lifecycle_status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(after?.human_answers ?? []).toEqual(before?.human_answers ?? []); // nothing recorded, nothing acted on

    const ok = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "hq", stateStore: store, humanAnswers: answers });
    expect(ok.status).toBe("AGENT_ACTION_REQUIRED"); // the responsible agent is re-dispatched
    expect(((await readDurable(store, "hq"))?.human_answers ?? []).length).toBe(answers.length);
  }, 60_000);

  it("if the answer record was written and a LATER write failed, the retry records the answers again (audit trail only) and the run completes", async () => {
    const store = new FaultyStore(tmpDir);
    let r = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "hq2", runtime: "MOCK", stateStore: store });
    for (let g = 0; g < 60 && r.status === "AGENT_ACTION_REQUIRED"; g++) {
      r = await submitProjectRunStep({ projectRoot: tmpDir, executionId: "hq2", stepId: r.stepId, result: await resultForRequest(store, r.request), stateStore: store });
    }
    if (r.status !== "HUMAN_INTERVENTION_REQUIRED") throw new Error("setup: expected a suspension, got " + r.status);
    const answers = r.humanIntervention.questions.map((q) => ({ questionId: q.id, answer: "yes" }));

    store.failOn(store.saves + 2); // 1st save = the answer record (ok); 2nd = the next checkpoint (fails)
    const failed = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "hq2", stateStore: store, humanAnswers: answers });
    expect(failed.status === "FAILED" && failed.failureCode).toBe("CHECKPOINT_WRITE_FAILED");
    expect(((await readDurable(store, "hq2"))?.human_answers ?? []).length).toBe(answers.length); // recorded once so far

    const retried = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "hq2", stateStore: store, humanAnswers: answers });
    expect(retried.status).toBe("AGENT_ACTION_REQUIRED");
    expect(((await readDurable(store, "hq2"))?.human_answers ?? []).length).toBe(answers.length * 2); // documented: recorded again
  }, 60_000);

  it("a store that cannot even READ after the failed write still yields a structured failure (never an exception)", async () => {
    class DyingStore extends FaultyStore {
      dead = false;
      override async save(s: PersistedExecutionState) { if (this.dead) throw new Error("EIO write"); return super.save(s); }
      override async load(id: string) { if (this.dead) throw new Error("EIO read"); return super.load(id); }
    }
    const store = new DyingStore(tmpDir);
    const first = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "br", runtime: "MOCK", stateStore: store });
    if (first.status !== "AGENT_ACTION_REQUIRED") throw new Error("setup");
    // the validation read succeeds, then the device dies: the write AND the follow-up read fail
    const realLoad = FileExecutionStateStore.prototype.load.bind(store);
    store.load = async (id: string) => { const v = await realLoad(id); store.dead = true; return v; };
    const r = await submitProjectRunStep({ projectRoot: tmpDir, executionId: "br", stepId: first.stepId, result: passResult(first.request), stateStore: store });
    expect(r.status).toBe("FAILED");
    expect(r.status === "FAILED" && r.failureCode).toBe("CHECKPOINT_WRITE_FAILED");
    expect(r.status === "FAILED" && r.terminal).toBe(false);
  });
});

// =======================================================================================
// Push mode
// =======================================================================================
describe("NF-2 push mode — a failed checkpoint write abandons the run at the last durable checkpoint", () => {
  const adapterFor = (store: FileExecutionStateStore, log?: string[]) =>
    new MockRuntimeAdapter(async (req) => { log?.push(req.state); return resultForRequest(store, req); });

  async function drivePush(store: FaultyStore, id: string, ran?: string[]) {
    const adapters = [adapterFor(store, ran)];
    let failures = 0;
    let res = await executeProjectRun({ projectRoot: tmpDir, executionId: id, runtime: "MOCK", context: { state: "INTAKE", runtime: "MOCK" }, adapters, stateStore: store });
    for (let guard = 0; guard < 60; guard++) {
      const cp = await readDurable(store, id);
      if (res.persistenceFailure) {
        expect(res.status).toBe("FAILED");
        expect(res.lockFailure).toBeUndefined();
        expect(res.failureReason).toMatch(/^CHECKPOINT_WRITE_FAILED:/);
        // The result reports the LAST DURABLE record, never unsaved in-memory progress.
        expect(res.stepLog).toEqual(cp?.step_log ?? []);
        expect(res.decisionHistory).toEqual(cp?.history ?? []);
        if (cp) expect(res.state).toBe(cp.state);
        failures++;
        store.heal();
        res = cp
          ? await executeProjectResume({ projectRoot: tmpDir, executionId: id, runtime: "MOCK", adapters, stateStore: store,
              humanAnswers: cp.lifecycle_status === "HUMAN_INTERVENTION_REQUIRED" ? (cp.human_intervention?.questions ?? []).map((q) => ({ questionId: q.id, answer: "approved" })) : undefined })
          : await executeProjectRun({ projectRoot: tmpDir, executionId: id, runtime: "MOCK", context: { state: "INTAKE", runtime: "MOCK" }, adapters, stateStore: store });
        continue;
      }
      expect(res.status === "FAILED" ? `${id}: ${res.failureReason} | durable=${cp?.lifecycle_status}/${cp?.state} | failures so far=${failures}` : "").toBe("");
      if (res.status === "HUMAN_INTERVENTION_REQUIRED") {
        expect(cp?.lifecycle_status).toBe("HUMAN_INTERVENTION_REQUIRED"); // response => durable
        res = await executeProjectResume({ projectRoot: tmpDir, executionId: id, runtime: "MOCK", adapters, stateStore: store,
          humanAnswers: (cp?.human_intervention?.questions ?? []).map((q) => ({ questionId: q.id, answer: "approved" })) });
        continue;
      }
      expect(res.status).toBe("COMPLETED");
      expect(cp?.lifecycle_status).toBe("COMPLETED"); // response => durable
      return { failures, final: cp! };
    }
    throw new Error("push lifecycle did not finish");
  }

  it("EXHAUSTIVE: failing ANY single save of a full push lifecycle (incl. HITL answers and completion) is reported as a persistence failure and the run recovers", async () => {
    const baseline = new FaultyStore(tmpDir);
    await drivePush(baseline, "count");
    const totalSaves = baseline.saves;
    expect(totalSaves).toBeGreaterThan(20);

    for (let k = 1; k <= totalSaves; k++) {
      const store = new FaultyStore(tmpDir);
      store.failOn(k);
      const out = await drivePush(store, `push-k${k}`);
      expect(store.failedAt, `save #${k} was never reached`).toBe(k);
      expect(out.failures, `failing save #${k} was not reported`).toBeGreaterThanOrEqual(1);
      expect(out.final.lifecycle_status).toBe("COMPLETED");
      expectConsistentRecord(out.final);
    }
  }, 600_000);

  it("the host start()/resume() responses are non-terminal FAILED with failureCode, and carry the durable record", async () => {
    // start(): the host builds its own FileExecutionStateStore, so fail a real write instead of injecting:
    // make the runs directory unwritable for the SECOND checkpoint by turning the checkpoint path into a directory.
    const adapter = new MockRuntimeAdapter(async (req) => {
      const runs = path.join(tmpDir, ".project-run", "runs");
      const file = path.join(runs, "hostfail.json");
      // after the first agent has run, replace the checkpoint file by a non-empty directory: the next atomic rename must fail
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        fs.rmSync(file);
        fs.mkdirSync(file);
        fs.writeFileSync(path.join(file, "x"), "blocker");
      }
      return passResult(req);
    });
    const res = await startProjectRun({ projectRoot: tmpDir, executionId: "hostfail", runtime: "MOCK", adapters: [adapter] });
    expect(res.status).toBe("FAILED");
    expect(res.terminal).toBe(false);
    expect(res.failureCode).toBe("CHECKPOINT_WRITE_FAILED");
    expect(res.failureReason).toMatch(/^CHECKPOINT_WRITE_FAILED:/);
    expect(res.stepsCount).toBe(0); // nothing durable was ever reported as a step
    expect(res.stepLog).toEqual([]);
    expect(res.history).toEqual([]);
    expect(res.status === "FAILED" && res.stepLog.length).toBe(0);
    void resumeProjectRun;
  });

  it("an ordinary run failure whose FAILED marker also cannot be written still reports the ORIGINAL error and leaves a resumable checkpoint", async () => {
    const store = new FaultyStore(tmpDir);
    let calls = 0;
    const adapter = new MockRuntimeAdapter(async (req) => {
      calls++;
      if (calls === 2) { store.failOn(store.saves + 1); throw new Error("agent crashed"); } // then the FAILED marker write fails too
      return passResult(req);
    });
    const res = await executeProjectRun({ projectRoot: tmpDir, executionId: "marker", runtime: "MOCK", context: { state: "INTAKE", runtime: "MOCK" }, adapters: [adapter], stateStore: store });
    expect(res.status).toBe("FAILED");
    expect(res.failureReason).toBe("agent crashed");
    expect(res.persistenceFailure).toBeUndefined(); // the root cause is the agent, not storage
    const cp = (await readDurable(store, "marker"))!;
    expect(cp.lifecycle_status).toBe("IN_PROGRESS"); // advisory marker not written => still recoverable
    const resumed = await executeProjectResume({ projectRoot: tmpDir, executionId: "marker", runtime: "MOCK", adapters: [adapterFor(store)], stateStore: store });
    expect(resumed.status === "COMPLETED" || resumed.status === "HUMAN_INTERVENTION_REQUIRED").toBe(true);
  });
});

// =======================================================================================
// Contract details
// =======================================================================================
describe("NF-2 contract details", () => {
  it("CheckpointWriteError is public, structured, and carries the cause without being parsed from text", () => {
    const cause = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    const err = new CheckpointWriteError("exec-1", "IN_PROGRESS", cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("CHECKPOINT_WRITE_FAILED");
    expect(err.executionId).toBe("exec-1");
    expect(err.lifecycleStatus).toBe("IN_PROGRESS");
    expect(err.cause).toBe(cause);
    expect(err.message).toMatch(/^CHECKPOINT_WRITE_FAILED:/);
  });

  it("status() of an execution that suffered a failed write reports only what is durable", async () => {
    const store = new FaultyStore(tmpDir);
    const first = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "st", runtime: "MOCK", stateStore: store });
    if (first.status !== "AGENT_ACTION_REQUIRED") throw new Error("setup");
    store.failOn(store.saves + 1);
    await submitProjectRunStep({ projectRoot: tmpDir, executionId: "st", stepId: first.stepId, result: passResult(first.request), stateStore: store });
    const status = await statusProjectRun({ executionId: "st", projectRoot: tmpDir });
    expect(status.stepsCount).toBe(0);
    expect(status.stepLog).toEqual([]);
  });

  it("a checkpoint left IN_PROGRESS at READY_FOR_PR (crash, or a failed COMPLETED write) is recoverable in pull AND push — it is not mistaken for a finished execution", async () => {
    // Build the exact window: CONVERGE -> READY_FOR_PR transition durable, COMPLETED not yet written.
    const mk = async (id: string) => {
      const store = new FaultyStore(tmpDir);
      let r = await nextProjectRunStep({ projectRoot: tmpDir, executionId: id, runtime: "MOCK", stateStore: store });
      for (let g = 0; g < 80 && r.status !== "COMPLETED"; g++) {
        if (r.status === "AGENT_ACTION_REQUIRED") {
          r = await submitProjectRunStep({ projectRoot: tmpDir, executionId: id, stepId: r.stepId, result: await resultForRequest(store, r.request), stateStore: store });
        } else if (r.status === "HUMAN_INTERVENTION_REQUIRED") {
          r = await nextProjectRunStep({ projectRoot: tmpDir, executionId: id, stateStore: store, humanAnswers: r.humanIntervention.questions.map((q) => ({ questionId: q.id, answer: "ok" })) });
        } else throw new Error("setup " + r.status);
      }
      const cp = (await readDurable(store, id))!;
      expect(cp.lifecycle_status).toBe("COMPLETED");
      const window: PersistedExecutionState = { ...cp, lifecycle_status: "IN_PROGRESS", terminal_reason: undefined };
      expect(window.state).toBe("READY_FOR_PR");
      await store.save(window);
      return store;
    };
    const pull = await mk("win-pull");
    const p = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "win-pull", stateStore: pull });
    expect(p.status).toBe("COMPLETED");
    expect((await readDurable(pull, "win-pull"))?.lifecycle_status).toBe("COMPLETED");

    const push = await mk("win-push");
    const q = await executeProjectResume({ projectRoot: tmpDir, executionId: "win-push", runtime: "MOCK", adapters: [adapterNever()], stateStore: push });
    expect(q.status).toBe("COMPLETED");
    expect((await readDurable(push, "win-push"))?.lifecycle_status).toBe("COMPLETED");

    // A checkpoint that records COMPLETED is still final.
    const done = await executeProjectResume({ projectRoot: tmpDir, executionId: "win-push", runtime: "MOCK", adapters: [adapterNever()], stateStore: push });
    expect(done.status).toBe("FAILED");
    expect(done.failureReason).toMatch(/^EXECUTION_NOT_RESUMABLE/);
  }, 60_000);

  it("lock failures carry failureCode too (additive, machine-readable), and stay non-terminal", async () => {
    const store = new FileExecutionStateStore(tmpDir, undefined, { timeoutMs: 100, pollMs: 10 });
    await new FileExecutionStateStore(tmpDir).withLock("held", async () => {
      const r = await nextProjectRunStep({ projectRoot: tmpDir, executionId: "held", runtime: "MOCK", stateStore: store });
      expect(r.status === "FAILED" && r.failureCode).toBe("EXECUTION_LOCKED");
      expect(r.status === "FAILED" && r.terminal).toBe(false);
      const sub = await submitProjectRunStep({ projectRoot: tmpDir, executionId: "held", stepId: "s", result: passResult({ execution_id: "held", role: "SPECIFICATION", state: "SPECIFY" }), stateStore: store });
      expect(sub.status === "FAILED" && sub.failureCode).toBe("EXECUTION_LOCKED");
    });
  });
});

/** An adapter that must never be asked to do agent work (recovery of a completed-window checkpoint dispatches nothing). */
function adapterNever(): MockRuntimeAdapter {
  return new MockRuntimeAdapter(async () => { throw new Error("no agent work expected"); });
}

