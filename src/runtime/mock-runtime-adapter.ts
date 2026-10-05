// packages/project-run-engine/src/runtime/mock-runtime-adapter.ts

import type {
  AgentDispatchRequest,
  AgentResult,
  AgentRuntime,
  HostExecutionOptions,
} from "../domain/types.js";
import type { AgentRuntimeAdapter } from "./runtime-adapter.js";
import { executeWithHostGuards } from "./host-execution-contract.js";

export class MockRuntimeAdapter implements AgentRuntimeAdapter {
  readonly runtime: AgentRuntime;

  constructor(
    private readonly executor: (
      request: AgentDispatchRequest,
      options?: HostExecutionOptions,
    ) => AgentResult | Promise<AgentResult>,
    private readonly defaultOptions?: HostExecutionOptions,
    runtime: AgentRuntime = "MOCK",
  ) {
    this.runtime = runtime;
  }

  execute(
    request: AgentDispatchRequest,
    options?: HostExecutionOptions,
  ): Promise<AgentResult> {
    const effectiveOptions: HostExecutionOptions = {
      ...this.defaultOptions,
      ...request.options,
      ...options,
    };

    return executeWithHostGuards(
      () => this.executor(request, effectiveOptions),
      request,
      this.runtime,
      effectiveOptions,
    );
  }
}
