// packages/project-run-engine/src/project/project-run.ts

import type {
  AgentDefinition,
  AgentRole,
  AgentRuntime,
  AgentSkill,
  AgentSkillRequirement,
  CoordinatorState,
  ExecutionStepRecord,
  HostExecutionOptions,
} from "../domain/types.js";
import { ExecutionLockError } from "../domain/types.js";
import type {
  CoordinatorExecutionContext,
  DecisionRecord,
  FindingInput,
} from "../decision/types.js";
import {
  type CoordinatorRunResult,
  type StepRecord,
  Coordinator,
} from "../coordinator/coordinator.js";
import { CoordinatorDecisionEngine, hasBlockingFindings, isExplicitlyBlocked } from "../decision/decision-engine.js";
import type { HumanAnswer, HumanAnswerRecord } from "../decision/human-intervention.js";
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
  withExecutionLock,
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
  /**
   * Coordinator loop iterations in THIS call (including pure transitions; bounded by
   * `maxSteps`). It is NOT the number of agent steps in the execution — that is
   * `countAgentSteps(stepLog)`, which is what `ProjectRunHostResponse.stepsCount` reports.
   */
  stepsCount: number;
  history: StepRecord[];
  role?: AgentRole;
  missingSkills?: string[];
  failureReason?: string;
  coordinatorResult?: CoordinatorRunResult;
  /** The execution's durable step log as of this call's end (including prior resumes). */
  stepLog?: ExecutionStepRecord[];
  /** The execution's durable decision history as of this call's end (including prior resumes). */
  decisionHistory?: DecisionRecord[];
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
  /**
   * Human answers to the questions returned on the prior HUMAN_INTERVENTION_REQUIRED
   * suspension (see `HumanInterventionRequired.questions`). Persisted durably on the
   * execution's checkpoint record for audit purposes (what was asked/answered/when).
   * Answers do NOT directly mutate findings or force a particular transition — the
   * responsible agent is still re-dispatched to independently verify the human's fix.
   */
  humanAnswers?: HumanAnswer[];
}

/**
 * Resolves the runtime a fresh or resuming execution should use, honoring one
 * precedence, in one place, for every entry point:
 *
 *   explicit per-call override (`requestRuntime`)
 *     ?? a runtime already present on the context/persisted record (`contextRuntime`)
 *     ?? the project's configured `runtime.default_runtime`
 *     ?? the engine's historical last-resort fallback ("ANTIGRAVITY")
 *
 * Called once, before the Coordinator's decision loop ever runs (`executeProjectRun`,
 * `nextProjectRunStep`'s fresh-start path, `reconstructResumeContext`) and the result
 * assigned onto `context.runtime` — so `CoordinatorDecisionEngine.decide()` and
 * `Coordinator.checkpoint()` always see an already-resolved runtime. Their own
 * `context.runtime ?? "ANTIGRAVITY"` fallbacks remain as a defensive last resort for a
 * caller that builds a `CoordinatorExecutionContext` directly without going through
 * one of these entry points (`Coordinator` is itself part of the public API surface);
 * they are not expected to fire for any supported host-facing entry point.
 */
export function resolveRuntime(
  requestRuntime: AgentRuntime | undefined,
  contextRuntime: AgentRuntime | undefined,
  config: ProjectWorkflowConfig,
): AgentRuntime {
  return requestRuntime ?? contextRuntime ?? config.runtime.default_runtime ?? "ANTIGRAVITY";
}

/**
 * Resolves the project's `.project-run/config.json` (or an explicitly provided
 * config object), returning a simple ok/error result rather than throwing.
 *
 * Extracted as the single, reusable config-resolution step shared by
 * `executeProjectRun`, `reconstructResumeContext`, and the pull-based step API
 * (`nextProjectRunStep`/`submitProjectRunStep`) — see `ARCHITECTURE.md` §4.11.
 */
export async function resolveConfig(
  projectRoot: string,
  providedConfig: ProjectWorkflowConfig | undefined,
  configPath: string | undefined,
): Promise<{ ok: true; config: ProjectWorkflowConfig } | { ok: false; failureReason: string }> {
  try {
    const config = providedConfig ?? (await loadProjectConfig(projectRoot, configPath));
    return { ok: true, config };
  } catch (err) {
    return { ok: false, failureReason: `Configuration error: ${(err as Error).message}` };
  }
}

export interface EngineServices {
  resolver: SkillResolver;
  validator: SkillValidator;
  registry: AgentRegistry;
}

/**
 * Builds the skill resolver/validator/agent registry trio from a resolved config,
 * honoring any explicit overrides a caller supplied. Extracted for the same reason
 * as `resolveConfig` above: every orchestration entry point needs the identical
 * construction, and duplicating it per entry point is exactly the class of drift
 * this refactor exists to prevent.
 */
export function buildEngineServices(
  projectRoot: string,
  config: ProjectWorkflowConfig,
  overrides: { resolver?: SkillResolver; validator?: SkillValidator; registry?: AgentRegistry },
): EngineServices {
  const searchPaths = config.skills?.search_paths ?? [];
  const resolver = overrides.resolver ?? new SkillResolver({ projectRoot, searchPaths });
  const validator = overrides.validator ?? new SkillValidator(resolver);
  const registry = overrides.registry ?? buildRegistryFromConfig(config);
  return { resolver, validator, registry };
}

/**
 * Reconstructs (in place, mutating `context`) the execution identity for a FRESH
 * execution: auto-discovers feature/branch when not already supplied, then assigns
 * an execution id and builds `context.execution` if it doesn't already exist.
 *
 * Extracted from `executeProjectRun`'s former inline steps 1.1–1.2 so the pull-based
 * step API (`nextProjectRunStep`, starting a new execution) reuses the identical
 * logic rather than a second, independently-maintained copy.
 */
export function reconstructStartContext(options: {
  projectRoot: string;
  context: CoordinatorExecutionContext;
  executionId?: string;
  explicitFeature?: string;
  explicitBranch?: string;
  config: ProjectWorkflowConfig;
}): { ok: true; executionId: string } | { ok: false; failureReason: string } {
  const { context, projectRoot, config } = options;
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
      return { ok: false, failureReason: `${discovery.error}: ${discovery.reason}` };
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

  return { ok: true, executionId };
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
  const context = options.context;
  const executionId =
    options.executionId ?? context.execution?.execution_id ?? context.execution?.id ?? context.execution_id;
  // No id supplied: reconstructStartContext mints a fresh, unguessable one that no
  // other host can know yet, so there is nothing to contend for.
  if (!executionId) return executeProjectRunUnlocked(options);

  const stateStore = options.stateStore ?? new FileExecutionStateStore(options.projectRoot ?? process.cwd());
  try {
    return await withExecutionLock(stateStore, executionId, () => executeProjectRunUnlocked({ ...options, stateStore }));
  } catch (err) {
    if (err instanceof ExecutionLockError) return lockedResult(context, err);
    throw err;
  }
}

function lockedResult(context: CoordinatorExecutionContext, err: ExecutionLockError): ProjectRunExecutionResult {
  return {
    status: "FAILED",
    state: context.execution?.state ?? context.state ?? "INTAKE",
    agentExecuted: false,
    stepsCount: 0,
    history: [],
    failureReason: err.message,
  };
}

/** The push-mode run itself. Callers hold the execution's lock; never call this nested inside another lock for the same id. */
async function executeProjectRunUnlocked(
  options: ProjectRunOptions,
): Promise<ProjectRunExecutionResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const context = options.context;
  if (options.executionOptions && !context.executionOptions) {
    context.executionOptions = options.executionOptions;
  }
  const decisionEngine = options.decisionEngine ?? new CoordinatorDecisionEngine();

  // 1. Resolve Project Configuration
  const resolvedConfig = await resolveConfig(projectRoot, options.config, options.configPath);
  if (!resolvedConfig.ok) {
    const rawState = context.execution?.state ?? context.state ?? "INTAKE";
    return {
      status: "FAILED",
      state: rawState,
      agentExecuted: false,
      stepsCount: 0,
      history: [],
      failureReason: resolvedConfig.failureReason,
    };
  }
  const config = resolvedConfig.config;

  // 1.1–1.2 Context Auto-Discovery (Branch & Feature) & Execution Identity
  const started = reconstructStartContext({
    projectRoot,
    context,
    executionId: options.executionId,
    explicitFeature: options.explicitFeature,
    explicitBranch: options.explicitBranch,
    config,
  });
  if (!started.ok) {
    const rawState = context.execution?.state ?? context.state ?? "INTAKE";
    return {
      status: "FAILED",
      state: rawState,
      agentExecuted: false,
      stepsCount: 0,
      history: [],
      failureReason: started.failureReason,
    };
  }
  const executionId = started.executionId;

  // 2. Setup Skill System & 4. Resolve / Build Agent Registry
  const { resolver, validator, registry } = buildEngineServices(projectRoot, config, {
    resolver: options.resolver,
    validator: options.validator,
    registry: options.registry,
  });

  // 3. Resolve Runtime — once, here, before the Coordinator decision loop ever runs,
  // so every `decisionEngine.decide(context)` call below (both the pre-flight check
  // and every step inside `coordinator.run()`) sees the SAME, fully-resolved runtime
  // rather than each independently re-deriving (and potentially diverging on) one.
  const runtime: AgentRuntime = resolveRuntime(options.runtime, context.runtime, config);
  context.runtime = runtime;

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
        stepLog: context.stepLog,
        decisionHistory: context.history,
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
      stepLog: context.stepLog,
      decisionHistory: context.history,
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
        stepLog: context.stepLog,
        decisionHistory: context.history,
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
      stepLog: context.stepLog,
      decisionHistory: context.history,
    };
  }
}

/**
 * States whose HUMAN_INTERVENTION_REQUIRED exit is reached EXCLUSIVELY via a blocking
 * condition (findings, FAIL, or BLOCKED) under the current decision engine — there is
 * no code path in this preset that suspends from these states for an unrelated reason.
 * Their stale result can therefore always be safely cleared on resume, forcing a fresh
 * re-verification dispatch, without first checking the persisted snapshot.
 */
const ALWAYS_REVERIFY_ON_RESUME: ReadonlySet<CoordinatorState> = new Set(["RE_REVIEW", "CONVERGE"]);

/**
 * States whose HUMAN_INTERVENTION_REQUIRED exit MAY also be reached via an explicit
 * host-supplied override (e.g. `blockingAmbiguity`/`blockingFindings`) or some other
 * reason unrelated to the agent's own result — so an already-clean persisted result
 * must not be discarded unconditionally. Resume only forces re-verification here when
 * the persisted snapshot itself still shows a genuine blocking condition.
 */
const CONDITIONALLY_REVERIFY_ON_RESUME: ReadonlySet<CoordinatorState> = new Set(["CLARIFY", "ANALYZE"]);

/**
 * Determines whether a HUMAN_INTERVENTION_REQUIRED suspension from `resumeState` should
 * force the responsible agent to be re-dispatched and re-verified on resume, as opposed
 * to trusting the already-persisted (clean) result and letting the decision engine
 * transition past it immediately.
 *
 * Extracted as a single, reusable mechanism — rather than duplicated per-state checks —
 * specifically so that extending this behavior to a new gate (as this function already
 * does for both CLARIFY and ANALYZE) never again requires rediscovering and copying the
 * CLARIFY-specific logic that originally lived inline here.
 */
function shouldReverifyOnResume(
  resumeState: CoordinatorState,
  snapshot: { result?: PersistedExecutionState["last_result"]; findings?: FindingInput[] },
): boolean {
  if (ALWAYS_REVERIFY_ON_RESUME.has(resumeState)) {
    return true;
  }
  if (CONDITIONALLY_REVERIFY_ON_RESUME.has(resumeState)) {
    return isExplicitlyBlocked(snapshot) || hasBlockingFindings(snapshot);
  }
  return false;
}

/**
 * Resumes an existing execution that was suspended or reached HUMAN_INTERVENTION_REQUIRED.
 * Restores context without re-executing already completed agents.
 */
export interface ResumeContextOptions {
  executionId: string;
  projectRoot: string;
  stateStore: ExecutionStateStore;
  config?: ProjectWorkflowConfig;
  configPath?: string;
  runtime?: AgentRuntime;
  humanAnswers?: HumanAnswer[];
  executionOptions?: HostExecutionOptions;
}

export type ResumeContextResult =
  | { ok: true; context: CoordinatorExecutionContext; config: ProjectWorkflowConfig; persisted: PersistedExecutionState }
  | { ok: false; failureReason: string; state: CoordinatorState };

/**
 * Loads a persisted execution, validates it is actually resumable, resolves project
 * configuration, and reconstructs the `CoordinatorExecutionContext` to resume from —
 * including the re-verification-on-resume logic (`shouldReverifyOnResume`) and durable,
 * immediate persistence of any newly supplied human answers.
 *
 * Extracted from `executeProjectResume`'s former inline steps 1–4 so the pull-based
 * step API (`nextProjectRunStep`/`submitProjectRunStep`, when continuing an existing
 * execution) reuses the IDENTICAL reconstruction logic — including every resume safety
 * guarantee from Phase 0–2 — rather than a second, independently-maintained copy that
 * could silently drift from it. `executeProjectResume` itself is now just this function
 * plus a hand-off into `executeProjectRun`'s push-based Coordinator loop (step 5).
 */
export async function reconstructResumeContext(
  options: ResumeContextOptions,
): Promise<ResumeContextResult> {
  const { executionId, projectRoot, stateStore } = options;

  // 1. Load persisted state
  let persisted: PersistedExecutionState | null;
  try {
    persisted = await stateStore.load(executionId);
  } catch (err) {
    return { ok: false, state: "HUMAN_INTERVENTION_REQUIRED", failureReason: (err as Error).message };
  }

  if (!persisted) {
    return {
      ok: false,
      state: "HUMAN_INTERVENTION_REQUIRED",
      failureReason: `EXECUTION_NOT_FOUND: Execution '${executionId}' not found in state store`,
    };
  }

  // 2. Validate resumability
  if (persisted.state === "READY_FOR_PR" || persisted.lifecycle_status === "COMPLETED") {
    return {
      ok: false,
      state: "READY_FOR_PR",
      failureReason: `EXECUTION_NOT_RESUMABLE: Cannot resume completed execution '${executionId}' in terminal state 'READY_FOR_PR'.`,
    };
  }

  if (persisted.lifecycle_status === "FAILED") {
    return {
      ok: false,
      state: persisted.state,
      failureReason: `EXECUTION_NOT_RESUMABLE: Execution '${executionId}' has failed terminally: ${persisted.terminal_reason ?? "unknown error"}.`,
    };
  }

  // 3. Resolve Project Configuration
  const resolvedConfig = await resolveConfig(projectRoot, options.config, options.configPath);
  if (!resolvedConfig.ok) {
    return { ok: false, state: persisted.state, failureReason: resolvedConfig.failureReason };
  }
  const config = resolvedConfig.config;

  // 4. Reconstruct Context
  const resumeState: CoordinatorState =
    persisted.state === "HUMAN_INTERVENTION_REQUIRED"
      ? (persisted.suspended_from ?? "INTAKE")
      : persisted.state;

  const runtime: AgentRuntime = resolveRuntime(options.runtime, persisted.runtime, config);

  // For states where human intervention was required because an evaluation gate failed
  // (e.g. RE_REVIEW or CONVERGE reached max remediation limit, or CLARIFY/ANALYZE hit a
  // blocking condition), the previous failure outcome does not represent the human's
  // fix. We clear context.result so the responsible agent is re-dispatched to verify
  // the fix rather than trusting the stale blocking result, and reset
  // remediation_iteration to 0 to grant a fresh budget following human intervention.
  const isPostHumanEvaluation =
    persisted.state === "HUMAN_INTERVENTION_REQUIRED" &&
    shouldReverifyOnResume(resumeState, {
      result: persisted.last_result,
      findings: persisted.findings as FindingInput[] | undefined,
    });

  const remediationIteration = isPostHumanEvaluation
    ? 0
    : (persisted.remediation_iteration ?? 0);

  // Human-in-the-Loop answers: persist them durably, immediately, before anything else
  // happens — so the audit trail (what was asked, what was answered, when) survives
  // even if the resumed run below fails again right away. Answers are NEVER used to
  // mutate the original finding or to force a particular outcome; the responsible
  // agent is still re-dispatched (above) and its fresh result is what the decision
  // engine actually trusts, consistent with the Finding Contract's "a finding may be
  // marked RESOLVED only after ... the Independent Review Agent has verified the
  // correction" — the same principle extended to a human's clarification answer.
  const existingAnswers = persisted.human_answers ?? [];
  const newAnswers: HumanAnswerRecord[] = (options.humanAnswers ?? []).map((answer: HumanAnswer) => ({
    ...answer,
    recordedAt: new Date().toISOString(),
  }));
  const mergedAnswers = [...existingAnswers, ...newAnswers];

  if (newAnswers.length > 0) {
    try {
      await stateStore.save({ ...persisted, human_answers: mergedAnswers });
    } catch {
      // Non-fatal: the resume attempt below still proceeds. A failure to persist the
      // answer record is reported as part of the FAILED result if the resume itself
      // then also fails, but must never block a resume that would otherwise succeed.
    }
  }

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
    humanAnswers: mergedAnswers.length > 0 ? mergedAnswers : undefined,
    stepLog: persisted.step_log,
    history: persisted.history,
    // blockingAmbiguity/blockingFindings are intentionally left unset here: they are
    // derived from `findings` by the decision engine (hasBlockingFindings), not stored
    // independently. Resetting them to `undefined` previously gave the false impression
    // that blocking state was being cleared on resume; it is `findings` + `result` above
    // that actually carry (and, for CLARIFY/ANALYZE/RE_REVIEW/CONVERGE, correctly clear)
    // that state.
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

  return { ok: true, context, config, persisted };
}

export async function executeProjectResume(
  options: ProjectResumeOptions,
): Promise<ProjectRunExecutionResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const stateStore = options.stateStore ?? new FileExecutionStateStore(projectRoot);
  // The whole turn — load, answer persistence, and the run loop — is one read-modify-
  // write of this execution, so it is one lock hold. Re-entry goes to the unlocked run.
  try {
    return await withExecutionLock(stateStore, options.executionId, () => resumeUnlocked(options, projectRoot, stateStore));
  } catch (err) {
    if (err instanceof ExecutionLockError) {
      return lockedResult({ state: "HUMAN_INTERVENTION_REQUIRED" }, err);
    }
    throw err;
  }
}

async function resumeUnlocked(
  options: ProjectResumeOptions,
  projectRoot: string,
  stateStore: ExecutionStateStore,
): Promise<ProjectRunExecutionResult> {

  const reconstructed = await reconstructResumeContext({
    executionId: options.executionId,
    projectRoot,
    stateStore,
    config: options.config,
    configPath: options.configPath,
    runtime: options.runtime,
    humanAnswers: options.humanAnswers,
    executionOptions: options.executionOptions,
  });

  if (!reconstructed.ok) {
    return {
      status: "FAILED",
      state: reconstructed.state,
      agentExecuted: false,
      stepsCount: 0,
      history: [],
      failureReason: reconstructed.failureReason,
    };
  }

  const { context, config } = reconstructed;

  // 5. Continue execution using Coordinator (already holding this execution's lock)
  return executeProjectRunUnlocked({
    projectRoot,
    config,
    context,
    runtime: context.runtime as AgentRuntime | undefined,
    executionId: context.execution_id,
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
