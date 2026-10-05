import { describe, it, expect } from "vitest";
import {
  CoordinatorDecisionEngine,
  Coordinator,
  AgentDispatcher,
  AgentRegistry,
  MockRuntimeAdapter,
  type WorkflowPreset,
  type AgentDefinition,
  type CoordinatorState,
  type AgentRole,
  type AgentDispatchRequest,
  type CoordinatorExecutionContext,
} from "../src/index.js";

describe("Workflow Preset Extensibility (project-run-engine)", () => {
  it("should support a custom workflow preset completely independent of Spec-Kit", async () => {
    // 1. Define custom states, transitions, and role mappings
    const customValidStates = new Set<CoordinatorState>([
      "INTAKE",
      "SPECIFY", // repurposed as TRIAGE
      "IMPLEMENT", // repurposed as FIX
      "READY_FOR_PR",
      "HUMAN_INTERVENTION_REQUIRED",
    ]);

    const customTransitions: ReadonlyMap<CoordinatorState, ReadonlySet<CoordinatorState>> = new Map([
      ["INTAKE", new Set<CoordinatorState>(["SPECIFY"])],
      ["SPECIFY", new Set<CoordinatorState>(["IMPLEMENT"])],
      ["IMPLEMENT", new Set<CoordinatorState>(["READY_FOR_PR"])],
      ["READY_FOR_PR", new Set<CoordinatorState>()],
    ]);

    const customStateToRole: ReadonlyMap<CoordinatorState, AgentRole> = new Map([
      ["SPECIFY", "TRIAGE_SPECIALIST"],
      ["IMPLEMENT", "HOTFIX_DEVELOPER"],
    ]);

    const customPreset: WorkflowPreset = {
      id: "hotfix-triage-v1",
      name: "Hotfix & Triage Preset",
      description: "Custom lightweight triage and fix methodology without Spec-Kit",
      validStates: customValidStates,
      allowedTransitions: customTransitions,
      stateToRole: customStateToRole,
      getExpectedOutput: () => ({ status: "PASS", evidence_required: false }),
      getStateSkillConfig: (state) => ({
        skill: state === "SPECIFY" ? "triage-skill" : "hotfix-skill",
        capability: state === "SPECIFY" ? "triage" : "hotfix",
      }),
      getSkillsForRole: (role) => [
        {
          id: role === "TRIAGE_SPECIALIST" ? "triage-skill" : "hotfix-skill",
          name: role,
          description: "Skill for custom role",
          capability: "custom",
          required: true,
          execution_order: 1,
        },
      ],
      resolveTransition(context) {
        const state = context.execution?.state ?? context.state;
        if (state === "INTAKE") {
          return { action: "TRANSITION", from: "INTAKE", to: "SPECIFY", reason: "Triage starting" };
        }
        if (state === "SPECIFY") {
          return { action: "TRANSITION", from: "SPECIFY", to: "IMPLEMENT", reason: "Triage complete" };
        }
        if (state === "IMPLEMENT") {
          return { action: "TRANSITION", from: "IMPLEMENT", to: "READY_FOR_PR", reason: "Fix complete" };
        }
        if (state === "READY_FOR_PR") {
          return { action: "COMPLETE", state: "READY_FOR_PR", reason: "Hotfix verified" };
        }
        return undefined;
      },
    };

    // 2. Instantiate decision engine with custom preset
    const decisionEngine = new CoordinatorDecisionEngine({ preset: customPreset });

    // 3. Register agents supporting custom roles
    const agentDefs: AgentDefinition[] = [
      {
        role: "TRIAGE_SPECIALIST",
        name: "Triage Specialist",
        description: "Diagnoses issue",
        supportedRuntimes: ["MOCK"],
      },
      {
        role: "HOTFIX_DEVELOPER",
        name: "Hotfix Developer",
        description: "Applies hotfix",
        supportedRuntimes: ["MOCK"],
      },
    ];

    const dispatched: AgentDispatchRequest[] = [];
    const mockAdapter = new MockRuntimeAdapter((req) => {
      dispatched.push(req);
      return {
        execution_id: req.execution_id,
        agent: req.role,
        state: req.state,
        status: "PASS",
        evidence: [],
        findings: [],
      };
    });

    const registry = new AgentRegistry(agentDefs);
    const dispatcher = new AgentDispatcher(registry, [mockAdapter]);
    const coordinator = new Coordinator({ dispatcher, decisionEngine });

    const context: CoordinatorExecutionContext = {
      execution_id: "custom-preset-exec-1",
      feature: "security-hotfix",
      branch: "fix/security",
      state: "INTAKE",
      runtime: "MOCK",
    };

    const result = await coordinator.run(context);

    expect(result.status).toBe("COMPLETED");
    expect(result.state).toBe("READY_FOR_PR");
    expect(dispatched.map((d) => d.role)).toEqual([
      "TRIAGE_SPECIALIST",
      "HOTFIX_DEVELOPER",
    ]);
  });
});
