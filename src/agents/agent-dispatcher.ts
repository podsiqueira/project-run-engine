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

  /**
   * Resolves the agent role/runtime, enriches the request with capability/skill
   * metadata, and validates required skills — everything `dispatch()` does EXCEPT
   * looking up and invoking a runtime adapter.
   *
   * Extracted so the pull-based step API (`Coordinator.prepareNextAction()`,
   * `src/host/project-run-step.ts`) can reuse the exact same enrichment and skill
   * validation `dispatch()` performs — including the Phase 3 Closure fix preferring
   * the registry definition's skills over the preset's defaults — without requiring
   * a real `AgentRuntimeAdapter` to exist at all. A pull-based host IS the agent
   * runtime for this execution; there is nothing for an adapter to do here.
   *
   * Throws `SkillValidationError` exactly as `dispatch()` does when a required skill
   * is unavailable. Throws the same `AgentRegistry.resolve()` error for an
   * unsupported role/runtime combination.
   */
  async prepareRequest(
    request: AgentDispatchRequest,
    runtime: AgentRuntime,
  ): Promise<AgentDispatchRequest> {
    // Resolve the agent first so unsupported role/runtime combinations fail fast.
    const definition = this.registry.resolve(request.role, runtime);

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

    // Prefer the registry definition's skills (built from the consuming project's own
    // `.project-run/config.json`, including any explicit `required: false` override)
    // over the decision engine's preset-derived defaults on `request.skills`. For the
    // default registry (no custom config), these are identical content anyway — the
    // preset is literally what `createDefaultAgentRegistry()` derives definitions
    // from — so this only changes behavior when a consumer actually customizes their
    // config, which is precisely when their customization should take effect.
    const rawSkills = definition.skills ?? request.skills ?? [];

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

    return request;
  }

  async dispatch(
    request: AgentDispatchRequest,
    runtime: AgentRuntime,
    options?: HostExecutionOptions,
  ): Promise<AgentResult> {
    // Resolve the agent first so unsupported role/runtime combinations fail before
    // any runtime adapter is considered for execution (preserved precedence from
    // before this method was split — registry.resolve() is called again inside
    // prepareRequest() below, but it is a cheap Map lookup, not a correctness
    // concern, and keeping it there is what lets prepareRequest() be called
    // standalone, without dispatch(), from the pull-based step API).
    this.registry.resolve(request.role, runtime);

    const adapter = this.adapters.get(runtime);

    if (!adapter) {
      throw new Error(
        `No runtime adapter registered for runtime: ${runtime}`,
      );
    }

    const enrichedRequest = await this.prepareRequest(request, runtime);

    const effectiveOptions = options ?? enrichedRequest.options;
    return adapter.execute(enrichedRequest, effectiveOptions);
  }
}
