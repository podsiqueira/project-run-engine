import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  FileExecutionStateStore,
  scrubSecrets,
  CURRENT_STATE_SCHEMA_VERSION,
  type PersistedExecutionState,
} from "../src/project/state-store.js";
import {
  InvalidPersistedStateError,
  StateVersionUnsupportedError,
} from "../src/domain/types.js";
import { Coordinator } from "../src/coordinator/coordinator.js";
import { CoordinatorDecisionEngine } from "../src/decision/decision-engine.js";
import { AgentRegistry } from "../src/agents/agent-registry.js";
import { AgentDispatcher } from "../src/agents/agent-dispatcher.js";
import { MockRuntimeAdapter } from "../src/runtime/mock-runtime-adapter.js";
import { SkillValidator } from "../src/skills/skill-validator.js";
import { SkillResolver } from "../src/skills/skill-resolver.js";
import type { CoordinatorExecutionContext } from "../src/decision/types.js";

describe("G-2: Execution State Persistence & Checkpointing", () => {
  let tmpDir: string;
  let stateStore: FileExecutionStateStore;

  const validState: PersistedExecutionState = {
    version: CURRENT_STATE_SCHEMA_VERSION,
    execution_id: "exec-test-123",
    project: "demo-service",
    feature: "auth-module",
    branch: "feat/auth",
    state: "IMPLEMENT",
    lifecycle_status: "IN_PROGRESS",
    runtime: "MOCK",
    iteration: 1,
    remediation_iteration: 0,
    preset: "spec-kit-v1",
    context: { foo: "bar" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-test-"));
    stateStore = new FileExecutionStateStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("FileExecutionStateStore", () => {
    it("saves and loads execution state successfully", async () => {
      await stateStore.save(validState);

      const exists = await stateStore.exists("exec-test-123");
      expect(exists).toBe(true);

      const loaded = await stateStore.load("exec-test-123");
      expect(loaded).toBeDefined();
      expect(loaded?.execution_id).toBe("exec-test-123");
      expect(loaded?.project).toBe("demo-service");
      expect(loaded?.feature).toBe("auth-module");
      expect(loaded?.state).toBe("IMPLEMENT");
      expect(loaded?.version).toBe(CURRENT_STATE_SCHEMA_VERSION);
    });

    it("returns null for unknown execution ID", async () => {
      const loaded = await stateStore.load("non-existent-id");
      expect(loaded).toBeNull();
    });

    it("creates .project-run/runs directory automatically when saving", async () => {
      const runsDir = path.join(tmpDir, ".project-run", "runs");
      expect(fs.existsSync(runsDir)).toBe(false);

      await stateStore.save(validState);
      expect(fs.existsSync(runsDir)).toBe(true);
      expect(fs.existsSync(path.join(runsDir, "exec-test-123.json"))).toBe(true);
    });

    it("rejects malformed persisted state (missing mandatory fields)", async () => {
      const runsDir = path.join(tmpDir, ".project-run", "runs");
      fs.mkdirSync(runsDir, { recursive: true });
      fs.writeFileSync(
        path.join(runsDir, "exec-corrupt.json"),
        JSON.stringify({ version: 1, execution_id: "exec-corrupt" }),
        "utf8",
      );

      await expect(stateStore.load("exec-corrupt")).rejects.toThrow(
        InvalidPersistedStateError,
      );
    });

    it("rejects state with schema version mismatch", async () => {
      const runsDir = path.join(tmpDir, ".project-run", "runs");
      fs.mkdirSync(runsDir, { recursive: true });
      fs.writeFileSync(
        path.join(runsDir, "exec-v99.json"),
        JSON.stringify({
          ...validState,
          version: 99,
          execution_id: "exec-v99",
        }),
        "utf8",
      );

      await expect(stateStore.load("exec-v99")).rejects.toThrow(
        StateVersionUnsupportedError,
      );
    });

    it("scrubs secrets, api keys, and passwords before persisting", async () => {
      const sensitiveState: PersistedExecutionState = {
        ...validState,
        execution_id: "exec-sensitive",
        context: {
          apiKey: "sk-secret-12345",
          password: "super-secret-password",
          nested: {
            auth_token: "bearer-token-abc",
            normal_data: "public-value",
          },
        },
      };

      await stateStore.save(sensitiveState);
      const loaded = await stateStore.load("exec-sensitive");

      const loadedCtx = loaded?.context as Record<string, unknown>;
      expect(loadedCtx.apiKey).toBe("[REDACTED]");
      expect(loadedCtx.password).toBe("[REDACTED]");
      const nested = loadedCtx.nested as Record<string, unknown>;
      expect(nested.auth_token).toBe("[REDACTED]");
      expect(nested.normal_data).toBe("public-value");
    });
  });

  describe("Coordinator Checkpointing Semantics", () => {
    it("checkpoints state at execution start, after agent result, after state transition, and at completion", async () => {
      const executionId = "exec-checkpoint-lifecycle";
      const registry = new AgentRegistry([
        {
          role: "SPECIFICATION",
          name: "Spec Agent",
          description: "Spec",
          supportedRuntimes: ["MOCK"],
        },
      ]);
      const mockAdapter = new MockRuntimeAdapter(() => ({
        execution_id: executionId,
        agent: "SPECIFICATION",
        state: "SPECIFY",
        status: "PASS",
        evidence: [{ type: "test-evidence" }],
        findings: [],
      }));
      const validator = {
        validateRole: async () => ({
          valid: true,
          role: "SPECIFICATION",
          missingRequiredSkills: [],
          missingOptionalSkills: [],
          availableSkills: [],
        }),
      } as unknown as SkillValidator;
      const dispatcher = new AgentDispatcher(registry, [mockAdapter], validator);
      const decisionEngine = new CoordinatorDecisionEngine();

      const savedStates: PersistedExecutionState[] = [];
      const trackingStore = {
        async save(state: PersistedExecutionState) {
          savedStates.push({ ...state });
        },
        async load(id: string) {
          return savedStates.find((s) => s.execution_id === id) ?? null;
        },
        async exists(id: string) {
          return savedStates.some((s) => s.execution_id === id);
        },
      };

      const coordinator = new Coordinator({
        dispatcher,
        decisionEngine,
        stateStore: trackingStore,
        executionMetadata: {
          executionId,
          project: "test-svc",
          feature: "login-flow",
          branch: "feat/login",
          runtime: "MOCK",
        },
      });

      const context: CoordinatorExecutionContext = {
        execution_id: executionId,
        feature: "login-flow",
        branch: "feat/login",
        state: "SPECIFY",
        iteration: 1,
        remediation_iteration: 0,
        runtime: "MOCK",
      };

      // Run 2 steps: 1 dispatch step, 1 transition step
      await coordinator.step(context); // Step 1: DISPATCH_AGENT -> executes mock -> checkpoints result
      await coordinator.step(context); // Step 2: TRANSITION to CLARIFY -> checkpoints transition

      expect(savedStates.length).toBeGreaterThanOrEqual(2);
      expect(savedStates[0].state).toBe("SPECIFY");
      expect(savedStates[0].last_result?.status).toBe("PASS");
      expect(savedStates[1].state).toBe("CLARIFY");
    });

    it("checkpoints before entering HUMAN_INTERVENTION_REQUIRED", async () => {
      const executionId = "exec-human-checkpoint";
      const registry = new AgentRegistry([]);
      const resolver = new SkillResolver({ projectRoot: tmpDir, searchPaths: [] });
      const validator = new SkillValidator(resolver);
      const dispatcher = new AgentDispatcher(registry, [], validator);
      const decisionEngine = new CoordinatorDecisionEngine();

      const savedStates: PersistedExecutionState[] = [];
      const trackingStore = {
        async save(state: PersistedExecutionState) {
          savedStates.push({ ...state });
        },
        async load(id: string) {
          return null;
        },
        async exists(id: string) {
          return false;
        },
      };

      const coordinator = new Coordinator({
        dispatcher,
        decisionEngine,
        stateStore: trackingStore,
        executionMetadata: {
          executionId,
          project: "test-svc",
          feature: "login",
          branch: "main",
          runtime: "MOCK",
        },
      });

      const context: CoordinatorExecutionContext = {
        execution_id: executionId,
        feature: "login",
        branch: "main",
        state: "CLARIFY",
        blockingAmbiguity: true, // triggers human intervention
        runtime: "MOCK",
      };

      await coordinator.step(context);

      expect(savedStates.length).toBe(1);
      expect(savedStates[0].lifecycle_status).toBe("HUMAN_INTERVENTION_REQUIRED");
      expect(savedStates[0].state).toBe("HUMAN_INTERVENTION_REQUIRED");
      expect(savedStates[0].suspended_from).toBe("CLARIFY");
    });

    it("checkpoints on terminal failure when Coordinator.run throws", async () => {
      const executionId = "exec-fail-checkpoint";
      const registry = new AgentRegistry([]);
      const resolver = new SkillResolver({ projectRoot: tmpDir, searchPaths: [] });
      const validator = new SkillValidator(resolver);
      const dispatcher = new AgentDispatcher(registry, [], validator);
      const decisionEngine = new CoordinatorDecisionEngine();

      const savedStates: PersistedExecutionState[] = [];
      const trackingStore = {
        async save(state: PersistedExecutionState) {
          savedStates.push({ ...state });
        },
        async load() {
          return null;
        },
        async exists() {
          return false;
        },
      };

      const coordinator = new Coordinator({
        dispatcher,
        decisionEngine,
        stateStore: trackingStore,
        executionMetadata: {
          executionId,
          project: "test-svc",
          feature: "bad-flow",
          branch: "main",
          runtime: "MOCK",
        },
      });

      // Context with invalid state causes decide to throw
      const context = {
        execution_id: executionId,
        state: "INVALID_STATE" as any,
      };

      await expect(coordinator.run(context)).rejects.toThrow();

      const failedCheckpoint = savedStates.find((s) => s.lifecycle_status === "FAILED");
      expect(failedCheckpoint).toBeDefined();
      expect(failedCheckpoint?.execution_id).toBe(executionId);
    });
  });
});
