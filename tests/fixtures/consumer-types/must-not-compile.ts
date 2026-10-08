// NEGATIVE control: proves the type check in the test is real. A save() that resolves to something
// that is neither void nor a receipt must be rejected.
import { FileExecutionStateStore } from "@incito-labs/project-run-engine/project";
import type { PersistedExecutionState } from "@incito-labs/project-run-engine/project";

export class Wrong extends FileExecutionStateStore {
  override async save(_state: PersistedExecutionState): Promise<string> { return "not a receipt"; }
}
