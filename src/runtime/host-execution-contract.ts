// packages/project-run-engine/src/runtime/host-execution-contract.ts

import type {
  AgentDispatchRequest,
  AgentResult,
  AgentRole,
  AgentRuntime,
} from "../domain/types.js";
import type { HostAgentDispatcher } from "./host-dispatch-adapter.js";

/**
 * Explicit execution lifecycle status of a host dispatch.
 */
export type HostExecutionLifecycleStatus =
  | "CREATED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

/**
 * Provider-neutral record of a host execution lifecycle event.
 */
export interface HostExecutionRecord {
  execution_id: string;
  runtime: AgentRuntime;
  role: AgentRole;
  status: HostExecutionLifecycleStatus;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  error?: string;
}

/**
 * Provider-neutral metadata attached to an AgentResult upon host completion.
 */
export interface HostExecutionMetadata {
  runtime: AgentRuntime;
  lifecycle_status?: HostExecutionLifecycleStatus;
  duration_ms?: number;
  started_at?: string;
  completed_at?: string;
  [key: string]: unknown;
}

/**
 * Provider-neutral execution options passed down to host execution.
 */
export interface HostExecutionOptions {
  signal?: AbortSignal;
  timeout_ms?: number;
  onLifecycleChange?: (
    status: HostExecutionLifecycleStatus,
    record: HostExecutionRecord,
  ) => void;
  [key: string]: unknown;
}

/**
 * Base class for all host execution failures.
 *
 * Operational host failures (process crash, unavailable runtime, timeout, cancellation)
 * are distinct from agent domain findings (e.g. status: "FINDINGS").
 */
export class HostExecutionError extends Error {
  readonly execution_id?: string;
  readonly runtime?: AgentRuntime;
  readonly status: HostExecutionLifecycleStatus;

  constructor(
    message: string,
    options?: {
      execution_id?: string;
      runtime?: AgentRuntime;
      status?: HostExecutionLifecycleStatus;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "HostExecutionError";
    this.execution_id = options?.execution_id;
    this.runtime = options?.runtime;
    this.status = options?.status ?? "FAILED";
    if (options?.cause) {
      this.cause = options.cause;
    }
    Object.setPrototypeOf(this, HostExecutionError.prototype);
  }
}

/**
 * Thrown when a host execution exceeds its configured timeout_ms limit.
 */
export class HostTimeoutError extends HostExecutionError {
  readonly timeout_ms: number;

  constructor(
    timeout_ms: number,
    options?: {
      execution_id?: string;
      runtime?: AgentRuntime;
      cause?: unknown;
    },
  ) {
    super(`Host execution timed out after ${timeout_ms}ms`, {
      ...options,
      status: "TIMED_OUT",
    });
    this.name = "HostTimeoutError";
    this.timeout_ms = timeout_ms;
    Object.setPrototypeOf(this, HostTimeoutError.prototype);
  }
}

/**
 * Thrown when a host execution is cancelled via an AbortSignal.
 */
export class HostCancellationError extends HostExecutionError {
  constructor(
    options?: {
      execution_id?: string;
      runtime?: AgentRuntime;
      cause?: unknown;
      reason?: string;
    },
  ) {
    super(
      options?.reason
        ? `Host execution was cancelled: ${options.reason}`
        : "Host execution was cancelled",
      {
        ...options,
        status: "CANCELLED",
      },
    );
    this.name = "HostCancellationError";
    Object.setPrototypeOf(this, HostCancellationError.prototype);
  }
}

/**
 * Shared, provider-neutral execution runner that coordinates lifecycle transitions,
 * cancellation checks, timeout races, and metadata enrichment without coupling to
 * any concrete LLM or host SDK.
 */
export async function executeWithHostGuards(
  executor: () => Promise<AgentResult> | AgentResult,
  request: AgentDispatchRequest,
  runtime: AgentRuntime,
  options?: HostExecutionOptions,
): Promise<AgentResult> {
  const signal = options?.signal;
  const timeoutMs = options?.timeout_ms;
  const onLifecycleChange = options?.onLifecycleChange;

  const createRecord = (
    status: HostExecutionLifecycleStatus,
    startedAtMs: number,
    completedAtMs?: number,
    error?: string,
  ): HostExecutionRecord => ({
    execution_id: request.execution_id,
    runtime,
    role: request.role,
    status,
    started_at: new Date(startedAtMs).toISOString(),
    completed_at: completedAtMs ? new Date(completedAtMs).toISOString() : undefined,
    duration_ms: completedAtMs ? completedAtMs - startedAtMs : undefined,
    error,
  });

  const startedAt = Date.now();

  // 1. Immediate cancellation check
  if (signal?.aborted) {
    const errorMsg = signal.reason ? String(signal.reason) : undefined;
    onLifecycleChange?.(
      "CANCELLED",
      createRecord("CANCELLED", startedAt, Date.now(), errorMsg),
    );
    throw new HostCancellationError({
      execution_id: request.execution_id,
      runtime,
      reason: errorMsg,
    });
  }

  // 2. Notify RUNNING
  onLifecycleChange?.("RUNNING", createRecord("RUNNING", startedAt));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  try {
    const dispatchPromise = Promise.resolve().then(() => executor());
    const racePromises: Promise<AgentResult>[] = [dispatchPromise];

    // Cancellation race
    if (signal) {
      const cancelPromise = new Promise<never>((_, reject) => {
        abortListener = () => {
          const completedAt = Date.now();
          const reason = signal.reason ? String(signal.reason) : undefined;
          onLifecycleChange?.(
            "CANCELLED",
            createRecord("CANCELLED", startedAt, completedAt, reason),
          );
          reject(
            new HostCancellationError({
              execution_id: request.execution_id,
              runtime,
              reason,
            }),
          );
        };
        signal.addEventListener("abort", abortListener, { once: true });
      });
      racePromises.push(cancelPromise);
    }

    // Timeout race
    if (timeoutMs !== undefined && timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const completedAt = Date.now();
          onLifecycleChange?.(
            "TIMED_OUT",
            createRecord("TIMED_OUT", startedAt, completedAt, `Timeout after ${timeoutMs}ms`),
          );
          reject(
            new HostTimeoutError(timeoutMs, {
              execution_id: request.execution_id,
              runtime,
            }),
          );
        }, timeoutMs);
      });
      racePromises.push(timeoutPromise);
    }

    const result = await Promise.race(racePromises);

    const completedAt = Date.now();
    const durationMs = completedAt - startedAt;

    onLifecycleChange?.("COMPLETED", createRecord("COMPLETED", startedAt, completedAt));

    const metadata: HostExecutionMetadata = {
      ...result.metadata,
      ...result.execution_metadata,
      runtime,
      lifecycle_status: "COMPLETED",
      duration_ms: durationMs,
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date(completedAt).toISOString(),
    };

    try {
      result.metadata = metadata;
      result.execution_metadata = metadata;
    } catch {
      // Guard against frozen objects
    }

    return result;
  } catch (error) {
    if (
      !(error instanceof HostTimeoutError) &&
      !(error instanceof HostCancellationError)
    ) {
      const completedAt = Date.now();
      const errorMsg = error instanceof Error ? error.message : String(error);
      onLifecycleChange?.(
        "FAILED",
        createRecord("FAILED", startedAt, completedAt, errorMsg),
      );
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

/**
 * MockHostAgentDispatcher provides a testable implementation of HostAgentDispatcher
 * to verify the host execution boundary in unit and integration tests without any LLM.
 */
export class MockHostAgentDispatcher implements HostAgentDispatcher {
  readonly receivedRequests: AgentDispatchRequest[] = [];
  readonly receivedOptions: (HostExecutionOptions | undefined)[] = [];

  constructor(
    private readonly handler?: (
      request: AgentDispatchRequest,
      options?: HostExecutionOptions,
    ) => Promise<AgentResult> | AgentResult,
  ) {}

  async dispatch(
    request: AgentDispatchRequest,
    options?: HostExecutionOptions,
  ): Promise<AgentResult> {
    this.receivedRequests.push(request);
    this.receivedOptions.push(options);

    if (this.handler) {
      return this.handler(request, options);
    }

    return {
      execution_id: request.execution_id,
      agent: request.role,
      state: request.state,
      status: "PASS",
      evidence: [],
      findings: [],
    };
  }

  get lastRequest(): AgentDispatchRequest | undefined {
    return this.receivedRequests[this.receivedRequests.length - 1];
  }

  get lastOptions(): HostExecutionOptions | undefined {
    return this.receivedOptions[this.receivedOptions.length - 1];
  }

  clear(): void {
    this.receivedRequests.length = 0;
    this.receivedOptions.length = 0;
  }
}
