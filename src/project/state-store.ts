// packages/project-run-engine/src/project/state-store.ts

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentDispatchRequest,
  AgentRole,
  AgentRuntime,
  AgentResult,
  CoordinatorState,
  ExecutionStepRecord,
  StructuredFinding,
} from "../domain/types.js";
import {
  CheckpointConflictError,
  ExecutionLockError,
  ExecutionLockTimeoutError,
  ExecutionLockUnavailableError,
  InvalidPersistedStateError,
  StateVersionUnsupportedError,
} from "../domain/types.js";
import type { DecisionRecord } from "../decision/types.js";
import type { HumanInterventionRequired, HumanAnswerRecord } from "../decision/human-intervention.js";

export const CURRENT_STATE_SCHEMA_VERSION = 1;

export type ExecutionLifecycleState =
  | "IN_PROGRESS"
  | "AWAITING_AGENT_ACTION"
  | "HUMAN_INTERVENTION_REQUIRED"
  | "COMPLETED"
  | "FAILED";

/**
 * A pending, not-yet-fulfilled agent dispatch request raised by the pull-based step
 * API (`nextProjectRunStep`/`submitProjectRunStep` — see `ARCHITECTURE.md` §4.11).
 * Persisted literally (not re-derived) so a host that restarted after `prepareNextAction`
 * checkpointed it, but before submitting a result, can recover exactly what was asked
 * without depending on re-deriving an identical decision from the decision engine.
 *
 * `step_id` is the correlation token `submitProjectRunStep` must echo back — this is
 * what lets duplicate or stale submissions be rejected (see `applyExternalResult`).
 */
export interface PersistedPendingAction {
  step_id: string;
  role: AgentRole;
  runtime: AgentRuntime;
  request: AgentDispatchRequest;
  requested_at: string;
}

export interface PersistedExecutionState {
  version: number;
  execution_id: string;
  project: string;
  feature: string;
  branch: string;
  state: CoordinatorState;
  lifecycle_status: ExecutionLifecycleState;
  suspended_from?: CoordinatorState;
  role?: AgentRole;
  runtime: AgentRuntime;
  iteration: number;
  remediation_iteration: number;
  preset: string;
  context?: unknown;
  last_result?: AgentResult;
  findings?: (StructuredFinding | unknown)[];
  /**
   * Durable, append-only record of every decision the engine made, in order
   * (`DecisionRecord`; Phase 5). Compact by design — no dispatch payloads or result
   * evidence — and distinct from `step_log` (what happened) and `findings` (what the
   * latest result reported). Absent on checkpoints written before Phase 5; readers
   * treat absent as empty and never reconstruct entries that were not recorded.
   */
  history?: DecisionRecord[];
  /**
   * Durable, append-only record of every agent result applied and every human
   * suspension, in order (ENG-002). Unlike `findings` (the latest result's findings,
   * which the decision engine gates on and which a clean re-run replaces), nothing in
   * here is overwritten. Absent on checkpoints written before this field existed.
   */
  step_log?: ExecutionStepRecord[];
  terminal_reason?: string;
  /**
   * The most recent Human-in-the-Loop request the engine raised: why the workflow
   * stopped (`reason`), which state it stopped in (`suspendedFrom`), and the
   * structured questions a host must present. Overwritten each time a new
   * HUMAN_INTERVENTION_REQUIRED suspension occurs; the running audit trail of
   * answers lives separately in `human_answers` (below), which is append-only.
   */
  human_intervention?: HumanInterventionRequired;
  /**
   * Append-only record of every human answer ever supplied for this execution,
   * across every resume. Persisted durably as soon as a resume request supplies
   * answers, independent of whether the resumed run subsequently succeeds — so the
   * audit trail (what was asked, what was answered, when) survives even if the
   * resumed execution immediately fails again.
   */
  human_answers?: HumanAnswerRecord[];
  /**
   * The current outstanding agent dispatch request, if `lifecycle_status ===
   * "AWAITING_AGENT_ACTION"`. Cleared (omitted) by every other checkpoint — it
   * describes a single in-flight request, not a history, and `submitProjectRunStep`
   * requires the submission's `step_id` to match this exact record before accepting
   * a result, which is what makes duplicate/stale submissions rejectable.
   */
  pending_action?: PersistedPendingAction;
  /**
   * Store-assigned, strictly increasing write counter for this execution: `1` for the first
   * checkpoint, `+1` for every successful save. Absent on checkpoints written before it existed
   * (read as `0`, "no revision yet"). It is the token of optimistic concurrency (see
   * `ExecutionSaveOptions.expectedRevision`); callers never set it — a store ignores any value in
   * the state it is given and assigns its own.
   */
  revision?: number;
  created_at: string;
  updated_at: string;
}

/**
 * Options of `ExecutionStateStore.save()`.
 */
export interface ExecutionSaveOptions {
  /**
   * Optimistic concurrency (compare-and-swap). When present, the save applies ONLY IF the
   * execution's currently stored revision equals this value (`0` = no checkpoint stored yet, or
   * one written before revisions existed). Otherwise the store must reject the write with a
   * `CheckpointConflictError` and change nothing. Stores that cannot honour it ignore the option.
   */
  expectedRevision?: number;
}

/** What a successful `save()` reports back. */
export interface ExecutionSaveReceipt {
  /** The revision now stored for the execution. */
  revision: number;
}

export interface ExecutionLockOptions {
  /** How long to wait for another operation to release the lock. Default 30 000 ms. */
  timeoutMs?: number;
  /** Base polling interval while waiting (jittered). Default 25 ms. */
  pollMs?: number;
}

/**
 * The storage contract the engine is written against. The Coordinator and every entry point know
 * nothing about files: anything that satisfies this interface can hold executions (the file store
 * below is the reference implementation; a database store would implement the same methods).
 *
 * Required semantics:
 *  - `save` resolves only once the checkpoint is DURABLE and rejects otherwise; a rejected save
 *    changed nothing visible (all-or-nothing — a reader sees the previous or the new checkpoint,
 *    never a mixture). The engine treats a rejection as "this progress did not happen"
 *    (`CheckpointWriteError`) — a store must never resolve a save it did not persist.
 *  - `load` returns the last durable checkpoint (`null` when none) or throws; `exists` agrees with it.
 *  - Optional `withLock`: mutual exclusion for one execution's read-modify-write turn.
 *  - Optional optimistic concurrency: if `save` is given `expectedRevision` it compares-and-swaps
 *    against the stored revision, rejects a mismatch with `CheckpointConflictError` without writing,
 *    and returns the new revision so the next write of the same turn can chain from it. A store that
 *    supports it must assign `revision` (1, 2, 3, ...) on every save and return it from `load`.
 *
 * `withLock` and `expectedRevision` are independent guarantees: the lock keeps cooperating callers
 * from interleaving; the revision check makes any lost update that still slips through (lock not
 * held, deleted by an operator, not offered by the store) a rejected write instead of silent overwrite.
 * See `ARCHITECTURE.md` §4.17 for what each backend can and cannot promise.
 */
export interface ExecutionStateStore {
  save(state: PersistedExecutionState, options?: ExecutionSaveOptions): Promise<void | ExecutionSaveReceipt>;
  load(executionId: string): Promise<PersistedExecutionState | null>;
  exists(executionId: string): Promise<boolean>;
  list?(): Promise<PersistedExecutionState[]>;
  /**
   * Optional advisory mutual exclusion for one execution's read-modify-write turn.
   * Stores that cannot offer it simply omit it; the engine then runs unlocked (the
   * pre-Phase-5 behaviour). See `withExecutionLock` and `ARCHITECTURE.md` §4.17.
   */
  withLock?<T>(executionId: string, fn: () => Promise<T>, options?: ExecutionLockOptions): Promise<T>;
}

/**
 * Runs `fn` while holding the store's advisory lock for `executionId`, or just runs it
 * when the store offers no locking. The lock is released when `fn` settles, whether it
 * returns, throws, or rejects. NOT re-entrant: never nest calls for the same execution.
 */
export function withExecutionLock<T>(
  store: ExecutionStateStore,
  executionId: string,
  fn: () => Promise<T>,
  options?: ExecutionLockOptions,
): Promise<T> {
  return store.withLock ? store.withLock(executionId, fn, options) : fn();
}

const SENSITIVE_KEY_PATTERN = /(?:password|secret|token|api[_-]?key|auth|bearer|private[_-]?key)/i;

/**
 * Sanitizes arbitrary context objects by redacting keys that appear to contain
 * secrets, credentials, or authentication tokens.
 */
export function scrubSecrets(input: unknown, depth = 0): unknown {
  if (depth > 10 || !input || typeof input !== "object") {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item) => scrubSecrets(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      result[key] = scrubSecrets(value, depth + 1);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Validates that raw parsed JSON satisfies the PersistedExecutionState contract.
 */
export function validatePersistedState(
  raw: unknown,
  executionId: string,
): PersistedExecutionState {
  if (!raw || typeof raw !== "object") {
    throw new InvalidPersistedStateError(
      executionId,
      `Persisted state file for '${executionId}' must be a JSON object.`,
    );
  }

  const state = raw as Partial<PersistedExecutionState>;

  if (state.version === undefined || state.version === null) {
    throw new InvalidPersistedStateError(
      executionId,
      `Persisted state for '${executionId}' is missing schema version.`,
    );
  }

  if (state.version !== CURRENT_STATE_SCHEMA_VERSION) {
    throw new StateVersionUnsupportedError(
      state.version,
      `Unsupported execution state schema version ${state.version} (expected ${CURRENT_STATE_SCHEMA_VERSION})`,
    );
  }

  if (!state.execution_id || state.execution_id !== executionId) {
    throw new InvalidPersistedStateError(
      executionId,
      `Persisted state execution_id '${state.execution_id}' does not match requested '${executionId}'.`,
    );
  }

  if (!state.project || typeof state.project !== "string") {
    throw new InvalidPersistedStateError(
      executionId,
      `Persisted state missing valid 'project' identifier.`,
    );
  }

  if (!state.feature || typeof state.feature !== "string") {
    throw new InvalidPersistedStateError(
      executionId,
      `Persisted state missing valid 'feature' identifier.`,
    );
  }

  if (!state.branch || typeof state.branch !== "string") {
    throw new InvalidPersistedStateError(
      executionId,
      `Persisted state missing valid 'branch' identifier.`,
    );
  }

  if (!state.state || typeof state.state !== "string") {
    throw new InvalidPersistedStateError(
      executionId,
      `Persisted state missing valid 'state'.`,
    );
  }

  if (!state.lifecycle_status || typeof state.lifecycle_status !== "string") {
    throw new InvalidPersistedStateError(
      executionId,
      `Persisted state missing valid 'lifecycle_status'.`,
    );
  }

  if (state.revision !== undefined && (!Number.isInteger(state.revision) || state.revision < 0)) {
    throw new InvalidPersistedStateError(
      executionId,
      `Persisted state for '${executionId}' has an invalid 'revision' (${String(state.revision)}); expected a non-negative integer.`,
    );
  }

  return state as PersistedExecutionState;
}

interface LockInfo {
  pid: number;
  token: string;
  acquired_at: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLockInfo(lockPath: string): LockInfo | "gone" | "unreadable" {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unreadable";
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof parsed.pid === "number" && typeof parsed.token === "string") {
      return { pid: parsed.pid, token: parsed.token, acquired_at: String(parsed.acquired_at ?? "") };
    }
  } catch {
    // fall through: empty (creator between open and write) or corrupt
  }
  return "unreadable";
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

function isLockStale(lockPath: string, holder: LockInfo | "unreadable"): boolean {
  if (holder === "unreadable") {
    // The creator is between open() and write(), or died there. Give it a moment.
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > 5_000;
    } catch {
      return false;
    }
  }
  return !isPidAlive(holder.pid);
}

/**
 * Filesystem-backed implementation of ExecutionStateStore.
 * Checkpoints execution states to `.project-run/runs/<execution_id>.json`.
 */
export class FileExecutionStateStore implements ExecutionStateStore {
  readonly runsDir: string;
  private readonly lockDefaults: ExecutionLockOptions;

  /**
   * @param lockDefaults wait budget / polling used by `withLock` unless a call overrides
   *   it (e.g. `{ timeoutMs: 120_000 }` for hosts that run long push-mode turns).
   */
  constructor(projectRoot: string, customRunsDir?: string, lockDefaults: ExecutionLockOptions = {}) {
    this.runsDir =
      customRunsDir ?? path.join(path.resolve(projectRoot), ".project-run", "runs");
    this.lockDefaults = lockDefaults;
  }

  private getFilePath(executionId: string): string {
    const safeId = executionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.runsDir, `${safeId}.json`);
  }

  async exists(executionId: string): Promise<boolean> {
    const filePath = this.getFilePath(executionId);
    return fs.existsSync(filePath);
  }

  /**
   * Writes a checkpoint atomically (temp file + fsync + rename) and assigns it the next revision.
   *
   * Every save runs inside a short per-execution WRITE GUARD (`<id>.cas`, the same exclusive-create
   * file mechanism as the execution lock, held only for the revision check + rename). That makes
   * "compare the stored revision, then replace the file" atomic among all engine processes on this
   * machine, independent of whether the execution lock is held — so `expectedRevision` is an exact
   * compare-and-swap here, not a best-effort check. Same scope as the lock: one machine, a local
   * filesystem with atomic exclusive create; callers that bypass the guard (an older engine, direct
   * file edits) are not covered.
   */
  async save(state: PersistedExecutionState, options: ExecutionSaveOptions = {}): Promise<ExecutionSaveReceipt> {
    if (!fs.existsSync(this.runsDir)) {
      fs.mkdirSync(this.runsDir, { recursive: true });
    }

    const filePath = this.getFilePath(state.execution_id);
    const release = await this.acquireWriteGuard(state.execution_id);
    try {
      const stored = this.readStoredRevision(filePath);
      if (stored === "unreadable" && options.expectedRevision !== undefined) {
        // Not a concurrent change: the stored checkpoint itself is broken. Refuse to guess
        // (an unconditional save is the only way to repair it); reported as a failed write.
        throw new Error(`The stored checkpoint at ${filePath} cannot be read, so the revision to compare against is unknown`);
      }
      if (options.expectedRevision !== undefined && stored !== "unreadable" && options.expectedRevision !== stored) {
        throw new CheckpointConflictError(state.execution_id, state.lifecycle_status, options.expectedRevision, stored);
      }
      const revision = (stored === "unreadable" ? 0 : stored) + 1;

      const sanitized: PersistedExecutionState = {
        ...state,
        version: CURRENT_STATE_SCHEMA_VERSION,
        context: scrubSecrets(state.context),
        revision,
        updated_at: new Date().toISOString(),
      };
      const serialized = JSON.stringify(sanitized, null, 2);

      // Write-then-rename: a concurrent reader (or a crash mid-write) never observes a
      // truncated or half-written checkpoint — the file is always either the previous
      // complete record or the new complete record. The temp file is fsync'd before the
      // rename so a process crash cannot leave a renamed-but-empty file.
      const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
      try {
        const fd = fs.openSync(tmpPath, "w");
        try {
          fs.writeSync(fd, serialized, 0, "utf8");
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(tmpPath, filePath);
      } catch (err) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // temp file may not exist
        }
        throw err;
      }
      return { revision };
    } finally {
      release();
    }
  }

  /** The revision of the stored checkpoint: `0` when none (or written before revisions existed), `"unreadable"` when the file cannot be parsed. */
  private readStoredRevision(filePath: string): number | "unreadable" {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? 0 : "unreadable";
    }
    try {
      const parsed = JSON.parse(raw) as { revision?: unknown };
      return typeof parsed.revision === "number" && Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0;
    } catch {
      return "unreadable";
    }
  }

  private async acquireWriteGuard(executionId: string): Promise<() => void> {
    try {
      return await this.acquireLockOrThrow(executionId, { timeoutMs: 10_000, pollMs: 5 }, this.getLockPath(executionId).replace(/\.lock$/, ".cas"));
    } catch (err) {
      // Not an execution-lock failure: say what actually failed (the checkpoint write guard).
      throw new Error(`Could not obtain the checkpoint write guard for execution '${executionId}' (${(err as Error).message})`);
    }
  }

  // ---------------------------------------------------------------------------------
  // Advisory per-execution lock
  //
  // Scope: processes on ONE machine sharing this runs directory (the engine is limited
  // to node:fs/node:path, so it cannot identify other machines). Guarantee: among
  // cooperating operations using this store class, at most one holds a given
  // execution's lock at a time — including operations inside one process. A holder
  // whose process has died without releasing is detected by probing its pid and its
  // lock is reclaimed; a live holder is never displaced, however long it holds.
  // Not guaranteed: protection against code that bypasses the lock (older engine
  // versions, direct `save()` calls), against pid reuse after a crash, or across
  // machines / filesystems without atomic `O_EXCL` creation (e.g. some network mounts).
  // ---------------------------------------------------------------------------------

  private getLockPath(executionId: string): string {
    return this.getFilePath(executionId).replace(/\.json$/, ".lock");
  }

  async withLock<T>(executionId: string, fn: () => Promise<T>, options: ExecutionLockOptions = {}): Promise<T> {
    const release = await this.acquireLock(executionId, options);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async acquireLock(executionId: string, options: ExecutionLockOptions): Promise<() => void> {
    try {
      return await this.acquireLockOrThrow(executionId, options);
    } catch (err) {
      if (err instanceof ExecutionLockError) throw err;
      // A filesystem failure while taking the lock (missing/unwritable runs dir, disk full,
      // too many open files, ...). Only failures from acquisition itself reach here — the
      // caller's own work runs after acquisition and is never wrapped.
      const e = err as NodeJS.ErrnoException;
      throw new ExecutionLockUnavailableError(
        executionId,
        `EXECUTION_LOCK_UNAVAILABLE: Could not acquire the lock for execution '${executionId}' in '${this.runsDir}' ` +
          `(${e.code ?? "error"}: ${e.message}). The execution was not modified, and the engine will not proceed without the lock. ` +
          `Check that the directory exists and is writable and that the disk is not full, then retry.`,
        err,
      );
    }
  }

  private async acquireLockOrThrow(executionId: string, options: ExecutionLockOptions, lockPathOverride?: string): Promise<() => void> {
    const timeoutMs = options.timeoutMs ?? this.lockDefaults.timeoutMs ?? 30_000;
    const pollMs = options.pollMs ?? this.lockDefaults.pollMs ?? 25;
    fs.mkdirSync(this.runsDir, { recursive: true });

    const lockPath = lockPathOverride ?? this.getLockPath(executionId);
    const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const info: LockInfo = { pid: process.pid, token, acquired_at: new Date().toISOString() };
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      if (this.tryCreateLock(lockPath, info)) return () => this.releaseLock(lockPath, token);

      const holder = readLockInfo(lockPath);
      // Progress = the situation changed (lock vanished, or we removed an abandoned one), so
      // retry at once; otherwise wait a poll interval. EVERY iteration passes through the
      // deadline check and yields to the event loop, so no path can spin or outlive the budget.
      let progressed = holder === "gone";
      if (holder !== "gone" && isLockStale(lockPath, holder)) progressed = this.reapStaleLock(lockPath, holder);

      if (Date.now() >= deadline) {
        const who = holder === "unreadable" || holder === "gone" ? "an unidentified holder" : `pid ${holder.pid} (since ${holder.acquired_at})`;
        throw new ExecutionLockTimeoutError(
          executionId,
          `EXECUTION_LOCKED: Execution '${executionId}' is locked by ${who}; gave up after ${timeoutMs}ms. Lock file: ${lockPath}. ` +
            `If that operation is still running, retry once it finishes. If no engine process is actually running for this ` +
            `execution (for example the pid now belongs to an unrelated process after a crash or restart), the lock is stale: ` +
            `delete the lock file manually. The engine never removes a lock whose pid is still alive. The execution itself is intact.`,
        );
      }
      await sleep(progressed ? 0 : pollMs + Math.floor(Math.random() * pollMs));
    }
  }

  /** Creates the lock file exclusively. Returns false when it already exists; any other failure throws (and leaves no half-written lock behind). */
  private tryCreateLock(lockPath: string, info: LockInfo): boolean {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      fs.writeSync(fd, JSON.stringify(info), 0, "utf8");
    } catch (err) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
      try {
        fs.unlinkSync(lockPath); // never leave an empty lock that would look held
      } catch {
        // nothing to remove
      }
      throw err;
    }
    fs.closeSync(fd);
    return true;
  }

  /** Releases only a lock that is still OURS — never one reclaimed after we were deemed dead. */
  private releaseLock(lockPath: string, token: string): void {
    const holder = readLockInfo(lockPath);
    if (holder !== "gone" && holder !== "unreadable" && holder.token === token) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // already gone
      }
    }
  }

  /**
   * Removes an abandoned lock. Reclamation itself is serialised through a short-lived
   * guard file, and the lock is re-verified under the guard, so two waiters cannot both
   * decide the same lock is stale and have the slower one delete the faster one's fresh lock.
   */
  private reapStaleLock(lockPath: string, stale: LockInfo | "unreadable"): boolean {
    const guardPath = `${lockPath}.reap`;
    try {
      const fd = fs.openSync(guardPath, "wx");
      fs.closeSync(fd);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Someone else is reaping. A guard that outlives any plausible reap is itself abandoned.
      try {
        if (Date.now() - fs.statSync(guardPath).mtimeMs > 10_000) fs.unlinkSync(guardPath);
      } catch {
        // raced with the other reaper finishing
      }
      return false; // no progress made: the caller waits a poll interval and re-checks its deadline
    }
    try {
      const current = readLockInfo(lockPath);
      const sameHolder =
        current !== "gone" &&
        (stale === "unreadable" ? current === "unreadable" : current !== "unreadable" && current.token === stale.token);
      if (sameHolder) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // already gone
        }
      }
      return true;
    } finally {
      try {
        fs.unlinkSync(guardPath);
      } catch {
        // already gone
      }
    }
  }

  async load(executionId: string): Promise<PersistedExecutionState | null> {
    const filePath = this.getFilePath(executionId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      throw new InvalidPersistedStateError(
        executionId,
        `Failed to read state file at ${filePath}: ${(err as Error).message}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new InvalidPersistedStateError(
        executionId,
        `Invalid JSON in state file at ${filePath}: ${(err as Error).message}`,
      );
    }

    return validatePersistedState(parsed, executionId);
  }

  async list(): Promise<PersistedExecutionState[]> {
    if (!fs.existsSync(this.runsDir)) {
      return [];
    }

    const files = fs.readdirSync(this.runsDir);
    const results: PersistedExecutionState[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const executionId = path.basename(file, ".json");
      try {
        const loaded = await this.load(executionId);
        if (loaded) {
          results.push(loaded);
        }
      } catch {
        // Skip corrupted files in list view
      }
    }

    return results.sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
  }
}
