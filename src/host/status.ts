// packages/project-run-engine/src/host/status.ts
//
// Read-only execution status: observes a persisted execution without attempting to
// advance it. This is the operation that makes multi-host / restart recovery possible
// (see ARCHITECTURE.md §4.4): a host that did not itself call `start()` — because a
// different process did, or because the original process disappeared — can still ask
// "what state is execution X in?" before deciding whether to present a question to
// the user or call `resume()`.
//
// Unlike `start()`/`resume()`, this never touches the Coordinator, the decision
// engine, or any AgentRuntimeAdapter: it is a pure translation of the persisted
// checkpoint record (FileExecutionStateStore) into the same ProjectRunHostResponse
// shape `start()`/`resume()` already return, so a host can treat all three uniformly.

import type { StructuredFinding } from "../domain/types.js";
import { FileExecutionStateStore, type ExecutionStateStore } from "../project/state-store.js";
import { deriveHumanQuestions, type HumanInterventionRequired } from "../decision/human-intervention.js";
import type { ProjectRunHostResponse, ProjectRunStatusRequest } from "./types.js";

export interface ProjectRunStatusOptions extends ProjectRunStatusRequest {
  stateStore?: ExecutionStateStore;
}

/**
 * Reads back the current, persisted status of an execution without advancing it.
 *
 * Note on completeness: the persisted checkpoint record does not currently retain the
 * full step-by-step `history` (only the Coordinator's in-memory run result does — see
 * the Phase 2 report's Findings). `status()` therefore always returns `history: []`
 * and a `stepsCount` approximated from the persisted `iteration` counter; a host that
 * needs the exact step sequence of a run must observe it live via `onEvent` during the
 * `start()`/`resume()` call that produced it.
 */
export async function statusProjectRun(
  options: ProjectRunStatusOptions,
): Promise<ProjectRunHostResponse> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const stateStore = options.stateStore ?? new FileExecutionStateStore(projectRoot);

  let persisted;
  try {
    persisted = await stateStore.load(options.executionId);
  } catch (err) {
    return {
      status: "FAILED",
      terminal: true,
      executionId: options.executionId,
      state: "HUMAN_INTERVENTION_REQUIRED",
      stepsCount: 0,
      history: [],
      findings: [],
      failureReason: (err as Error).message,
    };
  }

  if (!persisted) {
    return {
      status: "FAILED",
      terminal: true,
      executionId: options.executionId,
      state: "HUMAN_INTERVENTION_REQUIRED",
      stepsCount: 0,
      history: [],
      findings: [],
      failureReason: `EXECUTION_NOT_FOUND: Execution '${options.executionId}' not found in state store`,
    };
  }

  const findings = (persisted.findings ?? []) as StructuredFinding[];
  const base = {
    executionId: persisted.execution_id,
    state: persisted.state,
    stepsCount: persisted.iteration,
    history: [],
    findings,
  };

  switch (persisted.lifecycle_status) {
    case "COMPLETED":
      return { ...base, status: "COMPLETED", terminal: true };

    case "FAILED":
      return {
        ...base,
        status: "FAILED",
        terminal: true,
        failureReason: persisted.terminal_reason ?? "Execution failed",
      };

    case "HUMAN_INTERVENTION_REQUIRED": {
      // Prefer the record persisted at suspension time (identical to what the live
      // start()/resume() response carried); fall back to recomputing it for a
      // checkpoint written before this field existed (pre-Phase-1 persisted files).
      const humanIntervention: HumanInterventionRequired =
        persisted.human_intervention ?? {
          executionId: persisted.execution_id,
          suspendedFrom: persisted.suspended_from ?? persisted.state,
          reason: persisted.terminal_reason ?? "Human intervention required",
          questions: deriveHumanQuestions(persisted.terminal_reason ?? "", findings),
          findings,
        };

      return { ...base, status: "HUMAN_INTERVENTION_REQUIRED", terminal: false, humanIntervention };
    }

    case "IN_PROGRESS":
    default:
      return { ...base, status: "RUNNING", terminal: false };
  }
}
