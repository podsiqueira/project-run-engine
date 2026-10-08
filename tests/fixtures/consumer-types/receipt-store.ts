// Stores that DO report revisions, in every supported shape.
import { FileExecutionStateStore } from "@incito-labs/project-run-engine/project";
import type { ExecutionSaveOptions, ExecutionSaveReceipt, ExecutionStateStore, PersistedExecutionState } from "@incito-labs/project-run-engine/project";

// A subclass that forwards the options and hands back whatever the base returns.
export class Forwarding extends FileExecutionStateStore {
  override async save(state: PersistedExecutionState, options?: ExecutionSaveOptions): Promise<void | ExecutionSaveReceipt> {
    return super.save(state, options);
  }
}
// A subclass that narrows to the receipt (allowed: a receipt IS a void | receipt).
export class Narrowing extends FileExecutionStateStore {
  override async save(state: PersistedExecutionState, options?: ExecutionSaveOptions): Promise<ExecutionSaveReceipt> {
    const receipt = await super.save(state, options);
    return receipt ?? { revision: 0 };
  }
}
// A from-scratch store with the new contract, and one written against the old one.
export class Modern implements ExecutionStateStore {
  async save(_state: PersistedExecutionState, _options?: ExecutionSaveOptions): Promise<ExecutionSaveReceipt> { return { revision: 1 }; }
  async load(_id: string): Promise<PersistedExecutionState | null> { return null; }
  async exists(_id: string): Promise<boolean> { return false; }
}
export class Legacy implements ExecutionStateStore {
  async save(_state: PersistedExecutionState): Promise<void> { /* 0.3.0 contract */ }
  async load(_id: string): Promise<PersistedExecutionState | null> { return null; }
  async exists(_id: string): Promise<boolean> { return false; }
}
// Callers of the concrete class narrow the receipt.
export async function revisionOf(store: FileExecutionStateStore, state: PersistedExecutionState): Promise<number | undefined> {
  const receipt = await store.save(state);
  return receipt ? receipt.revision : undefined;
}
