// Internal (not re-exported from the package barrel): how the engine's entry points run a
// mutating turn under an execution's lock and tell a LOCK failure apart from a failure of
// the turn itself.

import { ExecutionLockError } from "../domain/types.js";
import { withExecutionLock, type ExecutionStateStore } from "./state-store.js";

export type LockedTurn<T> =
  | { acquired: true; value: T }
  | { acquired: false; error: ExecutionLockError };

/**
 * Runs `fn` while holding the execution's lock.
 *
 * The result says whether the lock was OBTAINED, decided structurally rather than by error
 * type or message text: once `fn` has started, the lock was held, so anything it (or the
 * store's release) throws is the operation's own failure and propagates unchanged — even if
 * it happens to be an `ExecutionLockError` raised by something the operation did. Only an
 * `ExecutionLockError` raised BEFORE `fn` started means "the lock was not obtained", and
 * only then is `{ acquired: false }` returned; `fn` has not run and nothing was modified.
 */
export async function runLockedTurn<T>(
  store: ExecutionStateStore,
  executionId: string,
  fn: () => Promise<T>,
): Promise<LockedTurn<T>> {
  let entered = false;
  try {
    const value = await withExecutionLock(store, executionId, async () => {
      entered = true;
      return fn();
    });
    return { acquired: true, value };
  } catch (err) {
    if (!entered && err instanceof ExecutionLockError) return { acquired: false, error: err };
    throw err;
  }
}

/**
 * The `failureReason` for a turn that failed because of an error RAISED INSIDE it. A lock
 * error raised inside an operation (for example an adapter that locks its own execution) is
 * not a lock failure of the engine's call, so its text must not begin with an
 * `EXECUTION_LOCKED:` / `EXECUTION_LOCK_UNAVAILABLE:` code — hosts react to those codes by
 * prefix and treat them as "rejected, execution intact".
 */
export function operationFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof ExecutionLockError)) return message;
  const detail = message.replace(/^EXECUTION_LOCK(ED|_UNAVAILABLE):\s*/, "");
  return `The operation was aborted by a lock error raised inside it (${err.code}): ${detail}`;
}
