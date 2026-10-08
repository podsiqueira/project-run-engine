// packages/project-run-engine/src/host/events.ts
//
// Provider-agnostic progress/event contract, so a host agent can render live progress
// ("✓ Specification  ✓ Clarification  → Architecture  ⏸ Waiting for your input")
// without scraping CLI logs or polling the state store.
//
// Deliberately a simple typed event union, not a streaming/pub-sub framework: a host
// supplies a single `onEvent` callback and receives events synchronously as they occur
// during a `start()`/`resume()` call.

import type { AgentRole, CoordinatorState } from "../domain/types.js";

export type ProjectRunEventType =
  | "RUN_STARTED"
  | "RESUME_STARTED"
  | "STATE_CHANGED"
  | "AGENT_DISPATCH_STARTED"
  | "AGENT_DISPATCH_COMPLETED"
  | "HUMAN_INTERVENTION_REQUIRED"
  | "RUN_COMPLETED"
  | "RUN_FAILED";

interface ProjectRunEventBase<T extends ProjectRunEventType> {
  type: T;
  executionId: string;
  timestamp: string;
}

export type RunStartedEvent = ProjectRunEventBase<"RUN_STARTED"> & {
  feature?: string;
  branch?: string;
};

export type ResumeStartedEvent = ProjectRunEventBase<"RESUME_STARTED">;

export type StateChangedEvent = ProjectRunEventBase<"STATE_CHANGED"> & {
  from: CoordinatorState;
  to: CoordinatorState;
};

export type AgentDispatchStartedEvent = ProjectRunEventBase<"AGENT_DISPATCH_STARTED"> & {
  role: AgentRole;
  state: string;
};

export type AgentDispatchCompletedEvent = ProjectRunEventBase<"AGENT_DISPATCH_COMPLETED"> & {
  role: AgentRole;
  state: string;
  status: string;
};

export type HumanInterventionRequiredEvent = ProjectRunEventBase<"HUMAN_INTERVENTION_REQUIRED"> & {
  suspendedFrom: CoordinatorState;
  reason: string;
  questionCount: number;
};

export type RunCompletedEvent = ProjectRunEventBase<"RUN_COMPLETED"> & {
  state: CoordinatorState;
  /** Agent steps in the whole execution (same meaning as `ProjectRunHostResponse.stepsCount`). */
  stepsCount: number;
};

export type RunFailedEvent = ProjectRunEventBase<"RUN_FAILED"> & {
  reason: string;
};

export type ProjectRunEvent =
  | RunStartedEvent
  | ResumeStartedEvent
  | StateChangedEvent
  | AgentDispatchStartedEvent
  | AgentDispatchCompletedEvent
  | HumanInterventionRequiredEvent
  | RunCompletedEvent
  | RunFailedEvent;

export type ProjectRunEventSink = (event: ProjectRunEvent) => void | Promise<void>;
