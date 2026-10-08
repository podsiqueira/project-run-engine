// Written against 0.3.0: a subclass of the file store that overrides save() returning Promise<void>.
// It must keep type-checking (the F2 regression).
import { FileExecutionStateStore } from "@incito-labs/project-run-engine/project";
import type { PersistedExecutionState } from "@incito-labs/project-run-engine/project";

export class AuditingStore extends FileExecutionStateStore {
  readonly saved: string[] = [];
  override async save(state: PersistedExecutionState): Promise<void> {
    this.saved.push(state.execution_id);
    await super.save(state);
  }
}
