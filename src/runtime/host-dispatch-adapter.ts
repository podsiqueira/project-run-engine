// packages/project-run-engine/src/runtime/host-dispatch-adapter.ts

import type {
  AgentDispatchRequest,
  AgentResult,
  AgentRuntime,
  HostExecutionOptions,
} from "../domain/types.js";
import type { AgentRuntimeAdapter } from "./runtime-adapter.js";
import { executeWithHostGuards } from "./host-execution-contract.js";

/**
 * Host-provided agent execution capability interface.
 *
 * Inverts the dependency so the coordinator runtime does not couple
 * directly to Antigravity, Claude, Cursor, or any specific host environment.
 * The host environment provides a concrete dispatcher that handles
 * agent invocation, tool execution, and result collection.
 */
export interface HostAgentDispatcher {
  dispatch(
    request: AgentDispatchRequest,
    options?: HostExecutionOptions,
  ): Promise<AgentResult>;
}

/**
 * Backward-compatibility alias for HostAgentDispatcher.
 */
export type HostDispatchSink = HostAgentDispatcher;

/**
 * Host dispatch boundary adapter.
 *
 * This adapter receives an AgentDispatchRequest from the Coordinator/Dispatcher
 * and delegates execution directly to an injected HostAgentDispatcher.
 *
 * Invariants:
 * - Does NOT call any LLM provider.
 * - Does NOT alter, interpret, or retry the request or result.
 * - Enforces timeout, cancellation, and lifecycle tracking via executeWithHostGuards.
 * - Propagates host execution errors faithfully.
 * - Extensible: supports standard runtimes (ANTIGRAVITY, CLAUDE, CURSOR, MOCK)
 *   as well as any custom runtime registered by consumers.
 */
export class HostDispatchAdapter implements AgentRuntimeAdapter {
  constructor(
    readonly runtime: AgentRuntime,
    private readonly hostDispatcher: HostAgentDispatcher,
    private readonly defaultOptions?: HostExecutionOptions,
  ) {
    if (!runtime || typeof runtime !== "string" || !runtime.trim()) {
      throw new Error("A valid non-empty runtime identifier must be provided");
    }

    if (!hostDispatcher || typeof hostDispatcher.dispatch !== "function") {
      throw new Error("A valid HostAgentDispatcher must be provided");
    }
  }

  async execute(
    request: AgentDispatchRequest,
    options?: HostExecutionOptions,
  ): Promise<AgentResult> {
    const effectiveOptions: HostExecutionOptions = {
      ...this.defaultOptions,
      ...request.options,
      ...options,
    };

    return executeWithHostGuards(
      () => this.hostDispatcher.dispatch(request, effectiveOptions),
      request,
      this.runtime,
      effectiveOptions,
    );
  }
}
