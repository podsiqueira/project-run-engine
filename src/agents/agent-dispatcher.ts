// packages/project-run-engine/src/agents/agent-dispatcher.ts

import type {
  AgentDispatchRequest,
  AgentResult,
  AgentRuntime,
  AgentSkillRequirement,
  HostExecutionOptions,
} from "../domain/types.js";
import type { AgentRuntimeAdapter } from "../runtime/runtime-adapter.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { SkillValidator } from "../skills/skill-validator.js";
import { SkillValidationError } from "../skills/skill-validation-error.js";

export class AgentDispatcher {
  private readonly adapters = new Map<AgentRuntime, AgentRuntimeAdapter>();

  constructor(
    private readonly registry: AgentRegistry,
    adapters: AgentRuntimeAdapter[],
    private readonly skillValidator?: SkillValidator,
  ) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.runtime)) {
        throw new Error(
          `Duplicate runtime adapter: ${adapter.runtime}`,
        );
      }

      this.adapters.set(adapter.runtime, adapter);
    }
  }

  /**
   * Registers or overrides a runtime adapter at runtime.
   */
  registerAdapter(adapter: AgentRuntimeAdapter): void {
    this.adapters.set(adapter.runtime, adapter);
  }

  async dispatch(
    request: AgentDispatchRequest,
    runtime: AgentRuntime,
    options?: HostExecutionOptions,
  ): Promise<AgentResult> {
    // Resolve the agent first so unsupported role/runtime combinations
    // fail before any runtime adapter is considered for execution.
    const definition = this.registry.resolve(request.role, runtime);

    const adapter = this.adapters.get(runtime);

    if (!adapter) {
      throw new Error(
        `No runtime adapter registered for runtime: ${runtime}`,
      );
    }

    // Enrich request with capability, skill, and skill metadata from registered definition
    // when they are not explicitly specified on the incoming request, preserving object identity.
    if (!request.capability && (definition.capability || definition.skillMetadata?.workflow)) {
      request.capability = definition.capability ?? definition.skillMetadata?.workflow;
    }
    if (!request.skill && definition.skill) {
      request.skill = definition.skill;
    }
    if (!request.skill_metadata && definition.skillMetadata) {
      request.skill_metadata = definition.skillMetadata;
    }

    const rawSkills = request.skills ?? definition.skills ?? [];

    // Validate required skills before executing the agent
    if (this.skillValidator) {
      const validation = await this.skillValidator.validateRole(
        request.role,
        rawSkills,
      );
      if (!validation.valid) {
        throw new SkillValidationError(validation);
      }

      // Explicitly inject and enrich resolved skills with discovered descriptor metadata (source, version, etc.)
      const resolvedSkills: AgentSkillRequirement[] = rawSkills.map((s, idx) => {
        const descriptor = validation.availableSkills.find((d) => d.id === s.id);
        return {
          id: s.id,
          name: descriptor?.name ?? s.name ?? s.id,
          description: descriptor?.description ?? s.description,
          capability: s.capability,
          required: s.required !== false,
          execution_order: s.execution_order ?? idx + 1,
          workflow: s.workflow,
          evidenceRequirements: s.evidenceRequirements,
          source: descriptor?.source ?? s.source,
          version: descriptor?.version ?? s.version,
        };
      });

      request.skills = resolvedSkills;
      request.required_skills = resolvedSkills;
    } else {
      const normalizedSkills: AgentSkillRequirement[] = rawSkills.map((s, idx) => ({
        id: s.id,
        name: s.name ?? s.id,
        description: s.description,
        capability: s.capability,
        required: s.required !== false,
        execution_order: s.execution_order ?? idx + 1,
        workflow: s.workflow,
        evidenceRequirements: s.evidenceRequirements,
        source: s.source,
        version: s.version,
      }));
      request.skills = normalizedSkills;
      request.required_skills = normalizedSkills;
    }

    const effectiveOptions = options ?? request.options;
    return adapter.execute(request, effectiveOptions);
  }
}
