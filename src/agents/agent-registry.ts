// packages/project-run-engine/src/agents/agent-registry.ts

import type {
  AgentRole,
  AgentRuntime,
  AgentDefinition,
} from "../domain/types.js";

export class AgentRegistry {
  private readonly definitions = new Map<AgentRole, AgentDefinition>();

  constructor(definitions: AgentDefinition[] = []) {
    for (const definition of definitions) {
      if (this.definitions.has(definition.role)) {
        throw new Error(`Duplicate agent role: ${definition.role}`);
      }

      this.definitions.set(definition.role, definition);
    }
  }

  /**
   * Registers or updates an agent definition.
   */
  register(definition: AgentDefinition): void {
    this.definitions.set(definition.role, definition);
  }

  resolve(role: AgentRole, runtime: AgentRuntime): AgentDefinition {
    const definition = this.definitions.get(role);

    if (!definition) {
      throw new Error(`No agent registered for role: ${role}`);
    }

    if (!definition.supportedRuntimes.includes(runtime)) {
      throw new Error(
        `Agent ${role} does not support runtime ${runtime}`,
      );
    }

    return definition;
  }

  has(role: AgentRole): boolean {
    return this.definitions.has(role);
  }
}
