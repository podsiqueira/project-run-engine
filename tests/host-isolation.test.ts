// packages/project-run-engine/tests/host-isolation.test.ts
//
// Phase 2 — host contract isolation.
//
// Proves the Host Skill Contract does not require a host integration to know
// anything about Coordinator internals, the decision engine's implementation,
// or the persistence mechanism: everything needed to drive a full feature workflow
// — including the Human-in-the-Loop round trip — is reachable from `src/host/index.js`
// alone. Deliberately avoids importing anything from `src/coordinator/`,
// `src/decision/decision-engine.js`, or `src/project/state-store.js` anywhere in this
// file. The one other engine import, `runProjectInit` from `src/project/bootstrap.js`,
// is used purely for fixture setup (it is the same scaffolding `project-run init`
// already documents publicly) — not something a real host integration calls as part
// of invoking the capability itself.
//
// This is not a fake end-to-end test that mocks the host boundary away: the only
// thing mocked is the actual external-agent execution boundary (the runtime
// adapter) — Coordinator, CoordinatorDecisionEngine, skill validation, context
// discovery, and FileExecutionStateStore persistence all run for real underneath.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { projectRunHost, type ProjectRunEvent } from "../src/host/index.js";
import { runProjectInit } from "../src/project/bootstrap.js";

/**
 * A minimal, hand-written host adapter — deliberately NOT importing
 * `AgentRuntimeAdapter`/`AgentDispatchRequest`/`AgentResult` from the engine at all,
 * to demonstrate that even a host written without TypeScript (or one that simply
 * doesn't want the dispatch-contract types) can satisfy the required shape
 * structurally. A real provider-specific host adapter would still want the real
 * types for safety; this is the floor, not the recommendation.
 */
function createMinimalAdapter(behavior: (req: { role: string; state: string }) => { status: string; findings: unknown[] }) {
  return {
    runtime: "MOCK",
    async execute(req: { execution_id: string; role: string; state: string }) {
      const outcome = behavior(req);
      return {
        execution_id: req.execution_id,
        agent: req.role,
        state: req.state,
        status: outcome.status,
        evidence: [],
        findings: outcome.findings,
      };
    },
  };
}

function writeMinimalProjectFixture(tmpDir: string): void {
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
}

describe("Phase 2 — host contract isolation (src/host/index.js is sufficient on its own)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-isolation-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    writeMinimalProjectFixture(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("drives a full workflow to completion using only projectRunHost.start()/resume()/status(), with a hand-rolled adapter and no imports beyond src/host/", async () => {
    const executionId = "exec-isolation-clean";
    const adapter = createMinimalAdapter(() => ({ status: "PASS", findings: [] }));

    const started = await projectRunHost.start({
      projectRoot: tmpDir,
      executionId,
      runtime: "MOCK",
      adapters: [adapter],
    });

    expect(started.status).toBe("COMPLETED");
    expect(started.state).toBe("READY_FOR_PR");

    const status = await projectRunHost.status({ executionId, projectRoot: tmpDir });
    expect(status.status).toBe("COMPLETED");
  });

  it("drives the full Human-in-the-Loop round trip (start -> questions -> resume with answers -> completion) through the same minimal import surface", async () => {
    const executionId = "exec-isolation-hitl";

    const blockingAdapter = createMinimalAdapter((req) => {
      if (req.role === "SPECIFICATION" && req.state === "CLARIFY") {
        return {
          status: "FINDINGS",
          findings: [{ id: "AMB-1", severity: "CRITICAL", status: "OPEN", required_remediation: "Pick an auth model" }],
        };
      }
      return { status: "PASS", findings: [] };
    });

    const events: ProjectRunEvent[] = [];
    const started = await projectRunHost.start({
      projectRoot: tmpDir,
      executionId,
      runtime: "MOCK",
      adapters: [blockingAdapter],
      onEvent: (e) => events.push(e),
    });

    expect(started.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(started.humanIntervention).toBeDefined();
    expect(started.humanIntervention?.questions).toHaveLength(1);
    const question = started.humanIntervention!.questions[0];
    expect(question.required).toBe(true);

    // A host renders `question` to the user and collects an answer; here we simulate
    // that round trip with a fixed answer.
    const fixedAdapter = createMinimalAdapter(() => ({ status: "PASS", findings: [] }));

    const resumed = await projectRunHost.resume({
      executionId,
      projectRoot: tmpDir,
      adapters: [fixedAdapter],
      humanAnswers: [{ questionId: question.id, answer: "OAuth" }],
    });

    expect(resumed.status).toBe("COMPLETED");
    expect(events.some((e) => e.type === "HUMAN_INTERVENTION_REQUIRED")).toBe(true);
  });
});
