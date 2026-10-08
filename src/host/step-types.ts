// packages/project-run-engine/src/host/step-types.ts
//
// The pull-based counterpart to ProjectRunHost (start/resume/status). Where
// start()/resume() run the Coordinator loop internally and require a real
// AgentRuntimeAdapter to perform dispatched work, the step contract is for a host
// that IS the agent runtime for this execution but cannot hand control back to the
// engine mid-call — a live, same-session interactive coding-agent host (Claude Code,
// Cursor, Codex, Antigravity) being the primary motivating case. See ARCHITECTURE.md
// §4.11 for the full rationale and the control-flow diagram.
//
// The engine still owns every transition decision, every safety gate, and all
// persistence; the host only ever contributes the content of an AgentResult.

import type {
  AgentDispatchRequest,
  AgentResult,
  AgentRole,
  AgentRuntime,
  CoordinatorState,
  ExecutionFailureCode,
} from "../domain/types.js";
import type { HostExecutionOptions } from "../runtime/host-execution-contract.js";
import type { ExecutionStateStore } from "../project/state-store.js";
import type { ProjectWorkflowConfig } from "../project/project-config.js";
import type { HumanAnswer, HumanInterventionRequired } from "../decision/human-intervention.js";
import type { ProjectRunHostResponse } from "./types.js";

export interface NextProjectRunStepRequest {
  /**
   * Omit to always start a brand new execution. Provide to recover or advance an
   * existing one — if no persisted execution exists yet for this id, one is started
   * fresh using it as the execution id.
   */
  executionId?: string;
  projectRoot?: string;
  feature?: string;
  branch?: string;
  runtime?: AgentRuntime;
  config?: ProjectWorkflowConfig;
  configPath?: string;
  executionOptions?: HostExecutionOptions;
  maxSteps?: number;
  /**
   * Structured answers to the questions on a prior `HUMAN_INTERVENTION_REQUIRED`
   * response. Supplying these against an execution currently suspended for human
   * intervention resumes it (persisting the answers durably and re-dispatching the
   * responsible agent to independently verify — exactly as `ProjectRunHost.resume()`
   * already does); omitting them against a suspended execution performs a pure,
   * non-mutating read of the current `HUMAN_INTERVENTION_REQUIRED` state instead.
   */
  humanAnswers?: HumanAnswer[];
  /** Advanced/test use — a custom state store instance. */
  stateStore?: ExecutionStateStore;
}

export interface SubmitProjectRunStepRequest {
  executionId: string;
  /**
   * Must match the `stepId` from the `AGENT_ACTION_REQUIRED` response this result is
   * answering. A mismatch (already-submitted, stale, or forged) is rejected with a
   * structured `FAILED` response — see `submitProjectRunStep`.
   */
  stepId: string;
  result: AgentResult;
  projectRoot?: string;
  config?: ProjectWorkflowConfig;
  configPath?: string;
  maxSteps?: number;
  stateStore?: ExecutionStateStore;
}

/**
 * The pull-based step response. Exactly one of these is returned by
 * `nextProjectRunStep()` and `submitProjectRunStep()` — a host never needs
 * Coordinator internals, the decision engine, the checkpoint file format, or logs to
 * interpret it.
 */
export type ProjectRunStepResponse =
  | {
      status: "AGENT_ACTION_REQUIRED";
      terminal: false;
      executionId: string;
      state: CoordinatorState;
      /** Echo this back verbatim in `submitProjectRunStep({ stepId, ... })`. */
      stepId: string;
      request: AgentDispatchRequest;
    }
  | {
      status: "HUMAN_INTERVENTION_REQUIRED";
      terminal: false;
      executionId: string;
      state: CoordinatorState;
      humanIntervention: HumanInterventionRequired;
    }
  | {
      status: "BLOCKED_MISSING_SKILLS";
      terminal: false;
      executionId: string;
      state: CoordinatorState;
      role?: AgentRole;
      missingSkills?: string[];
      failureReason?: string;
    }
  | {
      status: "COMPLETED";
      terminal: true;
      executionId: string;
      state: CoordinatorState;
      result: ProjectRunHostResponse;
    }
  | {
      status: "FAILED";
      /**
       * `true` when the execution itself is now terminally dead (not found, already
       * completed, already failed). `false` when only this particular call was
       * rejected (stale/duplicate stepId, no action currently pending, invalid
       * result) and the underlying execution may still be perfectly resumable —
       * the host should fix the request and retry, not treat the execution as lost.
       */
      terminal: boolean;
      executionId: string;
      state: CoordinatorState;
      failureReason: string;
      /**
       * Present for the failures a host can handle without reading `failureReason`:
       * `EXECUTION_LOCKED`, `EXECUTION_LOCK_UNAVAILABLE` and `CHECKPOINT_WRITE_FAILED`.
       * All three are non-terminal: this call did not take effect beyond the last durable
       * checkpoint, and calling `nextProjectRunStep()` again with the same `executionId`
       * returns the authoritative current state (the same pending action, or the recovered
       * next one). For `CHECKPOINT_WRITE_FAILED` the cause is the storage environment —
       * fix it first; the engine never reports progress that is not durable.
       */
      failureCode?: ExecutionFailureCode;
    };
