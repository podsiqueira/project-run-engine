// packages/project-run-engine/src/runtime/runtime-adapter.ts

import type {
  AgentDispatchRequest,
  AgentResult,
  AgentRuntime,
  HostExecutionOptions,
} from "../domain/types.js";

export interface AgentRuntimeAdapter {
  readonly runtime: AgentRuntime;

  execute(
    request: AgentDispatchRequest,
    options?: HostExecutionOptions,
  ): Promise<AgentResult>;
}
