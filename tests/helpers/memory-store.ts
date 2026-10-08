// A storage backend with NO filesystem knowledge, used to prove the engine is storage-neutral and to
// exercise the ExecutionStateStore contract against something other than FileExecutionStateStore.
// It is the shape a database-backed store would take: an atomic compare-and-swap on a per-execution
// revision, and a lease-style lock. (Test-only: not part of the package.)

import {
  CheckpointConflictError,
  ExecutionLockTimeoutError,
} from "../../src/domain/types.js";
import type {
  ExecutionSaveOptions,
  ExecutionSaveReceipt,
  ExecutionStateStore,
  ExecutionLockOptions,
  PersistedExecutionState,
} from "../../src/project/state-store.js";

export class MemoryExecutionStateStore implements ExecutionStateStore {
  readonly rows = new Map<string, string>();
  saves = 0;
  failNextSave: Error | null = null;
  private readonly locks = new Set<string>();

  async save(state: PersistedExecutionState, options: ExecutionSaveOptions = {}): Promise<ExecutionSaveReceipt> {
    this.saves++;
    if (this.failNextSave) {
      const err = this.failNextSave;
      this.failNextSave = null;
      throw err;
    }
    const raw = this.rows.get(state.execution_id);
    const stored = raw ? ((JSON.parse(raw) as PersistedExecutionState).revision ?? 0) : 0;
    // The whole check-and-write below is synchronous, i.e. atomic with respect to other callers —
    // what a database gets from a conditional UPDATE ... WHERE revision = :expected.
    if (options.expectedRevision !== undefined && options.expectedRevision !== stored) {
      throw new CheckpointConflictError(state.execution_id, state.lifecycle_status, options.expectedRevision, stored);
    }
    const revision = stored + 1;
    this.rows.set(state.execution_id, JSON.stringify({ ...state, revision, updated_at: new Date().toISOString() }));
    return { revision };
  }

  async load(executionId: string): Promise<PersistedExecutionState | null> {
    const raw = this.rows.get(executionId);
    return raw ? (JSON.parse(raw) as PersistedExecutionState) : null;
  }

  async exists(executionId: string): Promise<boolean> {
    return this.rows.has(executionId);
  }

  async list(): Promise<PersistedExecutionState[]> {
    return [...this.rows.values()].map((r) => JSON.parse(r) as PersistedExecutionState);
  }

  async withLock<T>(executionId: string, fn: () => Promise<T>, options: ExecutionLockOptions = {}): Promise<T> {
    const deadline = Date.now() + (options.timeoutMs ?? 5_000);
    while (this.locks.has(executionId)) {
      if (Date.now() >= deadline) throw new ExecutionLockTimeoutError(executionId, `EXECUTION_LOCKED: '${executionId}' is locked`);
      await new Promise((r) => setTimeout(r, 2));
    }
    this.locks.add(executionId);
    try {
      return await fn();
    } finally {
      this.locks.delete(executionId);
    }
  }
}

/**
 * A store written against the 0.3.0 contract: `save(state): Promise<void>`, no revisions, no
 * compare-and-swap, no lock. It must keep working unchanged.
 */
export class LegacyExecutionStateStore implements ExecutionStateStore {
  readonly rows = new Map<string, string>();
  async save(state: PersistedExecutionState): Promise<void> {
    this.rows.set(state.execution_id, JSON.stringify(state));
  }
  async load(executionId: string): Promise<PersistedExecutionState | null> {
    const raw = this.rows.get(executionId);
    return raw ? (JSON.parse(raw) as PersistedExecutionState) : null;
  }
  async exists(executionId: string): Promise<boolean> {
    return this.rows.has(executionId);
  }
}
