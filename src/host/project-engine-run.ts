// packages/project-run-engine/src/host/project-engine-run.ts
//
// The provider-neutral `project-engine-run` capability: a single, machine-readable,
// action-discriminated entry point over the exact same start/resume/status functions
// in `./project-run-host.js`. This is pure routing — it contains no orchestration
// logic of its own — so that a provider's tool-calling convention (Claude Code,
// Cursor, Codex, Antigravity, MCP, or anything else built on "one tool, one input
// schema, dispatch on a discriminant field") has exactly one capability to register,
// rather than three separate tools to wire up and keep in sync.
//
// The semantic capability is `project-engine-run` (no leading slash — see
// `PROJECT_ENGINE_RUN_TOOL_SCHEMA` below). Whether a given host exposes that as
// `/project-engine-run "<feature>"`, a native tool, or a skill is entirely a host
// decision; this module does not know or care which.

import { startProjectRun, resumeProjectRun } from "./project-run-host.js";
import { statusProjectRun } from "./status.js";
import type {
  ProjectRunHostRequest,
  ProjectRunHostResponse,
  ProjectRunResumeRequest,
  ProjectRunStatusRequest,
} from "./types.js";

/**
 * Bumped only on a breaking change to the shape of `ProjectEngineRunInput` or
 * `ProjectRunHostResponse`. A host can compare this against the version it was built
 * against to detect contract drift without needing to track the whole package's
 * semver (which also covers internal orchestration changes that do not affect this
 * capability's surface at all).
 */
export const PROJECT_ENGINE_RUN_CAPABILITY_VERSION = "1.0.0";

export type ProjectEngineRunInput =
  | ({ action: "start" } & ProjectRunHostRequest)
  | ({ action: "resume" } & ProjectRunResumeRequest)
  | ({ action: "status" } & ProjectRunStatusRequest);

/**
 * The single provider-neutral capability. Deterministic and safe to invoke
 * repeatedly: an unknown/completed/failed `executionId` always returns a structured
 * `FAILED` response (never throws), and `status` never mutates persisted state.
 *
 * ```ts
 * await projectEngineRun({ action: "start", feature: "004-campaigns-and-lead-attribution", adapters });
 * await projectEngineRun({ action: "status", executionId });
 * await projectEngineRun({ action: "resume", executionId, humanAnswers, adapters });
 * ```
 */
export async function projectEngineRun(input: ProjectEngineRunInput): Promise<ProjectRunHostResponse> {
  switch (input.action) {
    case "start": {
      const { action: _action, ...request } = input;
      return startProjectRun(request);
    }
    case "resume": {
      const { action: _action, ...request } = input;
      return resumeProjectRun(request);
    }
    case "status": {
      const { action: _action, ...request } = input;
      return statusProjectRun(request);
    }
  }
}

/**
 * A canonical, provider-neutral tool/skill description for `project-engine-run`,
 * expressed as plain JSON Schema — the one input format every major tool-calling
 * convention (Claude tool_use, OpenAI/Codex function calling, MCP tool definitions)
 * already consumes, so this single artifact can back a Claude Code Skill, a Cursor
 * tool, an MCP server, or an Antigravity tool definition without being specific to
 * any of them. See ARCHITECTURE.md §4.6 for why no provider-specific file ships here.
 *
 * Deliberately scoped to the JSON-serializable subset of `ProjectEngineRunInput`
 * (`action`, `executionId`, `feature`, `humanAnswers`, ...): `adapters` — the host's
 * `AgentRuntimeAdapter[]` — is a set of live functions, not JSON, and can never cross
 * a tool-calling wire. Whatever process receives this tool call and holds the actual
 * `AgentRuntimeAdapter` implementation calls `projectEngineRun()` (or `ProjectRunHost`)
 * directly, in-process, supplying its own adapters alongside the JSON-decoded fields
 * below. See ARCHITECTURE.md §4.5 "Host adapter responsibilities".
 */
export const PROJECT_ENGINE_RUN_TOOL_SCHEMA = {
  name: "project_engine_run",
  version: PROJECT_ENGINE_RUN_CAPABILITY_VERSION,
  description:
    "Starts, resumes, or checks the status of a Project Run feature-delivery workflow execution. " +
    "The workflow proceeds through SPECIFY, CLARIFY, PLAN, TASKS, ANALYZE, IMPLEMENT, " +
    "INDEPENDENT_REVIEW, REMEDIATION, RE_REVIEW, and CONVERGE to READY_FOR_PR. " +
    "When the response status is HUMAN_INTERVENTION_REQUIRED, present " +
    "`humanIntervention.questions` to the user, collect their answers, and call this " +
    "capability again with action \"resume\" and the collected `humanAnswers` — never " +
    "invent an answer or assume the workflow can proceed without one.",
  input_schema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["start", "resume", "status"],
        description:
          "\"start\" begins a new execution. \"resume\" continues a suspended execution, " +
          "optionally with human answers. \"status\" reads an execution's current state " +
          "without attempting to advance it.",
      },
      executionId: {
        type: "string",
        description:
          "Required for \"resume\" and \"status\". Optional for \"start\" (a new one is " +
          "generated if omitted) — always echoed back in the response; the host must " +
          "retain it to resume or check status later, including across process restarts.",
      },
      feature: {
        type: "string",
        description:
          "Feature identifier, e.g. \"004-campaigns-and-lead-attribution\". Only used by " +
          "\"start\"; auto-discovered from the git branch/specs directory when omitted.",
      },
      humanAnswers: {
        type: "array",
        description:
          "Only used by \"resume\". Answers to the questions from a prior " +
          "HUMAN_INTERVENTION_REQUIRED response, one entry per answered question.",
        items: {
          type: "object",
          required: ["questionId", "answer"],
          properties: {
            questionId: { type: "string" },
            answer: { type: "string" },
          },
        },
      },
    },
  },
  response_semantics: {
    status: ["RUNNING", "COMPLETED", "HUMAN_INTERVENTION_REQUIRED", "BLOCKED_MISSING_SKILLS", "FAILED"],
    terminal_statuses: ["COMPLETED", "FAILED"],
    human_intervention_field: "humanIntervention",
    // Machine-readable discriminator on a FAILED response (use it instead of parsing `failureReason`).
    // Every response that carries one is non-terminal (`terminal: false`): the call did not take
    // effect beyond the execution's last durable checkpoint, and the execution is intact.
    failure_code_field: "failureCode",
    failure_codes: [
      "EXECUTION_LOCKED",
      "EXECUTION_LOCK_UNAVAILABLE",
      "CHECKPOINT_WRITE_FAILED",
      "CHECKPOINT_CONFLICT",
    ],
    failure_code_semantics: {
      EXECUTION_LOCKED:
        "Another live operation held the execution's lock for the whole wait. Repeat the same call after a moment.",
      EXECUTION_LOCK_UNAVAILABLE:
        "The runs directory is unusable (missing, not writable, disk full), or the first checkpoint could not be written. Fix the environment, then retry.",
      CHECKPOINT_WRITE_FAILED:
        "The store rejected a checkpoint write. The execution stays at its last durable checkpoint and the response describes it (see the failure notes in ARCHITECTURE.md 4.17.1). Fix the storage problem, then call resume/start again with the same executionId.",
      CHECKPOINT_CONFLICT:
        "Another operation changed the execution while this call was in progress; nothing of this call was written. Read the current state with `status` instead of retrying blindly.",
    },
    safety_note:
      "An answer supplied on resume never directly forces a transition or mutates a " +
      "finding; the agent responsible for the suspended state is always re-dispatched " +
      "and independently re-evaluated before the workflow is allowed to continue.",
  },
} as const;
