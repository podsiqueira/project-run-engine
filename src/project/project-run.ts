// packages/project-run-engine/src/project/project-run.ts

import type {
  AgentDefinition,
  AgentRole,
  AgentRuntime,
  AgentSkill,
  AgentSkillRequirement,
  CoordinatorState,
  HostExecutionOptions,
} from "../domain/types.js";
import type {
  CoordinatorExecutionContext,
  FindingInput,
} from "../decision/types.js";
import {
  type CoordinatorRunResult,
  type StepRecord,
  Coordinator,
} from "../coordinator/coordinator.js";
import { CoordinatorDecisionEngine } from "../decision/decision-engine.js";
import { AgentRegistry } from "../agents/agent-registry.js";
import { AgentDispatcher } from "../agents/agent-dispatcher.js";
import type { AgentRuntimeAdapter } from "../runtime/runtime-adapter.js";
import { SkillResolver } from "../skills/skill-resolver.js";
import { SkillValidator } from "../skills/skill-validator.js";
import { SkillValidationError } from "../skills/skill-validation-error.js";
import {
  type ProjectWorkflowConfig,
  getRoleSkillRequirements,
  loadProjectConfig,
} from "./project-config.js";
import { discoverProjectContext } from "./context-discovery.js";
import {
  type ExecutionStateStore,
  type PersistedExecutionState,
  FileExecutionStateStore,
} from "./state-store.js";

export interface ProjectRunOptions {
  projectRoot?: string;
  config?: ProjectWorkflowConfig;
  configPath?: string;
  context: CoordinatorExecutionContext;
  runtime?: AgentRuntime;
  executionId?: string;
  explicitBranch?: string;
  explicitFeature?: string;
  stateStore?: ExecutionStateStore;
  adapters?: AgentRuntimeAdapter[];
  executionOptions?: HostExecutionOptions;
  resolver?: SkillResolver;
  validator?: SkillValidator;
  registry?: AgentRegistry;
  decisionEngine?: CoordinatorDecisionEngine;
  maxSteps?: number;
  onStep?: (record: StepRecord) => void | Promise<void>;
}

export type ProjectRunStatus =
  | "COMPLETED"
  | "HUMAN_INTERVENTION_REQUIRED"
  | "BLOCKED_MISSING_SKILLS"
  | "FAILED";

export interface ProjectRunExecutionResult {
  status: ProjectRunStatus;
  state: CoordinatorState;
  agentExecuted: boolean;
  stepsCount: number;
  history: StepRecord[];
  role?: AgentRole;
  missingSkills?: string[];
  failureReason?: string;
  coordinatorResult?: CoordinatorRunResult;
}

export interface ProjectResumeOptions {
  executionId: string;
  projectRoot?: string;
  config?: ProjectWorkflowConfig;
  configPath?: string;
  stateStore?: ExecutionStateStore;
  adapters?: AgentRuntimeAdapter[];
  runtime?: AgentRuntime;
  executionOptions?: HostExecutionOptions;
  resolver?: SkillResolver;
  validator?: SkillValidator;
  registry?: AgentRegistry;
  decisionEngine?: CoordinatorDecisionEngine;
  maxSteps?: number;
  onStep?: (record: StepRecord) => void | Promise<void>;
}

/**
 * Portable /project-run entry point bootstrap.
 *
 * Coordinates:
 * 1. Project configuration loading & validation.
 * 2. Deterministic context auto-discovery (git branch & feature).
 * 3. Pre-execution skill requirement verification for the requested role.
 * 4. Deterministic guard: blocks execution if required skills are unavailable.
 * 5. State checkpointing & dispatch through Coordinator execution loop to terminal state.
 *
 * This layer remains completely provider- and LLM-agnostic.
 */
export async function executeProjectRun(
  options: ProjectRunOptions,
): Promise<ProjectRunExecutionResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const context = options.context;
  if (options.executionOptions && !context.executionOptions) {
    context.executionOptions = options.executionOptions;
  }
  const decisionEngine = options.decisionEngine ?? new CoordinatorDecisionEngine();

  // 1. Resolve Project Configuration
  let config: ProjectWorkflowConfig;
  try {
    config = options.config ?? (await loadProjectConfig(projectRoot, options.configPath));
  } catch (err) {
    const rawState = context.execution?.state ?? context.state ?? "INTAKE";
    return {
      status: "FAILED",
      state: rawState,
      agentExecuted: false,
      stepsCount: 0,
      history: [],
      failureReason: `Configuration error: ${(err as Error).message}`,
    };
  }

  // 1.1 Context Auto-Discovery (Branch & Feature)
  const currentFeature = context.execution?.feature ?? context.feature;
  const currentBranch = context.execution?.branch ?? context.branch;

  if (!currentFeature || !currentBranch) {
    const discovery = discoverProjectContext({
      projectRoot,
      explicitBranch: options.explicitBranch,
      explicitFeature: options.explicitFeature,
      config,
    });

    if (!discovery.success) {
      const rawState = context.execution?.state ?? context.state ?? "INTAKE";
      return {
        status: "FAILED",
        state: rawState,
        agentExecuted: false,
        stepsCount: 0,
        history: [],
        failureReason: `${discovery.error}: ${discovery.reason}`,
      };
    }

    if (!currentBranch) {
      context.branch = discovery.context.branch;
      if (context.execution) context.execution.branch = discovery.context.branch;
    }
    if (!currentFeature) {
      context.feature = discovery.context.feature;
      if (context.execution) context.execution.feature = discovery.context.feature;
    }
  }

  // 1.2 Execution Identity
  const executionId =
    options.executionId ??
    context.execution?.execution_id ??
    context.execution?.id ??
    context.execution_id ??
    `exec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  context.execution_id = executionId;
  if (!context.execution) {
    context.execution = {
      execution_id: executionId,
      feature: context.feature ?? "",
      branch: context.branch ?? "",
      state: context.state ?? "INTAKE",
      iteration: context.iteration ?? 1,
      remediation_iteration: context.remediation_iteration ?? 0,
    };
  } else {
    context.execution.execution_id = executionId;
  }

  // 2. Setup Skill System
  const searchPaths = config.skills?.search_paths ?? [];
  const resolver =
    options.resolver ??
    new SkillResolver({
      projectRoot,
      searchPaths,
    });

  const validator = options.validator ?? new SkillValidator(resolver);

  // 3. Resolve Runtime
  const runtime: AgentRuntime =
    options.runtime ??
    context.runtime ??
    config.runtime.default_runtime ??
    "ANTIGRAVITY";

  // 4. Resolve / Build Agent Registry
  const registry = options.registry ?? buildRegistryFromConfig(config);

  // 5. Pre-flight Guard Check
  // Determine if the next action requires an agent dispatch. If so, validate required skills BEFORE starting.
  const initialDecision = decisionEngine.decide(context);

  if (initialDecision.action === "DISPATCH_AGENT") {
    const role = initialDecision.role;
    let requiredSkills: (AgentSkill | AgentSkillRequirement)[] = [];

    try {
      const definition = registry.resolve(role, runtime);
      requiredSkills = definition.skills ?? [];
    } catch {
      // If definition missing skills, check config
      const agentCfg = config.agents[role];
      const skillReqs = getRoleSkillRequirements(agentCfg);
      requiredSkills = skillReqs.map((s, idx) => ({
        id: s.id,
        name: s.id,
        description: s.description ?? s.id,
        capability: s.capability ?? s.id,
        required: s.required,
        execution_order: idx + 1,
      }));
    }

    const validation = await validator.validateRole(role, requiredSkills);

    if (!validation.valid) {
      const currentState = context.execution?.state ?? context.state ?? "INTAKE";
      return {
        status: "BLOCKED_MISSING_SKILLS",
        state: currentState,
        agentExecuted: false,
        stepsCount: 0,
        history: [],
        role,
        missingSkills: validation.missingRequiredSkills,
        failureReason: validation.failureReason,
      };
    }
  }

  // 6. Build Guarded Agent Dispatcher & Coordinator
  const adapters = options.adapters ?? [];
  const dispatcher = new AgentDispatcher(registry, adapters, validator);
  const stateStore = options.stateStore ?? new FileExecutionStateStore(projectRoot);

  const coordinator = new Coordinator({
    dispatcher,
    decisionEngine,
    maxSteps: options.maxSteps,
    stateStore,
    executionMetadata: {
      executionId,
      project: config.project.name,
      feature: context.execution?.feature ?? context.feature ?? "",
      branch: context.execution?.branch ?? context.branch ?? "",
      runtime,
      preset: config.project.workflow_version ?? "spec-kit-v1",
    },
    onStep: options.onStep,
  });

  // 7. Execute Coordinator Loop
  try {
    const coordinatorResult = await coordinator.run(context);
    return {
      status: coordinatorResult.status,
      state: coordinatorResult.state,
      agentExecuted: coordinatorResult.stepsCount > 0,
      stepsCount: coordinatorResult.stepsCount,
      history: coordinatorResult.history,
      coordinatorResult,
    };
  } catch (err) {
    if (err instanceof SkillValidationError) {
      const currentState = context.execution?.state ?? context.state ?? "INTAKE";
      return {
        status: "BLOCKED_MISSING_SKILLS",
        state: currentState,
        agentExecuted: false,
        stepsCount: 0,
        history: [],
        role: err.result.role,
        missingSkills: err.result.missingRequiredSkills,
        failureReason: err.result.failureReason,
      };
    }

    const currentState = context.execution?.state ?? context.state ?? "INTAKE";
    return {
      status: "FAILED",
      state: currentState,
      agentExecuted: false,
      stepsCount: 0,
      history: [],
      failureReason: (err as Error).message,
    };
  }
}

/**
 * Resumes an existing execution that was suspended or reached HUMAN_INTERVENTION_REQUIRED.
 * Restores context without re-executing already completed agents.
 */
export async function executeProjectResume(
  options: ProjectResumeOptions,
): Promise<ProjectRunExecutionResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const stateStore = options.stateStore ?? new FileExecutionStateStore(projectRoot);

  // 1. Load persisted state
  let persisted: PersistedExecutionState | null;
  try {
    persisted = await stateStore.load(options.executionId);
  } catch (err) {
    return {
      status: "FAILED",
      state: "HUMAN_INTERVENTION_REQUIRED",
      agentExecuted: false,
      stepsCount: 0,
      history: [],
      failureReason: (err as Error).message,
    };
  }

  if (!persisted) {
    return {
      status: "FAILED",
      state: "HUMAN_INTERVENTION_REQUIRED",
      agentExecuted: false,
      stepsCount: 0,
      history: [],
      failureReason: `EXECUTION_NOT_FOUND: Execution '${options.executionId}' not found in state store`,
    };
  }

  // 2. Validate resumability
  if (persisted.state === "READY_FOR_PR" || persisted.lifecycle_status === "COMPLETED") {
    return {
      status: "FAILED",
      state: "READY_FOR_PR",
      agentExecuted: false,
      stepsCount: 0,
      history: [],
      failureReason: `EXECUTION_NOT_RESUMABLE: Cannot resume completed execution '${options.executionId}' in terminal state 'READY_FOR_PR'.`,
    };
  }

  if (persisted.lifecycle_status === "FAILED") {
    return {
      status: "FAILED",
      state: persisted.state,
      agentExecuted: false,
      stepsCount: 0,
      history: [],
      failureReason: `EXECUTION_NOT_RESUMABLE: Execution '${options.executionId}' has failed terminally: ${persisted.terminal_reason ?? "unknown error"}.`,
    };
  }

  // 3. Resolve Project Configuration
  let config: ProjectWorkflowConfig;
  try {
    config = options.config ?? (await loadProjectConfig(projectRoot, options.configPath));
  } catch (err) {
    return {
      status: "FAILED",
      state: persisted.state,
      agentExecuted: false,
      stepsCount: 0,
      history: [],
      failureReason: `Configuration error: ${(err as Error).message}`,
    };
  }

  // 4. Reconstruct Context
  const resumeState: CoordinatorState =
    persisted.state === "HUMAN_INTERVENTION_REQUIRED"
      ? (persisted.suspended_from ?? "INTAKE")
      : persisted.state;

  const runtime: AgentRuntime =
    options.runtime ?? persisted.runtime ?? config.runtime.default_runtime ?? "ANTIGRAVITY";

  // For states where human intervention was required because an evaluation gate failed
  // (e.g. RE_REVIEW or CONVERGE reached max remediation limit), the previous failure
  // outcome does not represent the newly modified codebase. We clear context.result
  // so the review/convergence agent is re-dispatched to verify the human fix, and
  // reset remediation_iteration to 0 to grant a fresh budget following human intervention.
  const isPostHumanEvaluation =
    persisted.state === "HUMAN_INTERVENTION_REQUIRED" &&
    (resumeState === "RE_REVIEW" || resumeState === "CONVERGE");

  const remediationIteration = isPostHumanEvaluation
    ? 0
    : (persisted.remediation_iteration ?? 0);

  const context: CoordinatorExecutionContext = {
    execution_id: persisted.execution_id,
    feature: persisted.feature,
    branch: persisted.branch,
    state: resumeState,
    iteration: persisted.iteration,
    remediation_iteration: remediationIteration,
    runtime,
    context: persisted.context,
    result: isPostHumanEvaluation ? undefined : persisted.last_result,
    findings: persisted.findings as FindingInput[] | undefined,
    human_approved: true,
    human_resolved: true,
    blockingAmbiguity: undefined,
    blockingFindings: undefined,
    execution: {
      execution_id: persisted.execution_id,
      feature: persisted.feature,
      branch: persisted.branch,
      state: resumeState,
      iteration: persisted.iteration,
      remediation_iteration: remediationIteration,
    },
    executionOptions: options.executionOptions,
  };

  // 5. Continue execution using Coordinator via executeProjectRun
  return executeProjectRun({
    projectRoot,
    config,
    context,
    runtime,
    executionId: persisted.execution_id,
    adapters: options.adapters,
    stateStore,
    resolver: options.resolver,
    validator: options.validator,
    registry: options.registry,
    decisionEngine: options.decisionEngine,
    maxSteps: options.maxSteps,
    onStep: options.onStep,
  });
}

/**
 * Builds an AgentRegistry from a ProjectWorkflowConfig.
 */
function buildRegistryFromConfig(config: ProjectWorkflowConfig): AgentRegistry {
  const supportedRuntimes = config.runtime.supported_runtimes ?? [config.runtime.default_runtime];
  const definitions: AgentDefinition[] = [];

  for (const [roleKey, roleCfg] of Object.entries(config.agents)) {
    if (!roleCfg || roleCfg.enabled === false) continue;
    const role = roleKey as AgentRole;

    const skillReqs = getRoleSkillRequirements(roleCfg);
    const skills: AgentSkill[] = skillReqs.map((s, idx) => ({
      id: s.id,
      name: s.id,
      description: s.description ?? s.id,
      capability: s.capability ?? s.id,
      required: s.required,
      execution_order: idx + 1,
    }));

    definitions.push({
      role,
      name: roleCfg.name ?? `${role} Agent`,
      description: roleCfg.description ?? `${role} workflow agent`,
      supportedRuntimes,
      skills,
      capability: skills[0]?.capability,
      skill: skills[0]?.id,
    });
  }

  return new AgentRegistry(definitions);
}
