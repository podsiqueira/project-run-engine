// Compiled by tests/public-api-surface.test.ts as a CONSUMER of the built package, resolving every
// import through the package.json "exports" map exactly like a real dependency would.
import {
  CheckpointConflictError,
  CheckpointWriteError,
  ExecutionLockError,
  ExecutionLockTimeoutError,
  ExecutionLockUnavailableError,
  FileExecutionStateStore,
  nextProjectRunStep,
  startProjectRun,
} from "@incito-labs/project-run-engine";
import type {
  DecisionRecord,
  ExecutionFailureCode,
  ExecutionSaveOptions,
  ExecutionSaveReceipt,
  ExecutionStateStore,
  HumanAnswerFailureCode,
  PersistedExecutionState,
  PersistenceFailureCode,
  ProjectRunExecutionResult,
  ProjectRunHostRequest,
  ProjectRunHostResponse,
  ProjectRunResumeRequest,
  ProjectRunStatusRequest,
  ProjectRunStepResponse,
  ResumeContextResult,
} from "@incito-labs/project-run-engine";
import {
  CheckpointConflictError as DomainConflict,
  CheckpointWriteError as DomainWrite,
} from "@incito-labs/project-run-engine/domain";
import type {
  ExecutionFailureCode as DomainFailureCode,
  HumanAnswerFailureCode as DomainAnswerCode,
  PersistenceFailureCode as DomainPersistenceCode,
} from "@incito-labs/project-run-engine/domain";
import { FileExecutionStateStore as ProjectStore, withExecutionLock } from "@incito-labs/project-run-engine/project";
import type {
  ExecutionSaveOptions as ProjectSaveOptions,
  ExecutionSaveReceipt as ProjectSaveReceipt,
  ExecutionStateStore as ProjectStoreContract,
  PersistedExecutionState as ProjectPersisted,
  ProjectRunExecutionResult as ProjectResult,
} from "@incito-labs/project-run-engine/project";
import { startProjectRun as hostStart, statusProjectRun, PROJECT_ENGINE_RUN_TOOL_SCHEMA } from "@incito-labs/project-run-engine/host";
import type {
  ProjectRunHostRequest as HostRequest,
  ProjectRunResumeRequest as HostResumeRequest,
  ProjectRunStatusRequest as HostStatusRequest,
  ProjectRunStepResponse as HostStepResponse,
} from "@incito-labs/project-run-engine/host";

// The failure codes are one closed union, and the public responses carry them.
const codes: ExecutionFailureCode[] = ["EXECUTION_LOCKED", "EXECUTION_LOCK_UNAVAILABLE", "CHECKPOINT_WRITE_FAILED", "CHECKPOINT_CONFLICT", "INVALID_HUMAN_ANSWERS"];
const persistence: PersistenceFailureCode[] = ["CHECKPOINT_WRITE_FAILED", "CHECKPOINT_CONFLICT"];
const answerCodes: HumanAnswerFailureCode[] = ["INVALID_HUMAN_ANSWERS"];
function failureCodes(step: ProjectRunStepResponse, host: ProjectRunHostResponse, push: ProjectRunExecutionResult): Array<ExecutionFailureCode | undefined> {
  return [step.status === "FAILED" ? step.failureCode : undefined, host.failureCode, push.lockFailure ?? push.persistenceFailure ?? push.answerFailure];
}

// Realistic handling of a rejected `humanAnswers` call, on each entry point: it is a non-terminal FAILED.
function answersRejected(step: ProjectRunStepResponse, host: ProjectRunHostResponse, push: ProjectRunExecutionResult): boolean[] {
  return [
    step.status === "FAILED" && step.failureCode === "INVALID_HUMAN_ANSWERS" && !step.terminal,
    host.status === "FAILED" && host.failureCode === "INVALID_HUMAN_ANSWERS" && !host.terminal,
    push.status === "FAILED" && push.answerFailure === "INVALID_HUMAN_ANSWERS",
  ];
}
// A consumer that switches over every failure code exhaustively (the `never` check is what a new code breaks).
function advice(code: ExecutionFailureCode): string {
  switch (code) {
    case "EXECUTION_LOCKED":
    case "EXECUTION_LOCK_UNAVAILABLE":
      return "retry";
    case "CHECKPOINT_WRITE_FAILED":
    case "CHECKPOINT_CONFLICT":
      return "read status";
    case "INVALID_HUMAN_ANSWERS":
      return "fix the answers";
    default: {
      const unhandled: never = code;
      return unhandled;
    }
  }
}
function answerFailureOf(resumed: ResumeContextResult): HumanAnswerFailureCode | undefined {
  return resumed.ok ? undefined : resumed.failureCode;
}
const decisions: DecisionRecord[] = [];

// A conflict is a write error; the same classes come from every entry point.
function classify(err: unknown): PersistenceFailureCode | undefined {
  if (err instanceof CheckpointConflictError) return err.code;
  if (err instanceof CheckpointWriteError) return err.code;
  if (err instanceof DomainConflict || err instanceof DomainWrite) return err.code;
  return undefined;
}

// The storage contract: optional revisioned save, receipt, `stateStore` on every host request.
async function usesContract(store: ExecutionStateStore, state: PersistedExecutionState): Promise<number | undefined> {
  const options: ExecutionSaveOptions = { expectedRevision: state.revision ?? 0 };
  const receipt: void | ExecutionSaveReceipt = await store.save(state, options);
  return receipt ? receipt.revision : undefined;
}
const stores: Array<HostRequest["stateStore"] | HostResumeRequest["stateStore"] | HostStatusRequest["stateStore"] | ProjectStoreContract> = [new FileExecutionStateStore("."), new ProjectStore(".")];
const sameTypes: [ProjectSaveOptions, ProjectSaveReceipt, ProjectPersisted, ProjectResult, HostStepResponse, DomainFailureCode, DomainPersistenceCode, DomainAnswerCode] | null = null;

void [codes, persistence, answerCodes, failureCodes, answersRejected, advice, answerFailureOf, decisions, classify, usesContract, stores, sameTypes, ExecutionLockError, ExecutionLockTimeoutError, ExecutionLockUnavailableError, nextProjectRunStep, startProjectRun, hostStart, statusProjectRun, withExecutionLock, PROJECT_ENGINE_RUN_TOOL_SCHEMA];
export {};
