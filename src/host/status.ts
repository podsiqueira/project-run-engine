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

import { countAgentSteps, type StructuredFinding } from "../domain/types.js";
import { FileExecutionStateStore, type ExecutionStateStore } from "../project/state-store.js";
import { deriveHumanQuestions, type HumanInterventionRequired } from "../decision/human-intervention.js";
import type { ProjectRunHostResponse, ProjectRunStatusRequest } from "./types.js";

export interface ProjectRunStatusOptions extends ProjectRunStatusRequest {
  stateStore?: ExecutionStateStore;
}

/**
 * Reads back the current, persisted status of an execution without advancing it.
 *
 * What is and isn't durable (see `ARCHITECTURE.md` §4.4/§4.15 and `docs/backlog.md`
 * ENG-002): the checkpoint retains an append-only `step_log` — every agent step (with
 * the findings it reported) and every human suspension — so `stepLog` and `stepsCount`
 * are exact, including across resumes and restarts. `findings` is the latest result's
 * findings only. `history` (the live `StepRecord[]` of decisions) is NOT persisted, so
 * `status()` always returns `history: []`; use `stepLog` for the durable record. A
 * checkpoint written before the step log existed reports `stepsCount: 0` / `stepLog: []`.
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
      stepLog: [],
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
      stepLog: [],
      failureReason: `EXECUTION_NOT_FOUND: Execution '${options.executionId}' not found in state store`,
    };
  }

  const findings = (persisted.findings ?? []) as StructuredFinding[];
  const base = {
    executionId: persisted.execution_id,
    state: persisted.state,
    stepsCount: countAgentSteps(persisted.step_log),
    history: [],
    findings,
    stepLog: persisted.step_log ?? [],
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
