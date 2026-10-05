// packages/project-run-engine/tests/clarify-blocking-safety-gate.test.ts
//
// Phase 0 — Coordinator Correctness regression suite.
//
// Confirmed defect: CoordinatorDecisionEngine's CLARIFY branch only ever consulted
// `context.blockingAmbiguity`, a field nothing in the engine ever derived from an
// AgentResult. A genuinely blocking finding returned by the Specification agent during
// CLARIFY was therefore silently ignored and the workflow advanced to PLAN regardless.
//
// This suite proves (a) the defect is fixed, (b) the fix did not change behavior for
// non-blocking cases, (c) the fix survives checkpoint persistence and resume, and
// (d) the analogous REVIEW/REMEDIATION propagation (which was never broken) still works.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  Coordinator,
  CoordinatorDecisionEngine,
  AgentDispatcher,
  createDefaultAgentRegistry,
  MockRuntimeAdapter,
  type AgentDispatchRequest,
  type AgentResult,
  type CoordinatorExecutionContext,
} from "../src/index.js";
import {
  executeProjectRun,
  executeProjectResume,
} from "../src/project/project-run.js";
import { FileExecutionStateStore } from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";

// ---------------------------------------------------------------------------
// A. Decision-engine unit tests (fast, isolated — no dispatch, no filesystem)
// ---------------------------------------------------------------------------

describe("Phase 0 — CLARIFY blocking gate (decision engine unit)", () => {
  const engine = new CoordinatorDecisionEngine();

  const baseExecution = {
    id: "exec-clarify-unit",
    feature: "campaigns-and-lead-attribution",
    branch: "feat/004-campaigns-and-lead-attribution",
    iteration: 1,
    remediation_iteration: 0,
  };

  it("Case 1: a blocking (CRITICAL, OPEN) finding during CLARIFY -> REQUIRE_HUMAN_INTERVENTION", () => {
    const context: CoordinatorExecutionContext = {
      execution: { ...baseExecution, state: "CLARIFY" },
      result: {
        execution_id: "exec-clarify-unit",
        agent: "SPECIFICATION",
        state: "CLARIFY",
        status: "FINDINGS",
        evidence: [],
        findings: [
          {
            id: "AMB-AUTH-MODEL",
            severity: "CRITICAL",
            category: "specification-ambiguity",
            evidence: "Spec does not define which auth model campaign attribution endpoints use",
            expected: "Auth model decision resolved before planning begins",
            actual: "Left ambiguous in spec.md",
            required_remediation: "Human decision required on auth model before PLAN",
            status: "OPEN",
          },
        ],
      },
    };

    const decision = engine.decide(context);
    expect(decision.action).toBe("REQUIRE_HUMAN_INTERVENTION");
    if (decision.action === "REQUIRE_HUMAN_INTERVENTION") {
      expect(decision.from).toBe("CLARIFY");
      expect(decision.state).toBe("HUMAN_INTERVENTION_REQUIRED");
    }
  });

  it("Case 2: a non-blocking (LOW, OPEN) finding during CLARIFY -> normal progression to PLAN", () => {
    const context: CoordinatorExecutionContext = {
      execution: { ...baseExecution, state: "CLARIFY" },
      result: {
        execution_id: "exec-clarify-unit",
        agent: "SPECIFICATION",
        state: "CLARIFY",
        status: "FINDINGS",
        evidence: [],
        findings: [{ id: "F-LOW", severity: "LOW", status: "OPEN" }],
      },
    };

    const decision = engine.decide(context);
    expect(decision).toEqual({
      action: "TRANSITION",
      from: "CLARIFY",
      to: "PLAN",
      reason: "Clarification complete",
    });
  });

  it("Case 3: mixed findings (LOW + CRITICAL) during CLARIFY -> REQUIRE_HUMAN_INTERVENTION", () => {
    const context: CoordinatorExecutionContext = {
      execution: { ...baseExecution, state: "CLARIFY" },
      result: {
        execution_id: "exec-clarify-unit",
        agent: "SPECIFICATION",
        state: "CLARIFY",
        status: "FINDINGS",
        evidence: [],
        findings: [
          { id: "F-LOW", severity: "LOW", status: "OPEN" },
          { id: "F-CRIT", severity: "CRITICAL", status: "OPEN" },
        ],
      },
    };

    const decision = engine.decide(context);
    expect(decision.action).toBe("REQUIRE_HUMAN_INTERVENTION");
    if (decision.action === "REQUIRE_HUMAN_INTERVENTION") {
      expect(decision.from).toBe("CLARIFY");
    }
  });

  it("Case 4: no findings during CLARIFY -> normal progression to PLAN", () => {
    const context: CoordinatorExecutionContext = {
      execution: { ...baseExecution, state: "CLARIFY" },
      result: {
        execution_id: "exec-clarify-unit",
        agent: "SPECIFICATION",
        state: "CLARIFY",
        status: "PASS",
        evidence: [],
        findings: [],
      },
    };

    const decision = engine.decide(context);
    expect(decision).toEqual({
      action: "TRANSITION",
      from: "CLARIFY",
      to: "PLAN",
      reason: "Clarification complete",
    });
  });

  it("explicit host override (blockingAmbiguity: true) still forces REQUIRE_HUMAN_INTERVENTION even with no findings (backward compatible escape hatch)", () => {
    const context: CoordinatorExecutionContext = {
      execution: { ...baseExecution, state: "CLARIFY" },
      blockingAmbiguity: true,
      result: {
        execution_id: "exec-clarify-unit",
        agent: "SPECIFICATION",
        state: "CLARIFY",
        status: "PASS",
        evidence: [],
        findings: [],
      },
    };

    const decision = engine.decide(context);
    expect(decision.action).toBe("REQUIRE_HUMAN_INTERVENTION");
  });
});

// ---------------------------------------------------------------------------
// B. Coordinator end-to-end regression (the test that must fail on the old code)
// ---------------------------------------------------------------------------

describe("Phase 0 — CLARIFY safety gate (Coordinator end-to-end regression)", () => {
  function buildCoordinator(handler: (req: AgentDispatchRequest) => AgentResult) {
    const mockAdapter = new MockRuntimeAdapter(handler);
    const registry = createDefaultAgentRegistry();
    const dispatcher = new AgentDispatcher(registry, [mockAdapter]);
    const decisionEngine = new CoordinatorDecisionEngine();
    return new Coordinator({ dispatcher, decisionEngine });
  }

  function freshContext(executionId: string): CoordinatorExecutionContext {
    return {
      execution_id: executionId,
      feature: "campaigns-and-lead-attribution",
      branch: "feat/004-campaigns-and-lead-attribution",
      state: "INTAKE",
      runtime: "MOCK",
    };
  }

  it("REGRESSION (Feature 004 failure pattern): a genuine blocking finding reported during CLARIFY halts the workflow at HUMAN_INTERVENTION_REQUIRED instead of silently advancing to PLAN", async () => {
    const dispatchedRoles: string[] = [];

    const coordinator = buildCoordinator((req) => {
      dispatchedRoles.push(`${req.role}:${req.state}`);

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
              category: "specification-ambiguity",
              evidence: "Spec does not define which auth model campaign attribution endpoints use",
              expected: "Auth model decision resolved before planning begins",
              actual: "Left ambiguous in spec.md",
              required_remediation: "Human decision required on auth model before PLAN",
              status: "OPEN",
            },
          ],
        };
      }

      return {
        execution_id: req.execution_id,
        agent: req.role,
        state: req.state,
        status: "PASS",
        evidence: [],
        findings: [],
      };
    });

    const result = await coordinator.run(freshContext("exec-004-regression"));

    // Against the unfixed engine this reached "COMPLETED" / READY_FOR_PR, because
    // CLARIFY only ever consulted the dead `context.blockingAmbiguity` field.
    expect(result.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(result.state).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(result.terminalDecision.action).toBe("REQUIRE_HUMAN_INTERVENTION");
    if (result.terminalDecision.action === "REQUIRE_HUMAN_INTERVENTION") {
      expect(result.terminalDecision.from).toBe("CLARIFY");
    }

    // The workflow must not have proceeded past CLARIFY.
    expect(dispatchedRoles).toEqual([
      "SPECIFICATION:SPECIFY",
      "SPECIFICATION:CLARIFY",
    ]);
    expect(dispatchedRoles).not.toContain("ARCHITECTURE:PLAN");
  });

  it("a non-blocking finding during CLARIFY still allows normal progression through to READY_FOR_PR", async () => {
    const dispatchedRoles: string[] = [];

    const coordinator = buildCoordinator((req) => {
      dispatchedRoles.push(`${req.role}:${req.state}`);

      if (req.role === "SPECIFICATION" && req.state === "CLARIFY") {
        return {
          execution_id: req.execution_id,
          agent: req.role,
          state: req.state,
          status: "FINDINGS",
          evidence: [],
          findings: [{ id: "F-LOW", severity: "LOW", status: "OPEN" }],
        };
      }

      return {
        execution_id: req.execution_id,
        agent: req.role,
        state: req.state,
        status: "PASS",
        evidence: [],
        findings: [],
      };
    });

    const result = await coordinator.run(freshContext("exec-clarify-nonblocking"));

    expect(result.status).toBe("COMPLETED");
    expect(result.state).toBe("READY_FOR_PR");
    expect(dispatchedRoles).toContain("ARCHITECTURE:PLAN");
  });
});

// ---------------------------------------------------------------------------
// C. Persistence + resume-after-human-input
// ---------------------------------------------------------------------------

describe("Phase 0 — CLARIFY blocking state: persistence and resume after human input", () => {
  let tmpDir: string;
  let stateStore: FileExecutionStateStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clarify-safety-gate-"));
    stateStore = new FileExecutionStateStore(tmpDir);

    await runProjectInit({ projectRoot: tmpDir, silent: true });

    const configDir = path.join(tmpDir, ".project-run");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          project: {
            name: "campaigns-and-lead-attribution-service",
            workflow_version: "v1",
            feature_directory: "specs/004-campaigns-and-lead-attribution",
          },
          runtime: {
            default_runtime: "MOCK",
            supported_runtimes: ["MOCK"],
          },
          agents: {
            SPECIFICATION: {
              name: "Spec Agent",
              required_skills: [{ id: "speckit-specify", required: false }],
            },
            ARCHITECTURE: {
              name: "Arch Agent",
              required_skills: [{ id: "speckit-plan", required: false }],
            },
            IMPLEMENTATION: {
              name: "Impl Agent",
              required_skills: [{ id: "speckit-implement", required: false }],
            },
            INDEPENDENT_REVIEW: {
              name: "Review Agent",
              required_skills: [{ id: "speckit-analyze", required: false }],
            },
            REMEDIATION: {
              name: "Rem Agent",
              required_skills: [{ id: "speckit-bug-fix", required: false }],
            },
            CONVERGENCE: {
              name: "Conv Agent",
              required_skills: [{ id: "speckit-converge", required: false }],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const specDir = path.join(tmpDir, "specs", "004-campaigns-and-lead-attribution");
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, "spec.md"), "# Campaigns and Lead Attribution\n", "utf8");

    const gitDir = path.join(tmpDir, ".git");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(
      path.join(gitDir, "HEAD"),
      "ref: refs/heads/feat/004-campaigns-and-lead-attribution\n",
      "utf8",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a blocking CLARIFY finding is persisted (state + suspended_from + findings) and the run halts at HUMAN_INTERVENTION_REQUIRED", async () => {
    const executionId = "exec-004-persist";

    const blockingAdapter = new MockRuntimeAdapter((req) => {
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
              category: "specification-ambiguity",
              evidence: "Spec does not define which auth model campaign attribution endpoints use",
              expected: "Auth model decision resolved before planning begins",
              actual: "Left ambiguous in spec.md",
              required_remediation: "Human decision required on auth model before PLAN",
              status: "OPEN",
            },
          ],
        };
      }
      return {
        execution_id: req.execution_id,
        agent: req.role,
        state: req.state,
        status: "PASS",
        evidence: [],
        findings: [],
      };
    });

    const runResult = await executeProjectRun({
      executionId,
      projectRoot: tmpDir,
      runtime: "MOCK",
      stateStore,
      adapters: [blockingAdapter],
      context: { state: "INTAKE", runtime: "MOCK" },
    });

    expect(runResult.status).toBe("HUMAN_INTERVENTION_REQUIRED");

    // --- Persistence assertion (required test case 6) ---
    const persisted = await stateStore.load(executionId);
    expect(persisted).toBeDefined();
    expect(persisted?.state).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(persisted?.suspended_from).toBe("CLARIFY");
    expect(persisted?.lifecycle_status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(persisted?.findings).toHaveLength(1);
    expect((persisted?.findings?.[0] as { id: string }).id).toBe("AMB-AUTH-MODEL");
  });

  it("resumes correctly after valid human input: the Specification agent is re-dispatched for CLARIFY and, once it reports a clean result, the workflow proceeds to completion", async () => {
    const executionId = "exec-004-resume-fixed";
    const resumedDispatchedRoles: string[] = [];

    // 1. First pass: reach HUMAN_INTERVENTION_REQUIRED via the blocking finding.
    const blockingAdapter = new MockRuntimeAdapter((req) => {
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
              evidence: "Spec does not define which auth model campaign attribution endpoints use",
              required_remediation: "Human decision required on auth model before PLAN",
            },
          ],
        };
      }
      return {
        execution_id: req.execution_id,
        agent: req.role,
        state: req.state,
        status: "PASS",
        evidence: [],
        findings: [],
      };
    });

    const runResult = await executeProjectRun({
      executionId,
      projectRoot: tmpDir,
      runtime: "MOCK",
      stateStore,
      adapters: [blockingAdapter],
      context: { state: "INTAKE", runtime: "MOCK" },
    });
    expect(runResult.status).toBe("HUMAN_INTERVENTION_REQUIRED");

    // 2. "Human input" in this engine's existing contract model: the operator resolves
    //    the ambiguity in the repository (e.g. updates spec.md) and the next dispatch of
    //    the Specification agent for CLARIFY reflects that resolution by returning a
    //    clean result. The engine's job is to re-dispatch and re-verify, not to trust the
    //    stale blocking result.
    const fixedAdapter = new MockRuntimeAdapter((req) => {
      resumedDispatchedRoles.push(`${req.role}:${req.state}`);
      if (req.role === "SPECIFICATION" && req.state === "CLARIFY") {
        return {
          execution_id: req.execution_id,
          agent: req.role,
          state: req.state,
          status: "PASS",
          evidence: [{ check: "ambiguity-resolved-by-human", passed: true }],
          findings: [],
        };
      }
      return {
        execution_id: req.execution_id,
        agent: req.role,
        state: req.state,
        status: "PASS",
        evidence: [],
        findings: [],
      };
    });

    const resumeResult = await executeProjectResume({
      executionId,
      projectRoot: tmpDir,
      stateStore,
      adapters: [fixedAdapter],
      runtime: "MOCK",
    });

    // The Specification agent must actually be re-dispatched for CLARIFY, not skipped.
    expect(resumedDispatchedRoles).toContain("SPECIFICATION:CLARIFY");

    expect(resumeResult.status).toBe("COMPLETED");
    expect(resumeResult.state).toBe("READY_FOR_PR");

    const finalState = await stateStore.load(executionId);
    expect(finalState?.state).toBe("READY_FOR_PR");
    expect(finalState?.lifecycle_status).toBe("COMPLETED");
  });

  it("does not fabricate success on resume: if the blocking ambiguity is still unresolved, resume halts at HUMAN_INTERVENTION_REQUIRED again instead of advancing", async () => {
    const executionId = "exec-004-resume-still-blocked";

    const blockingAdapter = new MockRuntimeAdapter((req) => {
      if (req.role === "SPECIFICATION" && req.state === "CLARIFY") {
        return {
          execution_id: req.execution_id,
          agent: req.role,
          state: req.state,
          status: "FINDINGS",
          evidence: [],
          findings: [{ id: "AMB-AUTH-MODEL", severity: "CRITICAL", status: "OPEN" }],
        };
      }
      return {
        execution_id: req.execution_id,
        agent: req.role,
        state: req.state,
        status: "PASS",
        evidence: [],
        findings: [],
      };
    });

    const runResult = await executeProjectRun({
      executionId,
      projectRoot: tmpDir,
      runtime: "MOCK",
      stateStore,
      adapters: [blockingAdapter],
      context: { state: "INTAKE", runtime: "MOCK" },
    });
    expect(runResult.status).toBe("HUMAN_INTERVENTION_REQUIRED");

    // Human attempted a fix, but the ambiguity is still genuinely unresolved: the
    // Specification agent, re-dispatched, reports the same blocking finding again.
    const stillBlockingAdapter = new MockRuntimeAdapter((req) => {
      if (req.role === "SPECIFICATION" && req.state === "CLARIFY") {
        return {
          execution_id: req.execution_id,
          agent: req.role,
          state: req.state,
          status: "FINDINGS",
          evidence: [],
          findings: [{ id: "AMB-AUTH-MODEL", severity: "CRITICAL", status: "OPEN" }],
        };
      }
      return {
        execution_id: req.execution_id,
        agent: req.role,
        state: req.state,
        status: "PASS",
        evidence: [],
        findings: [],
      };
    });

    const resumeResult = await executeProjectResume({
      executionId,
      projectRoot: tmpDir,
      stateStore,
      adapters: [stillBlockingAdapter],
      runtime: "MOCK",
    });

    expect(resumeResult.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(resumeResult.status).not.toBe("COMPLETED");

    const finalState = await stateStore.load(executionId);
    expect(finalState?.state).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(finalState?.suspended_from).toBe("CLARIFY");
  });
});

// ---------------------------------------------------------------------------
// D. Review/Remediation safety-gate parity (requirement: same propagation
//    mechanism must not be silently broken for the other blocking gates)
// ---------------------------------------------------------------------------

describe("Phase 0 — INDEPENDENT_REVIEW safety gate parity (same propagation mechanism, was not broken, still correct)", () => {
  it("a blocking finding from INDEPENDENT_REVIEW routes to REMEDIATION and is re-verified at RE_REVIEW before CONVERGE — cannot be silently ignored", async () => {
    const dispatchedRoles: string[] = [];

    const mockAdapter = new MockRuntimeAdapter((req) => {
      dispatchedRoles.push(`${req.role}:${req.state}`);

      if (req.role === "INDEPENDENT_REVIEW" && req.state === "INDEPENDENT_REVIEW") {
        return {
          execution_id: req.execution_id,
          agent: req.role,
          state: req.state,
          status: "FINDINGS",
          evidence: [],
          findings: [
            {
              id: "REVIEW-SEC-1",
              severity: "HIGH",
              category: "security",
              evidence: "Campaign attribution endpoint exposed without tenant isolation",
              expected: "Tenant-scoped query",
              actual: "Unscoped query",
              required_remediation: "Add tenant_id filter",
              status: "OPEN",
            },
          ],
        };
      }

      return {
        execution_id: req.execution_id,
        agent: req.role,
        state: req.state,
        status: "PASS",
        evidence: [],
        findings: [],
      };
    });

    const registry = createDefaultAgentRegistry();
    const dispatcher = new AgentDispatcher(registry, [mockAdapter]);
    const coordinator = new Coordinator({
      dispatcher,
      decisionEngine: new CoordinatorDecisionEngine(),
    });

    const result = await coordinator.run({
      execution_id: "exec-review-parity",
      feature: "campaigns-and-lead-attribution",
      branch: "feat/004-campaigns-and-lead-attribution",
      state: "INTAKE",
      runtime: "MOCK",
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.state).toBe("READY_FOR_PR");

    // The blocking finding must have actually routed through REMEDIATION and been
    // re-verified at RE_REVIEW — never silently dropped on the way to CONVERGE.
    expect(dispatchedRoles).toContain("REMEDIATION:REMEDIATION");
    expect(dispatchedRoles).toContain("INDEPENDENT_REVIEW:RE_REVIEW");

    const reviewIndex = dispatchedRoles.indexOf("INDEPENDENT_REVIEW:INDEPENDENT_REVIEW");
    const remediationIndex = dispatchedRoles.indexOf("REMEDIATION:REMEDIATION");
    const reReviewIndex = dispatchedRoles.indexOf("INDEPENDENT_REVIEW:RE_REVIEW");
    expect(reviewIndex).toBeGreaterThanOrEqual(0);
    expect(remediationIndex).toBeGreaterThan(reviewIndex);
    expect(reReviewIndex).toBeGreaterThan(remediationIndex);
  });
});
