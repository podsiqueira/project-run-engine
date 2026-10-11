// NEGATIVE control for the compatibility note: a consumer written against 0.4.x that switches over
// ExecutionFailureCode exhaustively stops compiling when a member is added (here INVALID_HUMAN_ANSWERS)
// and must add a case. The widening is additive for everything else.
import type { ExecutionFailureCode } from "@incito-labs/project-run-engine";

export function advice(code: ExecutionFailureCode): string {
  switch (code) {
    case "EXECUTION_LOCKED":
    case "EXECUTION_LOCK_UNAVAILABLE":
      return "retry";
    case "CHECKPOINT_WRITE_FAILED":
    case "CHECKPOINT_CONFLICT":
      return "read status";
    default: {
      const unhandled: never = code;
      return unhandled;
    }
  }
}
