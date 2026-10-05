import { describe, it, expect } from "vitest";
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

describe("Coordinator Execution Loop (project-run-engine)", () => {
  it("should advance through the complete lifecycle to READY_FOR_PR", async () => {
    const executedRequests: AgentDispatchRequest[] = [];

    const mockAdapter = new MockRuntimeAdapter((req) => {
      executedRequests.push(req);

      // On review, simulate findings on initial review pass
      if (req.role === "INDEPENDENT_REVIEW" && req.state === "INDEPENDENT_REVIEW") {
        return {
          execution_id: req.execution_id,
          agent: req.role,
          state: req.state,
          status: "FINDINGS",
          evidence: [],
          findings: [{ id: "f1", severity: "HIGH", status: "OPEN" }],
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
    const decisionEngine = new CoordinatorDecisionEngine();
    const coordinator = new Coordinator({ dispatcher, decisionEngine });

    const context: CoordinatorExecutionContext = {
      execution_id: "exec-test-1",
      feature: "test-feature",
      branch: "feat/test",
      state: "INTAKE",
      runtime: "MOCK",
    };

    const result = await coordinator.run(context);

    expect(result.status).toBe("COMPLETED");
    expect(result.state).toBe("READY_FOR_PR");
    expect(result.terminalDecision.action).toBe("COMPLETE");
    expect(result.stepsCount).toBeGreaterThan(10);

    const roles = executedRequests.map((r) => r.role);
    expect(roles).toEqual([
      "SPECIFICATION", // SPECIFY
      "SPECIFICATION", // CLARIFY
      "ARCHITECTURE",  // PLAN
      "ARCHITECTURE",  // TASKS
      "ARCHITECTURE",  // ANALYZE
      "IMPLEMENTATION", // IMPLEMENT
      "INDEPENDENT_REVIEW", // INDEPENDENT_REVIEW -> returns FINDINGS
      "REMEDIATION",   // REMEDIATION
      "INDEPENDENT_REVIEW", // RE_REVIEW -> returns PASS
      "CONVERGENCE",   // CONVERGE -> returns PASS
    ]);
  });
});
