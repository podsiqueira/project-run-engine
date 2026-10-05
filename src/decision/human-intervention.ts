// packages/project-run-engine/src/decision/human-intervention.ts
//
// Engine-owned, provider-neutral Human-in-the-Loop contract.
//
// The engine determines WHEN human input is required and WHAT must be asked; it never
// asks the human directly. A host agent (Claude Code, Cursor, Antigravity, Codex, or any
// other interactive coding-agent environment) is responsible for rendering the returned
// questions, collecting the answers, and resuming the execution.

import type { AgentRole, CoordinatorState, StructuredFinding } from "../domain/types.js";

export interface HumanQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface HumanQuestion {
  id: string;
  question: string;
  context?: string;
  options?: HumanQuestionOption[];
  required: boolean;
}

export interface HumanInterventionRequired {
  executionId: string;
  suspendedFrom: CoordinatorState;
  role?: AgentRole;
  reason: string;
  questions: HumanQuestion[];
  findings: StructuredFinding[];
}

export interface HumanAnswer {
  questionId: string;
  answer: string;
  answeredAt?: string;
  answeredBy?: string;
}

/**
 * A durable, server-timestamped record of a human answer. Distinct from `HumanAnswer`
 * (the transport-level shape a host submits on resume): `recordedAt` reflects when the
 * engine actually recorded the answer, not merely when the host claims to have
 * collected it. This is the shape carried on `CoordinatorExecutionContext.humanAnswers`
 * and persisted on `PersistedExecutionState.human_answers`.
 */
export interface HumanAnswerRecord extends HumanAnswer {
  recordedAt: string;
}

/**
 * Normalizes an arbitrary finding-shaped value (as persisted/carried on an AgentResult)
 * into a StructuredFinding-shaped object for question derivation. Tolerant of partially
 * typed findings, consistent with how `isFindingActionable`/`isFindingBlocking` already
 * tolerate loosely typed finding objects elsewhere in the decision layer.
 */
function asFindingLike(value: unknown): Partial<StructuredFinding> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Partial<StructuredFinding>;
}

/**
 * Derives a human-readable, structured question from a single blocking finding.
 *
 * The finding's own identifier is reused as the question identifier: a finding's
 * identity must remain stable through remediation and re-review (per the Finding
 * Contract), and the question asking a human to weigh in on it is the same concern
 * by another name, not a new, independently-tracked artifact.
 */
function questionFromFinding(finding: Partial<StructuredFinding>, index: number): HumanQuestion {
  const id = typeof finding.id === "string" && finding.id.trim() ? finding.id : `finding-${index + 1}`;
  const severity = finding.severity ?? "UNKNOWN";
  const category = finding.category ? ` (${finding.category})` : "";

  const questionParts: string[] = [];
  if (finding.required_remediation) {
    questionParts.push(String(finding.required_remediation));
  } else if (finding.expected) {
    questionParts.push(`How should this be resolved: ${finding.expected}?`);
  } else {
    questionParts.push("How should this be resolved?");
  }

  const contextParts: string[] = [];
  if (finding.evidence) contextParts.push(`Evidence: ${finding.evidence}`);
  if (finding.expected) contextParts.push(`Expected: ${finding.expected}`);
  if (finding.actual) contextParts.push(`Actual: ${finding.actual}`);

  return {
    id,
    question: `[${severity}${category}] ${questionParts.join(" ")}`,
    context: contextParts.length > 0 ? contextParts.join("\n") : undefined,
    required: true,
  };
}

/**
 * Derives the structured HumanQuestion[] the host must present for a given
 * HUMAN_INTERVENTION_REQUIRED suspension.
 *
 * Deterministic and pure: the same (reason, findings) always produces the same
 * questions, with no I/O, no provider calls, and no reliance on free-form agent
 * prose. When no findings are present (e.g. an explicit host-level override, or a
 * BLOCKED result with an empty findings array), a single generic question is
 * returned so the host never has to render "intervention required" with nothing
 * to show the human — `questions` is never empty for a REQUIRE_HUMAN_INTERVENTION
 * outcome.
 */
export function deriveHumanQuestions(
  reason: string,
  findings: readonly unknown[],
): HumanQuestion[] {
  const blockingLike = findings
    .map(asFindingLike)
    .filter((f): f is Partial<StructuredFinding> => f !== undefined && f.status !== "RESOLVED" && f.status !== "ACCEPTED");

  if (blockingLike.length === 0) {
    return [
      {
        id: "intervention-required",
        question: reason || "The workflow cannot safely continue without human input. How should it proceed?",
        required: true,
      },
    ];
  }

  return blockingLike.map(questionFromFinding);
}
