import { describe, it, expect } from "vitest";
import {
  HostDispatchAdapter,
  AgentDispatcher,
  CoordinatorDecisionEngine,
  Coordinator,
  type HostAgentDispatcher,
  type AgentDispatchRequest,
  type AgentResult,
  type AgentDefinition,
  AgentRegistry,
  type CoordinatorExecutionContext,
} from "../src/index.js";

describe("Custom Runtime Extensibility (project-run-engine)", () => {
  it("should allow consumers to register and dispatch agents to a custom runtime without engine modification", async () => {
    const customDispatched: AgentDispatchRequest[] = [];

    const customDispatcher: HostAgentDispatcher = {
      async dispatch(request): Promise<AgentResult> {
        customDispatched.push(request);
        return {
          execution_id: request.execution_id,
          agent: request.role,
          state: request.state,
          status: "PASS",
          evidence: [{ runner: "CUSTOM_RUNNER_1" }],
          findings: [],
        };
      },
    };

    const customRuntimeAdapter = new HostDispatchAdapter(
      "CUSTOM_CLUSTER_RUNNER",
      customDispatcher,
    );

    const customAgentDef: AgentDefinition = {
      role: "IMPLEMENTATION",
      name: "Custom Runner Implementation Agent",
      description: "Custom runner",
      supportedRuntimes: ["CUSTOM_CLUSTER_RUNNER"],
    };

    const registry = new AgentRegistry([customAgentDef]);
    const dispatcher = new AgentDispatcher(registry, [customRuntimeAdapter]);

    const request: AgentDispatchRequest = {
      execution_id: "custom-exec-1",
      feature: "custom-feat",
      branch: "feat/custom",
      state: "IMPLEMENT",
      role: "IMPLEMENTATION",
      iteration: 1,
      remediation_iteration: 0,
      context: {},
      expected_output: { status: "PASS", evidence_required: true },
    };

    const result = await dispatcher.dispatch(request, "CUSTOM_CLUSTER_RUNNER");

    expect(result.status).toBe("PASS");
    expect(result.metadata?.runtime).toBe("CUSTOM_CLUSTER_RUNNER");
    expect(result.metadata?.lifecycle_status).toBe("COMPLETED");
    expect(customDispatched.length).toBe(1);
    expect(customDispatched[0].execution_id).toBe("custom-exec-1");
  });

  it("should reject an empty runtime identifier", () => {
    const dummyDispatcher: HostAgentDispatcher = {
      dispatch: async () => ({
        execution_id: "x",
        agent: "IMPLEMENTATION",
        state: "x",
        status: "PASS",
        evidence: [],
        findings: [],
      }),
    };

    expect(() => new HostDispatchAdapter("", dummyDispatcher)).toThrow(
      "A valid non-empty runtime identifier must be provided",
    );
  });
});
