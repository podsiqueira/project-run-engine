// packages/project-run-engine/tests/blocked-status-semantics.test.ts
//
// Phase 1 — BLOCKED/FAIL semantics.
//
// Confirmed Phase 0 follow-up: AgentResult.status === "BLOCKED" was not interpreted
// by the decision engine when findings were empty, so a BLOCKED result with no
// findings behaved identically to PASS. This suite proves: (1) BLOCKED never
// advances as if it were PASS, at any state; (2) BLOCKED bypasses the bounded
// remediation loop at INDEPENDENT_REVIEW/RE_REVIEW/CONVERGE and goes straight to
// HUMAN_INTERVENTION_REQUIRED, since remediation cannot meaningfully retry "the agent
// needs a human decision"; and (3) a flat FAIL (no findings, not asking for a human
// decision) still never silently becomes PASS either, and — where an existing,
// deliberate remediation-loop treatment of FAIL already existed (CONVERGE) — that
// existing, more nuanced behavior is preserved rather than overridden.

import { describe, it, expect } from "vitest";
import {
  CoordinatorDecisionEngine,
  hasBlockingFindings,
  isExplicitlyBlocked,
} from "../src/decision/decision-engine.js";
import type { CoordinatorExecutionContext } from "../src/decision/types.js";
import {
  Coordinator,
  AgentDispatcher,
  createDefaultAgentRegistry,
  MockRuntimeAdapter,
  type AgentDispatchRequest,
  type AgentResult,
} from "../src/index.js";

const engine = new CoordinatorDecisionEngine();

const baseExecution = {
  id: "exec-blocked",
  feature: "test-feature",
  branch: "feat/test",
  iteration: 1,
  remediation_iteration: 0,
};

function blockedResult(state: string, role = "ROLE"): CoordinatorExecutionContext["result"] {
  return {
    execution_id: "exec-blocked",
    agent: role,
    state,
    status: "BLOCKED",
    evidence: [],
    findings: [],
  };
}

function failResult(state: string, role = "ROLE"): CoordinatorExecutionContext["result"] {
  return {
    execution_id: "exec-blocked",
    agent: role,
    state,
    status: "FAIL",
    evidence: [],
    findings: [],
  };
}

describe("Phase 1 — isExplicitlyBlocked / hasBlockingFindings helpers", () => {
  it("isExplicitlyBlocked is true only for status BLOCKED", () => {
    expect(isExplicitlyBlocked({ result: blockedResult("ANALYZE") as never })).toBe(true);
    expect(isExplicitlyBlocked({ result: failResult("ANALYZE") as never })).toBe(false);
    expect(isExplicitlyBlocked({ result: { status: "PASS", findings: [] } as never })).toBe(false);
  });

  it("hasBlockingFindings is true for FAIL even with empty findings, but NOT for BLOCKED (handled separately)", () => {
    expect(hasBlockingFindings({ result: failResult("ANALYZE") as never })).toBe(true);
    expect(hasBlockingFindings({ result: blockedResult("ANALYZE") as never })).toBe(false);
  });
});

describe("Phase 1 — BLOCKED with no findings never silently advances as PASS (unit, every state with a direct gate)", () => {
  const casesRoutingToHumanIntervention: Array<{ state: string; from: string }> = [
    { state: "SPECIFY", from: "SPECIFY" },
    { state: "CLARIFY", from: "CLARIFY" },
    { state: "PLAN", from: "PLAN" },
    { state: "TASKS", from: "TASKS" },
    { state: "ANALYZE", from: "ANALYZE" },
    { state: "IMPLEMENT", from: "IMPLEMENT" },
    { state: "INDEPENDENT_REVIEW", from: "INDEPENDENT_REVIEW" },
    { state: "REMEDIATION", from: "REMEDIATION" },
    { state: "RE_REVIEW", from: "RE_REVIEW" },
    { state: "CONVERGE", from: "CONVERGE" },
  ];

  for (const { state, from } of casesRoutingToHumanIntervention) {
    it(`${state}: BLOCKED (no findings) -> REQUIRE_HUMAN_INTERVENTION, never TRANSITION/COMPLETE`, () => {
      const context: CoordinatorExecutionContext = {
        execution: { ...baseExecution, state: state as never },
        result: blockedResult(state) as never,
      };

      const decision = engine.decide(context);
      expect(decision.action).toBe("REQUIRE_HUMAN_INTERVENTION");
      if (decision.action === "REQUIRE_HUMAN_INTERVENTION") {
        expect(decision.from).toBe(from);
      }
    });
  }

  it("BLOCKED at INDEPENDENT_REVIEW bypasses the remediation loop entirely (does not route to REMEDIATION)", () => {
    const context: CoordinatorExecutionContext = {
      execution: { ...baseExecution, state: "INDEPENDENT_REVIEW" },
      result: blockedResult("INDEPENDENT_REVIEW") as never,
    };
    const decision = engine.decide(context);
    expect(decision.action).toBe("REQUIRE_HUMAN_INTERVENTION");
  });

  it("BLOCKED at RE_REVIEW bypasses the remediation loop even when remediation iterations remain available", () => {
    const context: CoordinatorExecutionContext = {
      execution: { ...baseExecution, state: "RE_REVIEW", remediation_iteration: 0 },
      result: blockedResult("RE_REVIEW") as never,
    };
    const decision = engine.decide(context);
    expect(decision.action).toBe("REQUIRE_HUMAN_INTERVENTION");
    if (decision.action === "REQUIRE_HUMAN_INTERVENTION") {
      expect(decision.from).toBe("RE_REVIEW");
    }
  });

  it("BLOCKED at CONVERGE bypasses the remediation loop even when remediation iterations remain available", () => {
    const context: CoordinatorExecutionContext = {
      execution: { ...baseExecution, state: "CONVERGE", remediation_iteration: 0 },
      result: blockedResult("CONVERGE") as never,
    };
    const decision = engine.decide(context);
    expect(decision.action).toBe("REQUIRE_HUMAN_INTERVENTION");
    if (decision.action === "REQUIRE_HUMAN_INTERVENTION") {
      expect(decision.from).toBe("CONVERGE");
    }
  });
});

describe("Phase 1 — FAIL with no findings never silently advances as PASS", () => {
  it("SPECIFY: FAIL -> REQUIRE_HUMAN_INTERVENTION (no remediation loop exists for this state)", () => {
    const context: CoordinatorExecutionContext = {
      execution: { ...baseExecution, state: "SPECIFY" },
      result: failResult("SPECIFY") as never,
    };
    const decision = engine.decide(context);
    expect(decision.action).toBe("REQUIRE_HUMAN_INTERVENTION");
  });

  it("CONVERGE: FAIL still routes into the existing, deliberate remediation-loop treatment (unchanged, pre-existing behavior)", () => {
    const context: CoordinatorExecutionContext = {
      execution: { ...baseExecution, state: "CONVERGE", remediation_iteration: 0 },
      result: failResult("CONVERGE") as never,
    };
    const decision = engine.decide(context);
    expect(decision.action).toBe("TRANSITION");
    if (decision.action === "TRANSITION") {
      expect(decision.to).toBe("REMEDIATION");
    }
  });

  it("CONVERGE: FAIL at max remediation iterations escalates to REQUIRE_HUMAN_INTERVENTION (unchanged, pre-existing behavior)", () => {
    const context: CoordinatorExecutionContext = {
      execution: { ...baseExecution, state: "CONVERGE", remediation_iteration: 3 },
      result: failResult("CONVERGE") as never,
    };
    const decision = engine.decide(context);
    expect(decision.action).toBe("REQUIRE_HUMAN_INTERVENTION");
  });
});

describe("Phase 1 — BLOCKED/FAIL Coordinator end-to-end regression (deterministic MockRuntimeAdapter, no real agent execution)", () => {
  function buildCoordinator(handler: (req: AgentDispatchRequest) => AgentResult) {
    const mockAdapter = new MockRuntimeAdapter(handler);
    const registry = createDefaultAgentRegistry();
    const dispatcher = new AgentDispatcher(registry, [mockAdapter]);
    return new Coordinator({ dispatcher, decisionEngine: new CoordinatorDecisionEngine() });
  }

  it("a BLOCKED result from the Architecture agent during PLAN halts the workflow instead of silently advancing to TASKS", async () => {
    const dispatchedRoles: string[] = [];

    const coordinator = buildCoordinator((req) => {
      dispatchedRoles.push(`${req.role}:${req.state}`);
      if (req.role === "ARCHITECTURE" && req.state === "PLAN") {
        return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "BLOCKED", evidence: [], findings: [] };
      }
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    const result = await coordinator.run({
      execution_id: "exec-blocked-plan",
      feature: "test-feature",
      branch: "feat/test",
      state: "INTAKE",
      runtime: "MOCK",
    });

    expect(result.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(dispatchedRoles).toEqual(["SPECIFICATION:SPECIFY", "SPECIFICATION:CLARIFY", "ARCHITECTURE:PLAN"]);
    expect(dispatchedRoles).not.toContain("ARCHITECTURE:TASKS");
  });

  it("a BLOCKED result from the Independent Review agent requires human intervention instead of a wasted remediation cycle", async () => {
    const dispatchedRoles: string[] = [];

    const coordinator = buildCoordinator((req) => {
      dispatchedRoles.push(`${req.role}:${req.state}`);
      if (req.role === "INDEPENDENT_REVIEW" && req.state === "INDEPENDENT_REVIEW") {
        return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "BLOCKED", evidence: [], findings: [] };
      }
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    const result = await coordinator.run({
      execution_id: "exec-blocked-review",
      feature: "test-feature",
      branch: "feat/test",
      state: "INTAKE",
      runtime: "MOCK",
    });

    expect(result.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(dispatchedRoles).not.toContain("REMEDIATION:REMEDIATION");
  });
});
