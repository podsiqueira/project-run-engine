// packages/project-run-engine/src/project/state-store.ts

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentRole,
  AgentRuntime,
  AgentResult,
  CoordinatorState,
  StructuredFinding,
} from "../domain/types.js";
import {
  InvalidPersistedStateError,
  StateVersionUnsupportedError,
} from "../domain/types.js";
import type { StepRecord } from "../coordinator/coordinator.js";

export const CURRENT_STATE_SCHEMA_VERSION = 1;

export type ExecutionLifecycleState =
  | "IN_PROGRESS"
  | "HUMAN_INTERVENTION_REQUIRED"
  | "COMPLETED"
  | "FAILED";

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
  history?: StepRecord[];
  terminal_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface ExecutionStateStore {
  save(state: PersistedExecutionState): Promise<void>;
  load(executionId: string): Promise<PersistedExecutionState | null>;
  exists(executionId: string): Promise<boolean>;
  list?(): Promise<PersistedExecutionState[]>;
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

  return state as PersistedExecutionState;
}

/**
 * Filesystem-backed implementation of ExecutionStateStore.
 * Checkpoints execution states to `.project-run/runs/<execution_id>.json`.
 */
export class FileExecutionStateStore implements ExecutionStateStore {
  readonly runsDir: string;

  constructor(projectRoot: string, customRunsDir?: string) {
    this.runsDir =
      customRunsDir ?? path.join(path.resolve(projectRoot), ".project-run", "runs");
  }

  private getFilePath(executionId: string): string {
    const safeId = executionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.runsDir, `${safeId}.json`);
  }

  async exists(executionId: string): Promise<boolean> {
    const filePath = this.getFilePath(executionId);
    return fs.existsSync(filePath);
  }

  async save(state: PersistedExecutionState): Promise<void> {
    if (!fs.existsSync(this.runsDir)) {
      fs.mkdirSync(this.runsDir, { recursive: true });
    }

    const sanitized: PersistedExecutionState = {
      ...state,
      version: CURRENT_STATE_SCHEMA_VERSION,
      context: scrubSecrets(state.context),
      updated_at: new Date().toISOString(),
    };

    const filePath = this.getFilePath(state.execution_id);
    const serialized = JSON.stringify(sanitized, null, 2);

    fs.writeFileSync(filePath, serialized, "utf8");
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
